/**
 * State Engine — interpretador de fluxos declarativos.
 *
 * Ciclo por evento (um "turno"):
 *   1. Idempotência (eventId já processado -> descarta)
 *   2. Carrega sessão/contato (ou resolve gatilho e cria sessão presa à versão atual do fluxo)
 *   3. Descarta eventos internos obsoletos (token de espera diferente)
 *   4. Intents globais ("atendente", "menu"...) têm precedência sobre o nó atual
 *   5. Entrega o evento ao nó atual e avança pelo grafo até um ponto de espera
 *   6. Commit ATÔMICO: sessão + contato + evento + comandos (Transactional Outbox)
 *
 * O motor é síncrono e determinístico dentro do turno: nenhum I/O de rede acontece aqui.
 */
import { randomUUID } from 'node:crypto';
import type { Address, Command, Contact, FlowDefinition, InboundEvent, OutboundMessage, Session, TenantConfig, TriggerSpec } from './types.ts';
import { TenantRegistry, greetingFor, isBusinessHours, zonedParts } from './tenants.ts';
import type { Storage } from '../storage/types.ts';
import { ConflictError } from '../storage/types.ts';
import { FlowRegistry } from './registry.ts';
import { VarContext, renderTemplate } from './context.ts';
import { handlers, type ExecContext, type NodeResult } from './nodes/index.ts';
import { KeyedMutex } from './keyed-mutex.ts';
import { matchesAny, normalize } from './text.ts';
import { Metrics, silentLogger, type Logger } from './observability.ts';

export interface EngineConfig {
  /** Máximo de nós executados num único turno (proteção contra loop). */
  maxStepsPerTurn: number;
  /** Após este tempo sem interação, a próxima mensagem inicia nova sessão. */
  sessionTtlSec: number;
  timezone: string;
  fallback: { message: string; handoffQueue?: string };
  /** Opt-out (LGPD): termos EXATOS que silenciam o bot para o contato, e termos que reativam. */
  optOut: { match: string[]; resume: string[]; message: string; resumeMessage?: string };
  /**
   * Resposta a comentário (Instagram) é uma *private reply* ÚNICA por comentário: as mensagens
   * do primeiro turno são aglutinadas numa só (textos unidos; botões da última escolha preservados).
   */
  commentSingleReply: boolean;
}

export const DEFAULT_ENGINE_CONFIG: EngineConfig = {
  maxStepsPerTurn: 25,
  sessionTtlSec: 24 * 3600,
  timezone: 'America/Sao_Paulo',
  fallback: { message: 'Desculpe, tive um problema por aqui. Vou te encaminhar para nossa equipe.', handoffQueue: 'geral' },
  optOut: {
    match: ['parar', 'descadastrar', 'nao quero mais receber', 'stop'],
    resume: ['voltar', 'reativar'],
    message: 'Pronto, você não receberá mais mensagens automáticas. Se mudar de ideia, envie "voltar".',
  },
  commentSingleReply: true,
};

/**
 * Aglutina todos os `send` de um turno numa única mensagem, na posição do primeiro envio.
 * Mídia vira linha com legenda + link; modelo vira o texto de fallback. Demais comandos ficam intactos.
 */
export function coalesceSends(commands: Command[]): Command[] {
  const sends = commands.filter((c): c is Extract<Command, { type: 'send' }> => c.type === 'send');
  if (sends.length <= 1) return commands;
  const parts: string[] = [];
  let choice: Extract<OutboundMessage, { kind: 'choice' }> | undefined;
  for (const { message: m } of sends) {
    if (m.kind === 'media') parts.push([m.media.caption, m.media.url].filter(Boolean).join('\n'));
    else parts.push(m.text);
    if (m.kind === 'choice') choice = m;
  }
  const text = parts.filter((p) => p.trim()).join('\n\n');
  const merged: Command = {
    type: 'send',
    to: sends[0].to,
    message: choice ? { kind: 'choice', text, options: choice.options, display: choice.display } : { kind: 'text', text },
  };
  const first = commands.indexOf(sends[0]);
  return commands.flatMap((c, i): Command[] => (i === first ? [merged] : c.type === 'send' ? [] : [c]));
}

