/**
 * Build do Studio (zero dependências): remove os tipos do TypeScript com o próprio Node
 * (module.stripTypeScriptTypes), reescreve imports para o navegador e empacota fluxos/clientes.
 * Saída: dist-studio/ — site estático pronto para GitHub Pages (ou qualquer hospedagem estática).
 */
import { stripTypeScriptTypes } from 'node:module';
import { cpSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const out = join(root, 'dist-studio');
const EXCLUDE = [/^server\//, /^cli\//, /^storage\/sqlite\.ts$/];
const SHIMS: Record<string, string> = { 'node:crypto': 'shims/crypto.js', 'node:events': 'shims/events.js', 'node:fs': 'shims/fs.js', 'node:path': 'shims/fs.js' };

rmSync(out, { recursive: true, force: true });
mkdirSync(join(out, 'lib', 'shims'), { recursive: true });

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((f) => (statSync(join(dir, f)).isDirectory() ? walk(join(dir, f)) : [join(dir, f)]));
}

let count = 0;
for (const file of walk(join(root, 'src'))) {
  const rel = relative(join(root, 'src'), file);
  if (!rel.endsWith('.ts') || EXCLUDE.some((r) => r.test(rel))) continue;
  let js = stripTypeScriptTypes(readFileSync(file, 'utf8'), { mode: 'strip' });
  const depth = rel.split('/').length - 1;
  const up = depth ? '../'.repeat(depth) : './';
  js = js.replace(/(from\s+|import\s*\(\s*|import\s+)(['"])([^'"]+)\2/g, (m, pre, q, spec: string) => {
    if (SHIMS[spec]) return `${pre}${q}${up}${SHIMS[spec]}${q}`;
    if (spec.startsWith('node:')) throw new Error(`${rel}: import sem shim para o navegador: ${spec}`);
    if (spec.startsWith('.') && spec.endsWith('.ts')) return `${pre}${q}${spec.slice(0, -3)}.js${q}`;
    return m;
  });
  const dest = join(out, 'lib', rel.replace(/\.ts$/, '.js'));
  mkdirSync(dirname(dest), { recursive: true });
  writeFileSync(dest, js);
  count++;
}
cpSync(join(root, 'studio', 'shims'), join(out, 'lib', 'shims'), { recursive: true });
for (const f of readdirSync(join(root, 'studio'))) {
  if (f !== 'shims') cpSync(join(root, 'studio', f), join(out, f), { recursive: true });
}
const readJsonDir = (d: string) =>
  readdirSync(join(root, d)).filter((f) => f.endsWith('.json')).sort().map((f) => JSON.parse(readFileSync(join(root, d, f), 'utf8')));
const data = { flows: readJsonDir('flows'), tenants: readJsonDir('tenants'), builtAt: new Date().toISOString() };
writeFileSync(join(out, 'data.js'), `export default ${JSON.stringify(data, null, 1)};\n`);
writeFileSync(join(out, '.nojekyll'), '');
console.log(`Studio gerado em dist-studio/ (${count} módulos, ${data.flows.length} fluxos, ${data.tenants.length} clientes)`);
