/**
 * Nós assíncronos: a execução é devolvida ao motor e retomada por um evento interno
 * (resultado de integração, timer do scheduler ou ação do atendente humano).
 */
import type { HandoffNode, HttpRequestSpec, IntegrationNode, WaitNode } from '../types.ts';
import { renderDeep } from '../context.ts';
import { send, type NodeHandler, type NodeResult } from './types.ts';

export const integrationHandler: NodeHandler<IntegrationNode> = {
  onEnter(ctx) {
    const token = ctx.newWaitToken();
    const request = renderDeep(ctx.node.request, ctx.vars) as HttpRequestSpec;
    return {
      commands: [
        {
          type: 'callIntegration',
          to: ctx.address,
          token,
          request,
          timeoutMs: ctx.node.timeoutMs ?? 8000,
          retry: { max: ctx.node.retry?.max ?? 2, backoffMs: ctx.node.retry?.backoffMs ?? 500 },
        },
      ],
      await: 'integration',
    };
  },

  onEvent(ctx, ev): NodeResult {
    // Mensagens do usuário enquanto a integração roda são ignoradas (a resposta virá em seguida).
    if (ev.kind !== 'integration_result') return { commands: [], await: 'integration' };
    const data = ev.data ?? {};
    if (data.ok) {
      if (ctx.node.saveTo) ctx.vars.set(ctx.node.saveTo, data.body);
      return { commands: [], next: ctx.node.next };
    }
    ctx.vars.set('flow.lastError', { node: ctx.nodeId, status: data.status, error: data.error });
    return { commands: [], next: ctx.node.onError };
  },
};

export const waitHandler: NodeHandler<WaitNode> = {
  onEnter(ctx) {
    const token = ctx.newWaitToken();
    return { commands: [{ type: 'schedule', to: ctx.address, token, delaySec: ctx.node.seconds, reason: 'wait' }], await: 'timer' };
  },
  onEvent(ctx, ev) {
    if (ev.kind === 'timer') return { commands: [], next: ctx.node.next };
    return { commands: [], await: 'timer' };
  },
};

/**
 * Transbordo humano. Após o onEnter, o motor trata a sessão em modo "handoff":
 * mensagens do usuário são encaminhadas ao atendente; `handoff_closed` devolve ao bot (node.next) ou encerra.
 */
export const handoffHandler: NodeHandler<HandoffNode> = {
  onEnter(ctx): NodeResult {
    const node = ctx.node;
    const token = ctx.newWaitToken();
    const context: Record<string, unknown> = {
      flowId: ctx.session.flowId,
      nodeId: ctx.nodeId,
      tags: [...ctx.vars.contact.tags],
    };
    for (const v of node.contextVars ?? []) context[v] = ctx.vars.get(v);
    const commands = [];
    if (node.message) commands.push(send(ctx.address, { kind: 'text', text: ctx.render(node.message) }));
    commands.push({ type: 'handoff' as const, to: ctx.address, queue: node.queue, context });
    if (node.slaSec) commands.push({ type: 'schedule' as const, to: ctx.address, token, delaySec: node.slaSec, reason: 'sla' as const });
    return { commands, await: 'human' };
  },
};