/** Pseudo-fluxo para sessões encerradas por ações de sistema (ex.: opt-out sem sessão prévia). */
const SYSTEM_FLOW: FlowDefinition = { id: '__system', version: 0, start: '__none', nodes: {} };

export interface HandleResult {
  status: 'processed' | 'duplicate' | 'ignored';
  reason?: string;
  conversationId: string;
  commands: Command[];
  session?: Session;
}

export interface EngineDeps {
  registry: FlowRegistry;
  storage: Storage;
  logger?: Logger;
  metrics?: Metrics;
  config?: Partial<EngineConfig>;
  clock?: () => Date;
  tenants?: TenantRegistry;
}

const USER_KINDS = new Set(['text', 'choice', 'media']);
const AWAIT_STATUS = { input: 'waiting_input', timer: 'waiting_timer', integration: 'waiting_integration', human: 'handoff' } as const;

export function conversationIdOf(ev: Pick<InboundEvent, 'tenantId' | 'channel' | 'userId'>): string {
  return `${ev.tenantId}:${ev.channel}:${ev.userId}`;
}

/** Estado mutável de um turno em execução. */
interface Turn {
  ev: InboundEvent;
  session: Session;
  contact: Contact;
  flow: FlowDefinition;
  tenant: TenantConfig;
  address: Address;
  commands: Command[];
  steps: number;
}

export class StateEngine {
  readonly registry: FlowRegistry;
  readonly storage: Storage;
  readonly logger: Logger;
  readonly metrics: Metrics;
  readonly config: EngineConfig;
  readonly tenants: TenantRegistry;
  private readonly clock: () => Date;
  private readonly mutex = new KeyedMutex();
  /** Hook chamado após cada commit (ex.: acordar o dispatcher da outbox). */
  onCommit?: () => void;

  constructor(deps: EngineDeps) {
    this.registry = deps.registry;
    this.storage = deps.storage;
    this.logger = deps.logger ?? silentLogger;
    this.metrics = deps.metrics ?? new Metrics();
    this.config = { ...DEFAULT_ENGINE_CONFIG, ...deps.config };
    this.tenants = deps.tenants ?? new TenantRegistry();
    this.clock = deps.clock ?? (() => new Date());
  }

  async handle(ev: InboundEvent): Promise<HandleResult> {
    const conversationId = conversationIdOf(ev);
    return this.mutex.run(conversationId, async () => {
      const started = performance.now();
      for (let attempt = 1; ; attempt++) {
        try {
          const r = this.processTurn(ev, conversationId);
          this.metrics.inc(`engine.events.${r.status}`);
          this.metrics.observe('engine.turn_ms', performance.now() - started);
          if (r.status === 'processed') this.onCommit?.();
          return r;
        } catch (err) {
          if (err instanceof ConflictError && attempt < 3) {
            this.metrics.inc('engine.conflict_retries');
            continue;
          }
          this.metrics.inc('engine.errors');
          this.logger.error('turn_failed', { conversationId, eventId: ev.eventId, error: String(err) });
          throw err;
        }
      }
    });
  }

  // -------------------------------------------------------------------------

