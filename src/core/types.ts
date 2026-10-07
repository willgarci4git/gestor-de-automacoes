/**
 * Tipos centrais do framework.
 *
 * Regra de ouro: nada neste arquivo conhece WhatsApp, Instagram ou Webchat.
 * O núcleo fala apenas em InboundEvent (entrada normalizada) e Command (efeito a executar).
 */

// ---------------------------------------------------------------------------
// DSL de fluxo (definição declarativa, versionada)
// ---------------------------------------------------------------------------

export type ValidatorSpec =
  | { kind: 'any' }
  | { kind: 'minLength'; value: number }
  | { kind: 'email' }
  | { kind: 'phone' }
  | { kind: 'number'; min?: number; max?: number }
  | { kind: 'date' }
  | { kind: 'cpf' }
  | { kind: 'regex'; pattern: string; flags?: string };

export type ConditionOp = 'eq' | 'neq' | 'contains' | 'gt' | 'gte' | 'lt' | 'lte' | 'exists' | 'notExists' | 'in' | 'hasTag';

export interface ConditionRule {
  var?: string;
  op?: ConditionOp;
  value?: unknown;
  all?: ConditionRule[];
  any?: ConditionRule[];
}

export interface RouterOption {
  id: string;
  label: string;
  /** Palavras/expressões que selecionam esta opção (normalizadas: sem acento, minúsculas). */
  match?: string[];
  next: string;
}

export interface HttpRequestSpec {
  method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  url: string;
  headers?: Record<string, string>;
  body?: unknown;
}

interface BaseNode {
  /** Nó de destino caso o handler lance exceção. Se ausente, usa o fallback global do motor. */
  onError?: string;
}

export interface MessageNode extends BaseNode {
  type: 'message';
  text?: string;
  media?: { kind: 'image' | 'document' | 'audio' | 'video'; url: string; caption?: string; filename?: string };
  /**
   * Modelo aprovado do WhatsApp (obrigatório fora da janela de 24h, ex.: broadcast/lembretes).
   * Outros canais recebem `text` como fallback.
   */
  template?: { name: string; language: string; components?: unknown[] };
  next: string;
}

export interface InputNode extends BaseNode {
  type: 'input';
  prompt: string;
  saveTo: string;
  validator?: ValidatorSpec;
  errorMessage?: string;
  maxAttempts?: number;
  timeoutSec?: number;
  next: string;
  onInvalid?: string;
  onTimeout?: string;
}

export interface RouterNode extends BaseNode {
  type: 'router';
  prompt: string;
  options: RouterOption[];
  display?: 'buttons' | 'list' | 'text';
  /**
   * Não envia o menu ao entrar: apenas aguarda a resposta. Use após um modelo do WhatsApp
   * com botões (cujos payloads sejam os ids das opções) — fora da janela de 24h só modelos são permitidos.
   */
  silent?: boolean;
  saveTo?: string;
  noMatchMessage?: string;
  maxAttempts?: number;
  timeoutSec?: number;
  onExhausted?: string;
  onTimeout?: string;
}

export interface ConditionNode extends BaseNode {
  type: 'condition';
  branches: { when: ConditionRule; next: string }[];
  default: string;
}

export interface SetNode extends BaseNode {
  type: 'set';
  assign?: Record<string, unknown>;
  addTags?: string[];
  removeTags?: string[];
  next: string;
}

export interface IntegrationNode extends BaseNode {
  type: 'integration';
  request: HttpRequestSpec;
  saveTo?: string;
  timeoutMs?: number;
  retry?: { max: number; backoffMs?: number };
  next: string;
  onError: string;
}

export interface WaitNode extends BaseNode {
  type: 'wait';
  seconds: number;
  next: string;
}

/** Teste A/B: sorteia uma variante por peso, grava em session.ab_<nó> e etiqueta ab:<nó>:<variante>. */
export interface RandomizerNode extends BaseNode {
  type: 'randomizer';
  variants: { id: string; weight: number; next: string }[];
}

export interface HandoffNode extends BaseNode {
  type: 'handoff';
  queue: string;
  message?: string;
  /** Variáveis enviadas como contexto ao atendente humano. */
  contextVars?: string[];
  /** Tempo máximo para um humano aceitar o atendimento. */
  slaSec?: number;
  onSlaTimeout?: string;
  /** Para onde o bot volta quando o atendente encerra. Ausente = encerra a sessão. */
  next?: string;
}

export interface SubflowNode extends BaseNode {
  type: 'subflow';
  flowId: string;
  next: string;
}

export interface EndNode extends BaseNode {
  type: 'end';
  message?: string;
}

export type FlowNode =
  | MessageNode
  | InputNode
  | RouterNode
  | ConditionNode
  | SetNode
  | IntegrationNode
  | WaitNode
  | HandoffNode
  | SubflowNode
  | EndNode
  | RandomizerNode;

export type NodeType = FlowNode['type'];

