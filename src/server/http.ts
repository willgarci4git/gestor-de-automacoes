/**
 * Servidor HTTP (node:http, sem dependências).
 * Rotas:
 *   GET  /health, /metrics
 *   GET  /                      widget webchat de teste      GET /agent  console do atendente
 *   POST /webchat/:tenant/messages   GET /webchat/:tenant/stream (SSE)   GET /webchat/:tenant/history
 *   GET|POST /whatsapp/webhook  (verificação + HMAC)
 *   POST /telegram/webhook      (secret token)
 *   GET|POST /instagram/webhook (verificação + HMAC; DMs e comentários)
 *   POST /admin/broadcast       transmissão por etiqueta (respeita opt-out)
 *   POST /admin/contacts/cleanup limpeza de contatos inativos (dryRun por padrão; preserva etiquetas VIP)
 *   /admin/*   fluxos, validação, sessões, dead letters      (x-admin-token)
 *   /handoff/* tickets de atendimento humano + SSE             (x-admin-token)
 *
 * Segurança (ADR-003): sessão de webchat assinada pelo servidor (T4), ticket de uso único para o SSE
 * do console (T6), limites de taxa e de conexões (T7), tokens por operador + trilha de auditoria (T10),
 * allowlist de tenants no webchat (T11) e cabeçalhos de segurança com CSP por hash (T12).
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import type { BotApp } from '../runtime/app.ts';
import type { WhatsAppChannel } from '../channels/whatsapp.ts';
import type { TelegramChannel } from '../channels/telegram.ts';
import type { InstagramChannel } from '../channels/instagram.ts';
import { FlowValidationError } from '../core/registry.ts';
import { validateFlow } from '../core/validator.ts';
import type { FlowDefinition } from '../core/types.ts';

export interface ServerOptions {
  tenantId: string;
  /** Token do operador "admin" (compatível com versões anteriores). */
  adminToken?: string;
  /** Tokens por operador (nome -> token): identificam quem fez cada ação na trilha de auditoria (T10). */
  adminTokens?: Record<string, string>;
  publicDir: string;
  maxBodyBytes?: number;
  webchat?: {
    /** 'token' (padrão): toda chamada exige a sessão assinada emitida por POST /webchat/:tenant/session (T4). */
    auth?: 'token' | 'off';
    /** Chave HMAC das sessões. Padrão: aleatória por processo (sessões expiram ao reiniciar). */
    secret?: string;
    /** Tenants aceitos no webchat (T11). Padrão: só o tenantId do servidor. */
    tenants?: string[];
  };
  /** Usa o primeiro IP de X-Forwarded-For (atrás de proxy confiável, ex.: Render). */
  trustProxy?: boolean;
  /** Envia Strict-Transport-Security (servidor atrás de HTTPS). */
  hsts?: boolean;
  limits?: Partial<Limits>;
}

export interface Limits {
  /** Mensagens de webchat por IP por minuto. */
  webchatPerIpPerMin: number;
  /** Mensagens por conversa por minuto. */
  webchatPerConversationPerMin: number;
  /** Novas sessões de webchat por IP por minuto. */
  sessionsPerIpPerMin: number;
  /** Falhas de autenticação administrativa por IP por minuto antes de 429. */
  authFailuresPerIpPerMin: number;
  /** Conexões SSE simultâneas por IP e no total. */
  ssePerIp: number;
  sseTotal: number;
}

const DEFAULT_LIMITS: Limits = { webchatPerIpPerMin: 60, webchatPerConversationPerMin: 20, sessionsPerIpPerMin: 10, authFailuresPerIpPerMin: 10, ssePerIp: 5, sseTotal: 500 };

/** Janela fixa por chave (em memória; instância única). Retorna segundos para tentar de novo ou 0. */
export class RateLimiter {
  private readonly hits = new Map<string, { n: number; reset: number }>();
  private readonly now: () => number;
  constructor(now: () => number = Date.now) {
    this.now = now;
  }
  take(key: string, limit: number, windowMs = 60_000): number {
    const t = this.now();
    let h = this.hits.get(key);
    if (!h || h.reset <= t) {
      h = { n: 0, reset: t + windowMs };
      this.hits.set(key, h);
    }
    h.n++;
    if (this.hits.size > 50_000) for (const [k, v] of this.hits) if (v.reset <= t) this.hits.delete(k);
    return h.n > limit ? Math.ceil((h.reset - t) / 1000) : 0;
  }
  peek(key: string, limit: number): boolean {
    const h = this.hits.get(key);
    return !!h && h.reset > this.now() && h.n >= limit;
  }
}

