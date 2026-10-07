// Aba "Fluxos": visualização em grafo + edição dos nós com validação ao vivo.
import { validateFlow } from './lib/core/validator.js';
import { state } from './state.js';
import { renderGraph } from './graph.js';
import { h, clear, json, toast, NODE_META, download } from './ui.js';
import data from './data.js';

let root;
let flowId = null;
let nodeId = null;

const TEMPLATES = {
  message: () => ({ type: 'message', text: 'Nova mensagem', next: '' }),
  input: () => ({ type: 'input', prompt: 'Qual é o seu …?', saveTo: 'session.resposta', maxAttempts: 3, next: '' }),
  router: () => ({ type: 'router', prompt: 'Escolha uma opção:', display: 'buttons', options: [{ id: 'op1', label: 'Opção 1', next: '' }] }),
  condition: () => ({ type: 'condition', branches: [{ when: { var: 'system.inBusinessHours', op: 'eq', value: true }, next: '' }], default: '' }),
  randomizer: () => ({ type: 'randomizer', variants: [{ id: 'a', weight: 50, next: '' }, { id: 'b', weight: 50, next: '' }] }),
  set: () => ({ type: 'set', addTags: ['nova_etiqueta'], next: '' }),
  integration: () => ({ type: 'integration', request: { method: 'POST', url: '{{secrets.leads_webhook_url}}', body: { nome: '{{contact.full_name}}' } }, timeoutMs: 5000, retry: { max: 2, backoffMs: 500 }, next: '', onError: '' }),
  wait: () => ({ type: 'wait', seconds: 600, next: '' }),
  handoff: () => ({ type: 'handoff', queue: 'geral', message: 'Vou te transferir para nossa equipe.' }),
  subflow: () => ({ type: 'subflow', flowId: 'agendamento', next: '' }),
  end: () => ({ type: 'end', message: 'Obrigado pelo contato!' }),
};

const FIELDS = {
  message: [['text', 'Texto', 'textarea'], ['next', 'Próximo', 'node'], ['media', 'Mídia {kind,url,caption}', 'json?'], ['template', 'Modelo WhatsApp {name,language,components}', 'json?']],
  input: [['prompt', 'Pergunta', 'textarea'], ['saveTo', 'Salvar resposta em', 'text'], ['validator', 'Validação', 'validator'], ['errorMessage', 'Mensagem se inválido', 'textarea'], ['maxAttempts', 'Tentativas', 'number'], ['next', 'Próximo', 'node'], ['onInvalid', 'Se esgotar tentativas', 'node?'], ['timeoutSec', 'Timeout (segundos)', 'number'], ['onTimeout', 'Se timeout', 'node?']],
  router: [['prompt', 'Pergunta', 'textarea'], ['options', 'Opções', 'options'], ['display', 'Exibição', 'select:buttons,list,text'], ['silent', 'Silencioso (após modelo com botões)', 'bool'], ['saveTo', 'Salvar escolha em', 'text'], ['noMatchMessage', 'Mensagem se não entender', 'text'], ['maxAttempts', 'Tentativas', 'number'], ['onExhausted', 'Se esgotar tentativas', 'node?'], ['timeoutSec', 'Timeout (segundos)', 'number'], ['onTimeout', 'Se timeout', 'node?']],
  condition: [['branches', 'Regras [{when:{var,op,value}, next}]', 'json'], ['default', 'Senão', 'node']],
  randomizer: [['variants', 'Variantes', 'variants']],
  set: [['assign', 'Atribuir variáveis {caminho: valor}', 'json?'], ['addTags', 'Adicionar etiquetas', 'tags'], ['removeTags', 'Remover etiquetas', 'tags'], ['next', 'Próximo', 'node']],
  integration: [['request', 'Requisição {method,url,headers,body}', 'json'], ['saveTo', 'Salvar resposta em', 'text'], ['timeoutMs', 'Timeout (ms)', 'number'], ['retry', 'Retry {max,backoffMs}', 'json?'], ['next', 'Se sucesso', 'node'], ['onError', 'Se erro', 'node']],
  wait: [['seconds', 'Segundos', 'number'], ['next', 'Próximo', 'node']],
  handoff: [['queue', 'Fila', 'text'], ['message', 'Mensagem ao transferir', 'textarea'], ['contextVars', 'Contexto para o atendente', 'tags'], ['slaSec', 'SLA para assumir (segundos)', 'number'], ['onSlaTimeout', 'Se ninguém assumir', 'node?'], ['next', 'Após o atendente encerrar', 'node?']],
  subflow: [['flowId', 'Subfluxo', 'flow'], ['next', 'Ao retornar', 'node']],
  end: [['message', 'Mensagem final', 'textarea']],
};

