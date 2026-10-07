/**
 * Serviço de transbordo humano (filas por setor).
 * - Cria tickets a partir dos comandos do motor
 * - Registra transcrição (usuário/atendente)
 * - Ações do atendente viram eventos para o motor (handoff_accepted / handoff_closed)
 * Emite eventos para consoles de atendimento em tempo real (SSE).
 */
import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import type { Address, InboundEvent } from '../core/types.ts';
import type { HandoffTicket, Storage } from '../storage/types.ts';

export interface HandoffDeps {
  storage: Storage;
  /** Entrega de evento ao motor (engine.handle). */
  dispatchEvent: (ev: InboundEvent) => Promise<unknown>;
  /** Envio direto ao canal (resposta do atendente não passa pelo fluxo). */
  sendToUser: (to: Address, text: string) => Promise<void>;
}

export class HandoffService extends EventEmitter {
  private readonly deps: HandoffDeps;

  constructor(deps: HandoffDeps) {
    super();
    this.deps = deps;
  }

  private now() {
    return new Date().toISOString();
  }

  private save(t: HandoffTicket, event: string) {
    this.deps.storage.saveTicket(t);
    this.emit('ticket', { event, ticket: t });
  }

  open(to: Address, queue: string, context: Record<string, unknown>): HandoffTicket {
    const existing = this.deps.storage.openTicketFor(to.conversationId);
    if (existing) return existing; // idempotente: um ticket aberto por conversa
    const t: HandoffTicket = {
      id: randomUUID(),
      conversationId: to.conversationId,
      address: to,
      queue,
      status: 'waiting',
      context,
      transcript: [{ from: 'system', text: `Transbordo para fila "${queue}"`, at: this.now() }],
      createdAt: this.now(),
    };
    this.save(t, 'opened');
    return t;
  }

  forward(to: Address, text: string): void {
    const t = this.deps.storage.openTicketFor(to.conversationId);
    if (!t) return;
    t.transcript.push({ from: 'user', text, at: this.now() });
    this.save(t, 'user_message');
  }

  /** Encerramento disparado pelo motor (ex.: SLA expirado). Não gera evento de volta. */
  systemClose(to: Address, reason: string): void {
    const t = this.deps.storage.openTicketFor(to.conversationId);
    if (!t) return;
    t.status = 'closed';
    t.closedAt = this.now();
    t.transcript.push({ from: 'system', text: `Encerrado: ${reason}`, at: this.now() });
    this.save(t, 'closed');
  }

  private require(id: string): HandoffTicket {
    const t = this.deps.storage.getTicket(id);
    if (!t) throw new Error('ticket_not_found');
    if (t.status === 'closed') throw new Error('ticket_closed');
    return t;
  }

  private event(t: HandoffTicket, kind: InboundEvent['kind']): InboundEvent {
    return { eventId: `${kind}:${t.id}`, tenantId: t.address.tenantId, channel: t.address.channel, userId: t.address.userId, kind, data: { ticketId: t.id } };
  }

  async accept(id: string, agent: string): Promise<HandoffTicket> {
    const t = this.require(id);
    if (t.status === 'waiting') {
      t.status = 'active';
      t.agent = agent;
      t.acceptedAt = this.now();
      t.transcript.push({ from: 'system', text: `Atendimento assumido por ${agent}`, at: this.now() });
      this.save(t, 'accepted');
      await this.deps.dispatchEvent(this.event(t, 'handoff_accepted'));
    }
    return t;
  }

  async reply(id: string, text: string, agent?: string): Promise<HandoffTicket> {
    let t = this.require(id);
    if (t.status === 'waiting') t = await this.accept(id, agent ?? 'atendente');
    await this.deps.sendToUser(t.address, text);
    t.transcript.push({ from: 'agent', text, at: this.now() });
    this.save(t, 'agent_message');
    return t;
  }

  async close(id: string): Promise<HandoffTicket> {
    const t = this.require(id);
    t.status = 'closed';
    t.closedAt = this.now();
    this.save(t, 'closed');
    await this.deps.dispatchEvent(this.event(t, 'handoff_closed'));
    return t;
  }

  list(filter?: { queue?: string; status?: HandoffTicket['status'] }): HandoffTicket[] {
    return this.deps.storage.listTickets(filter);
  }
}
