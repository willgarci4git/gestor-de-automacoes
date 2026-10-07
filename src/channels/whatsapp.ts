/**
 * Canal WhatsApp Cloud API (Meta).
 * - Verificação do webhook (hub.challenge)
 * - Assinatura HMAC-SHA256 (X-Hub-Signature-256) com comparação em tempo constante
 * - Normalização de mensagens: texto, botões, listas, mídia
 * - Renderização com limites do canal: até 3 botões, até 10 itens de lista; acima disso, texto numerado
 */
import { createHmac, timingSafeEqual } from 'node:crypto';
import type { Address, InboundEvent, OutboundMessage } from '../core/types.ts';
import { choiceAsText, PermanentChannelError, type ChannelAdapter } from './types.ts';

export interface WhatsAppConfig {
  phoneNumberId: string;
  accessToken: string;
  appSecret: string;
  verifyToken: string;
  apiVersion?: string;
  graphBaseUrl?: string;
}

const clip = (s: string, n: number) => (s.length > n ? s.slice(0, n - 1) + '…' : s);

export class WhatsAppChannel implements ChannelAdapter {
  readonly name = 'whatsapp';
  private readonly cfg: WhatsAppConfig;
  private readonly fetchImpl: typeof fetch;

  constructor(cfg: WhatsAppConfig, fetchImpl: typeof fetch = fetch) {
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
      for (const change of entry?.changes ?? []) {
        const value = change?.value ?? {};
        const names = new Map<string, string>((value.contacts ?? []).map((c: any) => [c.wa_id, c.profile?.name]));
        for (const m of value.messages ?? []) {
          const base = {
            eventId: String(m.id),
            tenantId,
            channel: this.name,
            userId: String(m.from),
            profile: names.get(m.from) ? { name: names.get(m.from) } : undefined,
            receivedAt: m.timestamp ? new Date(Number(m.timestamp) * 1000).toISOString() : new Date().toISOString(),
            // Anúncio "clique para o WhatsApp": source_id identifica a campanha (gatilho kind=ref).
            ...(m.referral ? { data: { ref: String(m.referral.source_id ?? m.referral.ref ?? ''), referral: { sourceUrl: m.referral.source_url, headline: m.referral.headline } } } : {}),
          };
          if (m.type === 'text') events.push({ ...base, kind: 'text', text: m.text?.body ?? '' });
          else if (m.type === 'interactive') {
            const r = m.interactive?.button_reply ?? m.interactive?.list_reply;
            events.push({ ...base, kind: 'choice', optionId: r?.id, text: r?.title });
          } else if (m.type === 'button') events.push({ ...base, kind: 'choice', optionId: m.button?.payload, text: m.button?.text });
          else if (['image', 'audio', 'document', 'video', 'sticker', 'voice'].includes(m.type)) {
            events.push({ ...base, kind: 'media', media: { kind: m.type, id: m[m.type]?.id }, text: m[m.type]?.caption });
          } else if (m.type === 'location') {
            events.push({ ...base, kind: 'text', text: `${m.location?.latitude},${m.location?.longitude}` });
          }
          // Tipos não suportados (reaction, unsupported...) são ignorados deliberadamente.
        }
        // value.statuses (entregue/lido) não geram eventos de conversa.
      }
    }
    return events;
  }

  /** Monta o payload da Graph API — função pura, testável. */
  buildPayload(to: string, msg: OutboundMessage): Record<string, unknown> {
    const base = { messaging_product: 'whatsapp', recipient_type: 'individual', to };
    if (msg.kind === 'text') return { ...base, type: 'text', text: { body: clip(msg.text, 4096), preview_url: true } };
    if (msg.kind === 'media') {
      const kind = ['image', 'document', 'audio', 'video'].includes(msg.media.kind) ? msg.media.kind : 'document';
      const media: Record<string, string> = { link: msg.media.url };
      if (msg.media.caption && kind !== 'audio') media.caption = msg.media.caption;
      if (msg.media.filename && kind === 'document') media.filename = msg.media.filename;
      return { ...base, type: kind, [kind]: media };
    }
    if (msg.kind === 'template') {
      return { ...base, type: 'template', template: { name: msg.template.name, language: { code: msg.template.language }, ...(msg.template.components ? { components: msg.template.components } : {}) } };
    }
    const { options, display } = msg;
    if (display === 'buttons' && options.length <= 3) {
      return {
        ...base, type: 'interactive',
        interactive: { type: 'button', body: { text: clip(msg.text, 1024) }, action: { buttons: options.map((o) => ({ type: 'reply', reply: { id: o.id, title: clip(o.label, 20) } })) } },
      };
    }
    if (display !== 'text' && options.length <= 10) {
      return {
        ...base, type: 'interactive',
        interactive: {
          type: 'list', body: { text: clip(msg.text, 1024) },
          action: { button: 'Ver opções', sections: [{ title: 'Opções', rows: options.map((o) => ({ id: o.id, title: clip(o.label, 24) })) }] },
        },
      };
    }
    return { ...base, type: 'text', text: { body: clip(choiceAsText(msg.text, options), 4096) } };
  }

  async send(to: Address, msg: OutboundMessage): Promise<void> {
    const base = this.cfg.graphBaseUrl ?? 'https://graph.facebook.com';
    const url = `${base}/${this.cfg.apiVersion ?? 'v21.0'}/${this.cfg.phoneNumberId}/messages`;
    const res = await this.fetchImpl(url, {
      method: 'POST',
      headers: { authorization: `Bearer ${this.cfg.accessToken}`, 'content-type': 'application/json' },
      body: JSON.stringify(this.buildPayload(to.userId, msg)),
      signal: AbortSignal.timeout(10_000),
    });
    if (res.ok) return;
    const detail = await res.text().catch(() => '');
    const err = `whatsapp_http_${res.status}: ${detail.slice(0, 300)}`;
    if (res.status >= 400 && res.status < 500 && res.status !== 429) throw new PermanentChannelError(err);
    throw new Error(err);
  }
}
