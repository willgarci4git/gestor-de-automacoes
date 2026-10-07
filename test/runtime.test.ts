import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { SqliteStorage } from '../src/storage/sqlite.ts';
import { ConflictError } from '../src/storage/types.ts';
import { runHttp, CircuitBreaker } from '../src/integrations/http-runner.ts';
import { WhatsAppChannel } from '../src/channels/whatsapp.ts';
import { TelegramChannel } from '../src/channels/telegram.ts';
import { PermanentChannelError } from '../src/channels/types.ts';
import { makeEngine, texts, flow } from './helpers.ts';
import type { Session } from '../src/core/types.ts';

test('outbox: falha transitória segura as mensagens seguintes da conversa (ordem preservada)', async () => {
  const { createBotApp } = await import('../src/runtime/app.ts');
  const { MemoryStorage } = await import('../src/storage/memory.ts');
  const sent: string[] = [];
  let fails = 1;
  const adapter = {
    name: 'fake',
    async send(_to: unknown, m: { kind: string; text?: string } & Record<string, unknown>) {
      if (fails-- > 0) throw new Error('503');
      sent.push(String(m.text ?? ''));
    },
  };
  const app = createBotApp({ storage: new MemoryStorage(), adapters: [adapter], outboxRetryMs: 30 });
  app.registry.publish(flow({ id: 'o', nodes: { a: { type: 'message', text: '1', next: 'b' }, b: { type: 'message', text: '2', next: 'c' }, c: { type: 'end', message: '3' } } }));
  app.start();
  await app.receive({ eventId: 'x', tenantId: 't', channel: 'fake', userId: 'u', kind: 'text', text: 'oi' });
  for (let i = 0; i < 60 && sent.length < 3; i++) await new Promise((r) => setTimeout(r, 25));
  app.stop();
  assert.deepEqual(sent, ['1', '2', '3']);
});

// ---------------------------------------------------------------- storage
test('SQLite: commit atômico, conflito otimista, outbox, jobs e tickets', () => {
  const st = new SqliteStorage(':memory:');
  const session = { conversationId: 'c1', rev: 1, updatedAt: 'x' } as Session;
  const contact = { conversationId: 'c1', fields: { a: 1 }, tags: [] };
  const cmd = { type: 'emit' as const, name: 'x', data: {} };
  st.commitTurn({ session, expectedRev: 0, contact, eventId: 'e1', commands: [cmd, cmd] });
  assert.equal(st.hasProcessedEvent('e1'), true);
  assert.equal(st.getContact('c1')!.fields.a, 1);
  assert.throws(() => st.commitTurn({ session: { ...session, rev: 2 }, expectedRev: 0, contact, eventId: 'e2', commands: [] }), ConflictError);
  assert.throws(() => st.commitTurn({ session: { ...session, rev: 3 }, expectedRev: 2, contact, eventId: 'e3', commands: [cmd] }), ConflictError);
  assert.equal(st.hasProcessedEvent('e3'), false, 'rollback não marca evento');
  assert.equal(st.pendingOutbox(Date.now(), 10).length, 2, 'rollback não grava comandos');
  st.commitTurn({ session: { ...session, rev: 2 }, expectedRev: 1, contact, eventId: 'e2', commands: [] });

  const [a, b] = st.pendingOutbox(Date.now(), 10);
  st.completeOutbox(a.id);
  st.failOutbox(b.id, 'x', Date.now() + 60_000);
  assert.equal(st.pendingOutbox(Date.now(), 10).length, 0);
  st.failOutbox(b.id, 'y', null);
  assert.equal(st.deadLetters()[0].attempts, 2);

  st.scheduleJob({ id: 'j', dueAt: 100, event: { eventId: 'x', tenantId: 't', channel: 'c', userId: 'u', kind: 'timer' } });
  assert.equal(st.dueJobs(50, 10).length, 0);
  assert.equal(st.dueJobs(150, 10).length, 1);
  st.deleteJob('j');
  assert.equal(st.dueJobs(150, 10).length, 0);

  const t = { id: 't1', conversationId: 'c1', address: { tenantId: 't', channel: 'c', userId: 'u', conversationId: 'c1' }, queue: 'q', status: 'waiting' as const, context: {}, transcript: [], createdAt: 'x' };
  st.saveTicket(t);
  assert.equal(st.openTicketFor('c1')!.id, 't1');
  st.saveTicket({ ...t, status: 'closed' });
  assert.equal(st.openTicketFor('c1'), undefined);
  assert.equal(st.listTickets({ status: 'closed' }).length, 1);
  st.close();
});