const flow = () => state.flows[flowId];

function commit(msg) {
  state.save();
  render();
  if (msg) toast(msg);
}

function validation(f) {
  return validateFlow(f, (id) => !!state.flows[id]);
}

function errorsByNode(res) {
  const m = {};
  for (const e of res.errors) {
    const r = /nó "([^"]+)"/.exec(e);
    if (r) m[r[1]] = true;
  }
  return m;
}

function nodeSelect(value, onchange, optional) {
  const ids = Object.keys(flow().nodes);
  return h('select', { onchange: (e) => onchange(e.target.value) },
    h('option', { value: '', selected: !value }, optional ? '— nenhum —' : '— escolha —'),
    ids.map((id) => h('option', { value: id, selected: id === value }, id)));
}

function setField(node, key, value) {
  if (value === '' || value === undefined || (Array.isArray(value) && !value.length)) delete node[key];
  else node[key] = value;
}

function fieldInput(node, [key, label, kind]) {
  const val = node[key];
  const upd = (v) => { setField(node, key, v); commit(); };
  let input;
  if (kind === 'textarea') input = h('textarea', { rows: 3, onchange: (e) => upd(e.target.value) }, val ?? '');
  else if (kind === 'text') input = h('input', { value: val ?? '', onchange: (e) => upd(e.target.value) });
  else if (kind === 'number') input = h('input', { type: 'number', value: val ?? '', onchange: (e) => upd(e.target.value === '' ? undefined : Number(e.target.value)) });
  else if (kind === 'bool') input = h('input', { type: 'checkbox', checked: !!val, onchange: (e) => upd(e.target.checked || undefined) });
  else if (kind.startsWith('node')) input = nodeSelect(val, upd, kind.endsWith('?'));
  else if (kind === 'flow') input = h('select', { onchange: (e) => upd(e.target.value) }, state.flowList.filter((f) => f.id !== flowId).map((f) => h('option', { value: f.id, selected: f.id === val }, f.id)));
  else if (kind.startsWith('select:')) input = h('select', { onchange: (e) => upd(e.target.value) }, kind.slice(7).split(',').map((o) => h('option', { value: o, selected: (val ?? 'buttons') === o }, o)));
  else if (kind === 'tags') input = h('input', { value: (val ?? []).join(', '), placeholder: 'separe por vírgula', onchange: (e) => upd(e.target.value.split(',').map((t) => t.trim()).filter(Boolean)) });
  else if (kind === 'validator') {
    const v = val ?? { kind: 'any' };
    const param = v.kind === 'minLength' ? ['value', 'mín. caracteres'] : v.kind === 'regex' ? ['pattern', 'expressão regular'] : null;
    input = h('div', { class: 'row' },
      h('select', { onchange: (e) => upd(e.target.value === 'any' ? undefined : { kind: e.target.value, ...(e.target.value === 'minLength' ? { value: 3 } : e.target.value === 'regex' ? { pattern: '.+' } : {}) }) },
        ['any', 'minLength', 'email', 'phone', 'number', 'date', 'cpf', 'regex'].map((k) => h('option', { value: k, selected: v.kind === k }, k))),
      param && h('input', { value: v[param[0]] ?? '', placeholder: param[1], onchange: (e) => upd({ ...v, [param[0]]: param[0] === 'value' ? Number(e.target.value) : e.target.value }) }));
  } else if (kind === 'options' || kind === 'variants') {
    const rows = val ?? [];
    const isOpt = kind === 'options';
    const change = (i, k, v) => { rows[i] = { ...rows[i], [k]: v }; upd([...rows]); };
    input = h('div', { class: 'rows' },
      rows.map((o, i) => h('div', { class: `optrow ${isOpt ? 'is-opt' : 'is-var'}` },
        h('input', { value: o.id ?? '', placeholder: 'id', 'aria-label': 'id', class: 'w-id', onchange: (e) => change(i, 'id', e.target.value) }),
        isOpt
          ? h('input', { value: o.label ?? '', placeholder: 'rótulo', 'aria-label': 'rótulo', class: 'w-label', onchange: (e) => change(i, 'label', e.target.value) })
          : h('input', { type: 'number', value: o.weight ?? 0, 'aria-label': 'peso', class: 'w-num', onchange: (e) => change(i, 'weight', Number(e.target.value)) }),
        isOpt && h('input', { value: (o.match ?? []).join(', '), placeholder: 'sinônimos (vírgula)', 'aria-label': 'sinônimos', class: 'w-match', onchange: (e) => change(i, 'match', e.target.value.split(',').map((t) => t.trim()).filter(Boolean)) }),
        h('div', { class: 'w-next' }, nodeSelect(o.next, (v) => change(i, 'next', v))),
        h('button', { class: 'icon w-del', title: 'Remover', 'aria-label': 'Remover', onclick: () => { rows.splice(i, 1); upd([...rows]); } }, '✕'))),
      h('button', { class: 'chip', onclick: () => upd([...rows, isOpt ? { id: `op${rows.length + 1}`, label: `Opção ${rows.length + 1}`, next: '' } : { id: String.fromCharCode(97 + rows.length), weight: 50, next: '' }]) }, '+ adicionar'));
  } else if (kind.startsWith('json')) {
    input = h('textarea', { rows: 4, class: 'code', onchange: (e) => {
      const t = e.target.value.trim();
      if (!t && kind.endsWith('?')) return upd(undefined);
      try { upd(JSON.parse(t)); } catch { e.target.classList.add('invalid'); toast('JSON inválido', 'error'); }
    } }, val === undefined ? '' : json(val));
  }
  return h('label', { class: kind === 'bool' ? 'check' : '' }, h('span', { class: 'lbl' }, label), input);
}

