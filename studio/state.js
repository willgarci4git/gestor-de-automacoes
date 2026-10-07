// Estado do Studio: fluxos, clientes e segredos de teste. Persistido no navegador (localStorage)
// e exportável como pacote JSON para versionar no repositório (npm run import-bundle).
import data from './data.js';
import { store } from './ui.js';

const KEY = 'gestor-automacoes-studio.v1';
const byId = (arr) => Object.fromEntries(arr.map((x) => [x.id, structuredClone(x)]));

class StudioState extends EventTarget {
  constructor() {
    super();
    const saved = store.get(KEY, null);
    this.flows = saved?.flows ?? byId(data.flows);
    this.tenants = saved?.tenants ?? byId(data.tenants);
    this.secrets = saved?.secrets ?? { leads_webhook_url: 'https://script.google.com/macros/s/EXEMPLO/exec' };
    this.builtAt = data.builtAt;
  }

  get flowList() {
    return Object.values(this.flows).sort((a, b) => a.id.localeCompare(b.id));
  }

  get tenantList() {
    return Object.values(this.tenants).sort((a, b) => a.id.localeCompare(b.id));
  }

  isModified() {
    return JSON.stringify(byId(data.flows)) !== JSON.stringify(this.flows) || JSON.stringify(byId(data.tenants)) !== JSON.stringify(this.tenants);
  }

  save() {
    store.set(KEY, { flows: this.flows, tenants: this.tenants, secrets: this.secrets });
    this.dispatchEvent(new Event('change'));
  }

  reset() {
    store.del(KEY);
    this.flows = byId(data.flows);
    this.tenants = byId(data.tenants);
    this.dispatchEvent(new Event('change'));
  }

  bundle() {
    return { format: 'gestor-automacoes-bundle@1', exportedAt: new Date().toISOString(), flows: this.flowList, tenants: this.tenantList };
  }

  importBundle(b) {
    if (!b || !Array.isArray(b.flows) || !Array.isArray(b.tenants)) throw new Error('Arquivo não é um pacote do Studio (esperado {flows:[], tenants:[]}).');
    this.flows = byId(b.flows);
    this.tenants = byId(b.tenants);
    this.save();
  }
}

export const state = new StudioState();
