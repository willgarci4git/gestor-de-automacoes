/** CLI: valida todos os fluxos de um diretório. Uso: npm run validate [dir] */
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { validateFlow } from '../core/validator.ts';
import type { FlowDefinition } from '../core/types.ts';

const dir = process.argv[2] ?? 'flows';
const flows = readdirSync(dir).filter((f) => f.endsWith('.json')).map((f) => ({ file: f, def: JSON.parse(readFileSync(join(dir, f), 'utf8')) as FlowDefinition }));
const ids = new Set(flows.map((f) => f.def.id));
let failed = 0;
for (const { file, def } of flows) {
  const r = validateFlow(def, (id) => ids.has(id));
  console.log(`${r.ok ? '✔' : '✖'} ${file} (${def.id}@${def.version})`);
  for (const e of r.errors) console.log(`   erro:  ${e}`);
  for (const w of r.warnings) console.log(`   aviso: ${w}`);
  if (!r.ok) failed++;
}
process.exit(failed ? 1 : 0);
