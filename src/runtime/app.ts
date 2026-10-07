/**
 * Composition root: monta motor + storage + canais + dispatcher + scheduler + transbordo.
 * Este é o único lugar que conhece todas as peças concretas.
 */
import { StateEngine, type EngineConfig } from '../core/engine.ts';
import { FlowRegistry } from '../core/registry.ts';
import { TenantRegistry } from '../core/tenants.ts';
import { Metrics, silentLogger, type Logger } from '../core/observability.ts';
import type { Address, InboundEvent } from '../core/types.ts';
import type { Storage } from '../storage/types.ts';
import type { ChannelAdapter } from '../channels/types.ts';
import { WebchatChannel } from '../channels/webchat.ts';
import { CircuitBreaker } from '../integrations/http-runner.ts';
import { OutboxDispatcher } from './dispatcher.ts';
import { Scheduler } from './scheduler.ts';
import { HandoffService } from './handoff.ts';

export interface BotAppOptions {
  storage: Storage;
  registry?: FlowRegistry;
  flowsDir?: string;
  tenants?: TenantRegistry;
  tenantsDir?: string;
  adapters?: ChannelAdapter[];
  engineConfig?: Partial<EngineConfig>;
  logger?: Logger;
  getSecret?: (name: string) => string | undefined;
  fetchImpl?: typeof fetch;
  breaker?: CircuitBreaker;
  outboxRetryMs?: number;
  clock?: () => Date;
}

export interface BotApp {
  engine: StateEngine;
  registry: FlowRegistry;
  tenants: TenantRegistry;
  storage: Storage;
  metrics: Metrics;
  logger: Logger;
  webchat: WebchatChannel;
  adapters: Record<string, ChannelAdapter>;
  dispatcher: OutboxDispatcher;
  scheduler: Scheduler;
  handoff: HandoffService;
  /** Entrada única de eventos (webhooks, scheduler, integrações, atendentes). */
  receive(ev: InboundEvent): Promise<void>;
  /**
   * Disparo ativo (transmissão): inicia `flowId` para contatos com a etiqueta, respeitando opt-out
   * e sem atropelar conversas em andamento. Idempotente por broadcastId.
   * No WhatsApp, fora da janela de 24h o fluxo deve começar com um nó message+template.
   */
  broadcast(opts: { broadcastId: string; flowId: string; tag?: string; tenantId?: string; vars?: Record<string, unknown> }): Promise<{ started: number; skipped: number }>;
  /**
   * "Limpeza de contatos" do curso (mensal): remove contatos sem interação há `inactiveDays`
   * que não tenham nenhuma etiqueta protegida (ex.: lista VIP) nem conversa em andamento.
   * dryRun (padrão true) apenas lista quem seria removido.
   */
  cleanupContacts(opts: { inactiveDays: number; keepTags?: string[]; tenantId?: string; dryRun?: boolean }): { removed: string[]; kept: number; dryRun: boolean };
  start(): void;
  stop(): void;
}

/** Segredos via variáveis de ambiente: {{secrets.sheets_url}} -> SECRET_SHEETS_URL */
export const envSecrets = (name: string) => process.env[`SECRET_${name.toUpperCase()}`];

