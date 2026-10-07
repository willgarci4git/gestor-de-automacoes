// Visualização do grafo de um fluxo (SVG, layout em camadas por distância do início).
import { edgesOf } from './lib/core/validator.js';
import { s, NODE_META, truncate, nodeSummary } from './ui.js';

const W = 190;
const H = 58;
const GX = 36;
const GY = 64;

function edgeLabel(node, field) {
  const m = /^(options|variants|branches)\[(\d+)\]/.exec(field);
  if (m) {
    const i = Number(m[2]);
    if (m[1] === 'options') return node.options[i]?.label;
    if (m[1] === 'variants') return `${node.variants[i]?.id} (${node.variants[i]?.weight})`;
    return `regra ${i + 1}`;
  }
  return { next: '', default: 'senão', onError: 'erro', onInvalid: 'inválido', onTimeout: 'timeout', onExhausted: 'esgotou', onSlaTimeout: 'SLA' }[field] ?? field;
}

export function layout(flow) {
  const depth = new Map();
  const order = [];
  const roots = [flow.start, ...Object.values(flow.globals?.intents ?? {}).map((i) => i.goto)].filter((r) => flow.nodes[r]);
  const queue = roots.map((r) => [r, 0]);
  while (queue.length) {
    const [id, d] = queue.shift();
    if (depth.has(id) || !flow.nodes[id]) continue;
    depth.set(id, d);
    order.push(id);
    for (const e of edgesOf(flow.nodes[id])) if (!depth.has(e.target)) queue.push([e.target, d + 1]);
  }
  const maxD = Math.max(0, ...depth.values());
  for (const id of Object.keys(flow.nodes)) if (!depth.has(id)) { depth.set(id, maxD + 1); order.push(id); } // inalcançáveis por último
  const rows = new Map();
  for (const id of order) {
    const d = depth.get(id);
    rows.set(d, [...(rows.get(d) ?? []), id]);
  }
  const widest = Math.max(...[...rows.values()].map((r) => r.length));
  const totalW = widest * (W + GX);
  const pos = new Map();
  for (const [d, ids] of rows) {
    const rowW = ids.length * (W + GX) - GX;
    const x0 = (totalW - rowW) / 2;
    ids.forEach((id, i) => pos.set(id, { x: x0 + i * (W + GX), y: 20 + d * (H + GY), depth: d }));
  }
  return { pos, width: totalW + 170, height: 20 + (Math.max(...depth.values()) + 1) * (H + GY) }; // folga à direita p/ arestas de retorno
}

export function renderGraph(flow, { selected, active, onSelect, errorsByNode = {} } = {}) {
  const { pos, width, height } = layout(flow);
  const svg = s('svg', { viewBox: `-10 0 ${width + 20} ${height}`, width: width + 20, height, class: 'graph', role: 'img', 'aria-label': `Grafo do fluxo ${flow.id}` });
  svg.append(
    s('defs', {},
      s('marker', { id: 'arr', viewBox: '0 0 10 10', refX: 9, refY: 5, markerWidth: 7, markerHeight: 7, orient: 'auto-start-reverse' }, s('path', { d: 'M0,0 L10,5 L0,10 z', class: 'arrowhead' })),
    ),
  );
  const edgesG = s('g', { class: 'edges' });
  const nodesG = s('g', { class: 'nodes' });
  svg.append(edgesG, nodesG);

  for (const [id, node] of Object.entries(flow.nodes)) {
    const a = pos.get(id);
    // Agrupa arestas com o mesmo destino (ex.: 3 opções que levam ao mesmo nó) em uma só, com rótulo combinado.
    const grouped = new Map();
    for (const e of edgesOf(node)) {
      const g = grouped.get(e.target) ?? { target: e.target, field: e.field, labels: [] };
      const l = edgeLabel(node, e.field);
      if (l) g.labels.push(l);
      grouped.set(e.target, g);
    }
    const outs = [...grouped.values()];
    outs.forEach((e, i) => {
      const b = pos.get(e.target);
      if (!b) return;
      const sx = a.x + W / 2 + (i - (outs.length - 1) / 2) * Math.min(24, W / (outs.length + 1));
      const sy = a.y + H;
      let d;
      if (b.depth > a.depth) {
        const tx = b.x + W / 2;
        const ty = b.y;
        const my = (sy + ty) / 2;
        d = `M${sx},${sy} C${sx},${my} ${tx},${my} ${tx},${ty - 2}`;
      } else {
        // aresta de retorno: contorna pela lateral
        const tx = b.x + W;
        const ty = b.y + H / 2;
        const bulge = Math.max(a.x + W, b.x + W) + 40 + i * 8;
        d = `M${sx},${sy} C${sx},${sy + 40} ${bulge},${sy + 30} ${bulge},${(sy + ty) / 2} S${tx + 30},${ty} ${tx + 2},${ty}`;
      }
      const kind = ['onError', 'onInvalid', 'onExhausted', 'onTimeout', 'onSlaTimeout', 'default'].includes(e.field) ? 'alt' : 'main';
      edgesG.append(s('path', { d, class: `edge ${kind}`, 'marker-end': 'url(#arr)' }));
      const label = e.labels.length > 1 ? `${e.labels.length} opções` : e.labels[0];
      if (label) {
        const lx = b.depth > a.depth ? (sx + b.x + W / 2) / 2 : Math.max(a.x + W, b.x + W) + 44;
        const ly = b.depth > a.depth ? (sy + b.y) / 2 : (sy + b.y + H / 2) / 2;
        edgesG.append(s('text', { x: lx, y: ly, class: `edge-label ${kind}`, 'text-anchor': 'middle' }, truncate(label, 18)));
      }
    });
  }

  for (const [id, node] of Object.entries(flow.nodes)) {
    const p = pos.get(id);
    const meta = NODE_META[node.type] ?? { label: node.type, cat: 'say' };
    const cls = ['node', `cat-${meta.cat}`, id === selected && 'selected', id === active && 'active', errorsByNode[id] && 'has-error', id === flow.start && 'start'].filter(Boolean).join(' ');
    const g = s('g', { class: cls, transform: `translate(${p.x},${p.y})`, tabindex: 0, role: 'button', 'aria-label': `${meta.label} ${id}`,
      onclick: () => onSelect?.(id), onkeydown: (ev) => { if (ev.key === 'Enter' || ev.key === ' ') { ev.preventDefault(); onSelect?.(id); } } });
    g.append(
      s('rect', { width: W, height: H, rx: 10 }),
      s('rect', { width: 5, height: H - 16, x: 0, y: 8, rx: 2, class: 'stripe' }),
      s('text', { x: 14, y: 20, class: 'n-type' }, `${meta.label.toUpperCase()}${id === flow.start ? ' · INÍCIO' : ''}`),
      s('text', { x: 14, y: 36, class: 'n-id' }, truncate(id, 24)),
      s('text', { x: 14, y: 50, class: 'n-sum' }, truncate(String(nodeSummary(node) ?? '').replace(/\s+/g, ' '), 30)),
      s('title', {}, `${id}\n${nodeSummary(node)}`),
    );
    nodesG.append(g);
  }
  return svg;
}
