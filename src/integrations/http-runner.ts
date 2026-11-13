/**
 * Executor de integrações HTTP com resiliência:
 *  - timeout por tentativa (AbortController)
 *  - retry com backoff exponencial + jitter, apenas para falhas transitórias (rede, timeout, 429, 5xx)
 *  - circuit breaker por host: após N falhas seguidas, falha rápido por um período (protege a API
 *    externa e evita que o usuário espere timeouts em cascata)
 *  - proteção contra SSRF (T3): só https, allowlist de hosts, bloqueio de endereços internos
 *    (loopback, privados, link-local/metadados de nuvem) e redirecionamentos revalidados a cada salto
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
  /**
   * Hosts permitidos (ex.: ["script.google.com", "*.hubspot.com"]). Padrão: INTEGRATION_ALLOWED_HOSTS
   * (lista separada por vírgula). Em produção (NODE_ENV=production) a lista é obrigatória: sem ela,
   * toda integração é recusada (secure by default). Fora de produção, vazio = qualquer host público.
   */
  allowedHosts?: string[];
  /** Permite http:// e destinos de rede interna. Só para desenvolvimento local. Padrão: false. */
  allowPrivateNetwork?: boolean;
  /** Resolve o DNS do host para checar endereços internos. Padrão: node:dns (desligado quando fetchImpl é injetado em testes). */
  resolveHost?: ((host: string) => Promise<string[]>) | null;
  /** Máximo de redirecionamentos seguidos (cada destino é revalidado). Padrão: 3. */
  maxRedirects?: number;
}

// O mesmo módulo roda no Studio (navegador): sem imports estáticos de node:* e sem depender de process.
const env = (): Record<string, string | undefined> => (globalThis as { process?: { env: Record<string, string | undefined> } }).process?.env ?? {};
const isProduction = () => env().NODE_ENV === 'production';
const envAllowedHosts = () =>
  (env().INTEGRATION_ALLOWED_HOSTS ?? '').split(',').map((h) => h.trim().toLowerCase()).filter(Boolean);

const DNS_MODULE = 'node:dns/promises';
const defaultResolve = async (host: string) => {
  const { lookup } = (await import(DNS_MODULE)) as typeof import('node:dns/promises');
  return (await lookup(host, { all: true, verbatim: true })).map((a) => a.address);
};

const IPV4_RE = /^(25[0-5]|2[0-4]\d|1?\d?\d)(\.(25[0-5]|2[0-4]\d|1?\d?\d)){3}$/;
/** 4, 6 ou 0 — equivalente a net.isIP, sem depender de node:net. */
export function isIP(a: string): 0 | 4 | 6 {
  if (IPV4_RE.test(a)) return 4;
  return a.includes(':') && /^[0-9a-f:.]+$/i.test(a) ? 6 : 0;
}

/** Expande um IPv6 para 8 grupos de 16 bits (aceita sufixo IPv4). null se inválido. */
function ipv6Groups(ip: string): number[] | null {
  let a = ip.toLowerCase();
  const v4 = /(\d+\.\d+\.\d+\.\d+)$/.exec(a);
  if (v4) {
    const o = v4[1].split('.').map(Number);
    a = a.slice(0, -v4[1].length) + ((o[0] << 8) | o[1]).toString(16) + ':' + ((o[2] << 8) | o[3]).toString(16);
  }
  const [head, tail] = a.split('::');
  if (a.split('::').length > 2) return null;
  const h = head ? head.split(':') : [];
  const t = tail !== undefined ? (tail ? tail.split(':') : []) : [];
  const fill = tail !== undefined ? 8 - h.length - t.length : 0;
  if (fill < 0) return null;
  const groups = [...h, ...Array(fill).fill('0'), ...t];
  if (groups.length !== 8 || groups.some((g) => !/^[0-9a-f]{1,4}$/.test(g))) return null;
  return groups.map((g) => parseInt(g, 16));
}

function ipv4Internal(a: string): boolean {
  const [x, y] = a.split('.').map(Number);
  return x === 0 || x === 10 || x === 127 || (x === 100 && y >= 64 && y <= 127) || (x === 169 && y === 254) ||
    (x === 172 && y >= 16 && y <= 31) || (x === 192 && y === 168) || (x === 198 && (y === 18 || y === 19)) || x >= 224;
}

/** Loopback, privados (RFC 1918), CGNAT, link-local (metadados de nuvem 169.254.169.254), ULA e afins. */
export function isInternalAddress(ip: string): boolean {
  const a = ip.toLowerCase().replace(/^\[|\]$/g, '');
  if (isIP(a) === 4) return ipv4Internal(a);
  if (isIP(a) !== 6) return false;
  const g = ipv6Groups(a);
  if (!g) return true; // grafia inesperada: trata como interna (fail-closed)
  const zeros5 = g.slice(0, 5).every((x) => x === 0);
  // IPv4 mapeado (::ffff:a.b.c.d) ou compatível (::a.b.c.d): avalia o IPv4 embutido.
  if (zeros5 && (g[5] === 0xffff || (g[5] === 0 && (g[6] !== 0 || g[7] > 1)))) {
    return ipv4Internal(`${g[6] >> 8}.${g[6] & 255}.${g[7] >> 8}.${g[7] & 255}`);
  }
  if (g.every((x, i) => x === (i === 7 ? 1 : 0)) || g.every((x) => x === 0)) return true; // ::1 e ::
  if ((g[0] & 0xfe00) === 0xfc00) return true; // fc00::/7 (ULA)
  if ((g[0] & 0xffc0) === 0xfe80) return true; // fe80::/10 (link-local)
  if ((g[0] & 0xff00) === 0xff00) return true; // multicast
  if (g[0] === 0x64 && g[1] === 0xff9b) return ipv4Internal(`${g[6] >> 8}.${g[6] & 255}.${g[7] >> 8}.${g[7] & 255}`); // NAT64
  return false;
}

