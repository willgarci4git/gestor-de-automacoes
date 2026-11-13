/**
 * Testes negativos de segurança das correções P1/P2 (claude/seguranca-modelo-ameacas.md):
 * T4 sessão assinada do webchat, T6 ticket do SSE, T7 limites, T8 ReDoS, T9 criptografia em repouso,
 * T10 operadores + auditoria, T11 allowlist de tenants, T12 cabeçalhos/CSP, T13 mídia https, T15 verify token.
 */
import { test, after, before } from 'node:test';
import assert from 'node:assert/strict';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdtempSync, readFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { createBotApp, type BotApp } from '../src/runtime/app.ts';
import { SqliteStorage, FieldCipher } from '../src/storage/sqlite.ts';
import { WhatsAppChannel } from '../src/channels/whatsapp.ts';
import { createHttpServer, cspFor, RateLimiter } from '../src/server/http.ts';
import { validateFlow, unsafeRegexReason } from '../src/core/validator.ts';
import { validateAnswer } from '../src/core/input-validators.ts';
import { checkStartupSecurity, parseOperatorTokens } from '../src/server/security.ts';
import { BUSINESS_HOURS } from './helpers.ts';

const ANA = 'a'.repeat(40);
const BRUNO = 'b'.repeat(40);
const logs: { msg: string; data: Record<string, unknown> }[] = [];
const logger = Object.fromEntries(['debug', 'info', 'warn', 'error'].map((l) => [l, (msg: string, data: Record<string, unknown> = {}) => logs.push({ msg, data })])) as any;

let app: BotApp;
let server: Server;
let base = '';

before(async () => {
  app = createBotApp({
    storage: new SqliteStorage(':memory:'),
    flowsDir: new URL('../flows', import.meta.url).pathname,
    tenantsDir: new URL('../tenants', import.meta.url).pathname,
    adapters: [],
    logger,
    clock: () => BUSINESS_HOURS,
  });
  app.start();
  server = createHttpServer(app, {
    tenantId: 'clinica',
    adminTokens: { ana: ANA, bruno: BRUNO },
    publicDir: new URL('../public', import.meta.url).pathname,
    webchat: { secret: 'segredo-de-teste-do-webchat-com-32+chars' },
    limits: { webchatPerConversationPerMin: 5, sessionsPerIpPerMin: 50, authFailuresPerIpPerMin: 3, ssePerIp: 2 },
  });
  base = await new Promise<string>((r) => server.listen(0, '127.0.0.1', () => r(`http://127.0.0.1:${(server.address() as AddressInfo).port}`)));
});

after(() => {
  app.stop();
  server.close();
});

const session = async (tenant = 'clinica') => (await fetch(`${base}/webchat/${tenant}/session`, { method: 'POST' })).json() as Promise<{ userId: string; token: string }>;
const send = (s: { userId: string; token?: string }, text: string, tenant = 'clinica') =>
  fetch(`${base}/webchat/${tenant}/messages`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(s.token ? { 'x-webchat-token': s.token } : {}) },
    body: JSON.stringify({ userId: s.userId, text }),
  });

// ---------------------------------------------------------------- T4 / T11
test('T4: webchat exige sessão emitida pelo servidor; id escolhido pelo cliente é recusado', async () => {
  const s = await session();
  assert.match(s.userId, /^w[0-9a-f]{32}$/);
  assert.equal((await send(s, 'oi')).status, 202);
  assert.equal((await send({ userId: 'ana' }, 'oi')).status, 401);
  assert.equal((await send({ userId: s.userId, token: 'x'.repeat(s.token.length) }, 'oi')).status, 401);
});

test('T4: IDOR — a sessão de um usuário não lê nem escuta a conversa de outro', async () => {
  const vitima = await session();
  const atacante = await session();
  await send(vitima, 'oi');
  const r = await fetch(`${base}/webchat/clinica/history?userId=${vitima.userId}`, { headers: { 'x-webchat-token': atacante.token } });
  assert.equal(r.status, 401);
  const ok = await fetch(`${base}/webchat/clinica/history?userId=${vitima.userId}`, { headers: { 'x-webchat-token': vitima.token } });
  assert.equal(ok.status, 200);
  const sse = await fetch(`${base}/webchat/clinica/stream?userId=${vitima.userId}&wt=${encodeURIComponent(atacante.token)}`);
  assert.equal(sse.status, 401);
});

test('T11: tenant fora da allowlist do webchat não é atendido', async () => {
  assert.equal((await fetch(`${base}/webchat/oficina/session`, { method: 'POST' })).status, 404);
  const s = await session();
  assert.equal((await send(s, 'oi', 'oficina')).status, 404);
});

