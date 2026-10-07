// Aba "Simulador": conversa em um "celular" por canal + inspeção da integração, do motor e do atendimento humano.
import { Simulation, CHANNELS } from './sim.js';
import { state } from './state.js';
import { renderGraph } from './graph.js';
import { h, clear, json, toast, store } from './ui.js';

const PREF = 'gestor-automacoes-studio.sim';
let sim = null;
let root;
let inspectorTab = store.get(PREF, {}).tab ?? 'estado';
const cfg = Object.assign(
  { tenantId: 'clinica', channel: 'whatsapp', userName: 'Ana Souza', integrationMode: 'ok', channelFailures: 0, startAt: nextBusinessMorning() },
  store.get(PREF, {}).cfg ?? {},
);

function nextBusinessMorning() {
  // Próxima segunda-feira às 10h (horário de Brasília) — garante horário comercial nos exemplos.
  const d = new Date();
  const day = d.getUTCDay();
  const add = ((1 - day + 7) % 7) || 7;
  const t = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + add, 13, 0));
  return t.toISOString();
}

const toLocalInput = (iso) => {
  const d = new Date(iso);
  const sp = new Date(d.getTime() - 3 * 3600_000); // America/Sao_Paulo (sem horário de verão)
  return sp.toISOString().slice(0, 16);
};
const fromLocalInput = (v) => new Date(v + ':00-03:00').toISOString();

function persist() {
  store.set(PREF, { cfg, tab: inspectorTab });
}

export function restart() {
  sim?.dispose();
  sim = null;
  try {
    sim = new Simulation({ ...cfg, flows: state.flowList, tenants: state.tenantList, secrets: state.secrets });
    sim.addEventListener('update', () => render());
  } catch (e) {
    const detail = e.results ? Object.entries(e.results).filter(([, r]) => !r.ok).map(([id, r]) => `${id}: ${r.errors.join('; ')}`).join('\n') : e.message;
    sim = { error: detail };
  }
  render();
}

export function mountSimulator(el) {
  root = el;
  restart();
}

export function currentSim() {
  return sim;
}

// ------------------------------------------------------------------------------------------

function controls() {
  const set = (k, v, restartNeeded = true) => {
    cfg[k] = v;
    persist();
    if (restartNeeded) restart();
    else render();
  };
  const tenantOpts = state.tenantList.map((t) => h('option', { value: t.id, selected: t.id === cfg.tenantId }, t.name ?? t.id));
  const flowOpts = state.flowList.map((f) => h('option', { value: f.id }, f.name ?? f.id));
  let flowSel;
  return h('section', { class: 'panel controls', 'aria-label': 'Configuração da simulação' },
    h('h3', {}, 'Cenário'),
    h('label', {}, 'Cliente (tenant)', h('select', { onchange: (e) => set('tenantId', e.target.value) }, tenantOpts)),
    h('div', { class: 'field' }, h('span', { class: 'lbl' }, 'Canal'),
      h('div', { class: 'seg', role: 'radiogroup' }, Object.entries(CHANNELS).map(([id, c]) =>
        h('button', { class: `ch-${id} ${cfg.channel === id ? 'on' : ''}`, role: 'radio', 'aria-checked': cfg.channel === id, onclick: () => set('channel', id) }, c.label)))),
    h('label', {}, 'Nome do contato', h('input', { value: cfg.userName, onchange: (e) => set('userName', e.target.value) })),
    h('label', {}, 'Data/hora inicial (Brasília)', h('input', { type: 'datetime-local', value: toLocalInput(cfg.startAt), onchange: (e) => set('startAt', fromLocalInput(e.target.value)) })),
    h('label', {}, 'Integração HTTP (planilha/CRM)',
      h('select', { onchange: (e) => { cfg.integrationMode = e.target.value; persist(); if (sim?.app) sim.integrationMode = e.target.value; } },
        [['ok', 'Responde 200 (sucesso)'], ['fail', 'Responde 500 (falha)'], ['timeout', 'Não responde (timeout)']].map(([v, l]) => h('option', { value: v, selected: cfg.integrationMode === v }, l)))),
    h('label', {}, 'Instabilidade do canal',
      h('select', { onchange: (e) => set('channelFailures', Number(e.target.value)) },
        [[0, 'Estável'], [2, '2 falhas 503 antes de aceitar'], [9, 'Fora do ar (vai para dead letter)']].map(([v, l]) => h('option', { value: v, selected: cfg.channelFailures === v }, l)))),
    h('button', { class: 'primary block', onclick: restart }, '↺ Nova conversa'),
    h('h3', {}, 'Ações'),
    h('div', { class: 'row' },
      flowSel = h('select', { 'aria-label': 'Fluxo para disparo ativo' }, flowOpts),
      h('button', { onclick: () => act(() => sim.startFlow(flowSel.value)) }, 'Disparar')),
    h('div', { class: 'row wrap' },
      h('span', { class: 'lbl' }, 'Avançar relógio:'),
      [['+5 min', 5], ['+31 min', 31], ['+1 h', 60], ['+1 dia', 1440]].map(([l, m]) => h('button', { class: 'chip', onclick: () => act(() => sim.advance(m * 60_000)) }, l))),
    cfg.channel === 'instagram' && h('button', { class: 'block', onclick: () => { const t = prompt('Comentário no post/Reel:', 'QUERO'); if (t) act(() => sim.comment(t)); } }, '💬 Comentar no post (gatilho de comentário)'),
    cfg.channel !== 'webchat' && h('button', { class: 'block', onclick: () => act(async () => { const r = await sim.redeliverLast(); toast(r.length && r.every((x) => x.status === 'duplicate') ? 'Reentrega descartada (idempotência) ✔' : 'Nenhum webhook para reenviar'); }) }, '⟳ Reenviar último webhook (teste de duplicidade)'),
  );
}

