/**
 * Validação da DSL em duas camadas:
 *  1. Estrutural (schema): campos obrigatórios e tipos por tipo de nó.
 *  2. Estática do grafo: referências, alcançabilidade e ciclos sem ponto de espera
 *     (que causariam loop infinito em tempo de execução).
 * Um fluxo com `errors` NÃO pode ser publicado.
 */
import type { FlowDefinition, FlowNode, ValidatorSpec } from './types.ts';
import { WRITABLE_SCOPES } from './context.ts';

export interface ValidationResult {
  ok: boolean;
  errors: string[];
  warnings: string[];
}

const NODE_TYPES = ['message', 'input', 'router', 'condition', 'set', 'integration', 'wait', 'handoff', 'subflow', 'end', 'randomizer'];
/** Nós que "cedem" a execução e aguardam um evento externo. */
const WAITING_TYPES = new Set(['input', 'router', 'wait', 'integration', 'handoff']);
const VALIDATOR_KINDS = ['any', 'minLength', 'email', 'phone', 'number', 'date', 'cpf', 'regex'];
const HTTP_METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'];

const isStr = (v: unknown): v is string => typeof v === 'string' && v.length > 0;
const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);

/** Retorna todas as arestas (campo -> nó destino) de um nó. */
export function edgesOf(node: FlowNode): { field: string; target: string }[] {
  const out: { field: string; target: string }[] = [];
  const add = (field: string, t: unknown) => {
    if (isStr(t)) out.push({ field, target: t });
  };
  const n = node as unknown as Record<string, unknown>;
  for (const f of ['next', 'onError', 'onInvalid', 'onTimeout', 'onExhausted', 'onSlaTimeout', 'default']) add(f, n[f]);
  if (node.type === 'router') node.options?.forEach((o, i) => add(`options[${i}].next`, o?.next));
  if (node.type === 'condition') node.branches?.forEach((b, i) => add(`branches[${i}].next`, b?.next));
  if (node.type === 'randomizer') node.variants?.forEach((v, i) => add(`variants[${i}].next`, v?.next));
  return out;
}

function checkSaveTo(path: unknown, where: string, errors: string[]) {
  if (path === undefined) return;
  if (!isStr(path) || !(WRITABLE_SCOPES as readonly string[]).includes(path.split('.')[0]) || !path.includes('.')) {
    errors.push(`${where}: saveTo "${String(path)}" inválido (use contact.x, session.x ou flow.x)`);
  }
}

function checkValidator(v: ValidatorSpec | undefined, where: string, errors: string[]) {
  if (!v) return;
  if (!VALIDATOR_KINDS.includes(v.kind)) errors.push(`${where}: validator.kind "${v.kind}" desconhecido`);
  if (v.kind === 'minLength' && !isNum(v.value)) errors.push(`${where}: validator minLength exige "value" numérico`);
  if (v.kind === 'regex') {
    try {
      new RegExp(v.pattern, v.flags);
    } catch {
      errors.push(`${where}: regex inválida "${v.pattern}"`);
    }
  }
}

