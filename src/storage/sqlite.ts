/**
 * Storage durável com SQLite embutido no Node (node:sqlite) — zero dependências externas.
 * Adequado para produção em instância única. Para escala horizontal, implemente a mesma
 * interface `Storage` sobre Postgres (as queries abaixo são SQL padrão e portam diretamente).
 */
import { DatabaseSync } from 'node:sqlite';
import type { Command, Contact, InboundEvent, Session } from '../core/types.ts';
import { ConflictError, type HandoffTicket, type OutboxRecord, type ScheduledJob, type Storage, type TurnCommit } from './types.ts';

const SCHEMA = `
PRAGMA journal_mode = WAL;
PRAGMA busy_timeout = 5000;
CREATE TABLE IF NOT EXISTS sessions (conversation_id TEXT PRIMARY KEY, data TEXT NOT NULL, rev INTEGER NOT NULL, updated_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS contacts (conversation_id TEXT PRIMARY KEY, data TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS processed_events (event_id TEXT PRIMARY KEY, at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS outbox (
  id INTEGER PRIMARY KEY AUTOINCREMENT, command TEXT NOT NULL, attempts INTEGER NOT NULL DEFAULT 0,
  available_at INTEGER NOT NULL DEFAULT 0, status TEXT NOT NULL DEFAULT 'pending', last_error TEXT);
CREATE INDEX IF NOT EXISTS outbox_pending ON outbox(status, available_at);
CREATE TABLE IF NOT EXISTS jobs (id TEXT PRIMARY KEY, due_at INTEGER NOT NULL, event TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS jobs_due ON jobs(due_at);
CREATE TABLE IF NOT EXISTS tickets (id TEXT PRIMARY KEY, conversation_id TEXT NOT NULL, queue TEXT NOT NULL, status TEXT NOT NULL, data TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS tickets_conv ON tickets(conversation_id, status);
`;

type Row = Record<string, unknown>;

export class SqliteStorage implements Storage {
  private readonly db: DatabaseSync;

  constructor(path: string) {
    this.db = new DatabaseSync(path);
    this.db.exec(SCHEMA);
  }

