// Aba "Diagnóstico": roteiros automáticos que provam, no navegador, que a integração funciona
// ponta a ponta (formatos oficiais de webhook e de API, idempotência, falhas, transbordo…).
import { Simulation } from './sim.js';
import { validateFlow } from './lib/core/validator.js';
import { state } from './state.js';
import data from './data.js';
import { h, clear } from './ui.js';

let root;
let results = [];
let running = false;

const MONDAY_10H = '2030-01-07T13:00:00.000Z'; // segunda-feira, 10h em Brasília
const SUNDAY_10H = '2030-01-06T13:00:00.000Z';
const secrets = { leads_webhook_url: 'https://script.google.com/macros/s/EXEMPLO/exec' };

function newSim(channel, extra = {}) {
  return new Simulation({ flows: data.flows, tenants: data.tenants, tenantId: 'clinica', channel, userName: 'Ana Souza', startAt: MONDAY_10H, secrets, ...extra });
}

function expect(cond, msg) {
  if (!cond) throw new Error(msg);
}

async function until(fn, ms = 4000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (fn()) return true;
    await new Promise((r) => setTimeout(r, 50));
  }
  return fn();
}

const bots = (s) => s.timeline.filter((b) => b.from === 'bot' || b.from === 'agent');
const last = (s) => bots(s).at(-1) ?? {};
const outs = (s) => s.http.filter((x) => x.dir === 'out' && x.kind === 'channel');
const texts = (s) => bots(s).map((b) => b.text ?? '').join('\n');

const API = {
  whatsapp: /graph\.facebook\.com\/v21\.0\/PNID-DEMO\/messages$/,
  instagram: /graph\.facebook\.com\/v21\.0\/IG-DEMO\/messages$/,
  telegram: /api\.telegram\.org\/bot\*\*\*\/sendMessage$/,
};
const NATIVE = { webchat: 'buttons', whatsapp: 'list', instagram: 'quick', telegram: 'inline' };