  private processTurn(ev: InboundEvent, conversationId: string): HandleResult {
    if (this.storage.hasProcessedEvent(ev.eventId)) {
      return { status: 'duplicate', conversationId, commands: [] };
    }
    const stored = this.storage.getSession(conversationId);
    const expectedRev = stored?.rev ?? 0;
    const contact: Contact = this.storage.getContact(conversationId) ?? { conversationId, fields: {}, tags: [] };
    if (ev.profile?.name && !contact.fields.name) {
      contact.fields.name = ev.profile.name;
      contact.fields.first_name = ev.profile.name.split(/\s+/)[0];
    }
    const address: Address = { tenantId: ev.tenantId, channel: ev.channel, userId: ev.userId, conversationId };
    const tenant = this.tenants.get(ev.tenantId);
    const isUser = USER_KINDS.has(ev.kind);
    const isComment = ev.data?.source === 'comment';
    const ignored = (reason: string): HandleResult => {
      this.logger.debug('event_ignored', { conversationId, eventId: ev.eventId, reason });
      return { status: 'ignored', reason, conversationId, commands: [] };
    };
    const exact = (terms: string[]) => !!ev.text && terms.some((t) => normalize(t) === normalize(ev.text!));
    const commit = (turn: Turn): HandleResult => {
      const s = turn.session;
      if (isComment && this.config.commentSingleReply) {
        const before = turn.commands.filter((c) => c.type === 'send').length;
        turn.commands = coalesceSends(turn.commands);
        if (before > 1) this.metrics.inc('engine.comment_replies_coalesced');
      }
      if (isUser) contact.fields.last_seen_at = this.clock().toISOString();
      s.rev = expectedRev + 1;
      s.updatedAt = this.clock().toISOString();
      this.storage.commitTurn({ session: s, expectedRev, contact: turn.contact, eventId: ev.eventId, commands: turn.commands });
      return { status: 'processed', conversationId, commands: turn.commands, session: s };
    };

    // --- Opt-out (LGPD): tem precedência sobre qualquer fluxo --------------------------------
    if (isUser && !isComment && exact(this.config.optOut.match)) {
      const session = stored ?? this.newSession(conversationId, ev, SYSTEM_FLOW, expectedRev);
      const turn: Turn = { ev, session, contact, flow: SYSTEM_FLOW, tenant, address, commands: [], steps: 0 };
      if (stored?.status === 'handoff') turn.commands.push({ type: 'handoffClose', to: address, reason: 'opt_out' });
      turn.commands.push({ type: 'send', to: address, message: { kind: 'text', text: this.config.optOut.message } });
      contact.fields.opted_out = true;
      contact.fields.opted_out_at = this.clock().toISOString();
      Object.assign(session, { status: 'ended', callStack: [], waitToken: undefined });
      this.metrics.inc('engine.opt_out');
      this.logger.info('opt_out', { conversationId });
      return commit(turn);
    }
    let restart = false;
    if (contact.fields.opted_out) {
      if (!(isUser && !isComment && exact(this.config.optOut.resume))) return ignored('opted_out');
      delete contact.fields.opted_out;
      delete contact.fields.opted_out_at;
      restart = true;
      this.metrics.inc('engine.opt_in');
    }

    let turn: Turn;
    const expired =
      stored && isUser && stored.status !== 'ended' && stored.status !== 'handoff' &&
      this.clock().getTime() - Date.parse(stored.updatedAt) > this.config.sessionTtlSec * 1000;
    const active = stored && stored.status !== 'ended';

    if (ev.kind === 'start' && active && !ev.data?.force) return ignored('session_active');
    if (isComment && stored?.status === 'handoff') return ignored('comment_during_handoff');

    // Clique num link de campanha (ref) reinicia a automação, como o "reiniciar automação" do curso —
    // exceto durante atendimento humano.
    const refRestart =
      isUser && !!active && stored!.status !== 'handoff' && typeof ev.data?.ref === 'string' &&
      this.registry.resolveTriggerMatch(ev, tenant.flows)?.trigger.kind === 'ref';
    if (refRestart) this.metrics.inc('engine.ref_restarts');

    if (!stored || stored.status === 'ended' || expired || restart || isComment || refRestart || ev.kind === 'start') {
      if (!isUser && ev.kind !== 'start') return ignored('internal_event_without_session');
      let flow: FlowDefinition | undefined;
      let trigger: TriggerSpec | undefined;
      if (ev.kind === 'start') {
        const id = String(ev.data?.flowId ?? '');
        if (tenant.flows && !tenant.flows.includes(id)) return ignored('flow_not_allowed_for_tenant');
        flow = this.registry.latest(id);
      } else {
        const match = this.registry.resolveTriggerMatch(ev, tenant.flows);
        flow = match?.flow;
        trigger = match?.trigger;
      }
      if (!flow) return ignored(isComment ? 'comment_without_trigger' : 'no_flow_for_trigger');
      // Etiquetas de origem do gatilho (campanha, palavra-chave, link, comentário).
      for (const tag of trigger?.tags ?? []) if (!contact.tags.includes(tag)) contact.tags.push(tag);
      if (trigger) this.metrics.inc(`engine.trigger.${trigger.kind}`);
      if (expired) this.metrics.inc('engine.sessions_expired');
      if (active && stored!.status === 'handoff') this.logger.warn('session_replaced_during_handoff', { conversationId });
      const session = this.newSession(conversationId, ev, flow, expectedRev);
      if (ev.kind === 'start' && ev.data?.vars && typeof ev.data.vars === 'object') Object.assign(session.vars.session, ev.data.vars);
      if (typeof ev.data?.ref === 'string' && ev.data.ref) session.vars.session.ref = ev.data.ref;
      turn = { ev, session, contact, flow, tenant, address, commands: [], steps: 0 };
      if (restart && this.config.optOut.resumeMessage) {
        turn.commands.push({ type: 'send', to: address, message: { kind: 'text', text: this.config.optOut.resumeMessage } });
      }
      this.metrics.inc('engine.sessions_started');
      this.logger.info('session_started', { conversationId, flow: `${flow.id}@${flow.version}`, eventId: ev.eventId, via: ev.kind === 'start' ? 'proactive' : isComment ? 'comment' : 'trigger' });
      this.enter(turn, flow.start);
    } else {
      const flow = this.registry.get(stored.flowId, stored.flowVersion);
      turn = { ev, session: stored, contact, flow: flow!, tenant, address, commands: [], steps: 0 };
      if (!flow) {
        this.logger.error('flow_version_missing', { conversationId, flow: `${stored.flowId}@${stored.flowVersion}` });
        this.fallback(turn, 'flow_version_missing');
      } else {
        const internal = ev.kind === 'timer' || ev.kind === 'integration_result';
        if (internal && ev.data?.token !== stored.waitToken) return ignored('stale_token');
        if (stored.status === 'handoff') {
          const r = this.handleHandoffEvent(turn);
          if (r === 'ignored') return ignored('handoff_noop');
        } else if (!(isUser && this.tryGlobalIntent(turn))) {
          const node = flow.nodes[stored.currentNodeId];
          const handler = node && handlers[node.type];
          if (!handler?.onEvent) return ignored('node_not_waiting');
          const result = this.safe(turn, stored.currentNodeId, () => handler.onEvent!(this.ctx(turn, stored.currentNodeId), ev));
          this.apply(turn, result);
        }
      }
    }

    return commit(turn);
  }