export function createBotApp(opts: BotAppOptions): BotApp {
  const logger = opts.logger ?? silentLogger;
  const metrics = new Metrics();
  const registry = opts.registry ?? new FlowRegistry();
  if (opts.flowsDir) {
    const results = registry.loadDir(opts.flowsDir);
    for (const [id, r] of Object.entries(results)) for (const w of r.warnings) logger.warn('flow_warning', { flowId: id, warning: w });
  }
  const webchat = (opts.adapters?.find((a) => a.name === 'webchat') as WebchatChannel | undefined) ?? new WebchatChannel();
  const adapters: Record<string, ChannelAdapter> = { webchat };
  for (const a of opts.adapters ?? []) adapters[a.name] = a;

  const tenants = opts.tenants ?? new TenantRegistry();
  if (opts.tenantsDir) tenants.loadDir(opts.tenantsDir);
  const engine = new StateEngine({ registry, storage: opts.storage, logger, metrics, config: opts.engineConfig, clock: opts.clock, tenants });
  const receive = async (ev: InboundEvent) => {
    await engine.handle(ev);
  };

  const sendToUser = async (to: Address, text: string) => {
    const adapter = adapters[to.channel];
    if (!adapter) throw new Error(`canal sem adapter: ${to.channel}`);
    await adapter.send(to, { kind: 'text', text });
  };
  const handoff = new HandoffService({ storage: opts.storage, dispatchEvent: receive, sendToUser });
  const dispatcher = new OutboxDispatcher({
    storage: opts.storage, adapters, handoff, dispatchEvent: receive, getSecret: opts.getSecret ?? envSecrets,
    logger, metrics, fetchImpl: opts.fetchImpl, breaker: opts.breaker, baseRetryMs: opts.outboxRetryMs, clock: opts.clock,
  });
  const scheduler = new Scheduler(opts.storage, receive, logger, opts.clock);
  engine.onCommit = () => void dispatcher.drain();

  let pruneTimer: NodeJS.Timeout | undefined;
  return {
    engine, registry, tenants, storage: opts.storage, metrics, logger, webchat, adapters, dispatcher, scheduler, handoff, receive,
    async broadcast({ broadcastId, flowId, tag, tenantId, vars }) {
      if (!registry.has(flowId)) throw new Error(`fluxo não encontrado: ${flowId}`);
      let started = 0;
      let skipped = 0;
      for (const c of opts.storage.listContacts({ tag })) {
        const [tId, channel, ...rest] = c.conversationId.split(':');
        if ((tenantId && tId !== tenantId) || c.fields.opted_out) {
          skipped++;
          continue;
        }
        const r = await engine.handle({
          eventId: `bc:${broadcastId}:${c.conversationId}`, tenantId: tId, channel, userId: rest.join(':'),
          kind: 'start', data: { flowId, vars: { ...vars, broadcastId } },
        });
        if (r.status === 'processed') started++;
        else skipped++;
      }
      logger.info('broadcast_done', { broadcastId, flowId, tag, started, skipped });
      return { started, skipped };
    },
    cleanupContacts({ inactiveDays, keepTags = [], tenantId, dryRun = true }) {
      if (!Number.isFinite(inactiveDays) || inactiveDays < 1) throw new Error('inactiveDays deve ser >= 1');
      const cutoff = (opts.clock?.() ?? new Date()).getTime() - inactiveDays * 86_400_000;
      const removed: string[] = [];
      let kept = 0;
      for (const c of opts.storage.listContacts({ limit: 1_000_000 })) {
        if (tenantId && !c.conversationId.startsWith(`${tenantId}:`)) continue;
        const session = opts.storage.getSession(c.conversationId);
        const lastSeen = Date.parse(String(c.fields.last_seen_at ?? session?.updatedAt ?? ''));
        const busy = session && session.status !== 'ended';
        // Sem data conhecida -> mantém (conservador); etiqueta protegida ou conversa ativa -> mantém.
        if (busy || Number.isNaN(lastSeen) || lastSeen >= cutoff || keepTags.some((t) => c.tags.includes(t))) {
          kept++;
          continue;
        }
        removed.push(c.conversationId);
        if (!dryRun) opts.storage.deleteContact(c.conversationId);
      }
      metrics.inc(dryRun ? 'contacts.cleanup_preview' : 'contacts.cleanup_run');
      logger.info('contacts_cleanup', { removed: removed.length, kept, dryRun, inactiveDays, keepTags, tenantId });
      return { removed, kept, dryRun };
    },
    start() {
      dispatcher.start();
      scheduler.start();
      pruneTimer = setInterval(() => opts.storage.pruneProcessedEvents(7 * 24 * 3600 * 1000), 3600_000);
      pruneTimer.unref?.(); // unref não existe no navegador (Studio)
    },
    stop() {
      dispatcher.stop();
      scheduler.stop();
      if (pruneTimer) clearInterval(pruneTimer);
    },
  };
}
