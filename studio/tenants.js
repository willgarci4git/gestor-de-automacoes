// Aba "Clientes": parâmetros de cada cliente, horário comercial, feriados e fluxos permitidos.
import { isBusinessHours, TenantRegistry } from './lib/core/tenants.js';
import { state } from './state.js';
import { h, clear, toast } from './ui.js';

let root;
let tenantId = null;
const DAYS = ['Domingo', 'Segunda', 'Terça', 'Quarta', 'Quinta', 'Sexta', 'Sábado'];

function commit(msg) {
  const t = state.tenants[tenantId];
  try {
    new TenantRegistry().set(t); // mesma validação usada pelo servidor
  } catch (e) {
    toast(e.message, 'error');
  }
  state.save();
  render();
  if (msg) toast(msg);
}

function params(t) {
  const entries = Object.entries(t.params ?? {});
  return h('section', { class: 'card' },
    h('h3', {}, 'Parâmetros ', h('small', { class: 'muted' }, 'usados nos fluxos como {{tenant.chave}}')),
    h('table', { class: 'kvtable' }, h('tbody', {},
      entries.map(([k, v]) => h('tr', {},
        h('td', {}, h('code', {}, `tenant.${k}`)),
        h('td', {}, h('textarea', { rows: String(v).length > 60 ? 3 : 1, 'aria-label': k, onchange: (e) => { t.params[k] = e.target.value; commit(); } }, String(v))),
        h('td', {}, h('button', { class: 'icon', 'aria-label': `Remover ${k}`, onclick: () => { delete t.params[k]; commit(); } }, '✕')))))),
    h('button', { class: 'chip', onclick: () => {
      const k = prompt('Nome do parâmetro (ex.: telefone, linkAgenda):');
      if (!k) return;
      if (!/^\w+$/.test(k)) return toast('Use apenas letras, números e _', 'error');
      t.params = { ...t.params, [k]: '' };
      commit();
    } }, '+ parâmetro'),
  );
}

function hours(t) {
  const bh = t.businessHours ?? { days: {} };
  const setRanges = (d, ranges) => {
    t.businessHours = { ...bh, days: { ...bh.days } };
    if (ranges.length) t.businessHours.days[d] = ranges;
    else delete t.businessHours.days[d];
    commit();
  };
  let probe;
  const probeOut = h('b', {});
  const test = () => {
    const d = new Date(probe.value + ':00-03:00');
    const r = isBusinessHours(t, d, 'America/Sao_Paulo');
    probeOut.textContent = r === null ? 'sem horário configurado' : r ? '✔ dentro do horário' : '✖ fora do horário';
  };
  return h('section', { class: 'card' },
    h('h3', {}, 'Horário comercial ', h('small', { class: 'muted' }, 'define system.inBusinessHours (transbordo x recado)')),
    h('label', {}, h('span', { class: 'lbl' }, 'Fuso horário'), h('input', { value: t.timezone ?? 'America/Sao_Paulo', onchange: (e) => { t.timezone = e.target.value; commit(); } })),
    h('table', { class: 'hours' }, h('tbody', {}, DAYS.map((name, d) => {
      const ranges = bh.days[String(d)] ?? [];
      return h('tr', {},
        h('td', {}, name),
        h('td', {}, ranges.length === 0 ? h('span', { class: 'muted' }, 'fechado') : null,
          ranges.map(([a, b], i) => h('span', { class: 'range' },
            h('input', { type: 'time', value: a, 'aria-label': `${name} início`, onchange: (e) => { ranges[i] = [e.target.value, b]; setRanges(String(d), ranges); } }),
            '–',
            h('input', { type: 'time', value: b, 'aria-label': `${name} fim`, onchange: (e) => { ranges[i] = [a, e.target.value]; setRanges(String(d), ranges); } }),
            h('button', { class: 'icon', 'aria-label': 'Remover faixa', onclick: () => { ranges.splice(i, 1); setRanges(String(d), ranges); } }, '✕')))),
        h('td', {}, h('button', { class: 'chip', onclick: () => setRanges(String(d), [...ranges, ranges.length ? ['13:00', '18:00'] : ['08:00', '12:00']]) }, '+ faixa')));
    }))),
    h('label', {}, h('span', { class: 'lbl' }, 'Feriados (AAAA-MM-DD, um por linha)'),
      h('textarea', { rows: 3, onchange: (e) => { t.businessHours = { ...bh, holidays: e.target.value.split(/\s+/).filter(Boolean) }; commit(); } }, (bh.holidays ?? []).join('\n'))),
    h('div', { class: 'row' }, h('span', { class: 'lbl' }, 'Testar em:'),
      probe = h('input', { type: 'datetime-local', value: new Date(Date.now() - 3 * 3600_000).toISOString().slice(0, 16), onchange: test }),
      probeOut),
  );
}

function flowsAllowed(t) {
  const all = !t.flows;
  return h('section', { class: 'card' },
    h('h3', {}, 'Fluxos permitidos'),
    h('label', { class: 'check' }, h('input', { type: 'checkbox', checked: all, onchange: (e) => { if (e.target.checked) delete t.flows; else t.flows = state.flowList.map((f) => f.id); commit(); } }), 'Todos os fluxos'),
    !all && h('div', { class: 'checks' }, state.flowList.map((f) => h('label', { class: 'check' },
      h('input', { type: 'checkbox', checked: t.flows.includes(f.id), onchange: (e) => { t.flows = e.target.checked ? [...t.flows, f.id] : t.flows.filter((x) => x !== f.id); commit(); } }),
      f.name ?? f.id))),
  );
}

export function render() {
  if (!root) return;
  if (!tenantId || !state.tenants[tenantId]) tenantId = state.tenantList[0]?.id ?? null;
  const t = state.tenants[tenantId];
  clear(root, h('div', { class: 'tenant-grid' },
    h('aside', { class: 'panel flow-list' },
      h('h3', {}, 'Clientes'),
      state.tenantList.map((x) => h('button', { class: `flow-item plain ${x.id === tenantId ? 'on' : ''}`, onclick: () => { tenantId = x.id; render(); } }, h('b', {}, x.name ?? x.id), h('small', {}, x.id))),
      h('div', { class: 'stack' },
        h('button', { onclick: () => {
          const id = prompt('Id do novo cliente (usado na URL e no TENANT_ID):', 'novo-cliente');
          if (!id) return;
          if (!/^[\w-]{1,64}$/.test(id) || state.tenants[id]) return toast('Id inválido ou já existe', 'error');
          const base = structuredClone(state.tenants.default ?? { params: {} });
          state.tenants[id] = { ...base, id, name: id };
          tenantId = id;
          commit('Cliente criado a partir do "default"');
        } }, '+ Novo cliente'),
        t && t.id !== 'default' && h('button', { class: 'danger', onclick: () => { if (confirm(`Excluir o cliente "${t.id}"?`)) { delete state.tenants[t.id]; tenantId = null; commit('Cliente excluído'); } } }, 'Excluir cliente'))),
    t ? h('div', { class: 'tenant-main' },
      h('section', { class: 'card' },
        h('div', { class: 'row' },
          h('label', {}, h('span', { class: 'lbl' }, 'Nome'), h('input', { value: t.name ?? '', onchange: (e) => { t.name = e.target.value; commit(); } })),
          h('label', {}, h('span', { class: 'lbl' }, 'Id'), h('input', { value: t.id, disabled: true })))),
      params(t), hours(t), flowsAllowed(t)) : h('p', {}, 'Nenhum cliente.'),
  ));
}

export function mountTenants(el) {
  root = el;
  render();
}