  private newSession(conversationId: string, ev: InboundEvent, flow: FlowDefinition, rev: number): Session {
    const now = this.clock().toISOString();
    return {
      sessionId: randomUUID(),
      conversationId,
      tenantId: ev.tenantId,
      channel: ev.channel,
      userId: ev.userId,
      flowId: flow.id,
      flowVersion: flow.version,
      currentNodeId: flow.start,
      status: 'active',
      callStack: [],
      vars: { session: { firstMessage: ev.text ?? null }, flow: {} },
      attempts: {},
      createdAt: now,
      updatedAt: now,
      rev,
    };
  }

  private systemVars(turn: Turn): Record<string, unknown> {
    const now = this.clock();
    const z = zonedParts(now, turn.tenant.timezone ?? this.config.timezone);
    return {
      channel: turn.address.channel,
      userId: turn.address.userId,
      tenantId: turn.address.tenantId,
      now: now.toISOString(),
      date: z.date,
      time: z.time,
      hour: z.hour,
      weekday: z.weekday,
      greeting: greetingFor(z.hour),
      /** null quando o tenant não configurou businessHours */
      inBusinessHours: isBusinessHours(turn.tenant, now, this.config.timezone),
      lastMessage: turn.ev.text ?? null,
    };
  }

  private ctx(turn: Turn, nodeId: string): ExecContext {
    const vars = new VarContext(turn.session, turn.contact, this.systemVars(turn), turn.tenant.params);
    return {
      nodeId,
      node: turn.flow.nodes[nodeId],
      flow: turn.flow,
      session: turn.session,
      vars,
      address: turn.address,
      newWaitToken: () => (turn.session.waitToken = randomUUID()),
      render: (tpl) => renderTemplate(tpl, vars),
    };
  }

