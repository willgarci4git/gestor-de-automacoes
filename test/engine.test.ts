import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeEngine, texts, commandOf, flow } from './helpers.ts';
import { handlers } from '../src/core/nodes/index.ts';
import type { FlowDefinition } from '../src/core/types.ts';

const cadastro: FlowDefinition = flow({
  id: 'cadastro',
  triggers: [{ kind: 'keyword', values: ['oi'] }],
  globals: { intents: { atendente: { match: ['atendente'], goto: 'humano' }, menu: { match: ['menu'], goto: 'menu' } } },
  nodes: {
    oi: { type: 'message', text: 'Olá!', next: 'nome' },
    nome: { type: 'input', prompt: 'Seu nome?', saveTo: 'contact.full_name', validator: { kind: 'minLength', value: 3 }, maxAttempts: 2, next: 'menu', onInvalid: 'humano', timeoutSec: 60, onTimeout: 'tchau' },
    menu: {
      type: 'router', prompt: 'Oi {{contact.full_name}}, escolha:', saveTo: 'session.escolha',
      options: [
        { id: 'ag', label: 'Agendar', match: ['marcar'], next: 'sub' },
        { id: 'fim', label: 'Sair', next: 'tchau' },
      ],
      maxAttempts: 2, onExhausted: 'humano',
    },
    sub: { type: 'subflow', flowId: 'sub', next: 'pos_sub' },
    pos_sub: { type: 'message', text: 'Voltei do subfluxo com {{flow.marcador}}', next: 'tchau' },
    humano: { type: 'handoff', queue: 'recepcao', message: 'Transferindo...', contextVars: ['contact.full_name'], slaSec: 300, onSlaTimeout: 'sla', next: 'menu' },
    sla: { type: 'message', text: 'Sem atendentes agora.', next: 'tchau' },
    tchau: { type: 'end', message: 'Até mais!' },
  },
});
cadastro.nodes.oi = { type: 'set', assign: { 'flow.marcador': 'pai' }, next: 'ola' } as any;
(cadastro.nodes as any).ola = { type: 'message', text: 'Olá!', next: 'nome' };

const sub: FlowDefinition = flow({
  id: 'sub',
  triggers: [],
  nodes: {
    dia: { type: 'input', prompt: 'Qual dia?', saveTo: 'flow.dia', validator: { kind: 'date' }, next: 'fim' },
    fim: { type: 'end', message: 'Marcado para {{flow.dia}}' },
  },
});

test('fluxo feliz: gatilho -> pergunta -> menu -> subfluxo -> retorno -> fim', async () => {
  const b = makeEngine([cadastro, sub]);
  let r = await b.say('Oi!');
  assert.deepEqual(texts(r.commands), ['Olá!', 'Seu nome?']);
  assert.equal(b.session().status, 'waiting_input');
  assert.ok(commandOf(r.commands, 'schedule'), 'agenda timeout da pergunta');

  r = await b.say('Maria Silva');
  const choice = commandOf(r.commands, 'send')!;
  assert.equal(choice.message.kind, 'choice');
  assert.equal((choice.message as any).text, 'Oi Maria Silva, escolha:');

  r = await b.say('quero marcar');
  assert.deepEqual(texts(r.commands), ['Qual dia?']);
  assert.equal(b.session().flowId, 'sub');
  assert.equal(b.session().callStack.length, 1);

  r = await b.say('10/11/2026');
  assert.deepEqual(texts(r.commands), ['Marcado para 2026-11-10', 'Voltei do subfluxo com pai', 'Até mais!']);
  const s = b.session();
  assert.equal(s.status, 'ended');
  assert.equal(s.flowId, 'cadastro');
  assert.equal(s.vars.session.escolha, 'ag');
  assert.equal(b.storage.getContact(b.conv)!.fields.full_name, 'Maria Silva');
});

test('idempotência: mesmo eventId processado uma única vez', async () => {
  const b = makeEngine([cadastro, sub]);
  const ev = { eventId: 'wamid.1', tenantId: 't1', channel: 'webchat', userId: 'u1', kind: 'text' as const, text: 'oi' };
  const first = await b.engine.handle(ev);
  const second = await b.engine.handle(ev);
  assert.equal(first.status, 'processed');
  assert.equal(second.status, 'duplicate');
  assert.equal(second.commands.length, 0);
});

test('mensagens concorrentes da mesma conversa são serializadas', async () => {
  const b = makeEngine([cadastro, sub]);
  await b.say('oi');
  const [r1, r2] = await Promise.all([b.say('Ana Paula'), b.say('Sair')]);
  assert.equal(r1.status, 'processed');
  assert.equal(r2.status, 'processed');
  assert.equal(b.session().status, 'ended');
  assert.equal(b.session().rev, 3);
});

