// node:fs/node:path não existem no navegador: o Studio recebe fluxos e clientes já carregados (data.js).
const no = (n) => () => { throw new Error(`${n} indisponível no navegador`); };
export const readdirSync = no('readdirSync');
export const readFileSync = no('readFileSync');
export const existsSync = () => false;
export const join = (...p) => p.join('/');
