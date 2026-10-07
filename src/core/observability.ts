/**
 * Logs estruturados (JSON por linha) e métricas em memória.
 * Todo log de transição carrega conversationId, flow@version, nodeId e eventId,
 * permitindo reconstruir qualquer conversa a partir dos logs.
 */

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';
const LEVELS: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };
const REDACT = /(token|secret|password|authorization|apikey|api_key)/i;

export interface Logger {
  debug(msg: string, data?: Record<string, unknown>): void;
  info(msg: string, data?: Record<string, unknown>): void;
  warn(msg: string, data?: Record<string, unknown>): void;
  error(msg: string, data?: Record<string, unknown>): void;
}

function redact(value: unknown, depth = 0): unknown {
  if (depth > 6 || value == null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map((v) => redact(v, depth + 1));
  return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, REDACT.test(k) ? '[REDACTED]' : redact(v, depth + 1)]));
}

export function createLogger(minLevel: LogLevel = 'info', sink: (line: string) => void = (l) => process.stdout.write(l + '\n')): Logger {
  const log = (level: LogLevel) => (msg: string, data: Record<string, unknown> = {}) => {
    if (LEVELS[level] < LEVELS[minLevel]) return;
    sink(JSON.stringify({ ts: new Date().toISOString(), level, msg, ...(redact(data) as object) }));
  };
  return { debug: log('debug'), info: log('info'), warn: log('warn'), error: log('error') };
}

export const silentLogger: Logger = { debug() {}, info() {}, warn() {}, error() {} };

export class Metrics {
  private counters = new Map<string, number>();
  private timings = new Map<string, number[]>();

  inc(name: string, by = 1): void {
    this.counters.set(name, (this.counters.get(name) ?? 0) + by);
  }

  observe(name: string, ms: number): void {
    const arr = this.timings.get(name) ?? [];
    arr.push(ms);
    if (arr.length > 1000) arr.shift();
    this.timings.set(name, arr);
  }

  get(name: string): number {
    return this.counters.get(name) ?? 0;
  }

  snapshot(): { counters: Record<string, number>; timings: Record<string, { count: number; p50: number; p95: number; max: number }> } {
    const pct = (arr: number[], p: number) => {
      const s = [...arr].sort((a, b) => a - b);
      return s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))] ?? 0;
    };
    return {
      counters: Object.fromEntries(this.counters),
      timings: Object.fromEntries(
        [...this.timings].map(([k, v]) => [k, { count: v.length, p50: pct(v, 50), p95: pct(v, 95), max: Math.max(0, ...v) }]),
      ),
    };
  }
}