async function act(fn) {
  if (!sim?.app) return;
  try {
    await fn();
  } catch (e) {
    toast(e.message, 'error');
  }
}

function bubble(b, isLast) {
  const clickable = isLast && b.from !== 'user';
  const optBtn = (o) => h('button', { class: 'opt', disabled: !clickable, onclick: () => act(() => sim.clickOption(o)) }, o.label);
  return h('div', { class: `bubble from-${b.from}` },
    b.from === 'agent' && h('div', { class: 'who' }, '👤 Atendente'),
    b.note && h('div', { class: 'who' }, b.note),
    b.template && h('div', { class: 'tpl' }, h('b', {}, '📄 Modelo aprovado: '), `${b.template.name} (${b.template.language})`, b.template.params?.length ? h('div', { class: 'muted' }, 'parâmetros: ' + b.template.params.join(', ')) : null),
    b.media && h('div', { class: 'media' }, `📎 ${b.media.kind}: `, h('a', { href: b.media.url, target: '_blank', rel: 'noopener' }, b.media.url), b.media.caption ? h('div', {}, b.media.caption) : null),
    b.text && h('div', { class: 'txt' }, b.text),
    b.buttons && h('div', { class: 'opts buttons' }, b.buttons.map(optBtn)),
    b.list && h('details', { class: 'wa-list', open: clickable }, h('summary', {}, '☰ ' + b.list.button), h('div', { class: 'opts list' }, b.list.rows.map(optBtn))),
    b.quick && h('div', { class: 'opts quick' }, b.quick.map(optBtn)),
    b.inline && h('div', { class: 'opts inline' }, b.inline.map(optBtn)),
  );
}

