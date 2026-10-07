// Shim mínimo de node:events para o navegador.
export class EventEmitter {
  #l = new Map();
  on(e, f) { (this.#l.get(e) ?? this.#l.set(e, new Set()).get(e)).add(f); return this; }
  off(e, f) { this.#l.get(e)?.delete(f); return this; }
  emit(e, ...a) { for (const f of [...(this.#l.get(e) ?? [])]) f(...a); return true; }
}
