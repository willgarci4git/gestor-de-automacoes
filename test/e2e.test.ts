/**
 * Teste ponta a ponta: servidor HTTP real + fluxos do projeto + dispatcher + integrações reais
 * (servidores falsos locais para a planilha/CRM e para a Graph API do WhatsApp).
 */
import { test, after, before } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import { createHmac } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import { createBotApp, type BotApp } from '../src/runtime/app.ts';
import { SqliteStorage } from '../src/storage/sqlite.ts';
import { WhatsAppChannel } from '../src/channels/whatsapp.ts';
import { createHttpServer } from '../src/server/http.ts';
import { BUSINESS_HOURS } from './helpers.ts';

const ADMIN = 'admin-secreto';
let app: BotApp;
let server: Server;
let base = '';
const leads: any[] = [];
const graphCalls: any[] = [];
let fakes: Server;

const listen = (s: Server) => new Promise<string>((r) => s.listen(0, '127.0.0.1', () => r(`http://127.0.0.1:${(s.address() as AddressInfo).port}`)));

before(async () => {
  fakes = createServer(async (req, res) => {
    let body = '';
    for await (const c of req) body += c;
    if (req.url === '/leads') leads.push(JSON.parse(body));
    else graphCalls.push({ url: req.url, auth: req.headers.authorization, body: JSON.parse(body) });
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ ok: true, row: leads.length }));
  });
  const fakeBase = await listen(fakes);
  app = createBotApp({
    storage: new SqliteStorage(':memory:'),
    flowsDir: new URL('../flows', import.meta.url).pathname,
    tenantsDir: new URL('../tenants', import.meta.url).pathname,
    adapters: [new WhatsAppChannel({ phoneNumberId: 'PNID', accessToken: 'tok', appSecret: 'app-secret', verifyToken: 'vt', graphBaseUrl: fakeBase })],
    getSecret: (n) => (n === 'leads_webhook_url' ? `${fakeBase}/leads` : undefined),
    clock: () => BUSINESS_HOURS,
  });
  app.start();
  server = createHttpServer(app, { tenantId: 'clinica', adminToken: ADMIN, publicDir: new URL('../public', import.meta.url).pathname });
  base = await listen(server);
});

after(() => {
  app.stop();
  server.close();
  fakes.close();
});

async function waitFor<T>(fn: () => T | Promise<T>, ok: (v: T) => boolean, ms = 3000): Promise<T> {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (ok(v)) return v;
    if (Date.now() > end) throw new Error('timeout esperando condição: ' + JSON.stringify(v).slice(0, 500));
    await new Promise((r) => setTimeout(r, 20));
  }
}

const post = (path: string, body: unknown, headers: Record<string, string> = {}) =>
  fetch(base + path, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) });
const admin = { 'x-admin-token': ADMIN };

async function chat(userId: string, body: Record<string, unknown>, expectBotMsgs: number) {
  const r = await post('/webchat/clinica/messages', { userId, ...body });
  assert.equal(r.status, 202);
  return waitFor(
    () => fetch(`${base}/webchat/clinica/history?userId=${userId}`).then((x) => x.json()),
    (h: any[]) => h.filter((e) => e.from === 'bot').length >= expectBotMsgs,
  );
}
const lastBot = (h: any[]) => h.filter((e) => e.from === 'bot').at(-1).message;