function phone() {
  const ch = cfg.channel;
  const tenant = state.tenants[cfg.tenantId];
  if (sim?.error) {
    return h('section', { class: 'panel phone-wrap' }, h('div', { class: 'alert error' }, h('b', {}, 'Os fluxos têm erros e não podem rodar:'), h('pre', {}, sim.error), h('p', {}, 'Corrija na aba Fluxos.')));
  }
  const tl = sim?.timeline ?? [];
  const lastBot = tl.map((b, i) => (b.from === 'bot' || b.from === 'agent' ? i : -1)).filter((i) => i >= 0).pop();
  const log = h('div', { class: 'chat', 'aria-live': 'polite' },
    tl.length === 0 && h('div', { class: 'empty' }, ch === 'instagram' ? 'Envie uma mensagem ou use "Comentar no post".' : 'Envie "oi" para começar.'),
    tl.map((b, i) => (b.from === 'system' ? h('div', { class: 'sysline' }, b.text) : bubble(b, i === lastBot))),
  );
  queueMicrotask(() => (log.scrollTop = log.scrollHeight));
  let input;
  const now = sim?.now ? sim.now.toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo', weekday: 'short', day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' }) : '';
  return h('section', { class: `panel phone-wrap ch-${ch}` },
    h('div', { class: 'phone' },
      h('div', { class: 'phone-head' }, h('div', { class: 'avatar' }, (tenant?.name ?? '?')[0]), h('div', {}, h('b', {}, tenant?.name ?? cfg.tenantId), h('small', {}, `${CHANNELS[ch].label} · ${now}`))),
      log,
      h('form', { class: 'composer', onsubmit: (e) => { e.preventDefault(); const t = input.value.trim(); if (t) { input.value = ''; act(() => sim.sendText(t)); } } },
        input = h('input', { placeholder: 'Mensagem do cliente…', 'aria-label': 'Mensagem do cliente', autocomplete: 'off' }),
        h('button', { class: 'primary', type: 'submit' }, 'Enviar')),
    ),
  );
}

// ------------------------------------------------------------------------------------------

function httpEntry(e) {
  const arrow = e.dir === 'in' ? '⬇ recebido' : e.kind === 'integration' ? '⬆ integração' : '⬆ enviado';
  const status = e.status ? h('span', { class: `status s${String(e.status)[0]}` }, e.status) : null;
  return h('details', { class: `http ${e.dir} ${e.kind}` },
    h('summary', {}, h('span', { class: 'dir' }, arrow), h('code', {}, `${e.method} ${e.url}`), status, e.note && h('span', { class: 'muted' }, ' · ' + e.note)),
    e.headers && Object.keys(e.headers).length ? h('pre', { class: 'hdr' }, Object.entries(e.headers).map(([k, v]) => `${k}: ${v}`).join('\n')) : null,
    h('pre', {}, json(e.body)),
  );
}