  /** Executa o handler protegendo o motor: exceção -> onError do nó -> fallback global. */
  private safe(turn: Turn, nodeId: string, fn: () => NodeResult): NodeResult {
    try {
      return fn();
    } catch (err) {
      this.metrics.inc('engine.node_errors');
      this.logger.error('node_error', { conversationId: turn.address.conversationId, flow: `${turn.flow.id}@${turn.flow.version}`, nodeId, error: String(err) });
      const onError = turn.flow.nodes[nodeId]?.onError;
      return onError ? { commands: [], next: onError } : { commands: [], fallback: 'node_error' };
    }
  }

  private enter(turn: Turn, nodeId: string): void {
    turn.steps++;
    if (turn.steps > this.config.maxStepsPerTurn) {
      this.logger.error('loop_guard_triggered', { conversationId: turn.address.conversationId, flow: turn.flow.id, nodeId });
      return this.fallback(turn, 'loop_guard');
    }
    const node = turn.flow.nodes[nodeId];
    if (!node) return this.fallback(turn, 'node_missing');
    const s = turn.session;
    s.currentNodeId = nodeId;
    s.status = 'active';
    s.waitToken = undefined; // sair de um ponto de espera invalida timers/integrações anteriores
    this.metrics.inc(`nodes.${node.type}`);
    this.logger.debug('node_enter', { conversationId: s.conversationId, flow: `${turn.flow.id}@${turn.flow.version}`, nodeId, eventId: turn.ev.eventId });
    const result = this.safe(turn, nodeId, () => handlers[node.type].onEnter(this.ctx(turn, nodeId)));
    this.apply(turn, result);
  }

  private apply(turn: Turn, r: NodeResult): void {
    turn.commands.push(...r.commands);
    const s = turn.session;
    if (r.fallback) return this.fallback(turn, r.fallback);
    if (r.subflow) {
      const child = this.registry.latest(r.subflow);
      if (!child) return this.fallback(turn, 'subflow_missing');
      s.callStack.push({ flowId: s.flowId, flowVersion: s.flowVersion, returnTo: r.next!, flowVars: s.vars.flow });
      s.flowId = child.id;
      s.flowVersion = child.version;
      s.vars.flow = {};
      turn.flow = child;
      return this.enter(turn, child.start);
    }
    if (r.end) {
      const frame = s.callStack.pop();
      if (frame) {
        const parent = this.registry.get(frame.flowId, frame.flowVersion);
        if (!parent) return this.fallback(turn, 'parent_flow_missing');
        s.flowId = parent.id;
        s.flowVersion = parent.version;
        s.vars.flow = frame.flowVars;
        turn.flow = parent;
        return this.enter(turn, frame.returnTo);
      }
      s.status = 'ended';
      s.waitToken = undefined;
      this.metrics.inc('engine.sessions_ended');
      this.logger.info('session_ended', { conversationId: s.conversationId, flow: `${turn.flow.id}@${turn.flow.version}`, nodeId: s.currentNodeId });
      return;
    }
    if (r.await) {
      s.status = AWAIT_STATUS[r.await];
      if (r.await === 'human') {
        s.handoffAccepted = false;
        this.metrics.inc('engine.handoffs');
      }
      return;
    }
    if (r.next) return this.enter(turn, r.next);
    this.fallback(turn, 'no_transition');
  }

