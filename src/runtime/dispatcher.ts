/**
 * Dispatcher da Transactional Outbox.
 * Lê comandos gravados atomicamente pelo motor e executa os efeitos colaterais:
 * envio ao canal, chamadas de integração, agendamentos e transbordo.
 * - Ordem preservada por conversa (execução sequencial dentro do grupo)
 * - Paralelismo entre conversas diferentes
 * - Retry com backoff; após `maxAttempts`, vai para dead letter (visível em /admin/dead-letters)
 */
import type { Command, InboundEvent } from '../core/types.ts';
import type { Storage, OutboxRecord } from '../storage/types.ts';
import type { ChannelAdapter } from '../channels/types.ts';
import { PermanentChannelError } from '../channels/types.ts';
import { runHttp, CircuitBreaker } from '../integrations/http-runner.ts';
import type { HandoffService } from './handoff.ts';
import { Metrics, silentLogger, type Logger } from '../core/observability.ts';

export interface DispatcherDeps {
  storage: Storage;
  adapters: Record<string, ChannelAdapter>;
  handoff: HandoffService;
  dispatchEvent: (ev: InboundEvent) => Promise<unknown>;
  getSecret: (name: string) => string | undefined;
  logger?: Logger;
  metrics?: Metrics;
  breaker?: CircuitBreaker;
  fetchImpl?: typeof fetch;
  maxAttempts?: number;
  baseRetryMs?: number;
  /** Relógio para agendamentos (injetável: o Studio simula a passagem do tempo). */
  clock?: () => Date;
}

export class OutboxDispatcher {
  private readonly d: DispatcherDeps;
  private readonly logger: Logger;
  private readonly metrics: Metrics;
  private readonly breaker: CircuitBreaker;
  private readonly inFlight = new Set<number>();
  /** Conversas com envio em backoff: mensagens seguintes esperam para não chegar fora de ordem. */
  private readonly blockedUntil = new Map<string, number>();
  private draining: Promise<void> | null = null;
  private again = false;
  private timer?: NodeJS.Timeout;

  constructor(deps: DispatcherDeps) {
    this.d = deps;
    this.logger = deps.logger ?? silentLogger;
    this.metrics = deps.metrics ?? new Metrics();
    this.breaker = deps.breaker ?? new CircuitBreaker();
  }

  start(intervalMs = 500): void {
    this.timer = setInterval(() => void this.drain(), intervalMs);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
  }

  /** Processa tudo que está pendente. Chamadas concorrentes são coalescidas. */
  drain(): Promise<void> {
    if (this.draining) {
      this.again = true;
      return this.draining;
    }
    this.draining = (async () => {
      try {
        do {
          this.again = false;
          await this.drainOnce();
        } while (this.again);
      } finally {
        this.draining = null;
      }
    })();
    return this.draining;
  }

  /** Aguarda até não haver trabalho imediato pendente (útil em testes). */
  async idle(maxRounds = 50): Promise<void> {
    for (let i = 0; i < maxRounds; i++) {
      await this.drain();
      if (!this.d.storage.pendingOutbox(Date.now(), 1).some((r) => !this.inFlight.has(r.id)) && this.inFlight.size === 0) return;
      await new Promise((r) => setTimeout(r, 5));
    }
  }

  private async drainOnce(): Promise<void> {
    const batch = this.d.storage.pendingOutbox(Date.now(), 100).filter((r) => !this.inFlight.has(r.id));
    if (!batch.length) return;
    const groups = new Map<string, OutboxRecord[]>();
    for (const r of batch) {
      const key = 'to' in r.command ? r.command.to.conversationId : 'global';
      groups.set(key, [...(groups.get(key) ?? []), r]);
    }
    const now = Date.now();
    const sequential = [...groups.entries()].map(async ([key, records]) => {
      if ((this.blockedUntil.get(key) ?? 0) > now) return;
      this.blockedUntil.delete(key);
      for (const r of records) {
        if (r.command.type === 'callIntegration') {
          // Integrações podem demorar: rodam em paralelo sem travar o grupo.
          this.inFlight.add(r.id);
          void this.execute(r).finally(() => this.inFlight.delete(r.id));
        } else {
          this.inFlight.add(r.id);
          let result: { ok: boolean; retryAt?: number | null };
          try {
            result = await this.execute(r);
          } finally {
            this.inFlight.delete(r.id);
          }
          // Falha transitória: segura o restante da conversa até o reenvio (preserva a ordem).
          if (!result.ok && result.retryAt) {
            this.blockedUntil.set(key, result.retryAt);
            break;
          }
        }
      }
    });
    await Promise.all(sequential);
  }