function renameNode(oldId, newId) {
  const f = flow();
  if (!/^[\w-]+$/.test(newId) || f.nodes[newId]) return toast('Id inválido ou já existe', 'error');
  const nodes = {};
  for (const [id, n] of Object.entries(f.nodes)) nodes[id === oldId ? newId : id] = n;
  const fix = (v) => (v === oldId ? newId : v);
  for (const n of Object.values(nodes)) {
    for (const k of ['next', 'onError', 'onInvalid', 'onTimeout', 'onExhausted', 'onSlaTimeout', 'default']) if (k in n) n[k] = fix(n[k]);
    n.options?.forEach((o) => (o.next = fix(o.next)));
    n.variants?.forEach((o) => (o.next = fix(o.next)));
    n.branches?.forEach((o) => (o.next = fix(o.next)));
  }
  for (const i of Object.values(f.globals?.intents ?? {})) i.goto = fix(i.goto);
  f.start = fix(f.start);
  f.nodes = nodes;
  nodeId = newId;
  commit('Nó renomeado e referências atualizadas');
}

function addNode(type) {
  const f = flow();
  let i = 1;
  while (f.nodes[`${type}_${i}`]) i++;
  const id = `${type}_${i}`;
  const node = TEMPLATES[type]();
  const sel = nodeId && f.nodes[nodeId];
  if (sel && 'next' in sel && type !== 'end' && 'next' in node) {
    node.next = sel.next; // insere depois do nó selecionado
    sel.next = id;
  } else if (sel && 'next' in sel && !sel.next) sel.next = id;
  f.nodes[id] = node;
  nodeId = id;
  commit(`Nó "${id}" criado`);
}

function deleteNode() {
  const f = flow();
  if (nodeId === f.start) return toast('Não é possível excluir o nó inicial', 'error');
  if (!confirm(`Excluir o nó "${nodeId}"? As ligações para ele ficarão vazias (a validação vai apontar).`)) return;
  delete f.nodes[nodeId];
  nodeId = null;
  commit('Nó excluído');
}

