/** Nós que aguardam resposta do usuário: input (pergunta livre) e router (menu de opções). */
import type { Command, InboundEvent, InputNode, RouterNode, RouterOption } from '../types.ts';
import { validateAnswer } from '../input-validators.ts';
import { matchesAny, normalize } from '../text.ts';
import { send, type ExecContext, type NodeHandler, type NodeResult } from './types.ts';

const DEFAULT_MAX_ATTEMPTS = 3;

function attemptKey(ctx: ExecContext): string {
  return `${ctx.session.flowId}:${ctx.nodeId}`;
}

function bumpAttempts(ctx: ExecContext): number {
  const k = attemptKey(ctx);
  ctx.session.attempts[k] = (ctx.session.attempts[k] ?? 0) + 1;
  return ctx.session.attempts[k];
}

function resetAttempts(ctx: ExecContext): void {
  delete ctx.session.attempts[attemptKey(ctx)];
}

function scheduleTimeout(ctx: ExecContext, timeoutSec: number | undefined, token: string): Command[] {
  return timeoutSec ? [{ type: 'schedule', to: ctx.address, token, delaySec: timeoutSec, reason: 'timeout' }] : [];
}

function isTimer(ev: InboundEvent): boolean {
  return ev.kind === 'timer';
}

// ---------------------------------------------------------------------------

export const inputHandler: NodeHandler<InputNode> = {
  onEnter(ctx) {
    resetAttempts(ctx);
    const token = ctx.newWaitToken();
    return {
      commands: [send(ctx.address, { kind: 'text', text: ctx.render(ctx.node.prompt) }), ...scheduleTimeout(ctx, ctx.node.timeoutSec, token)],
      await: 'input',
    };
  },

  onEvent(ctx, ev): NodeResult {
    const node = ctx.node;
    if (isTimer(ev)) return { commands: [], next: node.onTimeout };

    let value: unknown;
    let ok = false;
    if (ev.kind === 'media') {
      ok = (node.validator?.kind ?? 'any') === 'any';
      value = ev.media;
    } else {
      const outcome = validateAnswer(node.validator, ev.text ?? '');
      ok = outcome.ok;
      if (outcome.ok) value = outcome.value;
    }

    if (ok) {
      ctx.vars.set(node.saveTo, value);
      resetAttempts(ctx);
      return { commands: [], next: node.next };
    }

    const attempts = bumpAttempts(ctx);
    if (attempts >= (node.maxAttempts ?? DEFAULT_MAX_ATTEMPTS)) {
      resetAttempts(ctx);
      return node.onInvalid ? { commands: [], next: node.onInvalid } : { commands: [], fallback: 'input_attempts_exhausted' };
    }
    const msg = node.errorMessage ? ctx.render(node.errorMessage) : `Não consegui entender. ${ctx.render(node.prompt)}`;
    return { commands: [send(ctx.address, { kind: 'text', text: msg })], await: 'input' };
  },
};

// ---------------------------------------------------------------------------

/** Encontra a opção escolhida: id do botão, número digitado, rótulo ou termos de "match". */
export function pickOption(options: RouterOption[], ev: InboundEvent): RouterOption | undefined {
  if (ev.optionId) {
    const byId = options.find((o) => o.id === ev.optionId);
    if (byId) return byId;
  }
  const text = ev.text ?? '';
  const n = normalize(text);
  if (!n) return undefined;
  if (/^\d+$/.test(n)) {
    const idx = Number(n) - 1;
    const byExplicit = options.find((o) => o.match?.some((m) => normalize(m) === n));
    if (byExplicit) return byExplicit;
    if (idx >= 0 && idx < options.length) return options[idx];
  }
  // Correspondência exata do rótulo tem prioridade sobre termos parciais.
  const exact = options.find((o) => normalize(o.label) === n || o.match?.some((m) => normalize(m) === n));
  if (exact) return exact;
  const hits = options.filter((o) => matchesAny(text, [...(o.match ?? []), o.label]));
  return hits.length === 1 ? hits[0] : hits.find((o) => matchesAny(text, o.match));
}

function choiceMessage(ctx: ExecContext<RouterNode>, prefix?: string): Command {
  const text = (prefix ? prefix + '\n' : '') + ctx.render(ctx.node.prompt);
  return send(ctx.address, {
    kind: 'choice',
    text,
    options: ctx.node.options.map((o) => ({ id: o.id, label: ctx.render(o.label) })),
    display: ctx.node.display ?? 'buttons',
  });
}

export const routerHandler: NodeHandler<RouterNode> = {
  onEnter(ctx) {
    resetAttempts(ctx);
    const token = ctx.newWaitToken();
    const prompt = ctx.node.silent ? [] : [choiceMessage(ctx)];
    return { commands: [...prompt, ...scheduleTimeout(ctx, ctx.node.timeoutSec, token)], await: 'input' };
  },

  onEvent(ctx, ev): NodeResult {
    const node = ctx.node;
    if (isTimer(ev)) return { commands: [], next: node.onTimeout };
    const opt = pickOption(node.options, ev);
    if (opt) {
      if (node.saveTo) ctx.vars.set(node.saveTo, opt.id);
      resetAttempts(ctx);
      return { commands: [], next: opt.next };
    }
    const attempts = bumpAttempts(ctx);
    if (attempts >= (node.maxAttempts ?? DEFAULT_MAX_ATTEMPTS)) {
      resetAttempts(ctx);
      return node.onExhausted ? { commands: [], next: node.onExhausted } : { commands: [], fallback: 'router_attempts_exhausted' };
    }
    const prefix = node.noMatchMessage ? ctx.render(node.noMatchMessage) : 'Não encontrei essa opção. Escolha uma das alternativas:';
    return { commands: [choiceMessage(ctx, prefix)], await: 'input' };
  },
};