  private tx<T>(fn: () => T): T {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const r = fn();
      this.db.exec('COMMIT');
      return r;
    } catch (e) {
      this.db.exec('ROLLBACK');
      throw e;
    }
  }

  getSession(id: string): Session | undefined {
    const row = this.db.prepare('SELECT data FROM sessions WHERE conversation_id = ?').get(id) as Row | undefined;
    return row ? JSON.parse(row.data as string) : undefined;
  }

  getContact(id: string): Contact | undefined {
    const row = this.db.prepare('SELECT data FROM contacts WHERE conversation_id = ?').get(id) as Row | undefined;
    return row ? JSON.parse(row.data as string) : undefined;
  }

  listContacts(filter: { tag?: string; limit?: number } = {}): Contact[] {
    // Filtro por etiqueta via JSON1 (embutido no SQLite): evita carregar a base inteira.
    const rows = (filter.tag
      ? this.db.prepare("SELECT data FROM contacts WHERE EXISTS (SELECT 1 FROM json_each(json_extract(data, '$.tags')) WHERE value = ?) LIMIT ?").all(filter.tag, filter.limit ?? 10_000)
      : this.db.prepare('SELECT data FROM contacts LIMIT ?').all(filter.limit ?? 10_000)) as Row[];
    return rows.map((r) => JSON.parse(r.data as string));
  }

  deleteContact(conversationId: string): void {
    this.tx(() => {
      this.db.prepare('DELETE FROM contacts WHERE conversation_id = ?').run(conversationId);
      this.db.prepare('DELETE FROM sessions WHERE conversation_id = ?').run(conversationId);
    });
  }

  hasProcessedEvent(eventId: string): boolean {
    return !!this.db.prepare('SELECT 1 FROM processed_events WHERE event_id = ?').get(eventId);
  }

  commitTurn(t: TurnCommit): void {
    this.tx(() => {
      const s = t.session;
      const data = JSON.stringify(s);
      if (t.expectedRev === 0) {
        const exists = this.db.prepare('SELECT 1 FROM sessions WHERE conversation_id = ?').get(s.conversationId);
        if (exists) throw new ConflictError(s.conversationId);
        this.db.prepare('INSERT INTO sessions (conversation_id, data, rev, updated_at) VALUES (?, ?, ?, ?)').run(s.conversationId, data, s.rev, s.updatedAt);
      } else {
        const r = this.db
          .prepare('UPDATE sessions SET data = ?, rev = ?, updated_at = ? WHERE conversation_id = ? AND rev = ?')
          .run(data, s.rev, s.updatedAt, s.conversationId, t.expectedRev);
        if (Number(r.changes) === 0) throw new ConflictError(s.conversationId);
      }
      this.db
        .prepare('INSERT INTO contacts (conversation_id, data) VALUES (?, ?) ON CONFLICT(conversation_id) DO UPDATE SET data = excluded.data')
        .run(t.contact.conversationId, JSON.stringify(t.contact));
      this.db.prepare('INSERT INTO processed_events (event_id, at) VALUES (?, ?)').run(t.eventId, Date.now());
      const ins = this.db.prepare('INSERT INTO outbox (command) VALUES (?)');
      for (const c of t.commands) ins.run(JSON.stringify(c));
    });
  }

  private toOutbox(r: Row): OutboxRecord {
    return {
      id: Number(r.id),
      command: JSON.parse(r.command as string) as Command,
      attempts: Number(r.attempts),
      availableAt: Number(r.available_at),
      lastError: (r.last_error as string) ?? undefined,
    };
  }

  pendingOutbox(now: number, limit: number): OutboxRecord[] {
    const rows = this.db
      .prepare("SELECT * FROM outbox WHERE status = 'pending' AND available_at <= ? ORDER BY id LIMIT ?")
      .all(now, limit) as Row[];
    return rows.map((r) => this.toOutbox(r));
  }

  completeOutbox(id: number): void {
    this.db.prepare('DELETE FROM outbox WHERE id = ?').run(id);
  }

  failOutbox(id: number, error: string, retryAt: number | null): void {
    if (retryAt === null) {
      this.db.prepare("UPDATE outbox SET attempts = attempts + 1, last_error = ?, status = 'dead' WHERE id = ?").run(error, id);
    } else {
      this.db.prepare('UPDATE outbox SET attempts = attempts + 1, last_error = ?, available_at = ? WHERE id = ?').run(error, retryAt, id);
    }
  }

  deadLetters(limit = 100): OutboxRecord[] {
    const rows = this.db.prepare("SELECT * FROM outbox WHERE status = 'dead' ORDER BY id DESC LIMIT ?").all(limit) as Row[];
    return rows.map((r) => this.toOutbox(r));
  }

  scheduleJob(job: ScheduledJob): void {
    this.db
      .prepare('INSERT INTO jobs (id, due_at, event) VALUES (?, ?, ?) ON CONFLICT(id) DO UPDATE SET due_at = excluded.due_at, event = excluded.event')
      .run(job.id, job.dueAt, JSON.stringify(job.event));
  }

  dueJobs(now: number, limit: number): ScheduledJob[] {
    const rows = this.db.prepare('SELECT * FROM jobs WHERE due_at <= ? ORDER BY due_at LIMIT ?').all(now, limit) as Row[];
    return rows.map((r) => ({ id: r.id as string, dueAt: Number(r.due_at), event: JSON.parse(r.event as string) as InboundEvent }));
  }

  deleteJob(id: string): void {
    this.db.prepare('DELETE FROM jobs WHERE id = ?').run(id);
  }

  saveTicket(t: HandoffTicket): void {
    this.db
      .prepare(
        'INSERT INTO tickets (id, conversation_id, queue, status, data) VALUES (?, ?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET status = excluded.status, queue = excluded.queue, data = excluded.data',
      )
      .run(t.id, t.conversationId, t.queue, t.status, JSON.stringify(t));
  }

  getTicket(id: string): HandoffTicket | undefined {
    const row = this.db.prepare('SELECT data FROM tickets WHERE id = ?').get(id) as Row | undefined;
    return row ? JSON.parse(row.data as string) : undefined;
  }

  openTicketFor(conversationId: string): HandoffTicket | undefined {
    const row = this.db
      .prepare("SELECT data FROM tickets WHERE conversation_id = ? AND status != 'closed' ORDER BY rowid DESC LIMIT 1")
      .get(conversationId) as Row | undefined;
    return row ? JSON.parse(row.data as string) : undefined;
  }

  listTickets(filter: { queue?: string; status?: HandoffTicket['status'] } = {}): HandoffTicket[] {
    const rows = this.db
      .prepare('SELECT data FROM tickets WHERE (? IS NULL OR queue = ?) AND (? IS NULL OR status = ?) ORDER BY rowid')
      .all(filter.queue ?? null, filter.queue ?? null, filter.status ?? null, filter.status ?? null) as Row[];
    return rows.map((r) => JSON.parse(r.data as string));
  }

  pruneProcessedEvents(olderThanMs: number): void {
    this.db.prepare('DELETE FROM processed_events WHERE at < ?').run(Date.now() - olderThanMs);
  }

  close(): void {
    this.db.close();
  }
}