function nodePanel() {
  const f = flow();
  const node = f.nodes[nodeId];
  const meta = NODE_META[node.type];
  let adv;
  return h('div', { class: 'node-form' },
    h('div', { class: 'row between' }, h('h3', {}, `${meta?.label ?? node.type}`), h('button', { class: 'chip', onclick: () => { nodeId = null; render(); } }, '← fluxo')),
    h('label', {}, h('span', { class: 'lbl' }, 'Id do nó'), h('input', { value: nodeId, onchange: (e) => renameNode(nodeId, e.target.value.trim()) })),
    (FIELDS[node.type] ?? []).map((fd) => fieldInput(node, fd)),
    h('details', {}, h('summary', {}, 'Avançado'),
      fieldInput(node, ['onError', 'Se o nó falhar (onError)', 'node?']),
      h('label', {}, h('span', { class: 'lbl' }, 'JSON do nó'),
        adv = h('textarea', { rows: 10, class: 'code' }, json(node))),
      h('button', { onclick: () => { try { f.nodes[nodeId] = JSON.parse(adv.value); commit('JSON aplicado'); } catch { toast('JSON inválido', 'error'); } } }, 'Aplicar JSON')),
    h('div', { class: 'row' },
      f.start !== nodeId && h('button', { onclick: () => { f.start = nodeId; commit('Nó definido como início'); } }, 'Definir como início'),
      h('button', { class: 'danger', onclick: deleteNode }, 'Excluir nó')),
  );
}

function flowPanel() {
  const f = flow();
  const jsonField = (key, label, fallback) => h('label', {}, h('span', { class: 'lbl' }, label),
    h('textarea', { rows: 5, class: 'code', onchange: (e) => { try { const v = e.target.value.trim() ? JSON.parse(e.target.value) : undefined; setField(f, key, v); commit(); } catch { toast('JSON inválido', 'error'); } } }, f[key] ? json(f[key]) : fallback));
  return h('div', { class: 'node-form' },
    h('h3', {}, 'Configurações do fluxo'),
    h('label', {}, h('span', { class: 'lbl' }, 'Nome'), h('input', { value: f.name ?? '', onchange: (e) => { f.name = e.target.value; commit(); } })),
    h('label', {}, h('span', { class: 'lbl' }, 'Descrição'), h('textarea', { rows: 3, onchange: (e) => { f.description = e.target.value; commit(); } }, f.description ?? '')),
    h('div', { class: 'row' },
      h('label', {}, h('span', { class: 'lbl' }, 'Versão'), h('input', { type: 'number', min: 1, value: f.version, class: 'w-num', onchange: (e) => { f.version = Number(e.target.value); commit(); } })),
      h('label', {}, h('span', { class: 'lbl' }, 'Nó inicial'), nodeSelect(f.start, (v) => { f.start = v; commit(); }))),
    jsonField('triggers', 'Gatilhos [{kind: keyword|regex|default|comment|ref, values, tags?}]', ''),
    jsonField('globals', 'Intents globais {intents:{nome:{match:[], goto}}}', ''),
    h('p', { class: 'muted' }, 'Dica: clique em um nó do grafo para editá-lo. Com um nó selecionado, "Adicionar" insere o novo nó logo depois dele.'),
  );
}

