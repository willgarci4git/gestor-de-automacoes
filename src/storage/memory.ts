/** Storage em memória: testes e desenvolvimento local. Não sobrevive a reinícios. */
import type { Contact, Session } from '../core/types.ts';
import { ConflictError, type HandoffTicket, type OutboxRecord, type ScheduledJob, type Storage, type TurnCommit } from './types.ts';

const clone = <T>(v: T): T => structuredClone(v);

export class MemoryStorage implements Storage {
  private sessions = new Map<string, Session>();
  private contacts = new Map<string, Contact>();
  private events = new Map<string, number>();
  private outbox = new Map<number, OutboxRecord & { dead?: boolean }>();
  private jobs = new Map<string, ScheduledJob>();
  private tickets = new Map<string, HandoffTicket>();
  private seq = 0;

  getSession(id: string) {
    const s = this.sessions.get(id);
    return s ? clone(s) : undefined;
  }

  getContact(id: string) {
    const c = this.contacts.get(id);
    return c ? clone(c) : undefined;
  }

  listContacts(filter: { tag?: string; limit?: number } = {}) {
    return [...this.contacts.values()]
      .filter((c) => !filter.tag || c.tags.includes(filter.tag))
      .slice(0, filter.limit ?? 10_000)
      .map(clone);
  }

  deleteContact(conversationId: string) {
    this.contacts.delete(conversationId);
    this.sessions.delete(conversationId);
  }

  hasProcessedEvent(eventId: string) {
    return this.events.has(eventId);
  }

  commitTurn(t: TurnCommit) {
    const cur = this.sessions.get(t.session.conversationId);
    if ((cur?.rev ?? 0) !== t.expectedRev) throw new ConflictError(t.session.conversationId);
    this.sessions.set(t.session.conversationId, clone(t.session));
    this.contacts.set(t.contact.conversationId, clone(t.contact));
    this.events.set(t.eventId, Date.now());
    for (const c of t.commands) {
      const id = ++this.seq;
      this.outbox.set(id, { id, command: clone(c), attempts: 0, availableAt: 0 });
    }
  }

  pendingOutbox(now: number, limit: number) {
    return [...this.outbox.values()].filter((r) => !r.dead && r.availableAt <= now).slice(0, limit).map(clone);
  }

  completeOutbox(id: number) {
    this.outbox.delete(id);
  }

  failOutbox(id: number, error: string, retryAt: number | null) {
    const r = this.outbox.get(id);
    if (!r) return;
    r.attempts++;
    r.lastError = error;
    if (retryAt === null) r.dead = true;
    else r.availableAt = retryAt;
  }

  deadLetters(limit = 100) {
    return [...this.outbox.values()].filter((r) => r.dead).slice(0, limit).map(clone);
  }

  scheduleJob(job: ScheduledJob) {
    this.jobs.set(job.id, clone(job));
  }

  dueJobs(now: number, limit: number) {
    return [...this.jobs.values()].filter((j) => j.dueAt <= now).sort((a, b) => a.dueAt - b.dueAt).slice(0, limit).map(clone);
  }

  deleteJob(id: string) {
    this.jobs.delete(id);
  }

  saveTicket(t: HandoffTicket) {
    this.tickets.set(t.id, clone(t));
  }

  getTicket(id: string) {
    const t = this.tickets.get(id);
    return t ? clone(t) : undefined;
  }

  openTicketFor(conversationId: string) {
    const t = [...this.tickets.values()].find((x) => x.conversationId === conversationId && x.status !== 'closed');
    return t ? clone(t) : undefined;
  }

  listTickets(filter: { queue?: string; status?: HandoffTicket['status'] } = {}) {
    return [...this.tickets.values()]
      .filter((t) => (!filter.queue || t.queue === filter.queue) && (!filter.status || t.status === filter.status))
      .map(clone);
  }

  pruneProcessedEvents(olderThanMs: number) {
    const limit = Date.now() - olderThanMs;
    for (const [k, at] of this.events) if (at < limit) this.events.delete(k);
  }

  close() {}
}
