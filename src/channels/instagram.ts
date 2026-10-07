/**
 * Canal Instagram (Messaging API da Meta) — DMs e gatilho por comentário em post/Reel,
 * o padrão "comenta QUERO e recebe no direct" ensinado no curso com ManyChat.
 *
 * - Assinatura HMAC-SHA256 igual à do WhatsApp (X-Hub-Signature-256, App Secret)
 * - Comentário -> InboundEvent com data.source="comment" (só casa com gatilhos kind=comment)
 * - A 1ª resposta a um comentário vai como *private reply* (recipient.comment_id), que é a
 *   única forma permitida de iniciar DM a partir de comentário; opcionalmente responde em público.
 * - Menus viram quick replies (até 13, título até 20 caracteres); acima disso, texto numerado.
 */
import { createHmac, timingSafeEqual } from 'node:crypto';
import type { Address, InboundEvent, OutboundMessage } from '../core/types.ts';
import { choiceAsText, PermanentChannelError, type ChannelAdapter } from './types.ts';

export interface InstagramConfig {
  /** Id da conta profissional do Instagram (ou da Página vinculada). */
  accountId: string;
  accessToken: string;
  appSecret: string;
  verifyToken: string;
  apiVersion?: string;
  graphBaseUrl?: string;
  /** Resposta pública opcional no comentário (ex.: "Te chamei no direct! 📩"). */
  commentPublicReply?: string;
}

const clip = (s: string, n: number) => (s.length > n ? s.slice(0, n - 1) + '…' : s);

export class InstagramChannel implements ChannelAdapter {
  readonly name = 'instagram';
  private readonly cfg: InstagramConfig;
  private readonly fetchImpl: typeof fetch;
  /** userId -> commentId aguardando a primeira resposta privada. */
  private readonly pendingComments = new Map<string, string>();

  constructor(cfg: InstagramConfig, fetchImpl: typeof fetch = fetch) {
    this.cfg = cfg;
    this.fetchImpl = fetchImpl;
  }

  verifyChallenge(query: URLSearchParams): string | null {
    return query.get('hub.mode') === 'subscribe' && query.get('hub.verify_token') === this.cfg.verifyToken ? query.get('hub.challenge') : null;
  }

  verifySignature(rawBody: string | Buffer, header: string | undefined): boolean {
    if (!header?.startsWith('sha256=')) return false;
    const expected = createHmac('sha256', this.cfg.appSecret).update(rawBody).digest();
    const got = Buffer.from(header.slice(7), 'hex');
    return got.length === expected.length && timingSafeEqual(got, expected);
  }

  parseWebhook(body: any, tenantId: string): InboundEvent[] {
    const events: InboundEvent[] = [];
    for (const entry of body?.entry ?? []) {
      for (const m of entry?.messaging ?? []) {
        const userId = String(m.sender?.id ?? '');
        if (!userId || m.message?.is_echo || userId === this.cfg.accountId) continue; // ignora eco das nossas mensagens
        const ref = m.referral?.ref ?? m.message?.referral?.ref ?? m.postback?.referral?.ref;
        const base = { tenantId, channel: this.name, userId, ...(ref ? { data: { ref: String(ref) } } : {}) };
        if (m.referral && !m.message && !m.postback) {
          // Abriu a conversa por um link ig.me com ?ref= (sem digitar nada): inicia pelo gatilho kind=ref.
          events.push({ ...base, eventId: `igr:${userId}:${m.timestamp}`, kind: 'text', text: '' });
        } else if (m.postback) {
          events.push({ ...base, eventId: `igp:${m.postback.mid ?? m.timestamp}`, kind: 'choice', optionId: m.postback.payload, text: m.postback.title });
        } else if (m.message?.quick_reply) {
          events.push({ ...base, eventId: `igm:${m.message.mid}`, kind: 'choice', optionId: m.message.quick_reply.payload, text: m.message.text });
        } else if (typeof m.message?.text === 'string') {
          events.push({ ...base, eventId: `igm:${m.message.mid}`, kind: 'text', text: m.message.text });
        } else if (m.message?.attachments?.length) {
          const a = m.message.attachments[0];
          events.push({ ...base, eventId: `igm:${m.message.mid}`, kind: 'media', media: { kind: a.type, url: a.payload?.url } });
        }
      }
      for (const change of entry?.changes ?? []) {
        if (change?.field !== 'comments' && change?.field !== 'live_comments') continue;
        const v = change.value ?? {};
        const userId = String(v.from?.id ?? '');
        if (!userId || userId === this.cfg.accountId) continue; // não reage aos próprios comentários
        this.pendingComments.set(userId, String(v.id));
        events.push({
          eventId: `igc:${v.id}`, tenantId, channel: this.name, userId, kind: 'text', text: v.text ?? '',
          profile: v.from?.username ? { name: v.from.username } : undefined,
          data: { source: 'comment', commentId: v.id, mediaId: v.media?.id },
        });
      }
    }
    return events;
  }

  buildMessage(msg: OutboundMessage): Record<string, unknown> {
    if (msg.kind === 'text' || msg.kind === 'template') return { text: clip(msg.text, 1000) };
    if (msg.kind === 'media') {
      const type = ({ image: 'image', audio: 'audio', video: 'video' } as Record<string, string>)[msg.media.kind] ?? 'file';
      return { attachment: { type, payload: { url: msg.media.url } } };
    }
    if (msg.options.length <= 13) {
      return { text: clip(msg.text, 1000), quick_replies: msg.options.map((o) => ({ content_type: 'text', title: clip(o.label, 20), payload: o.id })) };
    }
    return { text: clip(choiceAsText(msg.text, msg.options), 1000) };
  }

  private async post(path: string, body: unknown): Promise<void> {
    const url = `${this.cfg.graphBaseUrl ?? 'https://graph.facebook.com'}/${this.cfg.apiVersion ?? 'v21.0'}/${path}`;
    const res = await this.fetchImpl(url, {
      method: 'POST',
      headers: { authorization: `Bearer ${this.cfg.accessToken}`, 'content-type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(10_000),
    });
    if (res.ok) return;
    const err = `instagram_http_${res.status}: ${(await res.text().catch(() => '')).slice(0, 300)}`;
    if (res.status >= 400 && res.status < 500 && res.status !== 429) throw new PermanentChannelError(err);
    throw new Error(err);
  }

  async send(to: Address, msg: OutboundMessage): Promise<void> {
    const commentId = this.pendingComments.get(to.userId);
    const recipient = commentId ? { comment_id: commentId } : { id: to.userId };
    await this.post(`${this.cfg.accountId}/messages`, { recipient, message: this.buildMessage(msg) });
    if (commentId) {
      this.pendingComments.delete(to.userId);
      if (this.cfg.commentPublicReply) {
        await this.post(`${commentId}/replies`, { message: this.cfg.commentPublicReply }).catch(() => undefined); // best effort
      }
    }
  }
}