function checkNodeSchema(id: string, node: FlowNode, errors: string[]) {
  const w = `nó "${id}" (${(node as { type?: string })?.type})`;
  if (!node || typeof node !== 'object') return errors.push(`nó "${id}": definição inválida`);
  if (!NODE_TYPES.includes(node.type)) return errors.push(`nó "${id}": tipo "${String(node.type)}" desconhecido`);
  const need = (cond: boolean, msg: string) => {
    if (!cond) errors.push(`${w}: ${msg}`);
  };
  switch (node.type) {
    case 'message':
      need(isStr(node.text) || !!node.media?.url || !!node.template, 'precisa de "text", "media.url" ou "template"');
      if (node.template) {
        need(isStr(node.template.name) && isStr(node.template.language), 'template precisa de "name" e "language"');
        need(isStr(node.text), 'template precisa de "text" (fallback para canais sem modelos)');
      }
      need(isStr(node.next), '"next" obrigatório');
      break;
    case 'input':
      need(isStr(node.prompt), '"prompt" obrigatório');
      need(isStr(node.saveTo), '"saveTo" obrigatório');
      need(isStr(node.next), '"next" obrigatório');
      checkSaveTo(node.saveTo, w, errors);
      checkValidator(node.validator, w, errors);
      if (node.timeoutSec !== undefined) need(isStr(node.onTimeout), '"onTimeout" obrigatório quando há timeoutSec');
      break;
    case 'router': {
      need(isStr(node.prompt), '"prompt" obrigatório');
      need(Array.isArray(node.options) && node.options.length > 0, 'precisa de ao menos uma opção');
      const ids = new Set<string>();
      node.options?.forEach((o, i) => {
        need(isStr(o?.id) && isStr(o?.label) && isStr(o?.next), `opção ${i} precisa de id, label e next`);
        if (ids.has(o?.id)) errors.push(`${w}: id de opção duplicado "${o.id}"`);
        ids.add(o?.id);
      });
      checkSaveTo(node.saveTo, w, errors);
      if (node.timeoutSec !== undefined) need(isStr(node.onTimeout), '"onTimeout" obrigatório quando há timeoutSec');
      break;
    }
    case 'condition':
      need(Array.isArray(node.branches), '"branches" obrigatório');
      need(isStr(node.default), '"default" obrigatório');
      break;
    case 'set':
      need(isStr(node.next), '"next" obrigatório');
      for (const k of Object.keys(node.assign ?? {})) checkSaveTo(k, w, errors);
      break;
    case 'integration':
      need(!!node.request && HTTP_METHODS.includes(node.request.method), 'request.method inválido');
      need(isStr(node.request?.url), 'request.url obrigatório');
      need(isStr(node.next), '"next" obrigatório');
      need(isStr(node.onError), '"onError" é obrigatório em integrações (resiliência)');
      checkSaveTo(node.saveTo, w, errors);
      break;
    case 'wait':
      need(isNum(node.seconds) && node.seconds > 0, '"seconds" > 0 obrigatório');
      need(isStr(node.next), '"next" obrigatório');
      break;
    case 'handoff':
      need(isStr(node.queue), '"queue" obrigatório');
      if (node.slaSec !== undefined) need(isStr(node.onSlaTimeout), '"onSlaTimeout" obrigatório quando há slaSec');
      break;
    case 'subflow':
      need(isStr(node.flowId), '"flowId" obrigatório');
      need(isStr(node.next), '"next" obrigatório');
      break;
    case 'end':
      break;
    case 'randomizer': {
      need(Array.isArray(node.variants) && node.variants.length >= 2, 'precisa de ao menos 2 variantes');
      const ids = new Set<string>();
      node.variants?.forEach((v, i) => {
        need(isStr(v?.id) && isStr(v?.next) && isNum(v?.weight) && v.weight >= 0, `variante ${i} precisa de id, next e weight >= 0`);
        if (ids.has(v?.id)) errors.push(`${w}: id de variante duplicado "${v.id}"`);
        ids.add(v?.id);
      });
      need((node.variants ?? []).reduce((a, v) => a + (isNum(v?.weight) ? v.weight : 0), 0) > 0, 'soma dos pesos deve ser > 0');
      break;
    }
  }
}

/** True se, a partir de `start`, o primeiro envio ao usuário é texto livre (não um modelo aprovado). */
function sendsFreeText(flow: FlowDefinition, start: string): boolean {
  const seen = new Set<string>();
  const q = [start];
  while (q.length) {
    const id = q.shift()!;
    const n = flow.nodes[id];
    if (!n || seen.has(id)) continue;
    seen.add(id);
    if (n.type === 'message') return !n.template;
    if (n.type === 'end') return !!n.message;
    if (n.type === 'input' || (n.type === 'router' && !n.silent) || n.type === 'handoff') return true;
    if (!WAITING_TYPES.has(n.type)) q.push(...edgesOf(n).map((e) => e.target));
  }
  return false;
}

/**
 * @param flowExists resolve se um flowId referenciado por subflow existe (registro de fluxos).
 */
