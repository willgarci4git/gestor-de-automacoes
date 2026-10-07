/**
 * Registro de fluxos versionados.
 * - Toda publicação passa pelo validador; fluxo inválido nunca entra no registro.
 * - Versões antigas são mantidas: sessões em andamento continuam na versão em que começaram.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { FlowDefinition, InboundEvent, TriggerSpec } from './types.ts';
import { validateFlow, type ValidationResult } from './validator.ts';
import { matchesAny, normalize } from './text.ts';

export class FlowValidationError extends Error {
  readonly results: Record<string, ValidationResult>;
  constructor(results: Record<string, ValidationResult>) {
    const msg = Object.entries(results)
      .filter(([, r]) => !r.ok)
      .map(([id, r]) => `${id}: ${r.errors.join('; ')}`)
      .join(' | ');
    super(`Fluxo(s) inválido(s): ${msg}`);
    this.results = results;
  }
}

export class FlowRegistry {
  private readonly flows = new Map<string, Map<number, FlowDefinition>>();

  has(flowId: string): boolean {
    return this.flows.has(flowId);
  }

  latest(flowId: string): FlowDefinition | undefined {
    const versions = this.flows.get(flowId);
    if (!versions) return undefined;
    return versions.get(Math.max(...versions.keys()));
  }

  get(flowId: string, version: number): FlowDefinition | undefined {
    return this.flows.get(flowId)?.get(version);
  }

  list(): { id: string; versions: number[]; latest: number }[] {
    return [...this.flows.entries()].map(([id, v]) => ({ id, versions: [...v.keys()].sort((a, b) => a - b), latest: Math.max(...v.keys()) }));
  }

  /** Publica um ou mais fluxos de forma atômica (todos válidos ou nenhum). */
  publish(...defs: FlowDefinition[]): Record<string, ValidationResult> {
    const batchIds = new Set(defs.map((d) => d?.id));
    const exists = (id: string) => this.has(id) || batchIds.has(id);
    const results: Record<string, ValidationResult> = {};
    for (const d of defs) {
      const r = validateFlow(d, exists);
      const existing = d?.id ? this.get(d.id, d.version) : undefined;
      if (r.ok && existing && JSON.stringify(existing) !== JSON.stringify(d)) {
        r.ok = false;
        r.errors.push(`versão ${d.version} de "${d.id}" já publicada com conteúdo diferente; incremente "version"`);
      }
      results[d?.id ?? '?'] = r;
    }
    if (Object.values(results).some((r) => !r.ok)) throw new FlowValidationError(results);
    for (const d of defs) {
      if (!this.flows.has(d.id)) this.flows.set(d.id, new Map());
      this.flows.get(d.id)!.set(d.version, structuredClone(d));
    }
    return results;
  }

  /** Carrega todos os *.json de um diretório. */
  loadDir(dir: string): Record<string, ValidationResult> {
    const defs = readdirSync(dir)
      .filter((f) => f.endsWith('.json'))
      .map((f) => JSON.parse(readFileSync(join(dir, f), 'utf8')) as FlowDefinition);
    return this.publish(...defs);
  }

  /**
   * Resolve qual fluxo inicia a conversa a partir do evento recebido.
   * Ordem: keyword/regex/comment (mais específicos) e depois o fluxo "default".
   * Comentários (Instagram) só casam com gatilhos kind=comment, e nunca com o default.
   * @param allowed fluxos permitidos para o tenant (ausente = todos)
   */
  resolveTrigger(ev: Pick<InboundEvent, 'text' | 'channel' | 'data'>, allowed?: string[]): FlowDefinition | undefined {
    return this.resolveTriggerMatch(ev, allowed)?.flow;
  }

  /**
   * Como resolveTrigger, mas informa também QUAL gatilho casou (para etiquetas de origem e métricas).
   * Precedência: ref (link de campanha) > comment > keyword/regex > default.
   * Quando o tenant define `flows`, a ORDEM dessa lista é a prioridade entre fluxos
   * (ex.: a oficina usa "atendimento-setor" como entrada padrão antes de "pre-atendimento").
   */
  resolveTriggerMatch(
    ev: Pick<InboundEvent, 'text' | 'channel' | 'data'>,
    allowed?: string[],
  ): { flow: FlowDefinition; trigger: TriggerSpec } | undefined {
    const text = ev.text;
    const isComment = ev.data?.source === 'comment';
    const ref = typeof ev.data?.ref === 'string' && ev.data.ref ? normalize(ev.data.ref) : undefined;
    const ids = allowed ? allowed.filter((id) => this.has(id)) : this.list().map((f) => f.id).filter((id) => !this.latest(id)!.optIn);
    const candidates = ids.flatMap((id) => {
      const flow = this.latest(id)!;
      return (flow.triggers ?? []).filter((t) => appliesTo(t, ev.channel)).map((trigger) => ({ flow, trigger }));
    });
    const find = (pred: (t: TriggerSpec) => boolean) => candidates.find((c) => pred(c.trigger));

    if (ref) {
      const hit = find((t) => t.kind === 'ref' && !!t.values?.some((v) => normalize(v) === ref));
      if (hit) return hit;
    }
    if (isComment) {
      return find((t) => {
        if (t.kind !== 'comment') return false;
        const mediaOk = !t.mediaIds?.length || t.mediaIds.includes(String(ev.data?.mediaId));
        const textOk = !t.values?.length || (!!text && matchesAny(text, t.values));
        return mediaOk && textOk;
      });
    }
    const byText = text
      ? find((t) => (t.kind === 'keyword' && matchesAny(text, t.values)) || (t.kind === 'regex' && new RegExp(t.pattern!, 'i').test(text)))
      : undefined;
    return byText ?? find((t) => t.kind === 'default');
  }
}

function appliesTo(t: TriggerSpec, channel: string): boolean {
  return !t.channels?.length || t.channels.includes(channel);
}