test('webchat: pré-atendimento completo com agendamento, integração e transbordo humano', async () => {
  let h = await chat('ana', { text: 'Oi, bom dia', name: 'Ana' }, 2);
  assert.match(h[1].message.text, /bem-vindo/);
  assert.equal(lastBot(h).text, 'Para começar, qual é o seu nome completo?');

  h = await chat('ana', { text: 'Ana Souza' }, 3);
  assert.equal(lastBot(h).kind, 'choice');
  assert.equal(lastBot(h).text, 'Como posso te ajudar hoje, Ana Souza?');

  h = await chat('ana', { optionId: 'agendar' }, 4);
  assert.equal(lastBot(h).text, 'Qual especialidade você procura?');
  h = await chat('ana', { text: 'dermatologia' }, 5);
  h = await chat('ana', { text: '31/02/2026' }, 6);
  assert.match(lastBot(h).text, /Data inválida/);
  h = await chat('ana', { text: '15/10/2026' }, 7);
  h = await chat('ana', { text: 'tarde' }, 8);
  h = await chat('ana', { text: '(11) 98888-7777' }, 10);

  assert.equal(leads.length, 1, 'lead enviado para a planilha/CRM');
  assert.deepEqual(
    { nome: leads[0].nome, telefone: leads[0].telefone, especialidade: leads[0].especialidade, data: leads[0].data, periodo: leads[0].periodo, canal: leads[0].canal },
    { nome: 'Ana Souza', telefone: '11988887777', especialidade: 'dermato', data: '2026-10-15', periodo: 'tarde', canal: 'webchat' },
  );
  const bot = h.filter((e: any) => e.from === 'bot');
  assert.match(bot.at(-2).message.text, /Pré-agendamento registrado: dermato em 2026-10-15 \(tarde\)/);
  assert.equal(lastBot(h).text, 'Posso ajudar em mais alguma coisa?');

  const contact = await fetch(`${base}/admin/sessions/${encodeURIComponent('clinica:webchat:ana')}`, { headers: admin }).then((r) => r.json());
  assert.deepEqual(contact.contact.tags.sort(), ['interesse_agendamento', 'lead_agendamento']);

  // Transbordo humano (segunda-feira 10h = horário comercial)
  h = await chat('ana', { text: 'quero falar com um atendente' }, 11);
  assert.match(lastBot(h).text, /transferir para nossa equipe/);
  const tickets = await waitFor(
    () => fetch(`${base}/handoff/tickets?status=waiting`, { headers: admin }).then((r) => r.json()),
    (t: any[]) => t.length === 1,
  );
  assert.equal(tickets[0].queue, 'recepcao');
  assert.equal(tickets[0].context['contact.full_name'], 'Ana Souza');

  await post('/webchat/clinica/messages', { userId: 'ana', text: 'Tenho uma dúvida sobre o preparo' });
  await waitFor(() => fetch(`${base}/handoff/tickets`, { headers: admin }).then((r) => r.json()), (t: any[]) => t[0].transcript.some((e: any) => e.from === 'user'));

  const reply = await post(`/handoff/tickets/${tickets[0].id}/reply`, { text: 'Olá Ana, sou a Júlia!', agent: 'Júlia' }, admin);
  assert.equal(reply.status, 200);
  h = await waitFor(() => fetch(`${base}/webchat/clinica/history?userId=ana`).then((r) => r.json()), (x: any[]) => lastBot(x).text === 'Olá Ana, sou a Júlia!');
  assert.equal((await post(`/handoff/tickets/${tickets[0].id}/close`, {}, admin)).status, 200);
  const s = await waitFor(
    () => fetch(`${base}/admin/sessions/${encodeURIComponent('clinica:webchat:ana')}`, { headers: admin }).then((r) => r.json()),
    (x: any) => x.session.status === 'ended',
  );
  assert.equal(s.session.status, 'ended');
  assert.equal((await post(`/handoff/tickets/${tickets[0].id}/close`, {}, admin)).status, 409);
});

test('whatsapp: webhook assinado -> fluxo -> Graph API; assinatura inválida é rejeitada', async () => {
  assert.equal(await fetch(`${base}/whatsapp/webhook?hub.mode=subscribe&hub.verify_token=vt&hub.challenge=abc`).then((r) => r.text()), 'abc');
  const payload = JSON.stringify({
    entry: [{ changes: [{ value: { contacts: [{ wa_id: '5511977776666', profile: { name: 'Bruno Lima' } }], messages: [{ id: 'wamid.X1', from: '5511977776666', type: 'text', text: { body: 'Olá' } }] } }] }],
  });
  const sig = 'sha256=' + createHmac('sha256', 'app-secret').update(payload).digest('hex');
  const bad = await fetch(`${base}/whatsapp/webhook`, { method: 'POST', headers: { 'x-hub-signature-256': 'sha256=00' }, body: payload });
  assert.equal(bad.status, 401);

  const ok = await fetch(`${base}/whatsapp/webhook`, { method: 'POST', headers: { 'x-hub-signature-256': sig, 'content-type': 'application/json' }, body: payload });
  assert.equal(ok.status, 200);
  // reentrega do mesmo webhook (a Meta faz isso) não duplica respostas
  await fetch(`${base}/whatsapp/webhook`, { method: 'POST', headers: { 'x-hub-signature-256': sig, 'content-type': 'application/json' }, body: payload });

  await waitFor(() => graphCalls.length, (n) => n >= 2);
  await new Promise((r) => setTimeout(r, 100));
  assert.equal(graphCalls.length, 2, 'boas-vindas + pergunta do nome, sem duplicação');
  assert.equal(graphCalls[0].url, '/v21.0/PNID/messages');
  assert.equal(graphCalls[0].auth, 'Bearer tok');
  assert.equal(graphCalls[0].body.to, '5511977776666');
  assert.equal(graphCalls[1].body.text.body, 'Para começar, qual é o seu nome completo?');

  const reply = JSON.stringify({ entry: [{ changes: [{ value: { messages: [{ id: 'wamid.X2', from: '5511977776666', type: 'text', text: { body: 'Bruno Lima' } }] } }] }] });
  await fetch(`${base}/whatsapp/webhook`, { method: 'POST', headers: { 'x-hub-signature-256': 'sha256=' + createHmac('sha256', 'app-secret').update(reply).digest('hex') }, body: reply });
  await waitFor(() => graphCalls.length, (n) => n >= 3);
  const menu = graphCalls[2].body;
  assert.equal(menu.type, 'interactive');
  assert.equal(menu.interactive.type, 'list');
  assert.equal(menu.interactive.action.sections[0].rows.length, 4);
});