export function hostAllowed(host: string, allowed: string[]): boolean {
  const h = host.toLowerCase();
  return allowed.some((p) => (p.startsWith('*.') ? h.endsWith(p.slice(1)) && h.length > p.length - 1 : h === p));
}

/** Valida um destino antes de cada tentativa e de cada redirecionamento. Retorna o motivo da recusa. */
async function checkDestination(url: URL, opts: HttpRunnerOptions): Promise<string | null> {
  // Rede interna só por opção explícita (ou INTEGRATION_ALLOW_PRIVATE_NETWORK=1 fora de produção).
  const allowPrivate = (opts.allowPrivateNetwork ?? env().INTEGRATION_ALLOW_PRIVATE_NETWORK === '1') && !isProduction();
  if (url.protocol !== 'https:' && !(allowPrivate && url.protocol === 'http:')) return `protocol_not_allowed:${url.protocol}`;
  if (url.username || url.password) return 'credentials_in_url_not_allowed';
  const host = url.hostname.replace(/^\[|\]$/g, '');
  const allowed = opts.allowedHosts ?? envAllowedHosts();
  if (allowed.length) {
    if (!hostAllowed(host, allowed)) return `host_not_allowed:${host}`;
  } else if (isProduction()) {
    return `host_not_allowed:${host} (defina INTEGRATION_ALLOWED_HOSTS)`;
  }
  if (allowPrivate) return null;
  if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.internal')) return `internal_host_blocked:${host}`;
  if (isIP(host)) return isInternalAddress(host) ? `internal_address_blocked:${host}` : null;
  const resolver = opts.resolveHost === undefined ? (opts.fetchImpl ? null : defaultResolve) : opts.resolveHost;
  if (resolver) {
    let addrs: string[];
    try {
      addrs = await resolver(host);
    } catch (e) {
      return `dns_error:${(e as Error).message}`;
    }
    const bad = addrs.find(isInternalAddress);
    if (bad) return `internal_address_blocked:${host}->${bad}`;
  }
  return null;
}

export async function runHttp(spec: HttpRequestSpec, opts: HttpRunnerOptions): Promise<HttpResult> {
  const started = Date.now();
  let resolved: HttpRequestSpec;
  try {
    resolved = resolveSecrets(spec, opts.getSecret) as HttpRequestSpec;
  } catch (e) {
    return { ok: false, error: String((e as Error).message), attempts: 0, durationMs: 0 };
  }
  let key: string;
  try {
    key = new URL(resolved.url).host;
  } catch {
    return { ok: false, error: 'invalid_url', attempts: 0, durationMs: 0 };
  }
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
      let url = new URL(resolved.url);
      let method = resolved.method;
      let headers: Record<string, string> = { ...resolved.headers };
      let reqBody: string | undefined =
        resolved.body !== undefined && method !== 'GET' ? (typeof resolved.body === 'string' ? resolved.body : JSON.stringify(resolved.body)) : undefined;
      if (reqBody !== undefined) headers = { 'content-type': 'application/json', ...headers };
      let res: Response;
      for (let hop = 0; ; hop++) {
        const blocked = await checkDestination(url, opts);
        if (blocked) return { ok: false, error: blocked, attempts: attempt, durationMs: Date.now() - started };
        res = await doFetch(url.toString(), { method, headers, body: reqBody, signal: ac.signal, redirect: 'manual' });
        const loc = res.headers.get('location');
        if (![301, 302, 303, 307, 308].includes(res.status) || !loc) break;
        if (hop >= (opts.maxRedirects ?? 3)) return { ok: false, status: res.status, error: 'too_many_redirects', attempts: attempt, durationMs: Date.now() - started };
        const next = new URL(loc, url);
        // Cabeçalhos de credencial não seguem para outro host (evita vazar segredos em redirecionamento).
        if (next.host !== url.host) headers = Object.fromEntries(Object.entries(headers).filter(([k]) => !/^(authorization|cookie|x-api-key)$/i.test(k)));
        if (res.status === 303 || ((res.status === 301 || res.status === 302) && method !== 'GET' && method !== 'HEAD')) {
          method = 'GET';
          reqBody = undefined;
          headers = Object.fromEntries(Object.entries(headers).filter(([k]) => k.toLowerCase() !== 'content-type'));
        }
        await res.body?.cancel().catch(() => {});
        url = next;
      }
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
