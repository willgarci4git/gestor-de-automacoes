/**
 * Harness de simulação: executa o framework REAL (mesmo código do servidor) no navegador,
 * com os adapters reais de WhatsApp, Instagram e Telegram. A única coisa simulada é a rede:
 *  - webhooks de entrada são montados no formato oficial de cada provedor e passam pelo parser do adapter;
 *  - chamadas de saída são capturadas (URL, cabeçalhos, corpo) exatamente como seriam enviadas.
 * Assim dá para validar a integração ponta a ponta sem conta na Meta/Telegram e sem custo.
 */
import { createBotApp } from './lib/runtime/app.js';
import { FlowRegistry } from './lib/core/registry.js';
import { TenantRegistry } from './lib/core/tenants.js';
import { MemoryStorage } from './lib/storage/memory.js';
import { WhatsAppChannel } from './lib/channels/whatsapp.js';
import { InstagramChannel } from './lib/channels/instagram.js';
import { TelegramChannel } from './lib/channels/telegram.js';

export const CHANNELS = {
  webchat: { label: 'Webchat', userId: 'visitante-demo' },
  whatsapp: { label: 'WhatsApp', userId: '5511999990000' },
  instagram: { label: 'Instagram', userId: '17841400000000001' },
  telegram: { label: 'Telegram', userId: '123456789' },
};

const DEMO = {
  wa: { phoneNumberId: 'PNID-DEMO', accessToken: 'TOKEN-DEMO', appSecret: 'app-secret-demo', verifyToken: 'verify-demo' },
  ig: { accountId: 'IG-DEMO', accessToken: 'TOKEN-DEMO', appSecret: 'app-secret-demo', verifyToken: 'verify-demo', commentPublicReply: 'Te chamei no direct! 📩' },
  tg: { botToken: 'BOT-TOKEN-DEMO', webhookSecret: 'secret-demo' },
  postId: 'POST-DEMO-1',
};

const rid = () => Math.random().toString(36).slice(2, 10);
const jsonResponse = (status, body) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

