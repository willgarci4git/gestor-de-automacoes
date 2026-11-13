/**
 * Testes negativos de segurança (revisão STRIDE × CIAND, claude/seguranca-modelo-ameacas.md).
 * Cobrem as correções P0: T1 (fail-closed), T2 (injeção de segredos), T3 (SSRF) e T5 (path traversal).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, writeFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { renderDeep, renderTemplate, resolveSecrets, neutralizeTemplateMarkers } from '../src/core/context.ts';
import { runHttp, CircuitBreaker, isInternalAddress, hostAllowed } from '../src/integrations/http-runner.ts';
import { validateFlow } from '../src/core/validator.ts';
import { checkStartupSecurity } from '../src/server/security.ts';

const root = resolve(import.meta.dirname, '..');
const ctxWith = (vals: Record<string, unknown>) => ({ get: (p: string) => vals[p] }) as any;
const secret = (n: string) => (n === 'LEADS' ? 'SEGREDO-REAL-123' : undefined);

// ---------------------------------------------------------------- T2
test('T2: valor digitado pelo usuário com {{secrets.X}} não é expandido para o segredo', () => {
  const ctx = ctxWith({ 'contact.name': 'Ana {{secrets.LEADS}}', 'contact.obj': { a: '{{ secrets.LEADS }}' } });
  const spec = {
    method: 'POST',
    url: 'https://crm.exemplo/api?q={{contact.name}}',
    headers: { authorization: 'Bearer {{secrets.LEADS}}' },
    body: { nome: '{{contact.name}}', frase: 'Olá {{contact.name}}', obj: '{{contact.obj}}' },
  };
  const out = resolveSecrets(renderDeep(spec, ctx), secret) as any;
  const flat = JSON.stringify({ url: out.url, body: out.body });
  assert.ok(!flat.includes('SEGREDO-REAL-123'), `segredo vazou em dados do usuário: ${flat}`);
  // O placeholder escrito pelo autor do fluxo continua funcionando.
  assert.equal(out.headers.authorization, 'Bearer SEGREDO-REAL-123');
});

test('T2: neutralização preserva o texto legível e tipos não textuais', () => {
  assert.equal(neutralizeTemplateMarkers('a {{b}} c'), 'a { {b} } c');
  assert.equal(neutralizeTemplateMarkers(42), 42);
  assert.equal(renderTemplate('Oi {{contact.n}}', ctxWith({ 'contact.n': 'Bia' })), 'Oi Bia');
});

// ---------------------------------------------------------------- T3
const okFetch = (log: string[]) =>
  (async (url: string) => {
    log.push(String(url));
    return new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } });
  }) as unknown as typeof fetch;
const base = (extra: object = {}) => ({ timeoutMs: 500, retry: { max: 0, backoffMs: 1 }, getSecret: secret, breaker: new CircuitBreaker(), ...extra });

test('T3: SSRF — endereços internos e metadados de nuvem são bloqueados sem chamar a rede', async () => {
  for (const url of [
    'https://127.0.0.1/x', 'https://169.254.169.254/latest/meta-data/', 'https://10.0.0.5/', 'https://192.168.1.1/',
    'https://[::1]/', 'https://[::ffff:127.0.0.1]/', 'https://localhost/', 'https://metadata.google.internal/',
  ]) {
    const log: string[] = [];
    const r = await runHttp({ method: 'GET', url }, base({ fetchImpl: okFetch(log) }));
    assert.equal(r.ok, false, url);
    assert.match(r.error ?? '', /internal_(address|host)_blocked/, url);
    assert.equal(log.length, 0, `não deveria chamar ${url}`);
  }
});

test('T3: SSRF — DNS que aponta para rede interna é bloqueado (DNS rebinding simples)', async () => {
  const log: string[] = [];
  const r = await runHttp({ method: 'GET', url: 'https://evil.example/' }, base({ fetchImpl: okFetch(log), resolveHost: async () => ['10.1.2.3'] }));
  assert.equal(r.ok, false);
  assert.match(r.error ?? '', /internal_address_blocked/);
  assert.equal(log.length, 0);
});

test('T3: só https, sem credenciais na URL, allowlist com curinga', async () => {
  const log: string[] = [];
  assert.match((await runHttp({ method: 'GET', url: 'http://api.x/' }, base({ fetchImpl: okFetch(log) }))).error ?? '', /protocol_not_allowed/);
  assert.match((await runHttp({ method: 'GET', url: 'https://u:p@api.x/' }, base({ fetchImpl: okFetch(log) }))).error ?? '', /credentials/);
  const allow = { allowedHosts: ['script.google.com', '*.hubspot.com'] };
  assert.match((await runHttp({ method: 'GET', url: 'https://evil.com/' }, base({ fetchImpl: okFetch(log), ...allow }))).error ?? '', /host_not_allowed/);
  assert.equal((await runHttp({ method: 'GET', url: 'https://api.hubspot.com/' }, base({ fetchImpl: okFetch(log), ...allow }))).ok, true);
  assert.equal(hostAllowed('hubspot.com.evil.com', ['*.hubspot.com']), false);
  assert.equal(log.length, 1);
});

test('T3: redirecionamento para destino interno é bloqueado; credenciais não seguem para outro host', async () => {
  const seen: { url: string; auth?: string }[] = [];
  const redirecting = (async (url: string, init: RequestInit) => {
    seen.push({ url: String(url), auth: (init.headers as Record<string, string>)?.authorization });
    if (String(url).startsWith('https://api.x/')) return new Response(null, { status: 302, headers: { location: 'https://169.254.169.254/latest' } });
    return new Response('{}', { status: 200 });
  }) as unknown as typeof fetch;
  const r = await runHttp({ method: 'GET', url: 'https://api.x/start', headers: { authorization: 'Bearer {{secrets.LEADS}}' } }, base({ fetchImpl: redirecting }));
  assert.equal(r.ok, false);
  assert.match(r.error ?? '', /internal_address_blocked/);
  assert.equal(seen.length, 1);

  const hop = (async (url: string, init: RequestInit) => {
    seen.push({ url: String(url), auth: (init.headers as Record<string, string>)?.authorization });
    if (String(url).startsWith('https://a.x/')) return new Response(null, { status: 302, headers: { location: 'https://b.x/final' } });
    return new Response('{}', { status: 200 });
  }) as unknown as typeof fetch;
  seen.length = 0;
  const ok = await runHttp({ method: 'POST', url: 'https://a.x/', headers: { authorization: 'Bearer t' }, body: { a: 1 } }, base({ fetchImpl: hop }));
  assert.equal(ok.ok, true);
  assert.equal(seen[1].url, 'https://b.x/final');
  assert.equal(seen[1].auth, undefined, 'Authorization não pode seguir para outro host');
});

test('T3: em produção, sem INTEGRATION_ALLOWED_HOSTS, nenhuma integração sai', async () => {
  const prev = { env: process.env.NODE_ENV, hosts: process.env.INTEGRATION_ALLOWED_HOSTS, priv: process.env.INTEGRATION_ALLOW_PRIVATE_NETWORK };
  process.env.NODE_ENV = 'production';
  delete process.env.INTEGRATION_ALLOWED_HOSTS;
  process.env.INTEGRATION_ALLOW_PRIVATE_NETWORK = '1'; // ignorado em produção
  try {
    const log: string[] = [];
    const r = await runHttp({ method: 'GET', url: 'https://api.publica.com/' }, base({ fetchImpl: okFetch(log) }));
    assert.match(r.error ?? '', /host_not_allowed/);
    const p = await runHttp({ method: 'GET', url: 'http://127.0.0.1:9/' }, base({ fetchImpl: okFetch(log) }));
    assert.equal(p.ok, false);
    assert.equal(log.length, 0);
  } finally {
    for (const [k, v] of [['NODE_ENV', prev.env], ['INTEGRATION_ALLOWED_HOSTS', prev.hosts], ['INTEGRATION_ALLOW_PRIVATE_NETWORK', prev.priv]] as const) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
});

test('T3: classificação de endereços', () => {
  for (const ip of ['127.0.0.1', '10.9.9.9', '172.16.0.1', '172.31.255.255', '192.168.0.1', '169.254.169.254', '100.64.0.1', '0.0.0.0', '::1', 'fd00::1', 'fe80::1', '::ffff:10.0.0.1', '::ffff:7f00:1', '0:0:0:0:0:ffff:7f00:1', '64:ff9b::a00:1', 'ff02::1'])
    assert.equal(isInternalAddress(ip), true, ip);
  for (const ip of ['8.8.8.8', '172.32.0.1', '142.250.0.1', '2001:4860:4860::8888', '::ffff:808:808']) assert.equal(isInternalAddress(ip), false, ip);
});

// ---------------------------------------------------------------- T5
test('T5: id de fluxo com path traversal é recusado pelo validador', () => {
  const flow = (id: string) => ({ id, version: 1, start: 'a', triggers: [{ kind: 'default' }], nodes: { a: { type: 'end' } } }) as any;
  for (const id of ['../src/server/main', 'a/b', '..', 'x'.repeat(65), 'a b', 'a\\b']) assert.equal(validateFlow(flow(id)).ok, false, id);
  assert.equal(validateFlow(flow('pre-atendimento_2')).ok, true);
});

test('T5: import-bundle não grava fora de flows/ e tenants/', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ga-sec-'));
  const evil = join(dir, 'bundle.json');
  const flow = { id: '../../evil', version: 1, start: 'a', triggers: [{ kind: 'default' }], nodes: { a: { type: 'end' } } };
  writeFileSync(evil, JSON.stringify({ flows: [flow], tenants: [] }));
  const before = readdirSync(root).sort();
  const r = spawnSync(process.execPath, ['--disable-warning=ExperimentalWarning', join(root, 'scripts/import-bundle.ts'), evil], { encoding: 'utf8' });
  assert.notEqual(r.status, 0, 'deveria falhar');
  assert.equal(existsSync(resolve(root, '..', 'evil.json')), false);
  assert.equal(existsSync(join(root, 'evil.json')), false);
  assert.deepEqual(readdirSync(root).sort(), before);
});

// ---------------------------------------------------------------- T1 / T15
test('T1: produção sem token, token de exemplo ou curto não sobe', () => {
  assert.ok(checkStartupSecurity({ NODE_ENV: 'production' }).fatal);
  assert.ok(checkStartupSecurity({ NODE_ENV: 'production', ADMIN_TOKEN: 'troque-este-token' }).fatal);
  assert.ok(checkStartupSecurity({ NODE_ENV: 'production', ADMIN_TOKEN: 'curto123' }).fatal);
  assert.equal(checkStartupSecurity({ NODE_ENV: 'production', ADMIN_TOKEN: 'x'.repeat(48), INTEGRATION_ALLOWED_HOSTS: 'a.com' }).fatal, undefined);
});

test('T1: sem token fora de produção só sobe com ALLOW_INSECURE_DEV=1 e em 127.0.0.1', () => {
  assert.ok(checkStartupSecurity({}).fatal);
  const dev = checkStartupSecurity({ ALLOW_INSECURE_DEV: '1', HOST: '0.0.0.0' });
  assert.equal(dev.fatal, undefined);
  assert.equal(dev.host, '127.0.0.1');
});

test('T1: o processo do servidor encerra com erro em produção sem ADMIN_TOKEN', () => {
  const env = { ...process.env, NODE_ENV: 'production', DB_PATH: ':memory:', PORT: '0' };
  delete (env as Record<string, string | undefined>).ADMIN_TOKEN;
  const r = spawnSync(process.execPath, ['--disable-warning=ExperimentalWarning', join(root, 'src/server/main.ts')], { env, encoding: 'utf8', timeout: 10_000 });
  assert.equal(r.status, 1);
  assert.match(r.stdout + r.stderr, /startup_refused/);
});

