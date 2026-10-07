/**
 * Registro de handlers por tipo de nó.
 * Para criar um tipo novo: implemente NodeHandler, registre aqui e adicione ao validador.
 * O loop do motor NÃO muda (princípio aberto/fechado).
 */
import type { NodeType } from '../types.ts';
import type { NodeHandler } from './types.ts';
import { conditionHandler, endHandler, messageHandler, randomizerHandler, setHandler, subflowHandler } from './basic.ts';
import { inputHandler, routerHandler } from './interactive.ts';
import { handoffHandler, integrationHandler, waitHandler } from './async.ts';

export const handlers: Record<NodeType, NodeHandler<any>> = {
  message: messageHandler,
  input: inputHandler,
  router: routerHandler,
  condition: conditionHandler,
  set: setHandler,
  integration: integrationHandler,
  wait: waitHandler,
  handoff: handoffHandler,
  subflow: subflowHandler,
  end: endHandler,
  randomizer: randomizerHandler,
};

export type { NodeHandler, NodeResult, ExecContext } from './types.ts';
