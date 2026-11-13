/**
 * Verificações de segurança na inicialização (secure by default — ameaças T1, T3 e T15).
 * Regras:
 *  - Produção (NODE_ENV=production): ADMIN_TOKEN obrigatório, com 32+ caracteres e diferente dos
 *    valores de exemplo. Sem isso o servidor NÃO sobe (fail-closed).
 *  - Fora de produção sem token: só sobe com ALLOW_INSECURE_DEV=1 e escutando apenas em 127.0.0.1.
 *  - Produção sem INTEGRATION_ALLOWED_HOSTS: sobe, mas avisa que integrações HTTP serão recusadas.
 */
const PLACEHOLDERS = new Set(['troque-este-token', 'changeme', 'admin', 'token', 'secret']);
export const MIN_ADMIN_TOKEN_LENGTH = 32;

export interface StartupSecurity {
  fatal?: string;
  warnings: string[];
  host: string;
}

/** ADMIN_TOKENS="ana:token1,bruno:token2" -> { ana: 'token1', bruno: 'token2' } (T10). */
export function parseOperatorTokens(raw: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  for (const part of (raw ?? '').split(',').map((x) => x.trim()).filter(Boolean)) {
    const i = part.indexOf(':');
    if (i <= 0) throw new Error(`ADMIN_TOKENS: item sem "nome:token" (${part.slice(0, 12)}…)`);
    const name = part.slice(0, i).trim();
    if (!/^[\w.-]{1,40}$/.test(name)) throw new Error(`ADMIN_TOKENS: nome de operador inválido "${name}"`);
    out[name] = part.slice(i + 1).trim();
  }
  return out;
}

export function checkStartupSecurity(env: Record<string, string | undefined>): StartupSecurity {
  const warnings: string[] = [];
  const production = env.NODE_ENV === 'production';
  const host = env.HOST ?? '0.0.0.0';
  let operators: Record<string, string>;
  try {
    operators = parseOperatorTokens(env.ADMIN_TOKENS);
  } catch (e) {
    return { fatal: (e as Error).message, warnings, host };
  }
  const tokens = [...(env.ADMIN_TOKEN ? [env.ADMIN_TOKEN] : []), ...Object.values(operators)];
  const token = tokens[0] ?? '';

  if (production && env.WEBCHAT_AUTH === 'off') return { fatal: 'WEBCHAT_AUTH=off não é permitido em produção', warnings, host };
  if (env.WEBCHAT_AUTH === 'off') warnings.push('WEBCHAT_AUTH=off: webchat sem sessão assinada (só desenvolvimento)');
  if (production && !env.WEBCHAT_SECRET) warnings.push('WEBCHAT_SECRET vazio: sessões de webchat expiram a cada reinício');
  if (production && !env.DATA_ENCRYPTION_KEY) warnings.push('DATA_ENCRYPTION_KEY vazio: conversas e contatos ficam sem criptografia no banco');

  if (!token) {
    if (production) return { fatal: 'ADMIN_TOKEN ausente em produção (gere um com: openssl rand -hex 32)', warnings, host };
    if (env.ALLOW_INSECURE_DEV !== '1') {
      return { fatal: 'ADMIN_TOKEN ausente. Defina ADMIN_TOKEN ou, só para desenvolvimento local, ALLOW_INSECURE_DEV=1', warnings, host };
    }
    warnings.push('modo de desenvolvimento inseguro: rotas /admin, /handoff e /metrics abertas, escutando só em 127.0.0.1');
    return { warnings, host: '127.0.0.1' };
  }
  for (const t of tokens) {
    if (PLACEHOLDERS.has(t.toLowerCase())) return { fatal: 'token administrativo usa um valor de exemplo; gere um aleatório', warnings, host };
    if (t.length < MIN_ADMIN_TOKEN_LENGTH) {
      const msg = `token administrativo curto (${t.length} caracteres; mínimo ${MIN_ADMIN_TOKEN_LENGTH})`;
      if (production) return { fatal: msg, warnings, host };
      warnings.push(msg);
    }
  }
  if (new Set(tokens).size !== tokens.length) return { fatal: 'tokens administrativos repetidos entre operadores', warnings, host };
  if (production && !env.INTEGRATION_ALLOWED_HOSTS) {
    warnings.push('INTEGRATION_ALLOWED_HOSTS vazio: integrações HTTP dos fluxos serão recusadas em produção');
  }
  if (env.INTEGRATION_ALLOW_PRIVATE_NETWORK === '1' && production) {
    warnings.push('INTEGRATION_ALLOW_PRIVATE_NETWORK é ignorado em produção');
  }
  return { warnings, host };
}
