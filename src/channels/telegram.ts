/**
 * Canal Telegram Bot API — demonstra a agnosticidade do núcleo: mesmo fluxo, outro canal.
 * Segurança: header X-Telegram-Bot-Api-Secret-Token configurado no setWebhook.
 */
import { timingSafeEqual } from 'node:crypto';
import type { Address, InboundEvent, OutboundMessage } from '../core/types.ts';
import { PermanentChannelError, type ChannelAdapter } from './types.ts';

export interface TelegramConfig {
  botToken: string;
  webhookSecret: string;
  apiBaseUrl?: string;
}

export class TelegramChannel implements ChannelAdapter {
  readonly name = 'telegram';
  private readonly cfg: TelegramConfig;
  private readonly fetchImpl: typeof fetch;

  constructor(cfg: TelegramConfig, fetchImpl: typeof fetch = fetch) {
    this.cfg = cfg;
    this.fetchImpl = fetchImpl;
  }

  verifySecret(header: string | undefined): boolean {
    if (!header) return false;
    const a = Buffer.from(header);
    const b = Buffer.from(this.cfg.webhookSecret);
    return a.length === b.length && timingSafeEqual(a, b);
  }

  parseUpdate(update: any, tenantId: string): InboundEvent[] {
    const base = (userId: unknown, name?: string) => ({
      eventId: `tg:${update.update_id}`, tenantId, channel: this.name, userId: String(userId), profile: name ? { name } : undefined,
    });
    if (update.callback_query) {
      const q = update.callback_query;
      return [{ ...base(q.message?.chat?.id ?? q.from?.id, q.from?.first_name), kind: 'choice', optionId: q.data, data: { callbackQueryId: q.id } }];
    }
    const m = update.message;
    if (!m) return [];
    if (typeof m.text === 'string') {
      // Deep link t.me/<bot>?start=<ref> chega como "/start <ref>" (gatilho kind=ref).
      const start = /^\/start(?:@\w+)?(?:\s+([\w-]{1,64}))?\s*$/.exec(m.text);
      return [{ ...base(m.chat.id, m.from?.first_name), kind: 'text', text: m.text, ...(start?.[1] ? { data: { ref: start[1] } } : {}) }];
    }
    const mediaKind = ['photo', 'document', 'audio', 'voice', 'video'].find((k) => m[k]);
    if (mediaKind) return [{ ...base(m.chat.id, m.from?.first_name), kind: 'media', media: { kind: mediaKind }, text: m.caption }];
    return [];
  }

  buildRequest(chatId: string, msg: OutboundMessage): { method: string; body: Record<string, unknown> } {
    if (msg.kind === 'text' || msg.kind === 'template') return { method: 'sendMessage', body: { chat_id: chatId, text: msg.text } };
    if (msg.kind === 'media') {
      const map: Record<string, string> = { image: 'sendPhoto', document: 'sendDocument', audio: 'sendAudio', video: 'sendVideo' };
      const field: Record<string, string> = { image: 'photo', document: 'document', audio: 'audio', video: 'video' };
      const k = map[msg.media.kind] ? msg.media.kind : 'document';
      return { method: map[k], body: { chat_id: chatId, [field[k]]: msg.media.url, caption: msg.media.caption } };
    }
    return {
      method: 'sendMessage',
      body: { chat_id: chatId, text: msg.text, reply_markup: { inline_keyboard: msg.options.map((o) => [{ text: o.label, callback_data: o.id.slice(0, 64) }]) } },
    };
  }

  /**
   * Confirma o clique num botão inline (answerCallbackQuery). Sem isso o Telegram mantém o
   * indicador de carregamento no botão por alguns segundos. Best effort: nunca lança.
   */
  async answerCallback(callbackQueryId: string): Promise<void> {
    await this.fetchImpl(`${this.cfg.apiBaseUrl ?? 'https://api.telegram.org'}/bot${this.cfg.botToken}/answerCallbackQuery`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ callback_query_id: callbackQueryId }), signal: AbortSignal.timeout(5_000),
    }).catch(() => undefined);
  }

  async send(to: Address, msg: OutboundMessage): Promise<void> {
    const { method, body } = this.buildRequest(to.userId, msg);
    const res = await this.fetchImpl(`${this.cfg.apiBaseUrl ?? 'https://api.telegram.org'}/bot${this.cfg.botToken}/${method}`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(10_000),
    });
    if (res.ok) return;
    const err = `telegram_http_${res.status}`;
    if (res.status >= 400 && res.status < 500 && res.status !== 429) throw new PermanentChannelError(err);
    throw new Error(err);
  }
}
