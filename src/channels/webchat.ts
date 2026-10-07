/**
 * Canal Webchat: widget HTTP + Server-Sent Events. Ideal para testes ponta a ponta
 * e para sites. Não depende de provedor externo.
 */
import { randomUUID } from 'node:crypto';
import type { Address, InboundEvent, OutboundMessage } from '../core/types.ts';
import type { ChannelAdapter } from './types.ts';

export interface WebchatEntry {
  id: string;
  from: 'bot' | 'user';
  message: OutboundMessage;
  at: string;
}

type Listener = (entry: WebchatEntry) => void;

export class WebchatChannel implements ChannelAdapter {
  readonly name = 'webchat';
  private readonly history = new Map<string, WebchatEntry[]>();
  private readonly listeners = new Map<string, Set<Listener>>();
  private readonly maxHistory: number;

  constructor(maxHistory = 200) {
    this.maxHistory = maxHistory;
  }

  private push(conversationId: string, entry: WebchatEntry) {
    const list = this.history.get(conversationId) ?? [];
    list.push(entry);
    if (list.length > this.maxHistory) list.shift();
    this.history.set(conversationId, list);
    for (const l of this.listeners.get(conversationId) ?? []) l(entry);
  }

  async send(to: Address, message: OutboundMessage): Promise<void> {
    this.push(to.conversationId, { id: randomUUID(), from: 'bot', message, at: new Date().toISOString() });
  }

  /** Converte o POST do widget em evento normalizado. */
  toInbound(tenantId: string, body: { userId?: string; text?: string; optionId?: string; eventId?: string; name?: string; ref?: string }): InboundEvent {
    if (!body.userId || !/^[\w-]{1,64}$/.test(body.userId)) throw new Error('userId inválido');
    if (!body.text && !body.optionId && !body.ref) throw new Error('text, optionId ou ref obrigatório');
    if (body.ref !== undefined && !/^[\w-]{1,64}$/.test(String(body.ref))) throw new Error('ref inválido');
    const text = body.text?.slice(0, 2000);
    const ev: InboundEvent = {
      eventId: body.eventId ?? randomUUID(),
      tenantId,
      channel: this.name,
      userId: body.userId,
      kind: body.optionId ? 'choice' : 'text',
      text,
      optionId: body.optionId,
      profile: body.name ? { name: body.name.slice(0, 80) } : undefined,
      receivedAt: new Date().toISOString(),
      ...(body.ref ? { data: { ref: String(body.ref) } } : {}),
    };
    const conversationId = `${tenantId}:${this.name}:${body.userId}`;
    this.push(conversationId, { id: ev.eventId, from: 'user', message: { kind: 'text', text: text ?? body.optionId ?? `🔗 ${body.ref}` }, at: ev.receivedAt! });
    return ev;
  }

  getHistory(conversationId: string): WebchatEntry[] {
    return [...(this.history.get(conversationId) ?? [])];
  }

  subscribe(conversationId: string, listener: Listener): () => void {
    const set = this.listeners.get(conversationId) ?? new Set();
    set.add(listener);
    this.listeners.set(conversationId, set);
    return () => set.delete(listener);
  }
}