async function hmacHex(secret, body) {
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(body));
  return [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

// ---------------------------------------------------------------------------------------------
// Renderização: payload REAL da API do canal -> balão de conversa (como o usuário veria)
// ---------------------------------------------------------------------------------------------
function bubbleFromWhatsApp(body) {
  if (body.type === 'text') return { text: body.text.body };
  if (body.type === 'interactive' && body.interactive.type === 'button') {
    return { text: body.interactive.body.text, buttons: body.interactive.action.buttons.map((b) => ({ id: b.reply.id, label: b.reply.title, kind: 'button_reply' })) };
  }
  if (body.type === 'interactive' && body.interactive.type === 'list') {
    return {
      text: body.interactive.body.text,
      list: { button: body.interactive.action.button, rows: body.interactive.action.sections.flatMap((s) => s.rows).map((r) => ({ id: r.id, label: r.title, kind: 'list_reply' })) },
    };
  }
  if (body.type === 'template') {
    const params = (body.template.components ?? []).flatMap((c) => c.parameters ?? []).map((p) => p.text).filter(Boolean);
    return { template: { name: body.template.name, language: body.template.language.code, params } };
  }
  const media = body[body.type];
  return { media: { kind: body.type, url: media?.link, caption: media?.caption } };
}

function bubbleFromInstagram(body) {
  const m = body.message ?? {};
  const note = body.recipient?.comment_id ? 'resposta privada ao comentário' : undefined;
  if (m.attachment) return { media: { kind: m.attachment.type, url: m.attachment.payload?.url }, note };
  return { text: m.text, quick: m.quick_replies?.map((q) => ({ id: q.payload, label: q.title })), note };
}

function bubbleFromTelegram(url, body) {
  const method = url.split('/').pop();
  if (method === 'sendMessage') {
    return { text: body.text, inline: body.reply_markup?.inline_keyboard?.flat().map((b) => ({ id: b.callback_data, label: b.text })) };
  }
  const field = { sendPhoto: 'photo', sendDocument: 'document', sendAudio: 'audio', sendVideo: 'video' }[method];
  return { media: { kind: field, url: body[field], caption: body.caption } };
}

function bubbleFromWebchat(msg) {
  if (msg.kind === 'text' || msg.kind === 'template') return { text: msg.text };
  if (msg.kind === 'choice') return { text: msg.text, buttons: msg.options.map((o) => ({ id: o.id, label: o.label })) };
  return { media: msg.media };
}

// ---------------------------------------------------------------------------------------------

export class Simulation extends EventTarget {
  constructor({ flows, tenants, tenantId, channel, userName, integrationMode = 'ok', channelFailures = 0, secrets = {}, startAt }) {
    super();
    this.channel = channel;
    this.tenantId = tenantId;
    this.userName = userName || 'Cliente Teste';
    this.userId = CHANNELS[channel].userId;
    this.conversationId = `${tenantId}:${channel}:${this.userId}`;
    this.integrationMode = integrationMode;
    this.channelFailures = channelFailures; // nº de falhas 503 antes de o canal aceitar
    this.now = new Date(startAt ?? Date.now());
    this.timeline = []; // balões da conversa
    this.http = []; // tráfego de rede (entrada e saída)
    this.logs = []; // eventos do motor
    this.agentSending = false;
    this.pendingFailures = channelFailures;

    const registry = new FlowRegistry();
    registry.publish(...flows); // lança FlowValidationError se algum fluxo for inválido
    const tenantReg = new TenantRegistry();
    for (const t of tenants) tenantReg.set(t);

    const capture = (channelName, toBubble) => async (url, init) => {
      const body = JSON.parse(String(init.body));
      const headers = { ...(init.headers ?? {}) };
      if (headers.authorization) headers.authorization = headers.authorization.replace(/Bearer .+/, 'Bearer ***');
      const entry = { dir: 'out', kind: 'channel', channel: channelName, method: init.method, url: String(url).replace(/bot[^/]+\//, 'bot***/'), headers, body, at: this.now.toISOString() };
      if (this.pendingFailures > 0) {
        this.pendingFailures--;
        entry.status = 503;
        this.push('http', entry);
        return jsonResponse(503, { error: { message: 'Service temporarily unavailable (simulado)' } });
      }
      entry.status = 200;
      this.push('http', entry);
      const bubble = toBubble(String(url), body);
      if (!body.recipient?.comment_id || !String(url).includes('/replies')) {
        this.push('timeline', { from: this.agentSending ? 'agent' : 'bot', ...bubble });
      }
      return jsonResponse(200, channelName === 'whatsapp' ? { messaging_product: 'whatsapp', messages: [{ id: 'wamid.' + rid() }] } : { ok: true, message_id: rid() });
    };

    const igCapture = capture('instagram', (_u, b) => bubbleFromInstagram(b));
    const igFetch = async (url, init) => {
      if (String(url).endsWith('/replies')) {
        this.push('http', { dir: 'out', kind: 'channel', channel: 'instagram', method: 'POST', url: String(url), body: JSON.parse(String(init.body)), status: 200, at: this.now.toISOString(), note: 'resposta pública no post' });
        return jsonResponse(200, { id: rid() });
      }
      return igCapture(url, init);
    };

    this.wa = new WhatsAppChannel({ ...DEMO.wa, graphBaseUrl: 'https://graph.facebook.com' }, capture('whatsapp', (_u, b) => bubbleFromWhatsApp(b)));
    this.ig = new InstagramChannel(DEMO.ig, igFetch);
    this.tg = new TelegramChannel(DEMO.tg, capture('telegram', (u, b) => bubbleFromTelegram(u, b)));

    const integrationFetch = async (url, init) => {
      const entry = { dir: 'out', kind: 'integration', method: init.method, url: String(url), headers: init.headers, body: init.body ? JSON.parse(String(init.body)) : undefined, at: this.now.toISOString() };
      if (this.integrationMode === 'timeout') {
        entry.status = 'timeout';
        this.push('http', entry);
        return new Promise((_, reject) => init.signal?.addEventListener('abort', () => reject(new Error('aborted'))));
      }
      entry.status = this.integrationMode === 'fail' ? 500 : 200;
      this.push('http', entry);
      return this.integrationMode === 'fail' ? jsonResponse(500, { error: 'falha simulada' }) : jsonResponse(200, { ok: true, row: Math.floor(Math.random() * 900) + 100 });
    };

    const logger = {};
    for (const level of ['debug', 'info', 'warn', 'error']) {
      logger[level] = (msg, data = {}) => this.push('logs', { level, msg, data, at: this.now.toISOString() });
    }

    this.app = createBotApp({
      storage: new MemoryStorage(),
      registry,
      tenants: tenantReg,
      adapters: [this.wa, this.ig, this.tg],
      getSecret: (name) => secrets[name],
      fetchImpl: integrationFetch,
      clock: () => this.now,
      logger,
      outboxRetryMs: 400,
    });
    this.app.webchat.subscribe(this.conversationId, (e) => {
      if (e.from === 'bot') this.push('timeline', { from: this.agentSending ? 'agent' : 'bot', ...bubbleFromWebchat(e.message) });
    });
    this.app.handoff.on('ticket', () => this.changed());
    this.app.start();
  }

  push(list, item) {
    this[list].push(item);
    this.changed();
  }

  changed() {
    clearTimeout(this._t);
    this._t = setTimeout(() => this.dispatchEvent(new Event('update')), 15);
  }

  dispose() {
    this.app.stop();
  }

  get session() {
    return this.app.storage.getSession(this.conversationId);
  }

  get contact() {
    return this.app.storage.getContact(this.conversationId);
  }

  async settle() {
    await this.app.dispatcher.idle();
    await new Promise((r) => setTimeout(r, 30));
    await this.app.dispatcher.idle();
    this.changed();
  }

  /** Entrega um webhook no formato oficial do canal, passando pelo parser real do adapter. */
  async deliverWebhook(path, payload, headers = {}) {
    const raw = JSON.stringify(payload);
    if (path !== '/telegram/webhook') headers['x-hub-signature-256'] = 'sha256=' + (await hmacHex(DEMO.wa.appSecret, raw));
    else headers['x-telegram-bot-api-secret-token'] = DEMO.tg.webhookSecret;
    this.push('http', { dir: 'in', kind: 'webhook', channel: this.channel, method: 'POST', url: path, headers, body: payload, at: this.now.toISOString() });
    const events =
      this.channel === 'whatsapp' ? this.wa.parseWebhook(payload, this.tenantId)
      : this.channel === 'instagram' ? this.ig.parseWebhook(payload, this.tenantId)
      : this.tg.parseUpdate(payload, this.tenantId);
    const results = [];
    for (const ev of events) results.push(await this.app.engine.handle(ev));
    await this.settle();
    return results;
  }

  async sendText(text) {
    this.push('timeline', { from: 'user', text });
    return this.inbound({ text });
  }

  async clickOption(opt) {
    this.push('timeline', { from: 'user', text: opt.label, clicked: true });
    return this.inbound({ optionId: opt.id, label: opt.label, replyKind: opt.kind });
  }

  async inbound({ text, optionId, label, replyKind }) {
    const ts = Math.floor(this.now.getTime() / 1000);
    const u = this.userId;
    if (this.channel === 'webchat') {
      const ev = this.app.webchat.toInbound(this.tenantId, { userId: u, text: text ?? label, optionId, name: this.userName });
      this.push('http', { dir: 'in', kind: 'webhook', channel: 'webchat', method: 'POST', url: `/webchat/${this.tenantId}/messages`, body: { userId: u, text: text ?? label, optionId, name: this.userName }, at: this.now.toISOString() });
      const r = await this.app.engine.handle(ev);
      await this.settle();
      return [r];
    }
    if (this.channel === 'whatsapp') {
      const message = optionId
        ? { from: u, id: 'wamid.' + rid(), timestamp: String(ts), type: 'interactive', interactive: { type: replyKind ?? 'button_reply', [replyKind ?? 'button_reply']: { id: optionId, title: label } } }
        : { from: u, id: 'wamid.' + rid(), timestamp: String(ts), type: 'text', text: { body: text } };
      return this.deliverWebhook('/whatsapp/webhook', {
        object: 'whatsapp_business_account',
        entry: [{ id: 'WABA-DEMO', changes: [{ field: 'messages', value: { messaging_product: 'whatsapp', metadata: { display_phone_number: '551130000000', phone_number_id: DEMO.wa.phoneNumberId }, contacts: [{ profile: { name: this.userName }, wa_id: u }], messages: [message] } }] }],
      });
    }
    if (this.channel === 'instagram') {
      const message = optionId ? { mid: 'm_' + rid(), text: label, quick_reply: { payload: optionId } } : { mid: 'm_' + rid(), text };
      return this.deliverWebhook('/instagram/webhook', {
        object: 'instagram',
        entry: [{ id: DEMO.ig.accountId, time: ts, messaging: [{ sender: { id: u }, recipient: { id: DEMO.ig.accountId }, timestamp: ts * 1000, message }] }],
      });
    }
    const update = optionId
      ? { update_id: Math.floor(Math.random() * 1e9), callback_query: { id: rid(), from: { id: Number(u), first_name: this.userName.split(' ')[0] }, message: { message_id: 1, chat: { id: Number(u), type: 'private' } }, data: optionId } }
      : { update_id: Math.floor(Math.random() * 1e9), message: { message_id: Math.floor(Math.random() * 1e6), from: { id: Number(u), first_name: this.userName.split(' ')[0] }, chat: { id: Number(u), type: 'private' }, date: ts, text } };
    return this.deliverWebhook('/telegram/webhook', update);
  }

  /** Instagram: comentário no post/Reel (gatilho kind=comment). */
  async comment(text) {
    this.push('timeline', { from: 'user', text: `💬 comentou no post: "${text}"`, comment: true });
    return this.deliverWebhook('/instagram/webhook', {
      object: 'instagram',
      entry: [{ id: DEMO.ig.accountId, time: Math.floor(this.now.getTime() / 1000), changes: [{ field: 'comments', value: { id: 'C' + rid(), text, from: { id: this.userId, username: this.userName.toLowerCase().replace(/\s+/g, '.') }, media: { id: DEMO.postId, media_product_type: 'FEED' } } }] }],
    });
  }

  /** Reenvia o último webhook recebido (a Meta faz isso): deve ser descartado por idempotência. */
  async redeliverLast() {
    const last = [...this.http].reverse().find((h) => h.dir === 'in' && h.kind === 'webhook');
    if (!last) return [];
    if (this.channel === 'webchat') return [];
    return this.deliverWebhook(last.url, last.body);
  }

  /** Disparo ativo (como no broadcast): inicia um fluxo específico para este contato. */
  async startFlow(flowId) {
    this.push('timeline', { from: 'system', text: `▶ disparo ativo do fluxo "${flowId}"` });
    const r = await this.app.engine.handle({ eventId: 'start:' + rid(), tenantId: this.tenantId, channel: this.channel, userId: this.userId, kind: 'start', data: { flowId, force: true } });
    await this.settle();
    return r;
  }

  /** Avança o relógio simulado e dispara timers vencidos (timeouts, atrasos, SLA). */
  async advance(ms) {
    this.now = new Date(this.now.getTime() + ms);
    this.push('timeline', { from: 'system', text: `⏩ relógio avançou para ${this.now.toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo' })}` });
    await this.app.scheduler.tick();
    await this.settle();
  }

  // --- atendente humano ---------------------------------------------------------------------
  tickets() {
    return this.app.handoff.list().filter((t) => t.conversationId === this.conversationId);
  }

  async agent(action, ticketId, text) {
    if (action === 'reply') {
      this.agentSending = true;
      try {
        await this.app.handoff.reply(ticketId, text, 'Atendente (Studio)');
      } finally {
        this.agentSending = false;
      }
    } else if (action === 'accept') await this.app.handoff.accept(ticketId, 'Atendente (Studio)');
    else if (action === 'close') await this.app.handoff.close(ticketId);
    await this.settle();
  }
}
