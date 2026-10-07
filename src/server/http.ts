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
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { timingSafeEqual } from 'node:crypto';
import type { BotApp } from '../runtime/app.ts';
import type { WhatsAppChannel } from '../channels/whatsapp.ts';
import type { TelegramChannel } from '../channels/telegram.ts';
import type { InstagramChannel } from '../channels/instagram.ts';
import { FlowValidationError } from '../core/registry.ts';
import { validateFlow } from '../core/validator.ts';
import type { FlowDefinition } from '../core/types.ts';

export interface ServerOptions {
  tenantId: string;
  adminToken?: string;
  publicDir: string;
  maxBodyBytes?: number;
}

class HttpError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

interface Ctx {
  req: IncomingMessage;
  res: ServerResponse;
  url: URL;
  params: Record<string, string>;
  raw: Buffer;
  json<T = any>(): T;
}

type Handler = (c: Ctx) => Promise<unknown> | unknown;

function send(res: ServerResponse, status: number, body: unknown, type = 'application/json; charset=utf-8') {
  if (res.headersSent) return;
  res.writeHead(status, { 'content-type': type, 'x-content-type-options': 'nosniff', 'cache-control': 'no-store' });
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
  res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' });
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
  const staticFile = (name: string) => readFileSync(join(opts.publicDir, name));
  const checkAdmin = (req: IncomingMessage) => {
    if (!opts.adminToken) return; // modo desenvolvimento
    const got = Buffer.from(String(req.headers['x-admin-token'] ?? new URL(req.url!, 'http://x').searchParams.get('token') ?? ''));
    const exp = Buffer.from(opts.adminToken);
    if (got.length !== exp.length || !timingSafeEqual(got, exp)) throw new HttpError(401, 'não autorizado');
  };
  const tenantOk = (t: string) => {
    if (!/^[\w-]{1,64}$/.test(t)) throw new HttpError(400, 'tenant inválido');
    return t;
  };

  // --- infraestrutura -------------------------------------------------------
  route('GET', '/health', () => ({ status: 'ok', flows: app.registry.list().length }));
  route('GET', '/metrics', () => app.metrics.snapshot(), true);
  route('GET', '/', ({ res }) => send(res, 200, staticFile('webchat.html'), 'text/html; charset=utf-8'));
  route('GET', '/agent', ({ res }) => send(res, 200, staticFile('agent.html'), 'text/html; charset=utf-8'));

  // --- webchat --------------------------------------------------------------
  route('POST', '/webchat/:tenant/messages', async (c) => {
    let ev;
    try {
      ev = app.webchat.toInbound(tenantOk(c.params.tenant), c.json());
    } catch (e) {
      throw new HttpError(400, (e as Error).message);
    }
    const r = await app.engine.handle(ev);
    send(c.res, 202, { status: r.status, eventId: ev.eventId });
  });
  route('GET', '/webchat/:tenant/history', (c) => {
    const userId = c.url.searchParams.get('userId') ?? '';
    return app.webchat.getHistory(`${tenantOk(c.params.tenant)}:webchat:${userId}`);
  });
  route('GET', '/webchat/:tenant/stream', (c) => {
    const userId = c.url.searchParams.get('userId') ?? '';
    if (!/^[\w-]{1,64}$/.test(userId)) throw new HttpError(400, 'userId inválido');
    const push = sse(c.res);
    const off = app.webchat.subscribe(`${tenantOk(c.params.tenant)}:webchat:${userId}`, (entry) => push('message', entry));
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
      const results = app.registry.publish(...(Array.isArray(body) ? body : [body]));
      app.logger.info('flows_published', { flows: Object.keys(results) });
      send(c.res, 201, results);
    } catch (e) {
      if (e instanceof FlowValidationError) return send(c.res, 422, e.results);
      throw e;
    }
  }, true);
  route('GET', '/admin/sessions/:conversationId', (c) => {
    const id = decodeURIComponent(c.params.conversationId);
    return { session: app.storage.getSession(id) ?? null, contact: app.storage.getContact(id) ?? null };
  }, true);
  route('GET', '/admin/dead-letters', () => app.storage.deadLetters(), true);
  route('GET', '/admin/tenants', () => app.tenants.list(), true);
  route('POST', '/admin/contacts/cleanup', (c) => {
    const { inactiveDays, keepTags, tenantId, dryRun } = c.json();
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
  route('POST', '/handoff/tickets/:id/accept', ticketAction((c) => app.handoff.accept(c.params.id, String(c.json().agent ?? 'atendente'))), true);
  route('POST', '/handoff/tickets/:id/reply', ticketAction((c) => {
    const { text, agent } = c.json();
    if (!text || typeof text !== 'string') throw new HttpError(400, 'text obrigatório');
    return app.handoff.reply(c.params.id, text.slice(0, 4000), agent);
  }), true);
  route('POST', '/handoff/tickets/:id/close', ticketAction((c) => app.handoff.close(c.params.id)), true);
  route('GET', '/handoff/stream', (c) => {
    const push = sse(c.res);
    const listener = (e: unknown) => push('ticket', e);
    app.handoff.on('ticket', listener);
    c.res.on('close', () => app.handoff.off('ticket', listener));
  }, true);

  // --- dispatcher ---------------------------------------------------------------
  return createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    const started = performance.now();
    try {
      const match = routes.map((r) => ({ r, m: r.method === req.method ? r.re.exec(url.pathname) : null })).find((x) => x.m);
      if (!match) throw new HttpError(routes.some((r) => r.re.test(url.pathname)) ? 405 : 404, 'rota não encontrada');
      if (match.r.admin) checkAdmin(req);
      const raw = req.method === 'GET' ? Buffer.alloc(0) : await readBody(req, opts.maxBodyBytes ?? 1_000_000);
      const ctx: Ctx = {
        req, res, url, raw, params: { ...match.m!.groups },
        json() {
          try {
            return JSON.parse(raw.toString('utf8') || '{}');
          } catch {
            throw new HttpError(400, 'JSON inválido');
          }
        },
      };
      const out = await match.r.handler(ctx);
      if (!res.headersSent && out !== undefined) send(res, 200, out);
      else if (!res.headersSent) send(res, 204, '');
    } catch (e) {
      const status = e instanceof HttpError ? e.status : 500;
      if (status >= 500) app.logger.error('http_error', { path: url.pathname, error: String(e) });
      send(res, status, { error: status >= 500 ? 'erro interno' : (e as Error).message });
    } finally {
      app.metrics.observe('http.ms', performance.now() - started);
    }
  });
}
