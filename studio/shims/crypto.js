// Shim de node:crypto para o navegador (Studio). Só o necessário para o núcleo rodar.
export const randomUUID = () => globalThis.crypto.randomUUID();
export function createHmac() {
  throw new Error('createHmac indisponível no navegador: a verificação de assinatura é exercida nos testes de CI (Node).');
}
export function timingSafeEqual(a, b) {
  if (a.length !== b.length) return false;
  let r = 0;
  for (let i = 0; i < a.length; i++) r |= a[i] ^ b[i];
  return r === 0;
}