  /** Fallback global: mensagem amigável + transbordo humano (ou encerramento). */
  private fallback(turn: Turn, reason: string): void {
    const s = turn.session;
    this.metrics.inc(`engine.fallback.${reason}`);
    this.logger.warn('fallback', { conversationId: s.conversationId, reason, nodeId: s.currentNodeId });
    const { message, handoffQueue } = this.config.fallback;
    turn.commands.push({ type: 'send', to: turn.address, message: { kind: 'text', text: message } });
    s.callStack = [];
    s.waitToken = undefined;
    if (handoffQueue) {
      turn.commands.push({ type: 'handoff', to: turn.address, queue: handoffQueue, context: { reason, flowId: s.flowId, nodeId: s.currentNodeId } });
      s.status = 'handoff';
      s.handoffAccepted = false;
      s.vars.session.__fallback = reason;
      this.metrics.inc('engine.handoffs');
    } else {
      s.status = 'ended';
    }
  }

  private tryGlobalIntent(turn: Turn): boolean {
    const text = turn.ev.text;
    if (!text) return false;
    const s = turn.session;
    // Em perguntas de texto livre (ex.: nome), só casamento EXATO: evita que "Maria Pessoa"
    // dispare a intent "pessoa". Nos demais nós, casamento por palavra/variação.
    const strict = turn.flow.nodes[s.currentNodeId]?.type === 'input';
    const hits = (terms: string[]) => (strict ? terms.some((t) => normalize(t) === normalize(text)) : matchesAny(text, terms));
    const check = (flow: FlowDefinition | undefined) =>
      Object.entries(flow?.globals?.intents ?? {}).find(([, i]) => hits(i.match));

    const local = check(turn.flow);
    if (local) {
      this.logger.info('global_intent', { conversationId: s.conversationId, intent: local[0], scope: 'local' });
      this.metrics.inc('engine.global_intents');
      this.enter(turn, local[1].goto);
      return true;
    }
    const rootFrame = s.callStack[0];
    if (!rootFrame) return false;
    const root = this.registry.get(rootFrame.flowId, rootFrame.flowVersion);
    const hit = check(root);
    if (!hit || !root) return false;
    this.logger.info('global_intent', { conversationId: s.conversationId, intent: hit[0], scope: 'root' });
    this.metrics.inc('engine.global_intents');
    s.flowId = root.id;
    s.flowVersion = root.version;
    s.vars.flow = rootFrame.flowVars;
    s.callStack = [];
    turn.flow = root;
    this.enter(turn, hit[1].goto);
    return true;
  }

  /** Sessão em atendimento humano: o bot só roteia mensagens e reage ao encerramento. */
  private handleHandoffEvent(turn: Turn): 'handled' | 'ignored' {
    const { ev, session: s } = turn;
    const node = turn.flow.nodes[s.currentNodeId];
    const handoffNode = node?.type === 'handoff' && !s.vars.session.__fallback ? node : undefined;
    switch (ev.kind) {
      case 'text':
      case 'choice':
      case 'media':
        turn.commands.push({ type: 'handoffForward', to: turn.address, text: ev.text ?? (ev.media ? `[${ev.media.kind}]` : '') });
        return 'handled';
      case 'handoff_accepted':
        s.handoffAccepted = true;
        return 'handled';
      case 'timer':
        if (s.handoffAccepted || !handoffNode?.onSlaTimeout) return 'ignored';
        this.metrics.inc('engine.handoff_sla_expired');
        turn.commands.push({ type: 'handoffClose', to: turn.address, reason: 'sla_expired' });
        this.enter(turn, handoffNode.onSlaTimeout);
        return 'handled';
      case 'handoff_closed':
        s.handoffAccepted = false;
        delete s.vars.session.__fallback;
        if (handoffNode?.next) this.enter(turn, handoffNode.next);
        else this.apply(turn, { commands: [], end: true });
        return 'handled';
      default:
        return 'ignored';
    }
  }
}
