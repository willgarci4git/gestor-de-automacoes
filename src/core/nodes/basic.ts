/** Nós síncronos: executam e transitam imediatamente. */
import type { ConditionNode, ConditionRule, EndNode, MessageNode, RandomizerNode, SetNode, SubflowNode } from '../types.ts';
import { renderDeep, type VarContext } from '../context.ts';
import { normalize } from '../text.ts';
import { send, type NodeHandler } from './types.ts';

export const messageHandler: NodeHandler<MessageNode> = {
  onEnter(ctx) {
    const commands = [];
    if (ctx.node.template) {
      const t = ctx.node.template;
      commands.push(send(ctx.address, { kind: 'template', text: ctx.render(ctx.node.text ?? ''), template: { ...t, components: t.components ? (renderDeep(t.components, ctx.vars) as unknown[]) : undefined } }));
      return { commands, next: ctx.node.next };
    }
    if (ctx.node.text) commands.push(send(ctx.address, { kind: 'text', text: ctx.render(ctx.node.text) }));
    if (ctx.node.media) {
      const m = ctx.node.media;
      commands.push(
        send(ctx.address, {
          kind: 'media',
          media: { kind: m.kind, url: ctx.render(m.url), caption: m.caption ? ctx.render(m.caption) : undefined, filename: m.filename },
        }),
      );
    }
    return { commands, next: ctx.node.next };
  },
};

export const setHandler: NodeHandler<SetNode> = {
  onEnter(ctx) {
    for (const [path, value] of Object.entries(ctx.node.assign ?? {})) ctx.vars.set(path, renderDeep(value, ctx.vars));
    if (ctx.node.addTags) ctx.vars.addTags(ctx.node.addTags);
    if (ctx.node.removeTags) ctx.vars.removeTags(ctx.node.removeTags);
    return { commands: [], next: ctx.node.next };
  },
};

function toComparable(v: unknown): unknown {
  return typeof v === 'string' ? normalize(v) : v;
}

export function evaluateRule(rule: ConditionRule, vars: VarContext): boolean {
  if (rule.all) return rule.all.every((r) => evaluateRule(r, vars));
  if (rule.any) return rule.any.some((r) => evaluateRule(r, vars));
  if (rule.op === 'hasTag') return vars.contact.tags.includes(String(rule.value));
  const actual = rule.var ? vars.get(rule.var) : undefined;
  const expected = renderDeep(rule.value, vars);
  switch (rule.op ?? 'eq') {
    case 'exists':
      return actual !== undefined && actual !== null && actual !== '';
    case 'notExists':
      return actual === undefined || actual === null || actual === '';
    case 'eq':
      return toComparable(actual) === toComparable(expected);
    case 'neq':
      return toComparable(actual) !== toComparable(expected);
    case 'contains':
      if (Array.isArray(actual)) return actual.map(toComparable).includes(toComparable(expected));
      return typeof actual === 'string' && normalize(actual).includes(normalize(String(expected)));
    case 'in':
      return Array.isArray(expected) && expected.map(toComparable).includes(toComparable(actual));
    case 'gt':
      return Number(actual) > Number(expected);
    case 'gte':
      return Number(actual) >= Number(expected);
    case 'lt':
      return Number(actual) < Number(expected);
    case 'lte':
      return Number(actual) <= Number(expected);
    default:
      return false;
  }
}

export const conditionHandler: NodeHandler<ConditionNode> = {
  onEnter(ctx) {
    const hit = ctx.node.branches.find((b) => evaluateRule(b.when, ctx.vars));
    return { commands: [], next: hit ? hit.next : ctx.node.default };
  },
};

export const subflowHandler: NodeHandler<SubflowNode> = {
  onEnter(ctx) {
    return { commands: [], subflow: ctx.node.flowId, next: ctx.node.next };
  },
};

export const endHandler: NodeHandler<EndNode> = {
  onEnter(ctx) {
    const commands = ctx.node.message ? [send(ctx.address, { kind: 'text', text: ctx.render(ctx.node.message) })] : [];
    return { commands, end: true };
  },
};

/** Sorteio ponderado. `random` é injetável para testes determinísticos. */
export function pickVariant<T extends { weight: number }>(variants: T[], random: () => number = Math.random): T {
  const total = variants.reduce((a, v) => a + Math.max(0, v.weight), 0);
  let r = random() * total;
  for (const v of variants) {
    r -= Math.max(0, v.weight);
    if (r < 0) return v;
  }
  return variants.filter((v) => v.weight > 0).at(-1) ?? variants[0];
}

export const randomizerHandler: NodeHandler<RandomizerNode> = {
  onEnter(ctx) {
    const v = pickVariant(ctx.node.variants);
    ctx.vars.set(`session.ab_${ctx.nodeId}`, v.id);
    ctx.vars.addTags([`ab:${ctx.nodeId}:${v.id}`]);
    return {
      commands: [{ type: 'emit', name: 'randomizer', data: { flowId: ctx.session.flowId, nodeId: ctx.nodeId, variant: v.id } }],
      next: v.next,
    };
  },
};
