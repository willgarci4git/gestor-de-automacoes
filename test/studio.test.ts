/**
 * Garante que o Studio (versão para navegador) é gerado e que o pacote compilado
 * roda o mesmo fluxo que o servidor — sem nenhuma API exclusiva do Node no núcleo.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync, readdirSync, statSync, mkdtempSync, writeFileSync, cpSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const root = new URL('..', import.meta.url).pathname;
const dist = join(root, 'dist-studio');
const node = (script: string, ...args: string[]) =>
  execFileSync(process.execPath, ['--disable-warning=ExperimentalWarning', script, ...args], { stdio: 'pipe' });

test('build do Studio gera site estático sem imports de Node no navegador', () => {
  node(join(root, 'scripts/build-studio.ts'));
  for (const f of ['index.html', 'app.js', 'studio.css', 'data.js', 'lib/core/engine.js', 'lib/runtime/app.js']) {
    assert.ok(statSync(join(dist, f)).isFile(), `faltou ${f}`);
  }
  const walk = (d: string): string[] => readdirSync(d).flatMap((f) => (statSync(join(d, f)).isDirectory() ? walk(join(d, f)) : [join(d, f)]));
  for (const f of walk(join(dist, 'lib')).filter((x) => x.endsWith('.js'))) {
    const src = readFileSync(f, 'utf8');
    assert.doesNotMatch(src, /from\s+['"]node:/, `${f} importa módulo do Node`);
    assert.doesNotMatch(src, /from\s+['"][^'"]+\.ts['"]/, `${f} importa .ts`);
  }
});

test('pacote do navegador executa uma conversa completa (mesmo motor do servidor)', async () => {
  const { createBotApp } = await import(join(dist, 'lib/runtime/app.js'));
  const { MemoryStorage } = await import(join(dist, 'lib/storage/memory.js'));
  const { TenantRegistry } = await import(join(dist, 'lib/core/tenants.js'));
  const { default: data } = await import(join(dist, 'data.js'));
  const tenants = new TenantRegistry();
  for (const t of data.tenants) tenants.set(t);
  const app = createBotApp({ storage: new MemoryStorage(), tenants, clock: () => new Date('2030-01-07T13:00:00Z') });
  app.registry.publish(...data.flows);
  await app.receive({ eventId: 'e1', tenantId: 'clinica', channel: 'webchat', userId: 'u', kind: 'text', text: 'oi' });
  await app.dispatcher.idle();
  const texts = app.webchat.getHistory('clinica:webchat:u').map((e: { message: { text: string } }) => e.message.text);
  assert.match(texts[0], /Bom dia! .*Clínica Exemplo/);
  app.stop();
});

test('import-bundle valida e grava fluxos/clientes exportados pelo Studio', () => {
  const tmp = mkdtempSync(join(tmpdir(), 'bundle-'));
  for (const d of ['src', 'scripts', 'flows', 'tenants']) cpSync(join(root, d), join(tmp, d), { recursive: true });
  const flows = readdirSync(join(root, 'flows')).map((f) => JSON.parse(readFileSync(join(root, 'flows', f), 'utf8')));
  const tenants = readdirSync(join(root, 'tenants')).map((f) => JSON.parse(readFileSync(join(root, 'tenants', f), 'utf8')));
  flows[0].name = 'Renomeado no Studio';
  writeFileSync(join(tmp, 'ok.json'), JSON.stringify({ flows, tenants }));
  node(join(tmp, 'scripts/import-bundle.ts'), join(tmp, 'ok.json'));
  assert.equal(JSON.parse(readFileSync(join(tmp, 'flows', `${flows[0].id}.json`), 'utf8')).name, 'Renomeado no Studio');

  const broken = structuredClone(flows);
  broken[0].nodes[broken[0].start].next = 'nao-existe';
  broken[0].name = 'Não deve gravar';
  writeFileSync(join(tmp, 'bad.json'), JSON.stringify({ flows: broken, tenants }));
  assert.throws(() => node(join(tmp, 'scripts/import-bundle.ts'), join(tmp, 'bad.json')));
  assert.equal(JSON.parse(readFileSync(join(tmp, 'flows', `${flows[0].id}.json`), 'utf8')).name, 'Renomeado no Studio', 'pacote inválido não grava nada');
});
