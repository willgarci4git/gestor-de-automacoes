/**
 * Recursos do curso sobre o motor (ADR-001):
 * tenants parametrizáveis, horário comercial, saudação, randomizador A/B, opt-out (LGPD),
 * disparo ativo/broadcast, gatilho por comentário do Instagram, modelos do WhatsApp,
 * router silencioso, lint E003 e Retry-After.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { makeEngine, texts, commandOf, flow, BUSINESS_HOURS } from './helpers.ts';
import { validateFlow } from '../src/core/validator.ts';
import { pickVariant } from '../src/core/nodes/basic.ts';
import { isBusinessHours, greetingFor } from '../src/core/tenants.ts';
import { InstagramChannel } from '../src/channels/instagram.ts';
import { WhatsAppChannel } from '../src/channels/whatsapp.ts';
import { TelegramChannel } from '../src/channels/telegram.ts';
import { runHttp, CircuitBreaker } from '../src/integrations/http-runner.ts';
import { createBotApp } from '../src/runtime/app.ts';
import { MemoryStorage } from '../src/storage/memory.ts';
import type { FlowDefinition, TenantConfig } from '../src/core/types.ts';

const tenant: TenantConfig = {
  id: 't1',
  params: { nome: 'Clínica Sol', endereco: 'Rua A, 1' },
  businessHours: { days: { '1': [['08:00', '12:00'], ['13:00', '18:00']] }, holidays: ['2026-10-12'] },
};

test('tenant: parâmetros, saudação e horário comercial (com almoço e feriado)', async () => {
  const f = flow({
    id: 'p',
    nodes: {
      oi: { type: 'message', text: '{{system.greeting}}! Aqui é a {{tenant.nome}} ({{tenant.endereco}})', next: 'h' },
      h: { type: 'condition', branches: [{ when: { var: 'system.inBusinessHours', op: 'eq', value: true }, next: 'aberto' }], default: 'fechado' },
      aberto: { type: 'end', message: 'aberto' },
      fechado: { type: 'end', message: 'fechado' },
    },
  });
  const b = makeEngine([f], { tenants: [tenant] });
  assert.deepEqual(texts((await b.say('x')).commands), ['Bom dia! Aqui é a Clínica Sol (Rua A, 1)', 'aberto']);

  const at = (iso: string) => new Date(iso);
  assert.equal(isBusinessHours(tenant, at('2026-09-28T15:30:00Z'), 'America/Sao_Paulo'), false, '12:30 = almoço');
  assert.equal(isBusinessHours(tenant, at('2026-10-12T13:00:00Z'), 'America/Sao_Paulo'), false, 'feriado');
  assert.equal(isBusinessHours(tenant, at('2026-09-29T13:00:00Z'), 'America/Sao_Paulo'), false, 'terça sem faixa');
  assert.equal(isBusinessHours({ id: 'x', params: {} }, BUSINESS_HOURS, 'America/Sao_Paulo'), null);
  assert.deepEqual([greetingFor(6), greetingFor(13), greetingFor(22)], ['Bom dia', 'Boa tarde', 'Boa noite']);
});

test('tenant: lista de fluxos permitidos restringe gatilhos e disparos', async () => {
  const a = flow({ id: 'a', triggers: [{ kind: 'keyword', values: ['promo'] }], nodes: { e: { type: 'end', message: 'A' } } });
  const d = flow({ id: 'd', nodes: { e: { type: 'end', message: 'D' } } });
  const b = makeEngine([a, d], { tenants: [{ id: 't1', params: {}, flows: ['d'] }] });
  assert.deepEqual(texts((await b.say('promo')).commands), ['D']);
  assert.equal((await b.internal('start', { flowId: 'a' })).reason, 'flow_not_allowed_for_tenant');
});

test('randomizer: sorteio ponderado, variável de sessão e etiqueta ab:*', async () => {
  assert.equal(pickVariant([{ id: 'a', weight: 1 }, { id: 'b', weight: 3 }], () => 0.1).id, 'a');
  assert.equal(pickVariant([{ id: 'a', weight: 1 }, { id: 'b', weight: 3 }], () => 0.9).id, 'b');
  const f = flow({
    id: 'ab',
    nodes: {
      r: { type: 'randomizer', variants: [{ id: 'a', weight: 0, next: 'ma' }, { id: 'b', weight: 1, next: 'mb' }] },
      ma: { type: 'end', message: 'A' },
      mb: { type: 'end', message: 'B' },
    },
  });
  const b = makeEngine([f]);
  const r = await b.say('x');
  assert.deepEqual(texts(r.commands), ['B']);
  assert.equal(commandOf(r.commands, 'emit')!.data.variant, 'b');
  assert.equal(b.session().vars.session.ab_r, 'b');
  assert.deepEqual(b.storage.getContact(b.conv)!.tags, ['ab:r:b']);
  assert.match(validateFlow(flow({ nodes: { r: { type: 'randomizer', variants: [{ id: 'a', weight: 1, next: 'e' }] }, e: { type: 'end' } } })).errors.join(), /2 variantes/);
});

const conversa: FlowDefinition = flow({
  id: 'c',
  nodes: {
    q: { type: 'input', prompt: 'Nome?', saveTo: 'contact.nome', next: 'e' },
    e: { type: 'end', message: 'ok' },
  },
});

test('opt-out (LGPD): silencia o bot, ignora disparos e reativa com "voltar"', async () => {
  const b = makeEngine([conversa]);
  await b.say('oi');
  const r = await b.say('PARAR');
  assert.match(texts(r.commands)[0], /não receberá mais/);
  assert.equal(b.session().status, 'ended');
  assert.equal(b.storage.getContact(b.conv)!.fields.opted_out, true);

  assert.equal((await b.say('oi de novo')).reason, 'opted_out');
  assert.equal((await b.internal('start', { flowId: 'c' })).reason, 'opted_out');

  const back = await b.say('voltar');
  assert.deepEqual(texts(back.commands), ['Nome?']);
  assert.equal(b.storage.getContact(b.conv)!.fields.opted_out, undefined);
});

test('opt-out só com termo exato e fecha transbordo aberto', async () => {
  const f = flow({ id: 'h', nodes: { q: { type: 'input', prompt: 'Diga', saveTo: 'flow.x', next: 'hum' }, hum: { type: 'handoff', queue: 'q' } } });
  const b = makeEngine([f]);
  await b.say('oi');
  await b.say('não quero parar agora'); // não é opt-out: vira resposta e segue para o humano
  assert.equal(b.session().status, 'handoff');
  const r = await b.say('parar');
  assert.ok(commandOf(r.commands, 'handoffClose'));
  assert.equal(b.session().status, 'ended');
});

test('disparo ativo (start): cria sessão, injeta variáveis e não atropela conversa em andamento', async () => {
  const lembrete = flow({ id: 'lembrete', triggers: [], nodes: { m: { type: 'end', message: 'Lembrete {{session.campanha}}' } } });
  const b = makeEngine([conversa, lembrete]);
  const r = await b.internal('start', { flowId: 'lembrete', vars: { campanha: 'outubro' } });
  assert.deepEqual(texts(r.commands), ['Lembrete outubro']);
  await b.say('oi'); // inicia conversa "c"
  assert.equal((await b.internal('start', { flowId: 'lembrete' })).reason, 'session_active');
  assert.deepEqual(texts((await b.internal('start', { flowId: 'lembrete', force: true })).commands), ['Lembrete ']);
});

test('broadcast pelo app: por etiqueta, idempotente e respeitando opt-out', async () => {
  const lembrete = flow({ id: 'lembrete', triggers: [], nodes: { m: { type: 'end', message: 'Oi {{contact.first_name}}' } } });
  const marcar = flow({ id: 'marcar', nodes: { s: { type: 'set', addTags: ['vip'], next: 'e' }, e: { type: 'end' } } });
  const app = createBotApp({ storage: new MemoryStorage() });
  app.registry.publish(lembrete, marcar);
  const say = (userId: string, text: string, name?: string) =>
    app.engine.handle({ eventId: crypto.randomUUID(), tenantId: 'x', channel: 'webchat', userId, kind: 'text', text, profile: name ? { name } : undefined });
  await say('ana', 'oi', 'Ana');
  await say('bia', 'oi', 'Bia');
  await say('bia', 'parar');
  await say('caio', 'oi', 'Caio');
  const first = await app.broadcast({ broadcastId: 'b1', flowId: 'lembrete', tag: 'vip' });
  assert.deepEqual(first, { started: 2, skipped: 1 });
  const again = await app.broadcast({ broadcastId: 'b1', flowId: 'lembrete', tag: 'vip' });
  assert.deepEqual(again, { started: 0, skipped: 3 }, 'reexecução não duplica envios');
  await app.dispatcher.idle();
  assert.equal(app.webchat.getHistory('x:webchat:ana').at(-1)!.message.kind === 'text' && (app.webchat.getHistory('x:webchat:ana').at(-1)!.message as any).text, 'Oi Ana');
  await assert.rejects(app.broadcast({ broadcastId: 'b2', flowId: 'nao-existe' }), /não encontrado/);
});

test('gatilho por comentário: só casa com triggers kind=comment (filtro por palavra e publicação)', async () => {
  const isca = flow({
    id: 'isca',
    triggers: [{ kind: 'comment', values: ['quero'], mediaIds: ['m1'] }],
    nodes: { o: { type: 'end', message: 'Te mandei no direct!' } },
  });
  const geral = flow({ id: 'geral', triggers: [{ kind: 'default' }], nodes: { e: { type: 'end', message: 'geral' } } });
  const b = makeEngine([isca, geral]);
  const comment = (text: string, mediaId: string) => b.say(text, { channel: 'webchat', data: { source: 'comment', mediaId, commentId: 'c' } });
  assert.equal((await comment('lindo post', 'm1')).reason, 'comment_without_trigger', 'comentário não cai no default');
  assert.equal((await comment('QUERO!', 'outro')).reason, 'comment_without_trigger');
  assert.deepEqual(texts((await comment('eu quero', 'm1')).commands), ['Te mandei no direct!']);
  assert.deepEqual(texts((await b.say('quero')).commands), ['geral'], 'DM com a mesma palavra não dispara a isca');
});

test('Instagram: webhook assinado, DM, quick reply, comentário e private reply', async () => {
  const calls: { url: string; body: any }[] = [];
  const fetchImpl = (async (url: string, init: RequestInit) => {
    calls.push({ url, body: JSON.parse(String(init.body)) });
    return new Response('{}', { status: 200 });
  }) as unknown as typeof fetch;
  const ig = new InstagramChannel({ accountId: 'IG1', accessToken: 't', appSecret: 's', verifyToken: 'v', commentPublicReply: 'Te chamei no direct!' }, fetchImpl);
  const raw = '{"x":1}';
  assert.ok(ig.verifySignature(raw, 'sha256=' + createHmac('sha256', 's').update(raw).digest('hex')));
  const evs = ig.parseWebhook({
    entry: [{
      messaging: [
        { sender: { id: 'u1' }, message: { mid: 'm1', text: 'oi' } },
        { sender: { id: 'u1' }, message: { mid: 'm2', text: 'Sim', quick_reply: { payload: 'sim' } } },
        { sender: { id: 'IG1' }, message: { mid: 'm3', text: 'eco', is_echo: true } },
      ],
      changes: [{ field: 'comments', value: { id: 'c9', text: 'QUERO', from: { id: 'u2', username: 'bia' }, media: { id: 'p1' } } }],
    }],
  }, 't');
  assert.deepEqual(evs.map((e) => [e.kind, e.eventId]), [['text', 'igm:m1'], ['choice', 'igm:m2'], ['text', 'igc:c9']]);
  assert.deepEqual(evs[2].data, { source: 'comment', commentId: 'c9', mediaId: 'p1' });

  const to = { tenantId: 't', channel: 'instagram', userId: 'u2', conversationId: 'x' };
  await ig.send(to, { kind: 'choice', text: 'Quer?', options: [{ id: 'sim', label: 'Sim' }], display: 'buttons' });
  assert.deepEqual(calls[0].body.recipient, { comment_id: 'c9' }, '1ª resposta = private reply');
  assert.equal(calls[0].body.message.quick_replies[0].payload, 'sim');
  assert.match(calls[1].url, /c9\/replies$/);
  await ig.send(to, { kind: 'text', text: 'depois' });
  assert.deepEqual(calls[2].body.recipient, { id: 'u2' });
});

test('modelos do WhatsApp: template no WhatsApp, texto nos demais canais; router silencioso', async () => {
  const f = flow({
    id: 't',
    nodes: {
      m: { type: 'message', text: 'Oi {{contact.first_name}}', template: { name: 'retorno', language: 'pt_BR', components: [{ type: 'body', parameters: [{ type: 'text', text: '{{contact.first_name}}' }] }] }, next: 'r' },
      r: { type: 'router', silent: true, prompt: 'Agendar?', options: [{ id: 'sim', label: 'Sim', next: 'e' }] },
      e: { type: 'end', message: 'fim' },
    },
  });
  const b = makeEngine([f]);
  const r = await b.say('x', { profile: { name: 'Ana Lima' } });
  assert.equal(r.commands.length, 1, 'router silencioso não envia menu');
  const msg = commandOf(r.commands, 'send')!.message as any;
  assert.equal(msg.kind, 'template');
  assert.equal(msg.text, 'Oi Ana');
  assert.equal(msg.template.components[0].parameters[0].text, 'Ana');
  const wa = new WhatsAppChannel({ phoneNumberId: 'p', accessToken: 't', appSecret: 's', verifyToken: 'v' }).buildPayload('55', msg) as any;
  assert.deepEqual([wa.type, wa.template.name, wa.template.language.code], ['template', 'retorno', 'pt_BR']);
  assert.equal(new TelegramChannel({ botToken: 'b', webhookSecret: 's' }).buildRequest('1', msg).body.text, 'Oi Ana');
  assert.deepEqual(texts((await b.click('sim')).commands), ['fim']);
  assert.match(validateFlow(flow({ nodes: { m: { type: 'message', template: { name: 'x', language: 'pt_BR' }, next: 'e' } as any, e: { type: 'end' } } })).errors.join(), /fallback/);
});

test('lint E003: wait não pode ser o último passo', () => {
  const bad = validateFlow(flow({ nodes: { w: { type: 'wait', seconds: 60, next: 'e' }, e: { type: 'end' } } }));
  assert.match(bad.errors.join(), /E003/);
  const ok = validateFlow(flow({ nodes: { w: { type: 'wait', seconds: 60, next: 'e' }, e: { type: 'end', message: 'lembrete!' } } }));
  assert.deepEqual(ok.errors, []);
});

test('HTTP: respeita Retry-After em 429 e não abre o circuito por limite de taxa', async () => {
  let n = 0;
  const started = Date.now();
  const fetchImpl = (async () => (++n === 1 ? new Response('', { status: 429, headers: { 'retry-after': '1' } }) : new Response('{}', { status: 200 }))) as unknown as typeof fetch;
  const br = new CircuitBreaker({ failureThreshold: 1 });
  const r = await runHttp({ method: 'GET', url: 'https://api.x' }, { timeoutMs: 500, retry: { max: 1, backoffMs: 1 }, getSecret: () => undefined, breaker: br, fetchImpl });
  assert.equal(r.ok, true);
  assert.ok(Date.now() - started >= 950, 'esperou o Retry-After');
  assert.equal(br.status('api.x'), 'closed');
});
