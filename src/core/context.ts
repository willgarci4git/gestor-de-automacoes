/**
 * Contexto de variáveis com escopos explícitos:
 *   system.*  somente leitura (canal, data/hora, saudação, horário comercial)
 *   tenant.*  somente leitura: parâmetros do cliente (tenants/<id>.json)
 *   contact.* persistente entre conversas (equivale aos "campos personalizados")
 *   session.* dura a conversa
 *   flow.*    local ao fluxo/subfluxo corrente
 *   secrets.* NUNCA resolvido pelo motor — apenas pelo worker de integração
 */
import type { Contact, Session } from './types.ts';

export const WRITABLE_SCOPES = ['contact', 'session', 'flow'] as const;
export type Scope = (typeof WRITABLE_SCOPES)[number] | 'system' | 'tenant' | 'secrets';

export class VarContext {
  readonly session: Session;
  readonly contact: Contact;
  readonly system: Record<string, unknown>;
  readonly tenant: Record<string, unknown>;

  constructor(session: Session, contact: Contact, system: Record<string, unknown>, tenant: Record<string, unknown> = {}) {
    this.session = session;
    this.contact = contact;
    this.system = system;
    this.tenant = tenant;
  }

  private root(scope: string): Record<string, unknown> | undefined {
    switch (scope) {
      case 'contact':
        return this.contact.fields;
      case 'session':
        return this.session.vars.session;
      case 'flow':
        return this.session.vars.flow;
      case 'system':
        return this.system;
      case 'tenant':
        return this.tenant;
      default:
        return undefined;
    }
  }

  get(path: string): unknown {
    const [scope, ...rest] = path.split('.');
    if (scope === 'contact' && rest[0] === 'tags' && rest.length === 1) return this.contact.tags;
    let cur: unknown = this.root(scope);
    for (const key of rest) {
      if (cur == null || typeof cur !== 'object') return undefined;
      cur = (cur as Record<string, unknown>)[key];
    }
    return cur;
  }

  set(path: string, value: unknown): void {
    const [scope, ...rest] = path.split('.');
    if (!(WRITABLE_SCOPES as readonly string[]).includes(scope) || rest.length === 0) {
      throw new Error(`Variável não gravável: "${path}" (use contact.*, session.* ou flow.*)`);
    }
    let cur = this.root(scope)!;
    for (let i = 0; i < rest.length - 1; i++) {
      const k = rest[i];
      if (cur[k] == null || typeof cur[k] !== 'object') cur[k] = {};
      cur = cur[k] as Record<string, unknown>;
    }
    cur[rest[rest.length - 1]] = value;
  }

  addTags(tags: string[]): void {
    for (const t of tags) if (!this.contact.tags.includes(t)) this.contact.tags.push(t);
  }

  removeTags(tags: string[]): void {
    this.contact.tags = this.contact.tags.filter((t) => !tags.includes(t));
  }
}

const TEMPLATE_RE = /\{\{\s*([\w.]+)\s*\}\}/g;

/**
 * Renderiza "Olá {{contact.first_name}}". Variáveis ausentes viram string vazia.
 * Placeholders de secrets.* são preservados intactos para o worker de integração.
 */
export function renderTemplate(tpl: string, ctx: VarContext): string {
  return tpl.replace(TEMPLATE_RE, (whole, path: string) => {
    if (path.startsWith('secrets.')) return whole;
    const v = ctx.get(path);
    if (v == null) return '';
    return typeof v === 'object' ? JSON.stringify(v) : String(v);
  });
}

/** Renderiza recursivamente strings em objetos/arrays (corpo de requisições, assign). */
export function renderDeep(value: unknown, ctx: VarContext): unknown {
  if (typeof value === 'string') {
    // "{{session.x}}" sozinho preserva o tipo original (número, objeto...)
    const single = /^\{\{\s*([\w.]+)\s*\}\}$/.exec(value);
    if (single && !single[1].startsWith('secrets.')) return ctx.get(single[1]);
    return renderTemplate(value, ctx);
  }
  if (Array.isArray(value)) return value.map((v) => renderDeep(v, ctx));
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, renderDeep(v, ctx)]));
  }
  return value;
}

/** Resolve {{secrets.X}} a partir de um provedor (ex.: variáveis de ambiente). */
export function resolveSecrets(value: unknown, getSecret: (name: string) => string | undefined): unknown {
  if (typeof value === 'string') {
    return value.replace(/\{\{\s*secrets\.([\w]+)\s*\}\}/g, (_, name: string) => {
      const s = getSecret(name);
      if (s === undefined) throw new Error(`Secret não configurado: ${name}`);
      return s;
    });
  }
  if (Array.isArray(value)) return value.map((v) => resolveSecrets(v, getSecret));
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, resolveSecrets(v, getSecret)]));
  }
  return value;
}