test('motor completo sobre SQLite', async () => {
  const st = new SqliteStorage(':memory:');
  const f = flow({ id: 's', nodes: { q: { type: 'input', prompt: 'Nome?', saveTo: 'contact.nome', next: 'e' }, e: { type: 'end', message: 'Oi {{contact.nome}}' } } });
  const b = makeEngine([f], { storage: st });
  await b.say('x');
  assert.deepEqual(texts((await b.say('Ana')).commands), ['Oi Ana']);
  assert.equal(st.getSession(b.conv)!.status, 'ended');
});

// ---------------------------------------------------------------- http runner
const fakeFetch = (responses: (Response | Error | 'hang')[]) => {
  let i = 0;
  const calls: RequestInit[] = [];
  const fn = (async (_url: string, init: RequestInit) => {
    calls.push(init);
    const r = responses[Math.min(i++, responses.length - 1)];
    if (r === 'hang') return new Promise((_, rej) => init.signal!.addEventListener('abort', () => rej(new Error('aborted'))));
    if (r instanceof Error) throw r;
    return r.clone();
  }) as unknown as typeof fetch;
  return { fn, calls };
};
const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const base = { timeoutMs: 200, retry: { max: 2, backoffMs: 1 }, getSecret: (n: string) => (n === 'tk' ? 'SEGREDO' : undefined) };

test('HTTP: retry em 5xx e sucesso; secrets resolvidos só aqui', async () => {
  const f = fakeFetch([json(503, {}), json(200, { id: 7 })]);
  const r = await runHttp({ method: 'POST', url: 'https://api.x/y', headers: { authorization: 'Bearer {{secrets.tk}}' }, body: { a: 1 } }, { ...base, breaker: new CircuitBreaker(), fetchImpl: f.fn });
  assert.equal(r.ok, true);
  assert.deepEqual(r.body, { id: 7 });
  assert.equal(r.attempts, 2);
  assert.equal((f.calls[0].headers as Record<string, string>).authorization, 'Bearer SEGREDO');
});

test('HTTP: 4xx não repete; timeout repete; secret ausente falha sem chamar', async () => {
  const f = fakeFetch([json(400, { e: 1 })]);
  const r = await runHttp({ method: 'GET', url: 'https://api.x' }, { ...base, breaker: new CircuitBreaker(), fetchImpl: f.fn });
  assert.equal(r.ok, false);
  assert.equal(f.calls.length, 1);

  const h = fakeFetch(['hang']);
  const t = await runHttp({ method: 'GET', url: 'https://api.x' }, { ...base, breaker: new CircuitBreaker(), fetchImpl: h.fn });
  assert.equal(t.error, 'timeout');
  assert.equal(h.calls.length, 3);

  const s = fakeFetch([json(200, {})]);
  const m = await runHttp({ method: 'GET', url: '{{secrets.nao}}' }, { ...base, breaker: new CircuitBreaker(), fetchImpl: s.fn });
  assert.match(m.error!, /não configurado/);
  assert.equal(s.calls.length, 0);
});

test('Circuit breaker abre após falhas e fecha após sucesso em half-open', async () => {
  let now = 0;
  const br = new CircuitBreaker({ failureThreshold: 3, resetMs: 1000, now: () => now });
  const failing = fakeFetch([new Error('ECONNREFUSED')]);
  const opts = { ...base, retry: { max: 0, backoffMs: 1 }, breaker: br };
  for (let i = 0; i < 3; i++) await runHttp({ method: 'GET', url: 'https://down.x' }, { ...opts, fetchImpl: failing.fn });
  assert.equal(br.status('down.x'), 'open');
  const fast = await runHttp({ method: 'GET', url: 'https://down.x' }, { ...opts, fetchImpl: failing.fn });
  assert.match(fast.error!, /circuit_open/);
  assert.equal(failing.calls.length, 3, 'não chamou a API com circuito aberto');
  now = 1500;
  assert.equal(br.status('down.x'), 'half-open');
  const ok = await runHttp({ method: 'GET', url: 'https://down.x' }, { ...opts, fetchImpl: fakeFetch([json(200, {})]).fn });
  assert.equal(ok.ok, true);
  assert.equal(br.status('down.x'), 'closed');
});

// ---------------------------------------------------------------- canais
const wa = (fetchImpl?: typeof fetch) => new WhatsAppChannel({ phoneNumberId: '123', accessToken: 'tok', appSecret: 's3cr3t', verifyToken: 'vt' }, fetchImpl);

test('WhatsApp: verificação do webhook e assinatura HMAC', () => {
  const ch = wa();
  assert.equal(ch.verifyChallenge(new URLSearchParams('hub.mode=subscribe&hub.verify_token=vt&hub.challenge=42')), '42');
  assert.equal(ch.verifyChallenge(new URLSearchParams('hub.mode=subscribe&hub.verify_token=errado&hub.challenge=42')), null);
  const body = '{"a":1}';
  const sig = 'sha256=' + createHmac('sha256', 's3cr3t').update(body).digest('hex');
  assert.equal(ch.verifySignature(body, sig), true);
  assert.equal(ch.verifySignature(body + ' ', sig), false);
  assert.equal(ch.verifySignature(body, undefined), false);
  assert.equal(ch.verifySignature(body, 'sha256=abc'), false);
});

