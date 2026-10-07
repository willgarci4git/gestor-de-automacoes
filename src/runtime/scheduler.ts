/**
 * Scheduler persistente: timeouts de pergunta, nós "wait" e SLA de transbordo.
 * Jobs ficam no storage (sobrevivem a reinícios com SQLite). Jobs obsoletos são inofensivos:
 * o motor descarta eventos cujo token não corresponde ao ponto de espera atual.
 */
import type { InboundEvent } from '../core/types.ts';
import type { Storage } from '../storage/types.ts';
import { silentLogger, type Logger } from '../core/observability.ts';

export class Scheduler {
  private timer?: NodeJS.Timeout;
  private ticking = false;
  private readonly storage: Storage;
  private readonly dispatchEvent: (ev: InboundEvent) => Promise<unknown>;
  private readonly logger: Logger;
  private readonly clock?: () => Date;

  constructor(storage: Storage, dispatchEvent: (ev: InboundEvent) => Promise<unknown>, logger: Logger = silentLogger, clock?: () => Date) {
    this.clock = clock;
    this.storage = storage;
    this.dispatchEvent = dispatchEvent;
    this.logger = logger;
  }

  start(intervalMs = 500): void {
    this.timer = setInterval(() => void this.tick(), intervalMs);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
  }

  async tick(now = (this.clock?.() ?? new Date()).getTime()): Promise<number> {
    if (this.ticking) return 0;
    this.ticking = true;
    let fired = 0;
    try {
      for (const job of this.storage.dueJobs(now, 100)) {
        try {
          await this.dispatchEvent(job.event);
          this.storage.deleteJob(job.id);
          fired++;
        } catch (err) {
          this.logger.error('scheduler_job_failed', { jobId: job.id, error: String(err) });
        }
      }
    } finally {
      this.ticking = false;
    }
    return fired;
  }
}
