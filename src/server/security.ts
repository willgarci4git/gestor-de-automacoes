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

export function checkStartupSecurity(env: Record<string, string | undefined>): StartupSecurity {
  const warnings: string[] = [];
  const production = env.NODE_ENV === 'production';
  const token = env.ADMIN_TOKEN ?? '';
  const host = env.HOST ?? '0.0.0.0';

  if (!token) {
    if (production) return { fatal: 'ADMIN_TOKEN ausente em produção (gere um com: openssl rand -hex 32)', warnings, host };
    if (env.ALLOW_INSECURE_DEV !== '1') {
      return { fatal: 'ADMIN_TOKEN ausente. Defina ADMIN_TOKEN ou, só para desenvolvimento local, ALLOW_INSECURE_DEV=1', warnings, host };
    }
    warnings.push('modo de desenvolvimento inseguro: rotas /admin, /handoff e /metrics abertas, escutando só em 127.0.0.1');
    return { warnings, host: '127.0.0.1' };
  }
  if (PLACEHOLDERS.has(token.toLowerCase())) return { fatal: 'ADMIN_TOKEN usa um valor de exemplo; gere um aleatório', warnings, host };
  if (token.length < MIN_ADMIN_TOKEN_LENGTH) {
    const msg = `ADMIN_TOKEN curto (${token.length} caracteres; mínimo ${MIN_ADMIN_TOKEN_LENGTH})`;
    if (production) return { fatal: msg, warnings, host };
    warnings.push(msg);
  }
  if (production && !env.INTEGRATION_ALLOWED_HOSTS) {
    warnings.push('INTEGRATION_ALLOWED_HOSTS vazio: integrações HTTP dos fluxos serão recusadas em produção');
  }
  if (env.INTEGRATION_ALLOW_PRIVATE_NETWORK === '1' && production) {
    warnings.push('INTEGRATION_ALLOW_PRIVATE_NETWORK é ignorado em produção');
  }
  return { warnings, host };
}