test('admin: autenticação, validação e publicação de fluxos; métricas', async () => {
  assert.equal((await fetch(`${base}/admin/flows`)).status, 401);
  const list = await fetch(`${base}/admin/flows`, { headers: admin }).then((r) => r.json());
  assert.deepEqual(list.map((f: any) => f.id).sort(), ['agendamento', 'atendimento-setor', 'isca-instagram', 'pre-atendimento', 'reengajamento']);

  const broken = { id: 'novo', version: 1, start: 'a', nodes: { a: { type: 'message', text: 'x', next: 'b' }, b: { type: 'set', next: 'a' } } };
  const r = await post('/admin/flows', broken, admin);
  assert.equal(r.status, 422);
  assert.match(JSON.stringify(await r.json()), /loop sem ponto de espera/);

  const good = { id: 'novo', version: 1, start: 'a', triggers: [{ kind: 'keyword', values: ['promo'] }], nodes: { a: { type: 'end', message: 'Promoção!' } } };
  assert.equal((await post('/admin/flows', good, admin)).status, 201);
  // Tenant "clinica" tem lista de fluxos permitidos: o fluxo novo não vaza para ele.
  const blocked = await chat('promo-user', { text: 'tem promo?' }, 1);
  assert.notEqual(lastBot(blocked).text, 'Promoção!');
  // Tenant sem restrição (cai no default.json) usa o fluxo recém-publicado.
  const r2 = await post('/webchat/livre/messages', { userId: 'promo2', text: 'tem promo?' });
  assert.equal(r2.status, 202);
  const h = await waitFor(() => fetch(`${base}/webchat/livre/history?userId=promo2`).then((x) => x.json()), (x: any[]) => x.some((e) => e.from === 'bot'));
  assert.equal(lastBot(h).text, 'Promoção!');

  const m = await fetch(`${base}/metrics`, { headers: admin }).then((r) => r.json());
  assert.ok(m.counters['engine.sessions_started'] >= 3);
  assert.ok(m.counters['engine.events.duplicate'] >= 1);
  assert.ok(m.counters['integration.ok'] >= 1);
  assert.ok(m.timings['engine.turn_ms'].p95 < 150, 'latência do motor dentro da meta');
  assert.equal((await fetch(`${base}/health`)).status, 200);
  assert.equal((await post('/webchat/clinica/messages', { userId: '../x', text: 'a' })).status, 400);

  // Limpeza de contatos: protegida por token, segura por padrão (dryRun) e valida parâmetros.
  assert.equal((await post('/admin/contacts/cleanup', { inactiveDays: 30 })).status, 401);
  const preview = await post('/admin/contacts/cleanup', { inactiveDays: 30, keepTags: ['vip'] }, admin).then((r) => r.json());
  assert.equal(preview.dryRun, true);
  assert.deepEqual(preview.removed, [], 'conversas recentes não são removidas');
  assert.equal((await post('/admin/contacts/cleanup', { inactiveDays: 0 }, admin)).status, 400);
});
