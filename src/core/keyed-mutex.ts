/**
 * Serializa o processamento por chave (conversationId) dentro do processo.
 * Garante que duas mensagens do mesmo contato nunca rodem em paralelo,
 * sem bloquear conversas diferentes. Entre processos, o controle é o `rev` otimista.
 */
export class KeyedMutex {
  private tails = new Map<string, Promise<unknown>>();

  run<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const prev = this.tails.get(key) ?? Promise.resolve();
    const next = prev.then(fn, fn);
    const tail = next.catch(() => undefined);
    this.tails.set(key, tail);
    tail.then(() => {
      if (this.tails.get(key) === tail) this.tails.delete(key);
    });
    return next;
  }
}
