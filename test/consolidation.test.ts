/**
 * Recursos da v0.4 (ADR-002): gatilho por link (ref) com etiquetas de origem, prioridade de fluxos por
 * cliente e fluxos opt-in, resposta única a comentário, ack do Telegram, limpeza de contatos,
 * avisos de limites de canal e o fluxo de atendimento por setor.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { makeEngine, texts, commandOf, flow, BUSINESS_HOURS } from './helpers.ts';
import { StateEngine, coalesceSends } from '../src/core/engine.ts';
import { FlowRegistry } from '../src/core/registry.ts';
import { TenantRegistry } from '../src/core/tenants.ts';
import { validateFlow } from '../src/core/validator.ts';
import { MemoryStorage } from '../src/storage/memory.ts';
import { SqliteStorage } from '../src/storage/sqlite.ts';
import { createBotApp } from '../src/runtime/app.ts';
import { TelegramChannel } from '../src/channels/telegram.ts';
import { WhatsAppChannel } from '../src/channels/whatsapp.ts';
import { InstagramChannel } from '../src/channels/instagram.ts';
import { WebchatChannel } from '../src/channels/webchat.ts';
import type { Address, Command, InboundEvent } from '../src/core/types.ts';

const root = new URL('..', import.meta.url).pathname;

// ---------------------------------------------------------------------------
// Gatilho por link (ref) e etiquetas de origem
// ---------------------------------------------------------------------------

const campanha = flow({
  id: 'campanha',
  triggers: [
    { kind: 'ref', values: ['promo-outubro'], tags: ['origem_promo_outubro'] },
    { kind: 'keyword', values: ['promocao'], tags: ['origem_palavra_promocao'] },
  ],
  nodes: { q: { type: 'input', prompt: 'Qual seu nome?', saveTo: 'contact.nome', next: 'e' }, e: { type: 'end', message: 'Obrigado!' } },
});
const geral = flow({ id: 'geral', triggers: [{ kind: 'default', tags: ['origem_organico'] }], nodes: { q: { type: 'input', prompt: 'Como posso ajudar?', saveTo: 'session.x', next: 'e' }, e: { type: 'end' } } });

test('ref: link de campanha inicia o fluxo certo, aplica etiqueta e grava session.ref', async () => {
  const b = makeEngine([geral, campanha]);
  const r = await b.say('/start promo-outubro', { data: { ref: 'promo-outubro' } });
  assert.deepEqual(texts(r.commands), ['Qual seu nome?']);
  assert.equal(b.session().flowId, 'campanha');
  assert.equal(b.session().vars.session.ref, 'promo-outubro');
  assert.deepEqual(b.storage.getContact(b.conv)!.tags, ['origem_promo_outubro']);
});

test('etiquetas de origem também valem para palavra-chave e default', async () => {
  const b = makeEngine([geral, campanha]);
  await b.say('vi a promoção no insta');
  assert.deepEqual(b.storage.getContact(b.conv)!.tags, ['origem_palavra_promocao']);
  const c = makeEngine([geral, campanha]);
  await c.say('bom dia');
  assert.deepEqual(c.storage.getContact(c.conv)!.tags, ['origem_organico']);
});

test('ref reinicia a automação no meio da conversa, mas não durante o atendimento humano', async () => {
  const humano = flow({ id: 'humano', triggers: [{ kind: 'keyword', values: ['ajuda'] }], nodes: { h: { type: 'handoff', queue: 'q' } } });
  const b = makeEngine([geral, campanha, humano]);
  await b.say('oi'); // fluxo geral, aguardando resposta
  const r = await b.say('/start promo-outubro', { data: { ref: 'promo-outubro' } });
  assert.deepEqual(texts(r.commands), ['Qual seu nome?']);
  assert.equal(b.session().flowId, 'campanha');

  const c = makeEngine([geral, campanha, humano]);
  await c.say('ajuda');
  assert.equal(c.session().status, 'handoff');
  const during = await c.say('/start promo-outubro', { data: { ref: 'promo-outubro' } });
  assert.ok(commandOf(during.commands, 'handoffForward'), 'durante o transbordo a mensagem vai para o atendente');
  assert.equal(c.session().flowId, 'humano');
});

test('ref desconhecido cai nos gatilhos normais (texto e default)', async () => {
  const b = makeEngine([geral, campanha]);
  const r = await b.say('', { data: { ref: 'nao-existe' } });
  assert.deepEqual(texts(r.commands), ['Como posso ajudar?']);
});

test('validador: ref exige values; tags deve ser lista de textos; optIn booleano', () => {
  const bad = flow({ triggers: [{ kind: 'ref' }, { kind: 'default', tags: [1 as unknown as string] }], nodes: { e: { type: 'end' } } });
  const errs = validateFlow(bad).errors.join(' | ');
  assert.match(errs, /trigger ref sem "values"/);
  assert.match(errs, /"tags" deve ser lista/);
  assert.match(validateFlow({ ...bad, triggers: [], optIn: 'sim' as unknown as boolean }).errors.join(), /optIn/);
});

// ---------------------------------------------------------------------------
// Prioridade por cliente e fluxos opt-in
// ---------------------------------------------------------------------------

test('tenant.flows define a prioridade entre fluxos; fluxo optIn não captura clientes sem lista', async () => {
  const a = flow({ id: 'a', triggers: [{ kind: 'keyword', values: ['oi'] }, { kind: 'default' }], nodes: { e: { type: 'end', message: 'A' } } });
  const z = flow({ id: 'z', optIn: true, triggers: [{ kind: 'keyword', values: ['oi'] }, { kind: 'default' }], nodes: { e: { type: 'end', message: 'Z' } } });
  const tenants = [{ id: 't1', params: {}, flows: ['z', 'a'] }];
  const b = makeEngine([a, z], { tenants });
  assert.deepEqual(texts((await b.say('oi')).commands), ['Z'], 'cliente que lista z primeiro entra por z');

  const livre = makeEngine([z, a]);
  assert.deepEqual(texts((await livre.say('oi')).commands), ['A'], 'sem lista: fluxo optIn é ignorado');
  assert.deepEqual(texts((await livre.internal('start', { flowId: 'z', force: true })).commands), ['Z'], 'disparo explícito continua permitido');
});

// ---------------------------------------------------------------------------
// Canais: ref, referral e ack
// ---------------------------------------------------------------------------

test('canais extraem o ref: Telegram /start, WhatsApp (anúncio), Instagram (ig.me) e Webchat', () => {
  const tg = new TelegramChannel({ botToken: 'B', webhookSecret: 's' });
  const [start] = tg.parseUpdate({ update_id: 1, message: { chat: { id: 9 }, from: { first_name: 'Rui' }, text: '/start site' } }, 't');
  assert.deepEqual(start.data, { ref: 'site' });
  const [plain] = tg.parseUpdate({ update_id: 2, message: { chat: { id: 9 }, text: '/start' } }, 't');
  assert.equal(plain.data, undefined);
  const [cb] = tg.parseUpdate({ update_id: 3, callback_query: { id: 'q1', data: 'sim', message: { chat: { id: 9 } }, from: {} } }, 't');
  assert.deepEqual([cb.kind, cb.optionId, cb.data?.callbackQueryId], ['choice', 'sim', 'q1']);

  const wa = new WhatsAppChannel({ phoneNumberId: '1', accessToken: 't', appSecret: 's', verifyToken: 'v' });
  const [ad] = wa.parseWebhook({ entry: [{ changes: [{ value: { messages: [{ id: 'w1', from: '55', type: 'text', text: { body: 'Olá! Quero saber mais' }, referral: { source_id: 'ad-123', source_url: 'https://fb.me/x', headline: 'Promo' } }] } }] }] }, 't');
  assert.equal(ad.data?.ref, 'ad-123');

  const ig = new InstagramChannel({ accountId: 'IG', accessToken: 't', appSecret: 's', verifyToken: 'v' });
  const [open] = ig.parseWebhook({ entry: [{ messaging: [{ sender: { id: 'u1' }, timestamp: 5, referral: { ref: 'bio', source: 'SHORTLINK', type: 'OPEN_THREAD' } }] }] }, 't');
  assert.deepEqual([open.kind, open.text, open.data?.ref, open.eventId], ['text', '', 'bio', 'igr:u1:5']);

  const web = new WebchatChannel();
  assert.equal(web.toInbound('t', { userId: 'u', ref: 'site' }).data?.ref, 'site');
  assert.throws(() => web.toInbound('t', { userId: 'u', ref: 'com espaço' }), /ref inválido/);
});

test('Telegram: answerCallback confirma o clique e nunca lança', async () => {
  const calls: { url: string; body: any }[] = [];
  const ok = (async (url: string, init: RequestInit) => {
    calls.push({ url, body: JSON.parse(String(init.body)) });
    return new Response('{}');
  }) as typeof fetch;
  await new TelegramChannel({ botToken: 'B', webhookSecret: 's' }, ok).answerCallback('q1');
  assert.deepEqual(calls, [{ url: 'https://api.telegram.org/botB/answerCallbackQuery', body: { callback_query_id: 'q1' } }]);
  const down = (async () => {
    throw new Error('rede');
  }) as typeof fetch;
  await new TelegramChannel({ botToken: 'B', webhookSecret: 's' }, down).answerCallback('q1');
});

// ---------------------------------------------------------------------------
// Resposta única a comentário (private reply)
// ---------------------------------------------------------------------------

const to: Address = { tenantId: 't', channel: 'instagram', userId: 'u', conversationId: 't:instagram:u' };

test('coalesceSends: une textos, mantém botões da última escolha e não mexe nos outros comandos', () => {
  const cmds: Command[] = [
    { type: 'send', to, message: { kind: 'text', text: 'Oi!' } },
    { type: 'schedule', to, token: 'k', delaySec: 60, reason: 'timeout' },
    { type: 'send', to, message: { kind: 'media', media: { kind: 'image', url: 'https://x/img.png', caption: 'Nosso espaço' } } },
    { type: 'send', to, message: { kind: 'choice', text: 'Quer o material?', options: [{ id: 's', label: 'Sim' }], display: 'buttons' } },
  ];
  const out = coalesceSends(cmds);
  assert.equal(out.length, 2);
  assert.deepEqual(out[0], {
    type: 'send', to,
    message: { kind: 'choice', text: 'Oi!\n\nNosso espaço\nhttps://x/img.png\n\nQuer o material?', options: [{ id: 's', label: 'Sim' }], display: 'buttons' },
  });
  assert.equal(out[1].type, 'schedule');
  const single = cmds.slice(0, 2);
  assert.equal(coalesceSends(single), single, 'um único envio: comandos inalterados');
});

test('comentário: o primeiro turno sai como UMA mensagem; turnos seguintes não são aglutinados', async () => {
  const isca = flow({
    id: 'isca',
    triggers: [{ kind: 'comment', values: ['quero'], tags: ['origem_comentario'] }],
    nodes: {
      ola: { type: 'message', text: 'Oi! Vi seu comentário 😊', next: 'oferta' },
      oferta: { type: 'router', prompt: 'Quer receber o material?', display: 'buttons', options: [{ id: 'sim', label: 'Sim', next: 'a' }] },
      a: { type: 'message', text: 'Aqui está!', next: 'b' },
      b: { type: 'end', message: 'Até mais!' },
    },
  });
  const b = makeEngine([isca]);
  const first = await b.say('QUERO', { data: { source: 'comment', commentId: 'c1', mediaId: 'p1' } });
  const sends = first.commands.filter((c) => c.type === 'send');
  assert.equal(sends.length, 1);
  assert.deepEqual(texts(first.commands), ['Oi! Vi seu comentário 😊\n\nQuer receber o material?']);
  assert.deepEqual(b.storage.getContact(b.conv)!.tags, ['origem_comentario']);
  assert.deepEqual(texts((await b.click('sim')).commands), ['Aqui está!', 'Até mais!']);

  const off = makeEngine([isca], { config: { commentSingleReply: false } });
  const raw = await off.say('QUERO', { data: { source: 'comment', commentId: 'c1', mediaId: 'p1' } });
  assert.equal(raw.commands.filter((c) => c.type === 'send').length, 2, 'política desligável');
});

// ---------------------------------------------------------------------------
// Limpeza de contatos
// ---------------------------------------------------------------------------

test('limpeza de contatos: dryRun por padrão, preserva VIP e conversas ativas, remove inativos', async () => {
  let now = new Date('2026-01-05T13:00:00Z');
  const fim = flow({ id: 'fim', nodes: { e: { type: 'end', message: 'ok' } } });
  const esperando = flow({ id: 'espera', triggers: [{ kind: 'keyword', values: ['pergunta'] }], nodes: { q: { type: 'input', prompt: '?', saveTo: 'session.x', next: 'e' }, e: { type: 'end' } } });
  const app = createBotApp({ storage: new MemoryStorage(), clock: () => now });
  app.registry.publish(fim, esperando);
  const say = (userId: string, text: string) => app.engine.handle({ eventId: crypto.randomUUID(), tenantId: 'x', channel: 'webchat', userId, kind: 'text', text });
  await say('inativo', 'oi');
  await say('vip', 'oi');
  await say('ativo', 'pergunta'); // fica aguardando resposta
  const vip = app.storage.getContact('x:webchat:vip')!;
  vip.tags.push('vip');
  app.storage.commitTurn({ session: { ...app.storage.getSession('x:webchat:vip')!, rev: 2 }, expectedRev: 1, contact: vip, eventId: 'tag-vip', commands: [] });
  now = new Date('2026-03-01T13:00:00Z');
  await say('recente', 'oi');

  const preview = app.cleanupContacts({ inactiveDays: 30, keepTags: ['vip'] });
  assert.deepEqual(preview, { removed: ['x:webchat:inativo'], kept: 3, dryRun: true });
  assert.ok(app.storage.getContact('x:webchat:inativo'), 'dryRun não apaga');

  app.cleanupContacts({ inactiveDays: 30, keepTags: ['vip'], dryRun: false });
  assert.equal(app.storage.getContact('x:webchat:inativo'), undefined);
  assert.equal(app.storage.getSession('x:webchat:inativo'), undefined);
  assert.throws(() => app.cleanupContacts({ inactiveDays: 0 }), /inactiveDays/);

  // Contato apagado volta como novo, sem conflito de versão
  assert.deepEqual(texts((await say('inativo', 'oi')).commands), ['ok']);
  app.stop();
});

test('SQLite: deleteContact remove contato e sessão', async () => {
  const storage = new SqliteStorage(join(mkdtempSync(join(tmpdir(), 'ga-')), 'db.sqlite'));
  const b = makeEngine([flow({ id: 'f', nodes: { e: { type: 'end', message: 'ok' } } })], { storage });
  await b.say('oi');
  assert.ok(storage.getContact(b.conv)?.fields.last_seen_at, 'last_seen_at registrado a cada mensagem');
  storage.deleteContact(b.conv);
  assert.equal(storage.getContact(b.conv), undefined);
  assert.equal(storage.getSession(b.conv), undefined);
  assert.deepEqual(texts((await b.say('oi de novo')).commands), ['ok']);
  storage.close();
});

// ---------------------------------------------------------------------------
// Avisos de limites de canal
// ---------------------------------------------------------------------------

test('validador avisa rótulo > 20 caracteres e texto livre depois de 24h (template silencia o aviso)', () => {
  const longo = flow({
    nodes: {
      m: { type: 'router', prompt: 'x', options: [{ id: 'a', label: 'Uma opção com rótulo comprido', next: 'e' }, { id: 'b', label: '{{tenant.labelMuitoGrandeMasDinamico}}', next: 'e' }] },
      e: { type: 'end' },
    },
  });
  const w1 = validateFlow(longo).warnings;
  assert.equal(w1.filter((w) => /rótulo/.test(w)).length, 1, 'rótulo com template não é avaliado');

  const lembrete = (next: Record<string, unknown>) =>
    flow({ nodes: { w: { type: 'wait', seconds: 2 * 86400, next: 'n' }, n: next as any, e: { type: 'end' } } });
  assert.ok(validateFlow(lembrete({ type: 'message', text: 'Volta!', next: 'e' })).warnings.some((w) => /janela de 24h/.test(w)));
  assert.ok(!validateFlow(lembrete({ type: 'message', text: 'Volta!', template: { name: 't', language: 'pt_BR' }, next: 'e' })).warnings.some((w) => /24h/.test(w)));
});

// ---------------------------------------------------------------------------
// Fluxo de atendimento por setor (oficina) com fluxos e clientes reais do repositório
// ---------------------------------------------------------------------------

test('atendimento por setor: oficina entra pela URA, KM decide o pacote e o atraso inteligente lembra em 10 min', async () => {
  const registry = new FlowRegistry();
  registry.loadDir(join(root, 'flows'));
  const tenants = new TenantRegistry();
  tenants.loadDir(join(root, 'tenants'));
  const storage = new MemoryStorage();
  let now = BUSINESS_HOURS;
  const engine = new StateEngine({ registry, storage, tenants, clock: () => now });
  const base = { tenantId: 'oficina', channel: 'whatsapp', userId: '5511999' };
  const say = (text: string, extra: Partial<InboundEvent> = {}) => engine.handle({ ...base, eventId: crypto.randomUUID(), kind: 'text', text, ...extra });
  const conv = 'oficina:whatsapp:5511999';

  let r = await say('oi');
  assert.deepEqual(texts(r.commands), ['Bom dia! 👋 Você está falando com a Oficina Exemplo.', 'Para começar, qual é o seu nome?']);
  assert.deepEqual(storage.getContact(conv)!.tags, []);
  r = await say('Edu Lima');
  assert.equal(texts(r.commands)[0], 'Edu Lima, com qual setor você quer falar?');
  await engine.handle({ ...base, eventId: 'c1', kind: 'choice', optionId: 'revisao' });
  await say('Onix 2021');
  r = await say('muitos');
  assert.match(texts(r.commands)[0], /só os números/);
  r = await say('52.300');
  assert.match(texts(r.commands)[0], /Onix 2021 com 52300 km recomendamos: \*Revisão completa/);
  assert.ok(commandOf(r.commands, 'schedule'), 'confirmação agenda o atraso inteligente');

  now = new Date(BUSINESS_HOURS.getTime() + 600_000);
  r = await engine.handle({ ...base, eventId: 'tm', kind: 'timer', data: { token: storage.getSession(conv)!.waitToken } });
  assert.deepEqual(texts(r.commands), ['Oi Edu Lima! Passando para saber se conseguiu escolher um horário 🗓️', 'Conseguiu agendar?']);
  r = await say('sim');
  assert.deepEqual(texts(r.commands), ['Perfeito! Te esperamos na Oficina Exemplo. 🔧']);
  assert.deepEqual(storage.getContact(conv)!.tags.sort(), ['agendado', 'setor_revisao']);

  // Link de campanha (ref) etiqueta a origem; clínica (sem o fluxo na lista) não é afetada.
  const ref = await engine.handle({ ...base, userId: '5511888', eventId: 'r1', kind: 'text', text: '/start site', data: { ref: 'site' } });
  assert.match(texts(ref.commands)[0], /Oficina Exemplo/);
  assert.deepEqual(storage.getContact('oficina:whatsapp:5511888')!.tags, ['origem_link']);
  const clinica = await engine.handle({ tenantId: 'clinica', channel: 'webchat', userId: 'c', eventId: 'k1', kind: 'text', text: 'oi' });
  assert.match(texts(clinica.commands)[0], /Clínica Exemplo/);
  assert.equal(storage.getSession('clinica:webchat:c')!.flowId, 'pre-atendimento');
});