function sidebar() {
  return h('aside', { class: 'panel flow-list' },
    h('h3', {}, 'Fluxos'),
    state.flowList.map((f) => {
      const r = validation(f);
      return h('button', { class: `flow-item ${f.id === flowId ? 'on' : ''}`, onclick: () => { flowId = f.id; nodeId = null; render(); } },
        h('span', { class: `dot ${r.ok ? (r.warnings.length ? 'warn' : 'ok') : 'err'}`, title: r.ok ? 'válido' : 'com erros' }),
        h('b', {}, f.name ?? f.id), h('small', {}, `${f.id}@${f.version} · ${Object.keys(f.nodes).length} nós`));
    }),
    h('div', { class: 'stack' },
      h('button', { onclick: () => {
        const id = prompt('Id do novo fluxo (letras, números, - e _):', 'novo-fluxo');
        if (!id) return;
        if (!/^[\w-]+$/.test(id) || state.flows[id]) return toast('Id inválido ou já existe', 'error');
        state.flows[id] = { id, version: 1, name: id, start: 'inicio', triggers: [{ kind: 'keyword', values: [id] }], nodes: { inicio: { type: 'message', text: '{{system.greeting}}!', next: 'fim' }, fim: { type: 'end', message: 'Até logo!' } } };
        flowId = id; nodeId = null; commit('Fluxo criado');
      } }, '+ Novo fluxo'),
      flowId && h('button', { onclick: () => {
        const id = prompt('Id da cópia:', `${flowId}-copia`);
        if (!id || state.flows[id] || !/^[\w-]+$/.test(id)) return;
        state.flows[id] = { ...structuredClone(flow()), id, version: 1 };
        flowId = id; nodeId = null; commit('Fluxo duplicado');
      } }, 'Duplicar'),
      flowId && data.flows.some((f) => f.id === flowId) && h('button', { onclick: () => {
        if (!confirm('Descartar suas alterações neste fluxo?')) return;
        state.flows[flowId] = structuredClone(data.flows.find((f) => f.id === flowId)); nodeId = null; commit('Fluxo restaurado');
      } }, 'Restaurar original'),
      flowId && h('button', { class: 'danger', onclick: () => {
        if (!confirm(`Excluir o fluxo "${flowId}"?`)) return;
        delete state.flows[flowId]; flowId = state.flowList[0]?.id ?? null; nodeId = null; commit('Fluxo excluído');
      } }, 'Excluir fluxo'),
      flowId && h('button', { onclick: () => download(`${flowId}.json`, json(flow()) + '\n') }, 'Baixar JSON'),
    ),
  );
}

export function render() {
  if (!root) return;
  if (!flowId || !state.flows[flowId]) flowId = state.flows['pre-atendimento'] ? 'pre-atendimento' : state.flowList[0]?.id ?? null;
  if (!flowId) return clear(root, h('p', {}, 'Nenhum fluxo.'), sidebar());
  const f = flow();
  if (nodeId && !f.nodes[nodeId]) nodeId = null;
  const res = validation(f);
  const graphBox = h('div', { class: 'graph-box' }, renderGraph(f, { selected: nodeId, errorsByNode: errorsByNode(res), onSelect: (id) => { nodeId = id; render(); } }));
  const scroll = root.querySelector('.graph-box');
  const pos = scroll ? [scroll.scrollLeft, scroll.scrollTop] : null;
  let typeSel;
  clear(root, h('div', { class: 'editor-grid' },
    sidebar(),
    h('section', { class: 'panel graph-panel' },
      h('div', { class: 'row between toolbar' },
        h('div', {}, h('b', {}, f.name ?? f.id), h('span', { class: 'muted' }, ` · ${f.id}@${f.version}`)),
        h('div', { class: 'row' },
          typeSel = h('select', { 'aria-label': 'Tipo do novo nó' }, Object.entries(NODE_META).map(([t, m]) => h('option', { value: t }, m.label))),
          h('button', { class: 'primary', onclick: () => addNode(typeSel.value) }, nodeId ? '+ Adicionar após o nó' : '+ Adicionar nó'),
          h('button', { onclick: () => document.dispatchEvent(new CustomEvent('studio:test-flow', { detail: flowId })) }, '▶ Testar'))),
      graphBox,
      h('div', { class: `validation ${res.ok ? 'ok' : 'err'}` },
        h('b', {}, res.ok ? `✔ Fluxo válido${res.warnings.length ? ` (${res.warnings.length} aviso(s))` : ''}` : `✖ ${res.errors.length} erro(s) — o fluxo não pode ser publicado`),
        h('ul', {}, res.errors.map((e) => h('li', { class: 'err' }, e)), res.warnings.map((w) => h('li', { class: 'warn' }, w)))),
    ),
    h('aside', { class: 'panel inspector-edit' }, nodeId ? nodePanel() : flowPanel()),
  ));
  if (pos) {
    const b = root.querySelector('.graph-box');
    b.scrollLeft = pos[0];
    b.scrollTop = pos[1];
  }
}

export function mountEditor(el) {
  root = el;
  render();
}