export interface TriggerSpec {
  /**
   * comment = comentário em post/Reel do Instagram (estilo ManyChat).
   * ref = parâmetro de link/campanha: t.me/<bot>?start=<ref>, ig.me/m/<conta>?ref=<ref>,
   *       anúncio "clique para o WhatsApp" (source_id) ou ?ref= no webchat.
   */
  kind: 'keyword' | 'regex' | 'default' | 'comment' | 'ref';
  values?: string[];
  pattern?: string;
  channels?: string[];
  /** Apenas para kind=comment: restringe a publicações específicas. */
  mediaIds?: string[];
  /**
   * Etiquetas de origem aplicadas ao contato quando ESTE gatilho inicia a conversa
   * (curso: "colocar a etiqueta para identificar de qual palavra-chave/campanha a pessoa veio").
   */
  tags?: string[];
}

/**
 * Parametrização por cliente (tenant). Um mesmo fluxo atende N clientes:
 * {{tenant.nome}}, {{tenant.endereco}}, {{tenant.linkAgenda}}...
 */
export interface TenantConfig {
  id: string;
  name?: string;
  params: Record<string, unknown>;
  /** Fluxos que este tenant pode usar como entrada (ausente = todos). */
  flows?: string[];
  timezone?: string;
  /** Faixas por dia da semana (0=domingo) no formato HH:MM, e feriados AAAA-MM-DD. */
  businessHours?: { days: Record<string, [string, string][]>; holidays?: string[] };
}

export interface FlowDefinition {
  id: string;
  version: number;
  name?: string;
  description?: string;
  start: string;
  /**
   * true = fluxo vertical (ex.: atendimento por setor de uma oficina): só serve de ENTRADA para
   * clientes que o listam em tenants/<id>.json → flows. Evita que seus gatilhos genéricos ("oi",
   * default) capturem conversas de clientes sem lista de fluxos.
   */
  optIn?: boolean;
  triggers?: TriggerSpec[];
  /** Intenções globais: palavra -> nó. Avaliadas antes do nó atual (ex.: "atendente", "menu"). */
  globals?: { intents?: Record<string, { match: string[]; goto: string }> };
  nodes: Record<string, FlowNode>;
}

// ---------------------------------------------------------------------------
// Eventos de entrada e comandos de saída (fronteira do núcleo)
// ---------------------------------------------------------------------------

export type InboundKind =
  | 'start'
  | 'text'
  | 'choice'
  | 'media'
  | 'timer'
  | 'integration_result'
  | 'handoff_accepted'
  | 'handoff_closed';

export interface InboundEvent {
  /** Id único do provedor (ou gerado). Base da idempotência. */
  eventId: string;
  tenantId: string;
  channel: string;
  /** Id do usuário no canal (telefone, id do webchat...). */
  userId: string;
  kind: InboundKind;
  text?: string;
  /** Id de opção clicada (botão/lista). */
  optionId?: string;
  media?: { kind: string; url?: string; id?: string };
  /** Dados de eventos internos (timer, integração, handoff). */
  data?: Record<string, unknown>;
  profile?: { name?: string };
  receivedAt?: string;
}

export type OutboundMessage =
  | { kind: 'text'; text: string }
  | { kind: 'choice'; text: string; options: { id: string; label: string }[]; display: 'buttons' | 'list' | 'text' }
  | { kind: 'media'; media: { kind: string; url: string; caption?: string; filename?: string } }
  | { kind: 'template'; text: string; template: { name: string; language: string; components?: unknown[] } };

export interface Address {
  tenantId: string;
  channel: string;
  userId: string;
  conversationId: string;
}

export type Command =
  | { type: 'send'; to: Address; message: OutboundMessage }
  | { type: 'callIntegration'; to: Address; token: string; request: HttpRequestSpec; timeoutMs: number; retry: { max: number; backoffMs: number } }
  | { type: 'schedule'; to: Address; token: string; delaySec: number; reason: 'timeout' | 'wait' | 'sla' }
  | { type: 'handoff'; to: Address; queue: string; context: Record<string, unknown> }
  | { type: 'handoffForward'; to: Address; text: string }
  | { type: 'handoffClose'; to: Address; reason: string }
  | { type: 'emit'; name: string; data: Record<string, unknown> };

// ---------------------------------------------------------------------------
// Sessão e contato
// ---------------------------------------------------------------------------

export type SessionStatus = 'active' | 'waiting_input' | 'waiting_timer' | 'waiting_integration' | 'handoff' | 'ended';

export interface StackFrame {
  flowId: string;
  flowVersion: number;
  returnTo: string;
  /** Variáveis flow.* do fluxo pai, restauradas ao retornar do subfluxo. */
  flowVars: Record<string, unknown>;
}

export interface Session {
  sessionId: string;
  conversationId: string;
  tenantId: string;
  channel: string;
  userId: string;
  flowId: string;
  flowVersion: number;
  currentNodeId: string;
  status: SessionStatus;
  callStack: StackFrame[];
  vars: { session: Record<string, unknown>; flow: Record<string, unknown> };
  attempts: Record<string, number>;
  /** Token do "yield" atual: eventos de timer/integração com token diferente são descartados. */
  waitToken?: string;
  handoffAccepted?: boolean;
  createdAt: string;
  updatedAt: string;
  rev: number;
}

export interface Contact {
  conversationId: string;
  fields: Record<string, unknown>;
  tags: string[];
}
