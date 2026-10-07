import type { VarContext } from '../context.ts';
import type { Address, Command, FlowDefinition, FlowNode, InboundEvent, OutboundMessage, Session } from '../types.ts';

export interface ExecContext<N extends FlowNode = FlowNode> {
  nodeId: string;
  node: N;
  flow: FlowDefinition;
  session: Session;
  vars: VarContext;
  address: Address;
  /** Gera e registra um novo token de espera (invalida timers/integrações anteriores). */
  newWaitToken(): string;
  render(tpl: string): string;
}

export type AwaitKind = 'input' | 'timer' | 'integration' | 'human';

export interface NodeResult {
  commands: Command[];
  /** Transição imediata para outro nó do fluxo corrente. */
  next?: string;
  /** Cede a execução e aguarda um evento. */
  await?: AwaitKind;
  /** Entra em subfluxo; ao terminar, retorna para `next`. */
  subflow?: string;
  /** Encerra o fluxo corrente (ou retorna ao fluxo pai). */
  end?: boolean;
  /** Pede ao motor que aplique o fallback global (ex.: tentativas esgotadas sem rota definida). */
  fallback?: string;
}

export interface NodeHandler<N extends FlowNode = FlowNode> {
  onEnter(ctx: ExecContext<N>): NodeResult;
  /** Chamado quando chega um evento enquanto a sessão está parada neste nó. */
  onEvent?(ctx: ExecContext<N>, ev: InboundEvent): NodeResult;
}

export const send = (to: Address, message: OutboundMessage): Command => ({ type: 'send', to, message });
