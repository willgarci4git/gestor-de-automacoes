import { test } from 'node:test';
import assert from 'node:assert/strict';
import { matchesTerm, normalize } from '../src/core/text.ts';
import { validateAnswer } from '../src/core/input-validators.ts';
import { pickOption } from '../src/core/nodes/interactive.ts';
import { renderDeep, renderTemplate, resolveSecrets, VarContext } from '../src/core/context.ts';
import { evaluateRule } from '../src/core/nodes/basic.ts';
import type { Contact, InboundEvent, Session } from '../src/core/types.ts';

test('normalize remove acentos, pontuação e caixa', () => {
  assert.equal(normalize('  Olá, BOM-DIA!! '), 'ola bom dia');
});

test('matchesTerm: variações, plural, erro de digitação e frases', () => {
  assert.ok(matchesTerm('quero saber dos planos', 'plano'));
  assert.ok(matchesTerm('Preço?', 'preco'));
  assert.ok(matchesTerm('agendamnto', 'agendamento')); // 1 erro
  assert.ok(matchesTerm('quero falar com humano agora', 'falar com humano'));
  assert.ok(!matchesTerm('planejamento', 'plano'));
  assert.ok(!matchesTerm('oi', 'o'));
  assert.ok(!matchesTerm('sim', 'sair'));
});

test('validadores de resposta', () => {
  assert.deepEqual(validateAnswer({ kind: 'email' }, 'Ana@Ex.com'), { ok: true, value: 'ana@ex.com' });
  assert.equal(validateAnswer({ kind: 'email' }, 'ana@').ok, false);
  assert.deepEqual(validateAnswer({ kind: 'phone' }, '(11) 99999-8888'), { ok: true, value: '11999998888' });
  assert.equal(validateAnswer({ kind: 'phone' }, '1234').ok, false);
  assert.deepEqual(validateAnswer({ kind: 'date' }, '15/10/2026'), { ok: true, value: '2026-10-15' });
  assert.equal(validateAnswer({ kind: 'date' }, '31/02/2026').ok, false);
  assert.equal(validateAnswer({ kind: 'cpf' }, '529.982.247-25').ok, true);
  assert.equal(validateAnswer({ kind: 'cpf' }, '111.111.111-11').ok, false);
  assert.deepEqual(validateAnswer({ kind: 'number', min: 1, max: 10 }, '7,5'), { ok: true, value: 7.5 });
  assert.equal(validateAnswer({ kind: 'number', min: 1, max: 10 }, '11').ok, false);
  assert.equal(validateAnswer({ kind: 'regex', pattern: '^[A-Z]{3}\\d{4}$' }, 'ABC1234').ok, true);
  assert.equal(validateAnswer({ kind: 'minLength', value: 3 }, 'Jo').ok, false);
  assert.equal(validateAnswer(undefined, '   ').ok, false);
});

test('pickOption: id, número, rótulo e termos', () => {
  const opts = [
    { id: 'agendar', label: 'Agendar consulta', match: ['marcar'], next: 'a' },
    { id: 'planos', label: 'Planos e valores', match: ['preco'], next: 'b' },
  ];
  const ev = (p: Partial<InboundEvent>) => ({ eventId: 'x', tenantId: 't', channel: 'c', userId: 'u', kind: 'text', ...p }) as InboundEvent;
  assert.equal(pickOption(opts, ev({ optionId: 'planos' }))?.id, 'planos');
  assert.equal(pickOption(opts, ev({ text: '1' }))?.id, 'agendar');
  assert.equal(pickOption(opts, ev({ text: 'planos e valores' }))?.id, 'planos');
  assert.equal(pickOption(opts, ev({ text: 'qual o preço?' }))?.id, 'planos');
  assert.equal(pickOption(opts, ev({ text: 'quero marcar' }))?.id, 'agendar');
  assert.equal(pickOption(opts, ev({ text: '9' })), undefined);
  assert.equal(pickOption(opts, ev({ text: 'banana' })), undefined);
});

function ctx() {
  const session = { vars: { session: { n: 5 }, flow: {} } } as unknown as Session;
  const contact: Contact = { conversationId: 'c', fields: { first_name: 'Ana' }, tags: ['vip'] };
  return new VarContext(session, contact, { channel: 'webchat' });
}

test('templates, escopos e secrets', () => {
  const v = ctx();
  assert.equal(renderTemplate('Oi {{contact.first_name}} via {{system.channel}}{{session.nada}}', v), 'Oi Ana via webchat');
  assert.deepEqual(renderDeep({ n: '{{session.n}}', s: 'x{{session.n}}', k: '{{secrets.api}}' }, v), { n: 5, s: 'x5', k: '{{secrets.api}}' });
  assert.throws(() => v.set('system.x', 1));
  v.set('flow.a.b', 2);
  assert.equal(v.get('flow.a.b'), 2);
  assert.equal(resolveSecrets('Bearer {{secrets.api}}', () => 'abc'), 'Bearer abc');
  assert.throws(() => resolveSecrets('{{secrets.nope}}', () => undefined), /não configurado/);
});

test('condições compostas', () => {
  const v = ctx();
  assert.ok(evaluateRule({ all: [{ var: 'session.n', op: 'gte', value: 5 }, { op: 'hasTag', value: 'vip' }] }, v));
  assert.ok(evaluateRule({ any: [{ var: 'contact.first_name', op: 'eq', value: 'ANA' }, { var: 'x.y', op: 'exists' }] }, v));
  assert.ok(evaluateRule({ var: 'contact.first_name', op: 'in', value: ['ana', 'bia'] }, v));
  assert.ok(evaluateRule({ var: 'contact.tags', op: 'contains', value: 'vip' }, v));
  assert.ok(!evaluateRule({ var: 'session.zzz', op: 'exists' }, v));
});
