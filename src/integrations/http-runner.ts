/**
 * Executor de integrações HTTP com resiliência:
 *  - timeout por tentativa (AbortController)
 *  - retry com backoff exponencial + jitter, apenas para falhas transitórias (rede, timeout, 429, 5xx)
 *  - circuit breaker por host: após N falhas seguidas, falha rápido por um período (protege a API
 *    externa e evita que o usuário espere timeouts em cascata)
 * O resultado NUNCA lança exceção: vira `integration_result` com ok=false e o fluxo segue por onError.
 */
import type { HttpRequestSpec } from '../core/types.ts';
import { resolveSecrets } from '../core/context.ts';

export interface HttpResult {
  ok: boolean;
  status?: number;
  body?: unknown;
  error?: string;
  attempts: number;
  durationMs: number;
}

export class CircuitBreaker {
  private readonly state = new Map<string, { failures: number; openedAt?: number }>();
  readonly failureThreshold: number;
  readonly resetMs: number;
  private readonly now: () => number;

  constructor(opts: { failureThreshold?: number; resetMs?: number; now?: () => number } = {}) {
    this.failureThreshold = opts.failureThreshold ?? 5;
    this.resetMs = opts.resetMs ?? 30_000;
    this.now = opts.now ?? Date.now;
  }

  /** closed = normal, open = falhando rápido, half-open = deixa uma tentativa passar. */
  status(key: string): 'closed' | 'open' | 'half-open' {
    const s = this.state.get(key);
    if (s?.openedAt === undefined) return 'closed';
    return this.now() - s.openedAt >= this.resetMs ? 'half-open' : 'open';
  }

  success(key: string): void {
    this.state.delete(key);
  }

  failure(key: string): void {
    const s = this.state.get(key) ?? { failures: 0 };
    s.failures++;
    if (s.failures >= this.failureThreshold || s.openedAt !== undefined) s.openedAt = this.now();
    this.state.set(key, s);
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const isTransient = (status: number) => status === 408 || status === 429 || status >= 500;

export interface HttpRunnerOptions {
  timeoutMs: number;
  retry: { max: number; backoffMs: number };
  getSecret: (name: string) => string | undefined;
  breaker: CircuitBreaker;
  fetchImpl?: typeof fetch;
}

export async function runHttp(spec: HttpRequestSpec, opts: HttpRunnerOptions): Promise<HttpResult> {
  const started = Date.now();
  let resolved: HttpRequestSpec;
  try {
    resolved = resolveSecrets(spec, opts.getSecret) as HttpRequestSpec;
  } catch (e) {
    return { ok: false, error: String((e as Error).message), attempts: 0, durationMs: 0 };
  }
  const key = new URL(resolved.url).host;
  const doFetch = opts.fetchImpl ?? fetch;
  let lastError = '';
  let lastStatus: number | undefined;
  let retryAfterMs: number | undefined;

  for (let attempt = 1; attempt <= opts.retry.max + 1; attempt++) {
    if (opts.breaker.status(key) === 'open') {
      return { ok: false, error: `circuit_open:${key}`, attempts: attempt - 1, durationMs: Date.now() - started };
    }
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), opts.timeoutMs);
    try {
      const hasBody = resolved.body !== undefined && resolved.method !== 'GET';
      const res = await doFetch(resolved.url, {
        method: resolved.method,
        headers: { ...(hasBody ? { 'content-type': 'application/json' } : {}), ...resolved.headers },
        body: hasBody ? (typeof resolved.body === 'string' ? resolved.body : JSON.stringify(resolved.body)) : undefined,
        signal: ac.signal,
        redirect: 'follow',
      });
      const text = await res.text();
      let body: unknown = text;
      if ((res.headers.get('content-type') ?? '').includes('json')) {
        try {
          body = JSON.parse(text);
        } catch {
          /* mantém texto */
        }
      }
      lastStatus = res.status;
      if (res.ok) {
        opts.breaker.success(key);
        return { ok: true, status: res.status, body, attempts: attempt, durationMs: Date.now() - started };
      }
      lastError = `http_${res.status}`;
      if (!isTransient(res.status)) {
        // 4xx: erro de contrato/dados; repetir não resolve e não indica indisponibilidade do host.
        return { ok: false, status: res.status, body, error: lastError, attempts: attempt, durationMs: Date.now() - started };
      }
      // Respeita Retry-After (segundos) em 429/503, limitado a 30s para não prender a conversa.
      const ra = Number(res.headers.get('retry-after'));
      retryAfterMs = Number.isFinite(ra) && ra > 0 ? Math.min(ra * 1000, 30_000) : undefined;
      if (res.status !== 429) opts.breaker.failure(key); // 429 = limite de taxa, não indisponibilidade
    } catch (e) {
      lastError = ac.signal.aborted ? 'timeout' : `network:${(e as Error).message}`;
      opts.breaker.failure(key);
    } finally {
      clearTimeout(timer);
    }
    if (attempt <= opts.retry.max) {
      const backoff = opts.retry.backoffMs * 2 ** (attempt - 1);
      await sleep(retryAfterMs ?? backoff / 2 + Math.random() * (backoff / 2));
      retryAfterMs = undefined;
    }
  }
  return { ok: false, status: lastStatus, error: lastError, attempts: opts.retry.max + 1, durationMs: Date.now() - started };
}