function inspector() {
  const tabs = [['estado', 'Estado'], ['integracao', 'Integração'], ['motor', 'Motor'], ['atendente', 'Atendente'], ['metricas', 'Métricas']];
  const body = h('div', { class: 'insp-body' });
  if (sim?.app) {
    if (inspectorTab === 'estado') {
      const s = sim.session;
      const c = sim.contact;
      const flow = s ? state.flows[s.flowId] : null;
      body.append(
        s ? h('div', { class: 'kv' },
          h('div', {}, h('span', {}, 'Fluxo'), h('b', {}, `${s.flowId}@${s.flowVersion}`)),
          h('div', {}, h('span', {}, 'Nó atual'), h('b', {}, s.currentNodeId)),
          h('div', {}, h('span', {}, 'Status'), h('b', { class: `st-${s.status}` }, s.status)),
          h('div', {}, h('span', {}, 'Pilha'), h('b', {}, s.callStack.map((f) => f.flowId).join(' › ') || '—')),
          h('div', {}, h('span', {}, 'Etiquetas'), h('b', {}, c?.tags?.join(', ') || '—')),
        ) : h('p', { class: 'muted' }, 'Sem sessão ainda.'),
        flow && s.status !== 'ended' && h('div', { class: 'mini-graph' }, renderGraph(flow, { active: s.currentNodeId })),
        s && h('details', { open: true }, h('summary', {}, 'Variáveis'), h('pre', {}, json({ contact: c?.fields, session: s.vars.session, flow: s.vars.flow }))),
      );
    } else if (inspectorTab === 'integracao') {
      const list = [...sim.http].reverse();
      body.append(
        h('p', { class: 'muted' }, 'Tráfego real que o framework geraria: webhooks no formato oficial do provedor e chamadas às APIs (tokens mascarados).'),
        list.length ? list.map(httpEntry) : h('p', { class: 'muted' }, 'Nada ainda.'),
      );
    } else if (inspectorTab === 'motor') {
      body.append([...sim.logs].reverse().map((l) => h('div', { class: `log lv-${l.level}` }, h('code', {}, l.level), h('b', {}, l.msg), h('span', { class: 'muted' }, ' ' + JSON.stringify(l.data)))));
    } else if (inspectorTab === 'atendente') {
      const tickets = sim.tickets();
      if (!tickets.length) body.append(h('p', { class: 'muted' }, 'Nenhum transbordo. Digite "atendente" na conversa (em horário comercial) para abrir um ticket.'));
      for (const t of tickets.reverse()) {
        let reply;
        body.append(h('div', { class: `ticket ${t.status}` },
          h('div', { class: 'row' }, h('b', {}, `Fila: ${t.queue}`), h('span', { class: `badge ${t.status}` }, t.status)),
          h('pre', {}, json(t.context)),
          h('div', { class: 'transcript' }, t.transcript.map((e) => h('div', { class: `tr-${e.from}` }, h('small', {}, e.from), ' ', e.text))),
          t.status !== 'closed' && h('form', { class: 'row', onsubmit: (e) => { e.preventDefault(); const v = reply.value.trim(); if (v) act(() => sim.agent('reply', t.id, v)); } },
            reply = h('input', { placeholder: 'Resposta do atendente…', 'aria-label': 'Resposta do atendente' }),
            h('button', { type: 'submit', class: 'primary' }, 'Responder')),
          t.status !== 'closed' && h('div', { class: 'row' },
            t.status === 'waiting' && h('button', { onclick: () => act(() => sim.agent('accept', t.id)) }, 'Assumir'),
            h('button', { onclick: () => act(() => sim.agent('close', t.id)) }, 'Encerrar e devolver ao bot')),
        ));
      }
    } else {
      const m = sim.app.metrics.snapshot();
      body.append(
        h('table', { class: 'metrics' }, h('tbody', {}, Object.entries(m.counters).sort().map(([k, v]) => h('tr', {}, h('td', {}, k), h('td', {}, v))))),
        h('table', { class: 'metrics' }, h('tbody', {}, Object.entries(m.timings).map(([k, v]) => h('tr', {}, h('td', {}, k), h('td', {}, `p50 ${v.p50.toFixed(1)} ms · p95 ${v.p95.toFixed(1)} ms · n=${v.count}`))))),
        h('p', { class: 'muted' }, `Dead letters: ${sim.app.storage.deadLetters().length}`),
      );
    }
  }
  return h('section', { class: 'panel inspector' },
    h('div', { class: 'tabs small', role: 'tablist' }, tabs.map(([id, l]) =>
      h('button', { role: 'tab', 'aria-selected': inspectorTab === id, class: inspectorTab === id ? 'on' : '', onclick: () => { inspectorTab = id; persist(); render(); } },
        l, id === 'atendente' && sim?.tickets?.().some((t) => t.status !== 'closed') ? h('span', { class: 'dot' }) : null))),
    body,
  );
}

let pending = false;
export function render() {
  if (!root || pending) return;
  pending = true;
  requestAnimationFrame(() => {
    pending = false;
    // Preserva foco/rolagem do painel de inspeção ao re-renderizar.
    const active = document.activeElement;
    const typing = active && root.contains(active) && active.tagName === 'INPUT' && active.closest('.inspector') ? { value: active.value } : null;
    const wasComposer = !!active?.closest?.('.composer') || active === document.body;
    const scroll = root.querySelector('.insp-body')?.scrollTop ?? 0;
    const openDetails = [...root.querySelectorAll('.inspector details[open] > summary')].map((s) => s.textContent);
    clear(root, h('div', { class: 'sim-grid' }, controls(), phone(), inspector()));
    const ib = root.querySelector('.insp-body');
    for (const s of root.querySelectorAll('.inspector details > summary')) if (openDetails.includes(s.textContent)) s.parentElement.open = true;
    if (ib) ib.scrollTop = scroll;
    if (typing) {
      const i = root.querySelector('.inspector input');
      if (i) { i.value = typing.value; i.focus(); }
    } else if (wasComposer) root.querySelector('.composer input')?.focus({ preventScroll: true });
  });
}