test('tentativas inválidas levam ao onInvalid (transbordo)', async () => {
  const b = makeEngine([cadastro, sub]);
  await b.say('oi');
  let r = await b.say('Jo');
  assert.match(texts(r.commands)[0], /Não consegui entender/);
  r = await b.say('X');
  assert.deepEqual(texts(r.commands), ['Transferindo...']);
  const h = commandOf(r.commands, 'handoff')!;
  assert.equal(h.queue, 'recepcao');
  assert.equal(b.session().status, 'handoff');
});

test('intent global em pergunta livre exige casamento exato', async () => {
  const b = makeEngine([cadastro, sub]);
  await b.say('oi');
  await b.say('Menu Silva'); // é um nome, não a intent "menu"
  assert.equal(b.storage.getContact(b.conv)!.fields.full_name, 'Menu Silva');
});

test('intent global do fluxo raiz funciona dentro do subfluxo e limpa a pilha', async () => {
  const b = makeEngine([cadastro, sub]);
  await b.say('oi');
  await b.say('Maria Silva');
  await b.click('ag');
  assert.equal(b.session().flowId, 'sub');
  const r = await b.say('atendente');
  assert.deepEqual(texts(r.commands), ['Transferindo...']);
  assert.equal(b.session().flowId, 'cadastro');
  assert.equal(b.session().callStack.length, 0);
});

test('timeout: timer com token atual dispara onTimeout; token antigo é descartado', async () => {
  const b = makeEngine([cadastro, sub]);
  const r = await b.say('oi');
  const sched = commandOf(r.commands, 'schedule')!;
  const stale = await b.internal('timer', { token: 'token-velho' });
  assert.equal(stale.status, 'ignored');
  const fired = await b.internal('timer', { token: sched.token });
  assert.deepEqual(texts(fired.commands), ['Até mais!']);
  assert.equal(b.session().status, 'ended');
});

test('timer de pergunta já respondida é ignorado', async () => {
  const b = makeEngine([cadastro, sub]);
  const r = await b.say('oi');
  const sched = commandOf(r.commands, 'schedule')!;
  await b.say('Maria Silva');
  const late = await b.internal('timer', { token: sched.token });
  assert.equal(late.status, 'ignored');
  assert.equal(b.session().currentNodeId, 'menu');
});

test('transbordo: encaminha mensagens, SLA só vale se ninguém assumir, fechamento volta ao bot', async () => {
  const b = makeEngine([cadastro, sub]);
  await b.say('oi');
  const r = await b.say('atendente');
  const sla = commandOf(r.commands, 'schedule')!;
  assert.equal(sla.reason, 'sla');
  assert.equal(commandOf(r.commands, 'handoff')!.context['contact.full_name'], undefined);

  const fwd = await b.say('alguém aí?');
  assert.equal(commandOf(fwd.commands, 'handoffForward')!.text, 'alguém aí?');

  await b.internal('handoff_accepted');
  const slaFire = await b.internal('timer', { token: sla.token });
  assert.equal(slaFire.status, 'ignored', 'SLA não estoura depois de aceito');

  const closed = await b.internal('handoff_closed');
  assert.equal((commandOf(closed.commands, 'send')!.message as any).kind, 'choice');
  assert.equal(b.session().currentNodeId, 'menu');
});

test('transbordo: SLA expirado sem atendente segue onSlaTimeout', async () => {
  const b = makeEngine([cadastro, sub]);
  await b.say('oi');
  const r = await b.say('atendente');
  const sla = commandOf(r.commands, 'schedule')!;
  const fired = await b.internal('timer', { token: sla.token });
  assert.ok(commandOf(fired.commands, 'handoffClose'));
  assert.deepEqual(texts(fired.commands), ['Sem atendentes agora.', 'Até mais!']);
});

test('integração: sucesso grava resposta; falha segue onError com lastError', async () => {
  const f = flow({
    id: 'int',
    nodes: {
      call: { type: 'integration', request: { method: 'POST', url: 'https://api.exemplo.com/{{contact.id}}', body: { n: '{{system.channel}}', k: '{{secrets.key}}' } }, saveTo: 'flow.resp', next: 'ok', onError: 'erro' },
      ok: { type: 'end', message: 'ok {{flow.resp.id}}' },
      erro: { type: 'end', message: 'falhou {{flow.lastError.error}}' },
    },
  });
  const b = makeEngine([f]);
  let r = await b.say('x');
  const call = commandOf(r.commands, 'callIntegration')!;
  assert.deepEqual(call.request.body, { n: 'webchat', k: '{{secrets.key}}' }, 'secrets não são resolvidos no motor');
  assert.equal(b.session().status, 'waiting_integration');
  assert.equal((await b.say('oi?')).commands.length, 0, 'texto durante integração é ignorado');
  r = await b.internal('integration_result', { token: call.token, ok: true, body: { id: 42 } });
  assert.deepEqual(texts(r.commands), ['ok 42']);

  const b2 = makeEngine([f]);
  const call2 = commandOf((await b2.say('x')).commands, 'callIntegration')!;
  r = await b2.internal('integration_result', { token: call2.token, ok: false, error: 'timeout' });
  assert.deepEqual(texts(r.commands), ['falhou timeout']);
});

