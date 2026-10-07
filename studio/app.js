// Ponto de entrada do Studio: abas, publicação/exportação e ligação entre as seções.
import { state } from './state.js';
import { mountSimulator, restart as restartSim, currentSim } from './simview.js';
import { mountEditor, render as renderEditor } from './editor.js';
import { mountTenants, render as renderTenants } from './tenants.js';
import { mountDiagnostics } from './diagnostics.js';
import { validateFlow } from './lib/core/validator.js';
import { h, clear, download, toast, json, store } from './ui.js';

const mounted = {};
const mounters = {
  simulador: mountSimulator,
  fluxos: mountEditor,
  clientes: mountTenants,
  diagnostico: mountDiagnostics,
  publicar: mountPublish,
};

function show(tab) {
  if (!mounters[tab]) tab = 'simulador';
  for (const b of document.querySelectorAll('.topbar .tabs button')) {
    const on = b.dataset.tab === tab;
    b.classList.toggle('on', on);
    b.setAttribute('aria-selected', on);
  }
  for (const p of document.querySelectorAll('.tabpane')) p.hidden = p.id !== `tab-${tab}`;
  const el = document.getElementById(`tab-${tab}`);
  if (!mounted[tab]) {
    mounters[tab](el);
    mounted[tab] = true;
  } else if (tab === 'simulador' && dirty) {
    restartSim();
  } else if (tab === 'publicar') mountPublish(el);
  if (tab === 'simulador') dirty = false;
  if (location.hash !== `#${tab}`) history.replaceState(null, '', `#${tab}`);
}

let dirty = false;
state.addEventListener('change', () => {
  dirty = true; // fluxos/clientes mudaram: a próxima visita ao simulador recria a conversa
  renderStatus();
});

function renderStatus() {
  const invalid = state.flowList.filter((f) => !validateFlow(f, (id) => !!state.flows[id]).ok).length;
  clear(document.getElementById('status'),
    invalid ? h('span', { class: 'pill err' }, `${invalid} fluxo(s) com erro`) : h('span', { class: 'pill ok' }, 'fluxos válidos'),
    state.isModified() ? h('span', { class: 'pill warn', title: 'Suas alterações estão salvas neste navegador. Exporte em "Publicar".' }, 'alterações locais') : null,
  );
}

// ------------------------------------------------------------------------------------------
// Aba Publicar: exportar/importar pacote, publicar em servidor e instruções do repositório
// ------------------------------------------------------------------------------------------
function mountPublish(el) {
  const srv = store.get('gestor-automacoes-studio.server', { url: '', token: '' });
  let url;
  let token;
  let fileIn;
  const publish = async () => {
    const base = url.value.trim().replace(/\/$/, '');
    store.set('gestor-automacoes-studio.server', { url: base, token: '' });
    try {
      const r = await fetch(`${base}/admin/flows`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-admin-token': token.value }, body: JSON.stringify(state.flowList) });
      const body = await r.text();
      if (r.ok) toast('Fluxos publicados no servidor ✔');
      else toast(`Servidor recusou (${r.status}): ${body.slice(0, 160)}`, 'error');
    } catch (e) {
      toast(`Não foi possível conectar: ${e.message}`, 'error');
    }
  };
  clear(el, h('div', { class: 'publish' },
    h('section', { class: 'panel' },
      h('h2', {}, 'Salvar suas alterações'),
      h('p', {}, 'Tudo o que você edita fica salvo neste navegador. Para tornar permanente (e compartilhar), exporte o pacote e versione no repositório:'),
      h('ol', {},
        h('li', {}, 'Clique em ', h('b', {}, 'Exportar pacote'), ' (gera ', h('code', {}, 'gestor-automacoes-bundle.json'), ').'),
        h('li', {}, 'No repositório, rode ', h('code', {}, 'npm run import-bundle gestor-automacoes-bundle.json'), ' — grava ', h('code', {}, 'flows/'), ' e ', h('code', {}, 'tenants/'), ' validando tudo.'),
        h('li', {}, 'Faça commit. O GitHub Actions roda os testes e republica este Studio automaticamente.')),
      h('div', { class: 'row wrap' },
        h('button', { class: 'primary', onclick: () => download('gestor-automacoes-bundle.json', json(state.bundle()) + '\n') }, '⬇ Exportar pacote'),
        h('button', { onclick: () => fileIn.click() }, '⬆ Importar pacote'),
        fileIn = h('input', { type: 'file', accept: 'application/json,.json', hidden: true, onchange: async (e) => {
          const f = e.target.files[0];
          if (!f) return;
          try {
            state.importBundle(JSON.parse(await f.text()));
            renderEditor(); renderTenants();
            toast('Pacote importado ✔');
          } catch (err) {
            toast(err.message, 'error');
          }
        } }),
        h('button', { class: 'danger', onclick: () => { if (confirm('Descartar todas as alterações locais e voltar aos fluxos do repositório?')) { state.reset(); renderEditor(); renderTenants(); toast('Restaurado'); } } }, 'Descartar alterações locais')),
    ),
    h('section', { class: 'panel' },
      h('h2', {}, 'Publicar em um servidor (quando houver)'),
      h('p', { class: 'muted' }, 'Opcional. Quando você subir o servidor do framework (ex.: Render, plano gratuito), publique os fluxos direto daqui — o servidor valida e versiona antes de aceitar.'),
      h('div', { class: 'row wrap' },
        url = h('input', { placeholder: 'https://seu-bot.onrender.com', value: srv.url, 'aria-label': 'URL do servidor', style: { minWidth: '280px' } }),
        token = h('input', { type: 'password', placeholder: 'ADMIN_TOKEN', 'aria-label': 'Token de administração' }),
        h('button', { onclick: publish }, 'Publicar fluxos')),
      h('p', { class: 'muted small' }, 'O token não é armazenado. Lembre-se de incrementar a "versão" do fluxo alterado: o servidor recusa conteúdo diferente com a mesma versão.'),
    ),
    h('section', { class: 'panel' },
      h('h2', {}, 'Sobre este Studio'),
      h('ul', {},
        h('li', {}, 'Roda 100% no navegador, com o mesmo código do servidor (compilado a partir de ', h('code', {}, 'src/'), '). Nenhuma mensagem sai do seu computador.'),
        h('li', {}, 'Os canais são simulados apenas na rede: os webhooks seguem o formato oficial (Meta/Telegram) e as chamadas de API são capturadas como seriam enviadas.'),
        h('li', {}, `Build: ${new Date(state.builtAt).toLocaleString('pt-BR')}.`)),
    ),
  ));
}

// ------------------------------------------------------------------------------------------
for (const b of document.querySelectorAll('.topbar .tabs button')) b.addEventListener('click', () => show(b.dataset.tab));
window.addEventListener('hashchange', () => show(location.hash.slice(1)));
document.addEventListener('studio:test-flow', (e) => {
  show('simulador');
  restartSim();
  setTimeout(() => currentSim()?.startFlow?.(e.detail), 50);
});
renderStatus();
show(location.hash.slice(1) || 'simulador');
