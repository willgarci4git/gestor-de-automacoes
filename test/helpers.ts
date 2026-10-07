import { randomUUID } from 'node:crypto';
import { StateEngine, type EngineConfig } from '../src/core/engine.ts';
import { FlowRegistry } from '../src/core/registry.ts';
import { MemoryStorage } from '../src/storage/memory.ts';
import type { Command, FlowDefinition, InboundEvent, Session, TenantConfig } from '../src/core/types.ts';
import { TenantRegistry } from '../src/core/tenants.ts';
import type { Storage } from '../src/storage/types.ts';

/** Segunda-feira, 10h em São Paulo (horário comercial). */
export const BUSINESS_HOURS = new Date('2026-09-28T13:00:00Z');

export function makeEngine(flows: FlowDefinition[], opts: { config?: Partial<EngineConfig>; storage?: Storage; now?: () => Date; tenants?: TenantConfig[] } = {}) {
  const registry = new FlowRegistry();
  registry.publish(...flows);
  const storage = opts.storage ?? new MemoryStorage();
  let now = opts.now ?? (() => BUSINESS_HOURS);
  const tenants = new TenantRegistry();
  for (const t of opts.tenants ?? []) tenants.set(t);
  const engine = new StateEngine({ registry, storage, config: opts.config, clock: () => now(), tenants });
  const user = 'u1';
  const base = { tenantId: 't1', channel: 'webchat', userId: user };
  const conv = `t1:webchat:${user}`;
  return {
    engine,
    registry,
    storage,
    conv,
    setNow(fn: () => Date) {
      now = fn;
    },
    say: (text: string, extra: Partial<InboundEvent> = {}) => engine.handle({ ...base, eventId: randomUUID(), kind: 'text', text, ...extra }),
    click: (optionId: string) => engine.handle({ ...base, eventId: randomUUID(), kind: 'choice', optionId }),
    internal: (kind: InboundEvent['kind'], data: Record<string, unknown> = {}) =>
      engine.handle({ ...base, eventId: randomUUID(), kind, data }),
    session: (): Session => storage.getSession(conv)!,
  };
}

/** Extrai os textos enviados ao usuário de uma lista de comandos. */
export function texts(commands: Command[]): string[] {
  return commands.flatMap((c) => (c.type === 'send' ? [c.message.kind === 'media' ? `[media ${c.message.media.url}]` : c.message.text] : []));
}

export function commandOf<T extends Command['type']>(commands: Command[], type: T): Extract<Command, { type: T }> | undefined {
  return commands.find((c) => c.type === type) as Extract<Command, { type: T }> | undefined;
}

export const flow = (partial: Partial<FlowDefinition> & { nodes: FlowDefinition['nodes'] }): FlowDefinition => ({
  id: 'f',
  version: 1,
  start: Object.keys(partial.nodes)[0],
  triggers: [{ kind: 'default' }],
  ...partial,
});
