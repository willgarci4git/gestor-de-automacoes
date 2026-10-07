// Utilitários de DOM sem framework (o Studio é estático e sem dependências).

/** h('div', {class:'x', onclick}, 'texto', filho) */
export function h(tag, attrs = {}, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs ?? {})) {
    if (v == null || v === false) continue;
    if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2), v);
    else if (k === 'class') el.className = v;
    else if (k === 'style' && typeof v === 'object') Object.assign(el.style, v);
    else if (k === 'value') el.value = v;
    else if (k === 'checked') el.checked = !!v;
    else el.setAttribute(k, v === true ? '' : String(v));
  }
  for (const c of children.flat(Infinity)) {
    if (c == null || c === false) continue;
    el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  return el;
}

export const svgNS = 'http://www.w3.org/2000/svg';
export function s(tag, attrs = {}, ...children) {
  const el = document.createElementNS(svgNS, tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v == null) continue;
    if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2), v);
    else el.setAttribute(k, String(v));
  }
  for (const c of children.flat()) if (c != null) el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  return el;
}

export function clear(el, ...children) {
  el.replaceChildren(...children.flat().filter((c) => c != null));
  return el;
}

export const store = {
  get(k, fallback) {
    try {
      const v = localStorage.getItem(k);
      return v ? JSON.parse(v) : fallback;
    } catch {
      return fallback;
    }
  },
  set(k, v) {
    try {
      localStorage.setItem(k, JSON.stringify(v));
    } catch {
      /* armazenamento indisponível: segue em memória */
    }
  },
  del(k) {
    try {
      localStorage.removeItem(k);
    } catch {}
  },
};

export function download(filename, text) {
  const a = h('a', { href: URL.createObjectURL(new Blob([text], { type: 'application/json' })), download: filename });
  document.body.append(a);
  a.click();
  setTimeout(() => {
    URL.revokeObjectURL(a.href);
    a.remove();
  }, 1000);
}

export function toast(msg, kind = 'info') {
  const el = h('div', { class: `toast ${kind}`, role: 'status' }, msg);
  document.body.append(el);
  setTimeout(() => el.classList.add('show'), 10);
  setTimeout(() => {
    el.classList.remove('show');
    setTimeout(() => el.remove(), 300);
  }, 3200);
}

export const truncate = (t, n) => (t && t.length > n ? t.slice(0, n - 1) + '…' : t ?? '');

export function json(v) {
  return JSON.stringify(v, null, 2);
}

export const NODE_META = {
  message: { label: 'Mensagem', cat: 'say' },
  end: { label: 'Fim', cat: 'say' },
  input: { label: 'Pergunta', cat: 'ask' },
  router: { label: 'Menu', cat: 'ask' },
  condition: { label: 'Condição', cat: 'decide' },
  randomizer: { label: 'Teste A/B', cat: 'decide' },
  set: { label: 'Ação', cat: 'act' },
  integration: { label: 'Integração', cat: 'act' },
  wait: { label: 'Atraso', cat: 'time' },
  handoff: { label: 'Humano', cat: 'time' },
  subflow: { label: 'Subfluxo', cat: 'flow' },
};

export function nodeSummary(n) {
  switch (n.type) {
    case 'message': return n.template ? `modelo: ${n.template.name}` : n.text ?? n.media?.url ?? '';
    case 'input': return n.prompt;
    case 'router': return n.prompt;
    case 'end': return n.message ?? '(encerra)';
    case 'condition': return `${n.branches?.length ?? 0} regra(s)`;
    case 'randomizer': return (n.variants ?? []).map((v) => `${v.id}:${v.weight}`).join(' / ');
    case 'set': return [...Object.keys(n.assign ?? {}), ...(n.addTags ?? []).map((t) => '+' + t)].join(', ');
    case 'integration': return `${n.request?.method} ${n.request?.url}`;
    case 'wait': return `${n.seconds}s`;
    case 'handoff': return `fila ${n.queue}`;
    case 'subflow': return `→ ${n.flowId}`;
    default: return '';
  }
}