// ---------------------------------------------------------------- T7
test('T7: limite de mensagens por conversa responde 429 com Retry-After', async () => {
  const s = await session();
  const codes: number[] = [];
  for (let i = 0; i < 7; i++) codes.push((await send(s, `msg ${i}`)).status);
  assert.ok(codes.includes(429), String(codes));
  const r = await send(s, 'mais uma');
  assert.equal(r.status, 429);
  assert.ok(Number(r.headers.get('retry-after')) > 0);
});

test('T7: conexões SSE simultâneas por IP são limitadas', async () => {
  const s = await session();
  const url = `${base}/webchat/clinica/stream?userId=${s.userId}&wt=${encodeURIComponent(s.token)}`;
  const ac = new AbortController();
  const a = await fetch(url, { signal: ac.signal });
  const b = await fetch(url, { signal: ac.signal });
  const c = await fetch(url, { signal: ac.signal });
  assert.deepEqual([a.status, b.status, c.status], [200, 200, 429]);
  ac.abort();
});

test('T7: RateLimiter reinicia a janela', () => {
  let t = 0;
  const rl = new RateLimiter(() => t);
  assert.equal(rl.take('k', 2), 0);
  assert.equal(rl.take('k', 2), 0);
  assert.ok(rl.take('k', 2) > 0);
  t = 61_000;
  assert.equal(rl.take('k', 2), 0);
});

// ---------------------------------------------------------------- T6 / T10
test('T6: token na URL não autentica; ticket do SSE é de uso único', async () => {
  assert.equal((await fetch(`${base}/admin/flows?token=${ANA}`)).status, 401);
  const { ticket } = await (await fetch(`${base}/handoff/stream-ticket`, { method: 'POST', headers: { 'x-admin-token': ANA } })).json();
  const ac = new AbortController();
  const first = await fetch(`${base}/handoff/stream?ticket=${ticket}`, { signal: ac.signal });
  assert.equal(first.status, 200);
  ac.abort();
  const reused = await fetch(`${base}/handoff/stream?ticket=${ticket}`);
  assert.equal(reused.status, 401);
});

test('T10: cada operador tem seu token e a auditoria registra quem agiu', async () => {
  logs.length = 0;
  assert.equal((await fetch(`${base}/admin/sessions/x`, { headers: { 'x-admin-token': BRUNO } })).status, 200);
  const entry = logs.find((l) => l.msg === 'audit' && l.data.action === 'session_read');
  assert.equal(entry?.data.actor, 'bruno');
  assert.deepEqual(parseOperatorTokens(`ana:${ANA},bruno:${BRUNO}`), { ana: ANA, bruno: BRUNO });
  assert.ok(checkStartupSecurity({ NODE_ENV: 'production', ADMIN_TOKENS: `ana:${ANA},bruno:${ANA}` }).fatal, 'tokens repetidos');
  assert.ok(checkStartupSecurity({ NODE_ENV: 'production', ADMIN_TOKEN: ANA, WEBCHAT_AUTH: 'off' }).fatal, 'webchat sem sessão em produção');
});

test('T10/T7: falhas de autenticação repetidas viram 429 e ficam na auditoria', async () => {
  logs.length = 0;
  const codes: number[] = [];
  for (let i = 0; i < 5; i++) codes.push((await fetch(`${base}/admin/tenants`, { headers: { 'x-admin-token': 'errado' } })).status);
  // O limite (3/min neste servidor) conta as falhas anteriores do mesmo IP, inclusive as de outros testes.
  assert.equal(codes[0] === 401 || codes[0] === 429, true);
  assert.equal(codes[4], 429);
  assert.ok(codes.every((c) => c === 401 || c === 429));
  assert.ok(logs.some((l) => l.msg === 'audit' && l.data.action === 'auth_failed'));
});