  private async execute(r: OutboxRecord): Promise<{ ok: boolean; retryAt?: number | null }> {
    try {
      await this.run(r.command);
      this.d.storage.completeOutbox(r.id);
      this.metrics.inc(`outbox.done.${r.command.type}`);
      return { ok: true };
    } catch (err) {
      const max = this.d.maxAttempts ?? 5;
      const permanent = err instanceof PermanentChannelError;
      const attempts = r.attempts + 1;
      const retryAt = permanent || attempts >= max ? null : Date.now() + (this.d.baseRetryMs ?? 1000) * 2 ** (attempts - 1);
      this.d.storage.failOutbox(r.id, String((err as Error).message ?? err), retryAt);
      this.metrics.inc(retryAt === null ? 'outbox.dead' : 'outbox.retry');
      this.logger[retryAt === null ? 'error' : 'warn']('outbox_failure', {
        id: r.id, type: r.command.type, attempts, dead: retryAt === null, error: String(err),
      });
      return { ok: false, retryAt };
    }
  }

  private async run(c: Command): Promise<void> {
    switch (c.type) {
      case 'send': {
        const adapter = this.d.adapters[c.to.channel];
        if (!adapter) throw new PermanentChannelError(`canal sem adapter: ${c.to.channel}`);
        const t0 = performance.now();
        await adapter.send(c.to, c.message);
        this.metrics.observe(`channel.${c.to.channel}.send_ms`, performance.now() - t0);
        return;
      }
      case 'callIntegration': {
        const res = await runHttp(c.request, {
          timeoutMs: c.timeoutMs, retry: c.retry, getSecret: this.d.getSecret, breaker: this.breaker, fetchImpl: this.d.fetchImpl,
        });
        this.metrics.inc(res.ok ? 'integration.ok' : 'integration.failed');
        this.metrics.observe('integration.ms', res.durationMs);
        this.logger.info('integration_result', { conversationId: c.to.conversationId, url: c.request.url.split('?')[0], ok: res.ok, status: res.status, attempts: res.attempts, error: res.error });
        await this.d.dispatchEvent({
          eventId: `int:${c.token}`, tenantId: c.to.tenantId, channel: c.to.channel, userId: c.to.userId,
          kind: 'integration_result', data: { token: c.token, ok: res.ok, status: res.status, body: res.body, error: res.error },
        });
        return;
      }
      case 'schedule':
        this.d.storage.scheduleJob({
          id: `${c.token}:${c.reason}`,
          dueAt: (this.d.clock?.() ?? new Date()).getTime() + c.delaySec * 1000,
          event: { eventId: `timer:${c.token}:${c.reason}`, tenantId: c.to.tenantId, channel: c.to.channel, userId: c.to.userId, kind: 'timer', data: { token: c.token, reason: c.reason } },
        });
        return;
      case 'handoff':
        this.d.handoff.open(c.to, c.queue, c.context);
        return;
      case 'handoffForward':
        this.d.handoff.forward(c.to, c.text);
        return;
      case 'handoffClose':
        this.d.handoff.systemClose(c.to, c.reason);
        return;
      case 'emit':
        this.metrics.inc(`emit.${c.name}`);
        if (c.name === 'randomizer') this.metrics.inc(`randomizer.${c.data.flowId}.${c.data.nodeId}.${c.data.variant}`);
        this.logger.info(`event.${c.name}`, c.data);
        return;
    }
  }
}