test('proteção contra loop: cadeia longa demais aciona fallback + transbordo', async () => {
  const nodes: FlowDefinition['nodes'] = {};
  for (let i = 0; i < 40; i++) nodes[`n${i}`] = { type: 'set', next: `n${i + 1}` };
  nodes.n40 = { type: 'end' };
  const b = makeEngine([flow({ id: 'longo', nodes })], { config: { maxStepsPerTurn: 25 } });
  const r = await b.say('x');
  assert.match(texts(r.commands)[0], /Desculpe/);
  assert.equal(commandOf(r.commands, 'handoff')!.context.reason, 'loop_guard');
  assert.equal(b.engine.metrics.get('engine.fallback.loop_guard'), 1);
  // encerrado pelo atendente, a sessão termina
  await b.internal('handoff_closed');
  assert.equal(b.session().status, 'ended');
});

test('erro no handler: usa onError do nó, senão fallback global', async () => {
  const original = handlers.message;
  handlers.message = { onEnter() { throw new Error('boom'); } };
  try {
    const f = flow({ id: 'err', nodes: { a: { type: 'message', text: 'x', next: 'z', onError: 'z' }, z: { type: 'end', message: 'recuperado' } } });
    const r = await makeEngine([f]).say('x');
    assert.deepEqual(texts(r.commands), ['recuperado']);

    const g = flow({ id: 'err2', nodes: { a: { type: 'message', text: 'x', next: 'z' }, z: { type: 'end' } } });
    const r2 = await makeEngine([g], { config: { fallback: { message: 'ops' } } }).say('x');
    assert.deepEqual(texts(r2.commands), ['ops']);
  } finally {
    handlers.message = original;
  }
});

test('versionamento: sessão continua na versão em que começou', async () => {
  const v1 = flow({ id: 'v', nodes: { q: { type: 'input', prompt: 'v1?', saveTo: 'flow.x', next: 'e' }, e: { type: 'end', message: 'fim v1' } } });
  const b = makeEngine([v1]);
  await b.say('oi');
  b.registry.publish({ ...v1, version: 2, nodes: { ...v1.nodes, e: { type: 'end', message: 'fim v2' } } });
  const r = await b.say('resposta');
  assert.deepEqual(texts(r.commands), ['fim v1']);
  const r2 = await b.say('nova conversa');
  assert.deepEqual(texts(r2.commands), ['v1?']);
  assert.equal(b.session().flowVersion, 2);
});

test('sessão expirada por inatividade reinicia o fluxo', async () => {
  const b = makeEngine([cadastro, sub], { config: { sessionTtlSec: 3600 } });
  await b.say('oi');
  b.setNow(() => new Date(Date.parse('2026-09-28T13:00:00Z') + 2 * 3600_000));
  const r = await b.say('oi de novo');
  assert.deepEqual(texts(r.commands), ['Olá!', 'Seu nome?']);
  assert.equal(b.engine.metrics.get('engine.sessions_expired'), 1);
});

test('sem fluxo para o gatilho: evento ignorado sem criar sessão', async () => {
  const f = flow({ id: 'k', triggers: [{ kind: 'keyword', values: ['promo'] }], nodes: { a: { type: 'end', message: 'promo!' } } });
  const b = makeEngine([f]);
  assert.equal((await b.say('bom dia')).status, 'ignored');
  assert.deepEqual(texts((await b.say('quero a PROMO!')).commands), ['promo!']);
});

test('variáveis de sistema: horário comercial em America/Sao_Paulo', async () => {
  const f = flow({
    id: 'h',
    nodes: {
      c: { type: 'condition', branches: [{ when: { all: [{ var: 'system.hour', op: 'eq', value: 10 }, { var: 'system.weekday', op: 'eq', value: 1 }] }, next: 'aberto' }], default: 'fechado' },
      aberto: { type: 'end', message: 'aberto {{system.time}}' },
      fechado: { type: 'end', message: 'fechado' },
    },
  });
  assert.deepEqual(texts((await makeEngine([f]).say('x')).commands), ['aberto 10:00']);
});