// ---------------------------------------------------------------- T12
test('T12: páginas saem com CSP por hash e cabeçalhos de proteção', async () => {
  for (const path of ['/', '/agent']) {
    const r = await fetch(base + path);
    const csp = r.headers.get('content-security-policy') ?? '';
    assert.match(csp, /frame-ancestors 'none'/);
    assert.match(csp, /script-src 'self' 'sha256-/);
    assert.ok(!csp.includes('unsafe-inline'));
    assert.equal(r.headers.get('x-frame-options'), 'DENY');
    assert.equal(r.headers.get('referrer-policy'), 'no-referrer');
  }
  const html = readFileSync(new URL('../public/agent.html', import.meta.url), 'utf8');
  assert.equal(cspFor(html), cspFor(html));
  assert.ok(!html.includes('?token='), 'console não pode mandar o token na URL');
  assert.ok(!/localStorage\.setItem\(['"]ag_token/.test(html), 'console não pode persistir o token');
});

// ---------------------------------------------------------------- T8 / T13
test('T8: regex com risco de ReDoS é recusada; entrada é limitada', () => {
  assert.ok(unsafeRegexReason('(a+)+$'));
  assert.ok(unsafeRegexReason('(a|aa)+'));
  assert.equal(unsafeRegexReason('^\\d{5}-?\\d{3}$'), null);
  const f = (pattern: string) => ({
    id: 'r', version: 1, start: 'p', triggers: [{ kind: 'default' }],
    nodes: { p: { type: 'input', prompt: 'x', saveTo: 'flow.x', validator: { kind: 'regex', pattern }, next: 'f' }, f: { type: 'end' } },
  }) as any;
  assert.equal(validateFlow(f('(x+)+y')).ok, false);
  assert.equal(validateFlow(f('^\\d+$')).ok, true);
  const t0 = performance.now();
  validateAnswer({ kind: 'regex', pattern: '^(a|b)*c$' } as any, 'a'.repeat(5000));
  assert.ok(performance.now() - t0 < 200);
});

test('T13: mídia de fluxo só por https; widget não cria link fora de https', () => {
  const f = (url: string) => ({ id: 'm', version: 1, start: 'a', triggers: [{ kind: 'default' }], nodes: { a: { type: 'message', media: { kind: 'document', url }, next: 'b' }, b: { type: 'end' } } }) as any;
  assert.equal(validateFlow(f('javascript:alert(1)')).ok, false);
  assert.equal(validateFlow(f('http://exemplo.com/a.pdf')).ok, false);
  assert.equal(validateFlow(f('https://exemplo.com/a.pdf')).ok, true);
  assert.equal(validateFlow(f('{{flow.link}}')).ok, true);
  const html = readFileSync(new URL('../public/webchat.html', import.meta.url), 'utf8');
  assert.match(html, /\/\^https:/);
});

// ---------------------------------------------------------------- T15
test('T15: verify token da Meta continua funcionando com comparação em tempo constante', () => {
  const wa = new WhatsAppChannel({ phoneNumberId: 'p', accessToken: 't', appSecret: 's', verifyToken: 'vt-123' });
  const q = (t: string) => new URLSearchParams({ 'hub.mode': 'subscribe', 'hub.verify_token': t, 'hub.challenge': 'ok' });
  assert.equal(wa.verifyChallenge(q('vt-123')), 'ok');
  assert.equal(wa.verifyChallenge(q('vt-12')), null);
  assert.equal(wa.verifyChallenge(q('vt-124')), null);
});

// ---------------------------------------------------------------- T9
test('T9: dados em repouso cifrados (AES-256-GCM), arquivo 0600, linhas antigas legíveis', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ga-enc-'));
  const path = join(dir, 'bot.db');
  const key = 'f'.repeat(64);
  const st = new SqliteStorage(path, { encryptionKey: key });
  const contact = { conversationId: 'clinica:webchat:u1', tenantId: 'clinica', channel: 'webchat', userId: 'u1', tags: ['vip'], fields: { cpf: '12345678909', full_name: 'Ana Souza' } } as any;
  const sessionRow = { conversationId: contact.conversationId, rev: 1, updatedAt: new Date().toISOString(), vars: { session: { nota: 'CPF 12345678909' }, flow: {} } } as any;
  st.commitTurn({ eventId: 'e1', expectedRev: 0, session: sessionRow, contact, commands: [] });
  st.close();
  const rawDb = new DatabaseSync(path);
  const raw = rawDb.prepare('SELECT data FROM contacts').get() as { data: string };
  const rawSession = rawDb.prepare('SELECT data FROM sessions').get() as { data: string };
  rawDb.close();
  assert.ok(!rawSession.data.includes('12345678909'));
  assert.match(raw.data, /^enc:v1:/);
  assert.ok(!raw.data.includes('12345678909') && !raw.data.includes('Ana'));
  assert.equal(statSync(path).mode & 0o777, 0o600);

  const again = new SqliteStorage(path, { encryptionKey: key });
  assert.equal(again.getContact('clinica:webchat:u1')?.fields.cpf, '12345678909');
  assert.equal(again.listContacts({ tag: 'vip' }).length, 1);
  assert.equal(again.listContacts({ tag: 'outra' }).length, 0);
  assert.throws(() => new SqliteStorage(path).getContact('clinica:webchat:u1'), /DATA_ENCRYPTION_KEY/);

  const c = new FieldCipher(key);
  assert.equal(c.open('{"legado":true}'), '{"legado":true}');
  assert.throws(() => new FieldCipher('g'.repeat(64)).open(c.seal('x')));
  assert.throws(() => new FieldCipher('curta'));
});
