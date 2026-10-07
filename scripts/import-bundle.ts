/**
 * Importa o pacote exportado pelo Studio para flows/ e tenants/ (com validação completa).
 * Uso: npm run import-bundle caminho/gestor-automacoes-bundle.json [--prune]
 *   --prune  remove arquivos de fluxo/cliente que não estão no pacote
 */
import { readdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { FlowRegistry, FlowValidationError } from '../src/core/registry.ts';
import { TenantRegistry } from '../src/core/tenants.ts';
import type { FlowDefinition, TenantConfig } from '../src/core/types.ts';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const [file, ...flags] = process.argv.slice(2);
if (!file) {
  console.error('Uso: npm run import-bundle <arquivo.json> [--prune]');
  process.exit(2);
}
const bundle = JSON.parse(readFileSync(file, 'utf8')) as { flows: FlowDefinition[]; tenants: TenantConfig[] };
if (!Array.isArray(bundle.flows) || !Array.isArray(bundle.tenants)) {
  console.error('Arquivo inválido: esperado { flows: [], tenants: [] } exportado pelo Studio.');
  process.exit(2);
}

try {
  new FlowRegistry().publish(...bundle.flows);
  const t = new TenantRegistry();
  for (const x of bundle.tenants) t.set(x);
} catch (e) {
  if (e instanceof FlowValidationError) {
    for (const [id, r] of Object.entries(e.results)) for (const err of r.errors) console.error(`✖ ${id}: ${err}`);
  } else console.error(`✖ ${(e as Error).message}`);
  console.error('Nada foi gravado.');
  process.exit(1);
}

const write = (dir: string, items: { id: string }[]) => {
  const keep = new Set(items.map((i) => `${i.id}.json`));
  for (const i of items) writeFileSync(join(root, dir, `${i.id}.json`), JSON.stringify(i, null, 2) + '\n');
  const orphans = readdirSync(join(root, dir)).filter((f) => f.endsWith('.json') && !keep.has(f));
  for (const o of orphans) {
    if (flags.includes('--prune')) {
      unlinkSync(join(root, dir, o));
      console.log(`  removido ${dir}/${o}`);
    } else console.log(`  aviso: ${dir}/${o} não está no pacote (use --prune para remover)`);
  }
  console.log(`✔ ${items.length} arquivo(s) em ${dir}/`);
};
write('flows', bundle.flows);
write('tenants', bundle.tenants);
console.log(`Pacote ${basename(file)} importado. Revise com "git diff" e faça commit.`);