test('WhatsApp: normaliza texto, botão, lista, mídia e ignora status', () => {
  const payload = {
    entry: [{ changes: [{ value: {
      contacts: [{ wa_id: '5511999', profile: { name: 'Ana Souza' } }],
      messages: [
        { id: 'w1', from: '5511999', type: 'text', text: { body: 'Oi' }, timestamp: '1700000000' },
        { id: 'w2', from: '5511999', type: 'interactive', interactive: { type: 'button_reply', button_reply: { id: 'agendar', title: 'Agendar' } } },
        { id: 'w3', from: '5511999', type: 'interactive', interactive: { type: 'list_reply', list_reply: { id: 'planos', title: 'Planos' } } },
        { id: 'w4', from: '5511999', type: 'image', image: { id: 'm1', caption: 'foto' } },
        { id: 'w5', from: '5511999', type: 'reaction', reaction: {} },
      ],
      statuses: [{ id: 'w0', status: 'read' }],
    } }] }],
  };
  const evs = wa().parseWebhook(payload, 't');
  assert.equal(evs.length, 4);
  assert.deepEqual([evs[0].kind, evs[0].text, evs[0].profile?.name], ['text', 'Oi', 'Ana Souza']);
  assert.deepEqual([evs[1].kind, evs[1].optionId], ['choice', 'agendar']);
  assert.equal(evs[2].optionId, 'planos');
  assert.deepEqual(evs[3].media, { kind: 'image', id: 'm1' });
});

test('WhatsApp: renderização respeita limites do canal', () => {
  const ch = wa();
  const opts = (n: number) => Array.from({ length: n }, (_, i) => ({ id: `o${i}`, label: `Opção número ${i} com texto longo` }));
  const b = ch.buildPayload('55', { kind: 'choice', text: 'Escolha', options: opts(3), display: 'buttons' }) as any;
  assert.equal(b.interactive.type, 'button');
  assert.ok(b.interactive.action.buttons.every((x: any) => x.reply.title.length <= 20));
  const l = ch.buildPayload('55', { kind: 'choice', text: 'Escolha', options: opts(5), display: 'buttons' }) as any;
  assert.equal(l.interactive.type, 'list');
  const t = ch.buildPayload('55', { kind: 'choice', text: 'Escolha', options: opts(12), display: 'list' }) as any;
  assert.equal(t.type, 'text');
  assert.match(t.text.body, /12\. Opção número 11/);
  const m = ch.buildPayload('55', { kind: 'media', media: { kind: 'document', url: 'https://x/a.pdf', filename: 'a.pdf' } }) as any;
  assert.deepEqual(m.document, { link: 'https://x/a.pdf', filename: 'a.pdf' });
});

test('WhatsApp: 4xx é erro permanente (sem retry), 5xx é transitório', async () => {
  const addr = { tenantId: 't', channel: 'whatsapp', userId: '55', conversationId: 'c' };
  await assert.rejects(wa(fakeFetch([json(400, {})]).fn).send(addr, { kind: 'text', text: 'x' }), PermanentChannelError);
  await assert.rejects(wa(fakeFetch([json(500, {})]).fn).send(addr, { kind: 'text', text: 'x' }), (e) => !(e instanceof PermanentChannelError));
  const ok = fakeFetch([json(200, {})]);
  await wa(ok.fn).send(addr, { kind: 'text', text: 'x' });
  assert.equal((ok.calls[0].headers as Record<string, string>).authorization, 'Bearer tok');
});

test('Telegram: secret, update de texto e callback, teclado inline', () => {
  const tg = new TelegramChannel({ botToken: 'b', webhookSecret: 'sec' });
  assert.equal(tg.verifySecret('sec'), true);
  assert.equal(tg.verifySecret('x'), false);
  const [t] = tg.parseUpdate({ update_id: 1, message: { chat: { id: 9 }, from: { first_name: 'Ana' }, text: 'oi' } }, 't');
  assert.deepEqual([t.eventId, t.userId, t.text, t.profile?.name], ['tg:1', '9', 'oi', 'Ana']);
  const [c] = tg.parseUpdate({ update_id: 2, callback_query: { data: 'agendar', from: { id: 9 }, message: { chat: { id: 9 } } } }, 't');
  assert.deepEqual([c.kind, c.optionId], ['choice', 'agendar']);
  const req = tg.buildRequest('9', { kind: 'choice', text: 'Escolha', options: [{ id: 'a', label: 'A' }], display: 'buttons' });
  assert.deepEqual((req.body.reply_markup as any).inline_keyboard, [[{ text: 'A', callback_data: 'a' }]]);
});
