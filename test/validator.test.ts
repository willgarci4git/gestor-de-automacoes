import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validateFlow } from '../src/core/validator.ts';
import { FlowRegistry, FlowValidationError } from '../src/core/registry.ts';
import type { FlowDefinition } from '../src/core/types.ts';
import { flow } from './helpers.ts';

test('fluxos de exemplo do projeto são válidos', () => {
  const r = new FlowRegistry();
  const results = r.loadDir(new URL('../flows', import.meta.url).pathname);
  for (const res of Object.values(results)) assert.deepEqual(res.errors, []);
  assert.deepEqual(results['pre-atendimento'].warnings, []);
});

test('detecta referência para nó inexistente', () => {
  const r = validateFlow(flow({ nodes: { a: { type: 'message', text: 'x', next: 'zzz' } } }));
  assert.equal(r.ok, false);
  assert.match(r.errors.join(), /inexistente "zzz"/);
});

test('detecta loop sem ponto de espera', () => {
  const r = validateFlow(flow({ nodes: { a: { type: 'message', text: 'x', next: 'b' }, b: { type: 'set', next: 'a' } } }));
  assert.equal(r.ok, false);
  assert.match(r.errors.join(), /loop sem ponto de espera: a -> b -> a/);
});

test('loop que passa por um nó de espera é permitido', () => {
  const r = validateFlow(flow({
    nodes: {
      a: { type: 'message', text: 'x', next: 'b' },
      b: { type: 'router', prompt: 'p', options: [{ id: '1', label: 'de novo', next: 'a' }, { id: '2', label: 'fim', next: 'c' }] },
      c: { type: 'end' },
    },
  }));
  assert.deepEqual(r.errors, []);
});

test('integração exige onError; subfluxo precisa existir; opções únicas; saveTo gravável', () => {
  const r = validateFlow(flow({
    nodes: {
      a: { type: 'integration', request: { method: 'POST', url: 'https://x' }, next: 'b' } as any,
      b: { type: 'subflow', flowId: 'nao_existe', next: 'c' },
      c: { type: 'router', prompt: 'p', options: [{ id: 'x', label: 'A', next: 'd' }, { id: 'x', label: 'B', next: 'd' }] },
      d: { type: 'input', prompt: 'p', saveTo: 'system.x', next: 'e' },
      e: { type: 'end' },
    },
  }), () => false);
  assert.equal(r.ok, false);
  const all = r.errors.join('\n');
  assert.match(all, /onError/);
  assert.match(all, /id de opção duplicado/);
  assert.match(all, /saveTo "system.x"/);
});

test('avisa nós inalcançáveis', () => {
  const r = validateFlow(flow({ nodes: { a: { type: 'end' }, orfao: { type: 'end' } } }));
  assert.ok(r.ok);
  assert.match(r.warnings.join(), /"orfao" é inalcançável/);
});

test('registro: publicação atômica e imutabilidade de versão', () => {
  const r = new FlowRegistry();
  const good: FlowDefinition = flow({ id: 'ok', nodes: { a: { type: 'end' } } });
  const bad: FlowDefinition = flow({ id: 'bad', nodes: { a: { type: 'message', text: 'x', next: 'nope' } } });
  assert.throws(() => r.publish(good, bad), FlowValidationError);
  assert.equal(r.has('ok'), false, 'nada publicado se um falhar');
  r.publish(good);
  assert.throws(() => r.publish({ ...good, name: 'mudou' }), /incremente "version"/);
  r.publish({ ...good, version: 2, name: 'mudou' });
  assert.equal(r.latest('ok')!.version, 2);
  assert.equal(r.get('ok', 1)!.name, undefined);
});