function scenarios() {
  const list = [];
  const add = (group, name, fn) => list.push({ group, name, fn });

  for (const ch of ['webchat', 'whatsapp', 'instagram', 'telegram']) {
    add(`Canal: ${ch}`, 'Webhook oficial → motor → resposta pela API do canal', async () => {
      const s = newSim(ch);
      await s.sendText('oi');
      expect(bots(s).length >= 2, `esperava boas-vindas + pergunta, veio ${bots(s).length} mensagem(ns)`);
      expect(/Bom dia/.test(texts(s)) && /Clínica Exemplo/.test(texts(s)), 'saudação/parâmetros do cliente não aplicados');
      if (ch !== 'webchat') {
        expect(outs(s).length >= 2 && outs(s).every((o) => API[ch].test(o.url)), `chamada de saída fora do endpoint oficial: ${outs(s)[0]?.url}`);
      }
      s.dispose();
      return `${bots(s).length} mensagens; ${ch === 'webchat' ? 'SSE/HTTP local' : outs(s)[0].url}`;
    });
    add(`Canal: ${ch}`, 'Menu renderizado no componente nativo do canal', async () => {
      const s = newSim(ch);
      await s.sendText('oi');
      await s.sendText('Ana Souza');
      const b = last(s);
      expect(b[NATIVE[ch]], `esperava componente "${NATIVE[ch]}", veio ${JSON.stringify(Object.keys(b))}`);
      const opts = b.buttons ?? b.list?.rows ?? b.quick ?? b.inline;
      expect(opts.length === 4, `esperava 4 opções, veio ${opts.length}`);
      s.dispose();
      return `${NATIVE[ch]} com ${opts.length} opções`;
    });
    add(`Canal: ${ch}`, 'Clique na opção (payload do canal) avança o fluxo', async () => {
      const s = newSim(ch);
      await s.sendText('oi');
      await s.sendText('Ana Souza');
      const b = last(s);
      const opts = b.buttons ?? b.list?.rows ?? b.quick ?? b.inline;
      await s.clickOption(opts[0]);
      expect(last(s).text === 'Qual especialidade você procura?', `após clique veio: "${last(s).text}"`);
      expect(s.session.flowId === 'agendamento', 'não entrou no subfluxo de agendamento');
      s.dispose();
      return 'entrou no subfluxo "agendamento"';
    });
  }

  add('Resiliência', 'Webhook reentregue pela Meta é descartado (idempotência)', async () => {
    const s = newSim('whatsapp');
    await s.sendText('oi');
    const before = outs(s).length;
    const r = await s.redeliverLast();
    expect(r.length === 1 && r[0].status === 'duplicate', `status: ${r.map((x) => x.status)}`);
    expect(outs(s).length === before, 'reentrega gerou mensagens duplicadas');
    s.dispose();
    return 'duplicata descartada, 0 mensagens extras';
  });

  const agendar = async (s) => {
    await s.sendText('oi');
    await s.sendText('Ana Souza');
    await s.clickOption({ id: 'agendar', label: 'Agendar consulta', kind: 'list_reply' });
    await s.clickOption({ id: 'dermato', label: 'Dermatologia', kind: 'button_reply' });
    await s.sendText('15/10/2030');
    await s.clickOption({ id: 'tarde', label: 'Tarde', kind: 'button_reply' });
    await s.sendText('(11) 98888-7777');
    await until(() => /Pré-agendamento registrado/.test(texts(s)));
  };

  add('Integrações', 'Lead enviado à planilha/CRM (POST com dados coletados)', async () => {
    const s = newSim('whatsapp');
    await agendar(s);
    const call = s.http.find((x) => x.kind === 'integration');
    expect(call && call.url === secrets.leads_webhook_url, 'integração não foi chamada no endpoint configurado');
    expect(call.body.telefone === '11988887777' && call.body.data === '2030-10-15' && call.body.especialidade === 'dermato', `corpo inesperado: ${JSON.stringify(call.body)}`);
    expect(s.contact.tags.includes('lead_agendamento'), 'etiqueta lead_agendamento ausente');
    s.dispose();
    return `POST ${call.url} → ${call.status}`;
  });

  add('Integrações', 'API externa fora do ar: cliente é atendido e lead fica pendente', async () => {
    const s = newSim('whatsapp', { integrationMode: 'fail' });
    await agendar(s);
    expect(/Pré-agendamento registrado/.test(texts(s)), 'cliente não recebeu confirmação');
    expect(s.contact.tags.includes('pendente_sincronizacao'), 'faltou etiqueta pendente_sincronizacao');
    const tries = s.http.filter((x) => x.kind === 'integration').length;
    expect(tries === 3, `esperava 3 tentativas (1 + 2 retries), houve ${tries}`);
    s.dispose();
    return `${tries} tentativas com backoff → caminho onError`;
  });

  add('Resiliência', 'Canal instável (503): reenvio automático até entregar', async () => {
    const s = newSim('whatsapp', { channelFailures: 2 });
    await s.sendText('oi');
    const ok = await until(() => bots(s).length >= 2, 6000);
    expect(ok, `entregou só ${bots(s).length} mensagem(ns)`);
    const fails = s.http.filter((x) => x.status === 503).length;
    expect(fails === 2, `esperava 2 falhas 503, houve ${fails}`);
    s.dispose();
    return `${fails} falhas 503 → entregue na nova tentativa`;
  });

  add('Conversa', 'Timeout de inatividade encerra educadamente', async () => {
    const s = newSim('whatsapp');
    await s.sendText('oi');
    await s.advance(31 * 60_000);
    expect(/inatividade/.test(last(s).text ?? ''), `última mensagem: "${last(s).text}"`);
    expect(s.session.status === 'ended', 'sessão não encerrou');
    s.dispose();
    return 'timer disparado após 30 min';
  });

  add('Conversa', 'Transbordo humano em horário comercial (ticket, resposta, devolução)', async () => {
    const s = newSim('whatsapp');
    await s.sendText('oi');
    await s.sendText('Ana Souza');
    await s.sendText('quero falar com um atendente');
    const [t] = s.tickets();
    expect(t && t.queue === 'recepcao', 'ticket não foi aberto na fila recepcao');
    expect(t.context['contact.full_name'] === 'Ana Souza', 'contexto não chegou ao atendente');
    await s.agent('reply', t.id, 'Olá Ana, sou a Júlia!');
    expect(last(s).from === 'agent' && outs(s).at(-1).body.text.body === 'Olá Ana, sou a Júlia!', 'resposta do atendente não saiu pela API do canal');
    await s.agent('close', t.id);
    expect(s.session.status === 'ended', 'sessão não encerrou após o atendente fechar');
    s.dispose();
    return 'ticket → resposta via WhatsApp → encerrado';
  });

  add('Conversa', 'Fora do horário: deixa recado em vez de transferir', async () => {
    const s = newSim('whatsapp', { startAt: SUNDAY_10H });
    await s.sendText('oi');
    await s.sendText('Ana Souza');
    await s.sendText('atendente');
    expect(/atendimento humano funciona/.test(texts(s)), 'não informou o horário');
    expect(s.tickets().length === 0, 'abriu ticket fora do horário');
    s.dispose();
    return 'domingo → fluxo de recado';
  });

  add('Conversa', 'Opt-out (LGPD): "parar" silencia o bot', async () => {
    const s = newSim('whatsapp');
    await s.sendText('oi');
    await s.sendText('parar');
    const n = bots(s).length;
    await s.sendText('oi');
    expect(bots(s).length === n, 'bot respondeu após opt-out');
    await s.sendText('voltar');
    expect(bots(s).length > n, 'bot não voltou após "voltar"');
    s.dispose();
    return 'silenciado e reativado';
  });

  add('Instagram', 'Comentário "QUERO" → resposta privada no direct + resposta pública', async () => {
    const s = newSim('instagram');
    await s.comment('QUERO');
    const first = outs(s).find((o) => o.url.endsWith('/messages'));
    expect(first?.body.recipient.comment_id, 'primeira resposta não foi private reply');
    expect(s.http.some((x) => x.note === 'resposta pública no post'), 'faltou resposta pública');
    expect(outs(s).filter((o) => o.url.endsWith('/messages')).length === 1, 'enviou mais de uma mensagem antes da resposta do usuário');
    s.dispose();
    return 'private reply única + resposta pública';
  });

  add('Fluxos', 'Todos os fluxos atuais (com suas edições) são válidos', async () => {
    const bad = state.flowList.map((f) => [f.id, validateFlow(f, (id) => !!state.flows[id])]).filter(([, r]) => !r.ok);
    expect(bad.length === 0, bad.map(([id, r]) => `${id}: ${r.errors[0]}`).join(' | '));
    return `${state.flowList.length} fluxos válidos`;
  });
  return list;
}