/** Gera a CSP de uma página HTML autorizando só os <script>/<style> inline dela (por hash SHA-256). */
export function cspFor(html: string): string {
  const hashes = (tag: string) =>
    [...html.matchAll(new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)</${tag}>`, 'gi'))]
      .filter((m) => !/\ssrc=/.test(m[0].slice(0, m[0].indexOf('>'))))
      .map((m) => `'sha256-${createHash('sha256').update(m[1]).digest('base64')}'`)
      .join(' ');
  return [
    "default-src 'self'", `script-src 'self' ${hashes('script')}`.trim(), `style-src 'self' ${hashes('style')}`.trim(),
    "img-src 'self' https: data:", "connect-src 'self'", "frame-ancestors 'none'", "base-uri 'none'", "form-action 'self'", "object-src 'none'",
  ].join('; ');
}

class HttpError extends Error {
  readonly status: number;
  readonly headers: Record<string, string>;
  constructor(status: number, message: string, headers: Record<string, string> = {}) {
    super(message);
    this.status = status;
    this.headers = headers;
  }
}

declare module 'node:http' {
  interface ServerResponse {
    locals?: { hsts?: boolean };
  }
}

interface Ctx {
  req: IncomingMessage;
  res: ServerResponse;
  url: URL;
  params: Record<string, string>;
  raw: Buffer;
  ip: string;
  /** Operador autenticado nas rotas administrativas (T10). */
  actor?: string;
  json<T = any>(): T;
}

type Handler = (c: Ctx) => Promise<unknown> | unknown;

const SECURITY_HEADERS = {
  'x-content-type-options': 'nosniff',
  'cache-control': 'no-store',
  'referrer-policy': 'no-referrer',
  'x-frame-options': 'DENY',
  'cross-origin-opener-policy': 'same-origin',
  'cross-origin-resource-policy': 'same-origin',
  'permissions-policy': 'camera=(), microphone=(), geolocation=(), payment=()',
} as const;

function send(res: ServerResponse, status: number, body: unknown, type = 'application/json; charset=utf-8', extra: Record<string, string> = {}) {
  if (res.headersSent) return;
  res.writeHead(status, { 'content-type': type, ...SECURITY_HEADERS, ...(res.locals?.hsts ? { 'strict-transport-security': 'max-age=31536000; includeSubDomains' } : {}), ...extra });
  res.end(typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body));
}

async function readBody(req: IncomingMessage, limit: number): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > limit) throw new HttpError(413, 'payload muito grande');
    chunks.push(chunk as Buffer);
  }
  return Buffer.concat(chunks);
}

function sse(res: ServerResponse): (event: string, data: unknown) => void {
  res.writeHead(200, { ...SECURITY_HEADERS, 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' });
  res.write(': ok\n\n');
  const ping = setInterval(() => res.write(': ping\n\n'), 25_000);
  res.on('close', () => clearInterval(ping));
  return (event, data) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}

export function createHttpServer(app: BotApp, opts: ServerOptions): Server {
  const routes: { method: string; re: RegExp; handler: Handler; admin?: boolean }[] = [];
  const route = (method: string, path: string, handler: Handler, admin = false) => {
    const re = new RegExp('^' + path.replace(/:(\w+)/g, '(?<$1>[^/]+)') + '$');
    routes.push({ method, re, handler, admin });
  };
  const limits: Limits = { ...DEFAULT_LIMITS, ...opts.limits };
  const limiter = new RateLimiter();
  const tooMany = (retry: number, what: string) => new HttpError(429, `muitas requisições (${what})`, { 'retry-after': String(retry) });

  // Páginas estáticas com CSP calculada a partir do próprio conteúdo (T12).
  const pages = new Map<string, { body: Buffer; csp: string }>();
  const page = (name: string) => {
    let p = pages.get(name);
    if (!p) {
      const body = readFileSync(join(opts.publicDir, name));
      p = { body, csp: cspFor(body.toString('utf8')) };
      pages.set(name, p);
    }
    return p;
  };

  // --- autenticação administrativa: tokens por operador (T10), sem token na query (T6) ----------
  const operators = Object.entries({ ...(opts.adminToken ? { admin: opts.adminToken } : {}), ...opts.adminTokens }).map(([name, token]) => ({ name, token: Buffer.from(token) }));
  const checkAdmin = (c: Ctx) => {
    if (!operators.length) {
      c.actor = 'dev-inseguro'; // só alcançável com ALLOW_INSECURE_DEV=1 (ver security.ts)
      return;
    }
    const failKey = `authfail:${c.ip}`;
    if (limiter.peek(failKey, limits.authFailuresPerIpPerMin)) throw tooMany(60, 'autenticação');
    const got = Buffer.from(String(c.req.headers['x-admin-token'] ?? ''));
    const op = operators.find((o) => o.token.length === got.length && timingSafeEqual(o.token, got));
    if (!op) {
      limiter.take(failKey, limits.authFailuresPerIpPerMin);
      app.logger.warn('audit', { action: 'auth_failed', path: c.url.pathname, ip: c.ip });
      throw new HttpError(401, 'não autorizado');
    }
    c.actor = op.name;
  };
  /** Trilha de auditoria (T10): quem, o quê, em qual alvo e de onde. */
  const audit = (c: Ctx, action: string, detail: Record<string, unknown> = {}) =>
    app.logger.info('audit', { actor: c.actor ?? 'anon', action, ip: c.ip, ...detail });

  // --- webchat: allowlist de tenants (T11) e sessão assinada (T4) --------------------------------
  const wcAuth = opts.webchat?.auth ?? 'token';
  const wcSecret = opts.webchat?.secret ?? randomBytes(32).toString('hex');
  const wcTenants = new Set(opts.webchat?.tenants ?? [opts.tenantId]);
  const tenantOk = (t: string) => {
    if (!/^[\w-]{1,64}$/.test(t)) throw new HttpError(400, 'tenant inválido');
    return t;
  };
  const webchatTenant = (t: string) => {
    tenantOk(t);
    if (!wcTenants.has('*') && !wcTenants.has(t)) throw new HttpError(404, 'tenant não disponível no webchat');
    return t;
  };
  const sign = (tenant: string, userId: string) => createHmac('sha256', wcSecret).update(`webchat:${tenant}:${userId}`).digest('base64url');
  const checkWebchat = (c: Ctx, tenant: string, userId: string) => {
    if (!/^[\w-]{1,64}$/.test(userId)) throw new HttpError(400, 'userId inválido');
    if (wcAuth === 'off') return;
    const got = Buffer.from(String(c.req.headers['x-webchat-token'] ?? c.url.searchParams.get('wt') ?? ''));
    const exp = Buffer.from(sign(tenant, userId));
    if (got.length !== exp.length || !timingSafeEqual(got, exp)) throw new HttpError(401, 'sessão de webchat inválida');
  };

  // --- limites de SSE (T7) ------------------------------------------------------------------------
  const sseByIp = new Map<string, number>();
  let sseTotal = 0;
  const sseOpen = (c: Ctx) => {
    const n = sseByIp.get(c.ip) ?? 0;
    if (n >= limits.ssePerIp || sseTotal >= limits.sseTotal) throw tooMany(30, 'conexões em tempo real');
    sseByIp.set(c.ip, n + 1);
    sseTotal++;
    c.res.on('close', () => {
      const m = (sseByIp.get(c.ip) ?? 1) - 1;
      if (m <= 0) sseByIp.delete(c.ip);
      else sseByIp.set(c.ip, m);
      sseTotal--;
    });
  };

  // --- tickets de uso único para o SSE do console (T6) --------------------------------------------
  const streamTickets = new Map<string, { actor: string; exp: number }>();

  // --- infraestrutura -------------------------------------------------------
  route('GET', '/health', () => ({ status: 'ok', flows: app.registry.list().length }));
  route('GET', '/metrics', () => app.metrics.snapshot(), true);
  const html = (name: string) => ({ res }: Ctx) => {
    const p = page(name);
    send(res, 200, p.body, 'text/html; charset=utf-8', { 'content-security-policy': p.csp });
  };
  route('GET', '/', html('webchat.html'));
  route('GET', '/agent', html('agent.html'));

  // --- webchat --------------------------------------------------------------
  route('POST', '/webchat/:tenant/session', (c) => {
    const tenant = webchatTenant(c.params.tenant);
    const retry = limiter.take(`wcsess:${c.ip}`, limits.sessionsPerIpPerMin);
    if (retry) throw tooMany(retry, 'novas sessões');
    const userId = 'w' + randomBytes(16).toString('hex');
    send(c.res, 201, { userId, token: wcAuth === 'off' ? null : sign(tenant, userId) });
  });
  route('POST', '/webchat/:tenant/messages', async (c) => {
    const tenant = webchatTenant(c.params.tenant);
    const body = c.json();
    checkWebchat(c, tenant, String(body?.userId ?? ''));
    const retry = limiter.take(`wcip:${c.ip}`, limits.webchatPerIpPerMin) || limiter.take(`wcconv:${tenant}:${body.userId}`, limits.webchatPerConversationPerMin);
    if (retry) throw tooMany(retry, 'mensagens');
    let ev;
    try {
      ev = app.webchat.toInbound(tenant, body);
    } catch (e) {
      throw new HttpError(400, (e as Error).message);
    }
    const r = await app.engine.handle(ev);
    send(c.res, 202, { status: r.status, eventId: ev.eventId });
  });
  route('GET', '/webchat/:tenant/history', (c) => {
    const tenant = webchatTenant(c.params.tenant);
    const userId = c.url.searchParams.get('userId') ?? '';
    checkWebchat(c, tenant, userId);
    return app.webchat.getHistory(`${tenant}:webchat:${userId}`);
  });
  route('GET', '/webchat/:tenant/stream', (c) => {
    const tenant = webchatTenant(c.params.tenant);
    const userId = c.url.searchParams.get('userId') ?? '';
    checkWebchat(c, tenant, userId);
    sseOpen(c);
    const push = sse(c.res);
    const off = app.webchat.subscribe(`${tenant}:webchat:${userId}`, (entry) => push('message', entry));
    c.res.on('close', off);
  });

  // --- whatsapp -------------------------------------------------------------
  const wa = app.adapters.whatsapp as WhatsAppChannel | undefined;
  route('GET', '/whatsapp/webhook', (c) => {
    if (!wa) throw new HttpError(404, 'whatsapp não configurado');
    const challenge = wa.verifyChallenge(c.url.searchParams);
    if (challenge === null) throw new HttpError(403, 'verify token inválido');
    send(c.res, 200, challenge, 'text/plain');
  });
  route('POST', '/whatsapp/webhook', (c) => {
    if (!wa) throw new HttpError(404, 'whatsapp não configurado');
    if (!wa.verifySignature(c.raw, c.req.headers['x-hub-signature-256'] as string | undefined)) {
      app.metrics.inc('webhook.whatsapp.bad_signature');
      throw new HttpError(401, 'assinatura inválida');
    }
    const events = wa.parseWebhook(c.json(), opts.tenantId);
    // ACK imediato (a Meta re-entrega se demorar); processamento assíncrono e idempotente.
    send(c.res, 200, { received: events.length });
    for (const ev of events) void app.engine.handle(ev).catch((e) => app.logger.error('whatsapp_event_failed', { eventId: ev.eventId, error: String(e) }));
  });

  // --- instagram (DM + comentários) --------------------------------------------
  const ig = app.adapters.instagram as InstagramChannel | undefined;
  route('GET', '/instagram/webhook', (c) => {
    if (!ig) throw new HttpError(404, 'instagram não configurado');
    const challenge = ig.verifyChallenge(c.url.searchParams);
    if (challenge === null) throw new HttpError(403, 'verify token inválido');
    send(c.res, 200, challenge, 'text/plain');
  });
  route('POST', '/instagram/webhook', (c) => {
    if (!ig) throw new HttpError(404, 'instagram não configurado');
    if (!ig.verifySignature(c.raw, c.req.headers['x-hub-signature-256'] as string | undefined)) {
      app.metrics.inc('webhook.instagram.bad_signature');
      throw new HttpError(401, 'assinatura inválida');
    }
    const events = ig.parseWebhook(c.json(), opts.tenantId);
    send(c.res, 200, { received: events.length });
    for (const ev of events) void app.engine.handle(ev).catch((e) => app.logger.error('instagram_event_failed', { eventId: ev.eventId, error: String(e) }));
  });

  // --- telegram -------------------------------------------------------------
  const tg = app.adapters.telegram as TelegramChannel | undefined;
  route('POST', '/telegram/webhook', (c) => {
    if (!tg) throw new HttpError(404, 'telegram não configurado');
    if (!tg.verifySecret(c.req.headers['x-telegram-bot-api-secret-token'] as string | undefined)) throw new HttpError(401, 'secret inválido');
    const events = tg.parseUpdate(c.json(), opts.tenantId);
    send(c.res, 200, { received: events.length });
    for (const ev of events) {
      if (typeof ev.data?.callbackQueryId === 'string') void tg.answerCallback(ev.data.callbackQueryId);
      void app.engine.handle(ev).catch((e) => app.logger.error('telegram_event_failed', { eventId: ev.eventId, error: String(e) }));
    }
  });

  // --- admin ----------------------------------------------------------------
  route('GET', '/admin/flows', () => app.registry.list(), true);
  route('GET', '/admin/flows/:id', (c) => app.registry.latest(c.params.id) ?? (() => { throw new HttpError(404, 'fluxo não encontrado'); })(), true);
  route('POST', '/admin/flows/validate', (c) => {
    const flow = c.json<FlowDefinition>();
    return validateFlow(flow, (id) => app.registry.has(id) || id === flow.id);
  }, true);
  route('POST', '/admin/flows', (c) => {
    const body = c.json<FlowDefinition | FlowDefinition[]>();
    try {
      const list = Array.isArray(body) ? body : [body];
      const results = app.registry.publish(...list);
      audit(c, 'flows_published', { flows: list.map((f) => `${f?.id}@${f?.version}`), sha256: createHash('sha256').update(c.raw).digest('hex') });
      send(c.res, 201, results);
    } catch (e) {
      if (e instanceof FlowValidationError) return send(c.res, 422, e.results);
      throw e;
    }
  }, true);
  route('GET', '/admin/sessions/:conversationId', (c) => {
    const id = decodeURIComponent(c.params.conversationId);
    audit(c, 'session_read', { conversationId: id });
    return { session: app.storage.getSession(id) ?? null, contact: app.storage.getContact(id) ?? null };
  }, true);
  route('GET', '/admin/dead-letters', () => app.storage.deadLetters(), true);
  route('GET', '/admin/tenants', () => app.tenants.list(), true);
  route('POST', '/admin/contacts/cleanup', (c) => {
    const { inactiveDays, keepTags, tenantId, dryRun } = c.json();
    audit(c, 'contacts_cleanup', { inactiveDays, tenantId, dryRun: dryRun !== false });
    try {
      return app.cleanupContacts({
        inactiveDays: Number(inactiveDays),
        keepTags: Array.isArray(keepTags) ? keepTags.map(String) : undefined,
        tenantId: tenantId ? String(tenantId) : undefined,
        dryRun: dryRun !== false, // seguro por padrão: só remove com dryRun=false explícito
      });
    } catch (e) {
      throw new HttpError(400, (e as Error).message);
    }
  }, true);
  route('POST', '/admin/broadcast', async (c) => {
    const { broadcastId, flowId, tag, tenantId, vars } = c.json();
    if (!broadcastId || !flowId) throw new HttpError(400, 'broadcastId e flowId obrigatórios');
    audit(c, 'broadcast', { broadcastId: String(broadcastId), flowId: String(flowId), tag, tenantId });
    try {
      return await app.broadcast({ broadcastId: String(broadcastId), flowId: String(flowId), tag, tenantId, vars });
    } catch (e) {
      throw new HttpError(404, (e as Error).message);
    }
  }, true);

  // --- handoff (atendentes) ---------------------------------------------------
  route('GET', '/handoff/tickets', (c) => {
    const status = c.url.searchParams.get('status') as 'waiting' | 'active' | 'closed' | null;
    return app.handoff.list({ queue: c.url.searchParams.get('queue') ?? undefined, status: status ?? undefined });
  }, true);
  const ticketAction = (fn: (c: Ctx) => Promise<unknown>) => async (c: Ctx) => {
    try {
      return await fn(c);
    } catch (e) {
      const m = (e as Error).message;
      if (m === 'ticket_not_found') throw new HttpError(404, m);
      if (m === 'ticket_closed') throw new HttpError(409, m);
      throw e;
    }
  };
  // O nome exibido ao cliente pode ser escolhido pelo atendente, mas a auditoria registra o operador
  // autenticado (T10): o campo "agent" do corpo não serve como prova de autoria.
  const agentName = (c: Ctx) => {
    const a = c.json().agent;
    return typeof a === 'string' && a.trim() ? a.trim().slice(0, 60) : (c.actor ?? 'atendente');
  };
  route('POST', '/handoff/tickets/:id/accept', ticketAction(async (c) => {
    audit(c, 'ticket_accept', { ticket: c.params.id });
    return app.handoff.accept(c.params.id, agentName(c));
  }), true);
  route('POST', '/handoff/tickets/:id/reply', ticketAction(async (c) => {
    const { text } = c.json();
    if (!text || typeof text !== 'string') throw new HttpError(400, 'text obrigatório');
    audit(c, 'ticket_reply', { ticket: c.params.id, chars: text.length });
    return app.handoff.reply(c.params.id, text.slice(0, 4000), agentName(c));
  }), true);
  route('POST', '/handoff/tickets/:id/close', ticketAction(async (c) => {
    audit(c, 'ticket_close', { ticket: c.params.id });
    return app.handoff.close(c.params.id);
  }), true);
  // T6: o navegador não manda cabeçalho no EventSource; em vez do token na URL, troca-se o token por
  // um ticket aleatório de uso único, válido por 60 s.
  route('POST', '/handoff/stream-ticket', (c) => {
    const ticket = randomBytes(24).toString('base64url');
    const t = Date.now();
    for (const [k, v] of streamTickets) if (v.exp < t) streamTickets.delete(k);
    streamTickets.set(ticket, { actor: c.actor ?? 'admin', exp: t + 60_000 });
    return { ticket, expiresInSec: 60 };
  }, true);
  route('GET', '/handoff/stream', (c) => {
    const ticket = c.url.searchParams.get('ticket') ?? '';
    const entry = streamTickets.get(ticket);
    streamTickets.delete(ticket);
    if (!entry || entry.exp < Date.now()) checkAdmin(c); // sem ticket válido, exige o cabeçalho
    else c.actor = entry.actor;
    sseOpen(c);
    const push = sse(c.res);
    const listener = (e: unknown) => push('ticket', e);
    app.handoff.on('ticket', listener);
    c.res.on('close', () => app.handoff.off('ticket', listener));
  });

  // --- dispatcher ---------------------------------------------------------------
  const clientIp = (req: IncomingMessage) => {
    const fwd = opts.trustProxy ? String(req.headers['x-forwarded-for'] ?? '').split(',')[0].trim() : '';
    return fwd || req.socket.remoteAddress || 'desconhecido';
  };

  return createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    const started = performance.now();
    res.locals = { hsts: opts.hsts };
    try {
      const match = routes.map((r) => ({ r, m: r.method === req.method ? r.re.exec(url.pathname) : null })).find((x) => x.m);
      if (!match) throw new HttpError(routes.some((r) => r.re.test(url.pathname)) ? 405 : 404, 'rota não encontrada');
      const raw = req.method === 'GET' ? Buffer.alloc(0) : await readBody(req, opts.maxBodyBytes ?? 1_000_000);
      const ctx: Ctx = {
        req, res, url, raw, ip: clientIp(req), params: { ...match.m!.groups },
        json() {
          try {
            return JSON.parse(raw.toString('utf8') || '{}');
          } catch {
            throw new HttpError(400, 'JSON inválido');
          }
        },
      };
      if (match.r.admin) checkAdmin(ctx);
      const out = await match.r.handler(ctx);
      if (!res.headersSent && out !== undefined) send(res, 200, out);
      else if (!res.headersSent) send(res, 204, '');
    } catch (e) {
      const status = e instanceof HttpError ? e.status : 500;
      if (status >= 500) app.logger.error('http_error', { path: url.pathname, error: String(e) });
      send(res, status, { error: status >= 500 ? 'erro interno' : (e as Error).message }, undefined, e instanceof HttpError ? e.headers : {});
    } finally {
      app.metrics.observe('http.ms', performance.now() - started);
    }
  });
}
