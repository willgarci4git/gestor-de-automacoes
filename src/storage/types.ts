/**
 * Contrato de persistência. O motor depende apenas desta interface (Inversão de Dependência):
 * trocar Memory -> SQLite -> Postgres/Redis não altera o núcleo.
 */
import type { Address, Command, Contact, InboundEvent, Session } from '../core/types.ts';

export class ConflictError extends Error {
  constructor(conversationId: string) {
    super(`Conflito de concorrência na conversa ${conversationId}`);
  }
}

export interface TurnCommit {
  session: Session;
  /** rev lido no início do turno (0 = sessão nova). */
  expectedRev: number;
  contact: Contact;
  eventId: string;
  commands: Command[];
}

export interface OutboxRecord {
  id: number;
  command: Command;
  attempts: number;
  availableAt: number;
  lastError?: string;
}

export interface ScheduledJob {
  id: string;
  dueAt: number;
  event: InboundEvent;
}

export interface TranscriptEntry {
  from: 'user' | 'agent' | 'system';
  text: string;
  at: string;
}

export interface HandoffTicket {
  id: string;
  conversationId: string;
  address: Address;
  queue: string;
  status: 'waiting' | 'active' | 'closed';
  context: Record<string, unknown>;
  transcript: TranscriptEntry[];
  agent?: string;
  createdAt: string;
  acceptedAt?: string;
  closedAt?: string;
}

export interface Storage {
  getSession(conversationId: string): Session | undefined;
  getContact(conversationId: string): Contact | undefined;
  /** Lista contatos (ex.: público de um broadcast por etiqueta). */
  listContacts(filter?: { tag?: string; limit?: number }): Contact[];
  /** Remove contato e sessão (limpeza de base/LGPD). Tickets e outbox não são afetados. */
  deleteContact(conversationId: string): void;
  hasProcessedEvent(eventId: string): boolean;
  /** Grava sessão + contato + evento processado + comandos (outbox) de forma ATÔMICA. */
  commitTurn(turn: TurnCommit): void;

  pendingOutbox(now: number, limit: number): OutboxRecord[];
  completeOutbox(id: number): void;
  /** retryAt null = esgotou tentativas (vai para dead letter). */
  failOutbox(id: number, error: string, retryAt: number | null): void;
  deadLetters(limit?: number): OutboxRecord[];

  scheduleJob(job: ScheduledJob): void;
  dueJobs(now: number, limit: number): ScheduledJob[];
  deleteJob(id: string): void;

  saveTicket(ticket: HandoffTicket): void;
  getTicket(id: string): HandoffTicket | undefined;
  openTicketFor(conversationId: string): HandoffTicket | undefined;
  listTickets(filter?: { queue?: string; status?: HandoffTicket['status'] }): HandoffTicket[];

  pruneProcessedEvents(olderThanMs: number): void;
  close(): void;
}