async function runAll() {
  running = true;
  results = scenarios().map((s) => ({ ...s, status: 'pending' }));
  render();
  for (const r of results) {
    r.status = 'running';
    render();
    const t0 = performance.now();
    try {
      r.detail = await r.fn();
      r.status = 'pass';
    } catch (e) {
      r.status = 'fail';
      r.detail = e.message;
    }
    r.ms = Math.round(performance.now() - t0);
    render();
  }
  running = false;
  render();
}

export function render() {
  if (!root) return;
  const pass = results.filter((r) => r.status === 'pass').length;
  const fail = results.filter((r) => r.status === 'fail').length;
  const groups = [...new Set(results.map((r) => r.group))];
  clear(root, h('div', { class: 'diag' },
    h('section', { class: 'panel' },
      h('div', { class: 'row between' },
        h('div', {},
          h('h2', {}, 'Diagnóstico da integração'),
          h('p', { class: 'muted' }, 'Roteiros automáticos executados aqui no navegador com o código real do framework. Os canais usam os formatos oficiais de webhook e de API (Meta/Telegram); só a rede é simulada. Os roteiros de canal usam os fluxos e clientes originais do repositório; o último valida as suas edições.')),
        h('button', { class: 'primary', disabled: running, onclick: runAll }, running ? 'Executando…' : '▶ Executar diagnóstico')),
      results.length > 0 && h('div', { class: `summary ${fail ? 'bad' : running ? '' : 'good'}` }, `${pass} de ${results.length} aprovados${fail ? ` · ${fail} falha(s)` : ''}`),
      groups.map((g) => h('div', { class: 'diag-group' },
        h('h3', {}, g),
        results.filter((r) => r.group === g).map((r) => h('div', { class: `diag-row ${r.status}` },
          h('span', { class: 'icon' }, { pass: '✔', fail: '✖', running: '…', pending: '·' }[r.status]),
          h('span', { class: 'name' }, r.name),
          h('span', { class: 'detail' }, r.detail ?? ''),
          h('span', { class: 'ms' }, r.ms != null ? `${r.ms} ms` : ''))))),
    ),
  ));
}

export function mountDiagnostics(el) {
  root = el;
  render();
}