export function validateFlow(flow: FlowDefinition, flowExists?: (flowId: string) => boolean): ValidationResult {
  const errors: string[] = [];
  const warnings: string[] = [];

  if (!flow || typeof flow !== 'object') return { ok: false, errors: ['definição de fluxo ausente'], warnings };
  if (!isStr(flow.id)) errors.push('"id" do fluxo obrigatório');
  if (!Number.isInteger(flow.version) || flow.version < 1) errors.push('"version" deve ser inteiro >= 1');
  if (!flow.nodes || typeof flow.nodes !== 'object' || !Object.keys(flow.nodes).length) {
    errors.push('"nodes" obrigatório e não vazio');
    return { ok: false, errors, warnings };
  }
  if (!isStr(flow.start) || !flow.nodes[flow.start]) errors.push(`nó inicial "${flow.start}" não existe`);
  if (flow.optIn !== undefined && typeof flow.optIn !== 'boolean') errors.push('"optIn" deve ser true ou false');

  for (const [id, node] of Object.entries(flow.nodes)) checkNodeSchema(id, node, errors);
  if (errors.length) return { ok: false, errors, warnings };

  // Referências
  for (const [id, node] of Object.entries(flow.nodes)) {
    for (const e of edgesOf(node)) {
      if (!flow.nodes[e.target]) errors.push(`nó "${id}": ${e.field} aponta para nó inexistente "${e.target}"`);
    }
    if (node.type === 'subflow' && flowExists && !flowExists(node.flowId)) {
      errors.push(`nó "${id}": subfluxo "${node.flowId}" não está registrado`);
    }
  }
  for (const [name, intent] of Object.entries(flow.globals?.intents ?? {})) {
    if (!flow.nodes[intent.goto]) errors.push(`intent global "${name}" aponta para nó inexistente "${intent.goto}"`);
    if (!intent.match?.length) errors.push(`intent global "${name}" sem termos em "match"`);
  }
  for (const t of flow.triggers ?? []) {
    if (!['keyword', 'regex', 'default', 'comment', 'ref'].includes(t.kind)) errors.push(`trigger kind "${t.kind}" desconhecido`);
    if ((t.kind === 'keyword' || t.kind === 'ref') && !t.values?.length) errors.push(`trigger ${t.kind} sem "values"`);
    if (t.tags !== undefined && (!Array.isArray(t.tags) || !t.tags.every(isStr))) errors.push(`trigger ${t.kind}: "tags" deve ser lista de textos`);
    if (t.kind === 'regex') {
      try {
        new RegExp(t.pattern ?? '');
      } catch {
        errors.push(`trigger regex inválida "${t.pattern}"`);
      }
    }
  }
  // "Atrasos nunca podem vir por último" (regra do curso): um wait seguido de fim silencioso
  // só deixa a conversa pendurada e consome um job à toa.
  for (const [id, node] of Object.entries(flow.nodes)) {
    if (node.type !== 'wait') continue;
    const after = flow.nodes[node.next];
    if (after?.type === 'end' && !after.message) errors.push(`nó "${id}": wait não pode ser o último passo do fluxo (E003)`);
  }
  if (errors.length) return { ok: false, errors, warnings };

  // Alcançabilidade (a partir do start e das intents globais)
  const roots = [flow.start, ...Object.values(flow.globals?.intents ?? {}).map((i) => i.goto)];
  const seen = new Set<string>();
  const stack = [...roots];
  while (stack.length) {
    const id = stack.pop()!;
    if (seen.has(id)) continue;
    seen.add(id);
    for (const e of edgesOf(flow.nodes[id])) stack.push(e.target);
  }
  for (const id of Object.keys(flow.nodes)) if (!seen.has(id)) warnings.push(`nó "${id}" é inalcançável`);

  // Ciclos sem ponto de espera: DFS apenas sobre nós "imediatos"
  const immediate = (id: string) => !WAITING_TYPES.has(flow.nodes[id].type);
  const color = new Map<string, 0 | 1 | 2>();
  const dfs = (id: string, path: string[]): void => {
    color.set(id, 1);
    for (const e of edgesOf(flow.nodes[id])) {
      if (!immediate(e.target)) continue;
      const c = color.get(e.target) ?? 0;
      if (c === 1) {
        const cycle = [...path.slice(path.indexOf(e.target)), e.target];
        errors.push(`loop sem ponto de espera: ${cycle.join(' -> ')}`);
      } else if (c === 0) dfs(e.target, [...path, e.target]);
    }
    color.set(id, 2);
  };
  for (const id of Object.keys(flow.nodes)) {
    if (immediate(id) && !color.get(id)) dfs(id, [id]);
  }

  // Avisos de boas práticas
  // (só para fluxos de entrada — subfluxos herdam as intents do fluxo raiz)
  const leadsToHandoff = (start: string) => {
    const q = [start];
    const visited = new Set<string>();
    while (q.length) {
      const id = q.shift()!;
      if (visited.has(id)) continue;
      visited.add(id);
      if (flow.nodes[id].type === 'handoff') return true;
      if (immediate(id)) for (const e of edgesOf(flow.nodes[id])) q.push(e.target);
    }
    return false;
  };
  // Limites dos canais (não bloqueiam; o adapter trunca ou rebaixa para texto numerado)
  const DAY = 24 * 3600;
  for (const [id, node] of Object.entries(flow.nodes)) {
    if (node.type === 'router') {
      for (const o of node.options) {
        if (!o.label.includes('{{') && o.label.length > 20) {
          warnings.push(`nó "${id}": rótulo "${o.label}" tem ${o.label.length} caracteres; botões do WhatsApp/Instagram mostram só 20`);
        }
      }
    }
    // Espera longa: o que sai DEPOIS dela precisa ser modelo aprovado no WhatsApp (janela de 24h).
    const after =
      node.type === 'wait' ? { sec: node.seconds, to: node.next }
      : (node.type === 'input' || node.type === 'router') && isNum(node.timeoutSec) ? { sec: node.timeoutSec, to: node.onTimeout }
      : node.type === 'handoff' && isNum(node.slaSec) ? { sec: node.slaSec, to: node.onSlaTimeout }
      : undefined;
    if (after && after.sec > DAY && after.to && sendsFreeText(flow, after.to)) {
      warnings.push(`nó "${id}": espera de ${Math.round(after.sec / 3600)}h passa da janela de 24h do WhatsApp; a próxima mensagem precisa ser um "message" com "template"`);
    }
  }

  if (flow.triggers?.length && !Object.values(flow.globals?.intents ?? {}).some((i) => leadsToHandoff(i.goto))) {
    warnings.push('recomendado: intent global que leve a um nó "handoff" (ex.: "atendente")');
  }
  return { ok: errors.length === 0, errors, warnings };
}
