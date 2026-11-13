# ADR-003: Correções de segurança P0 (v0.4.1)

- **Status:** implementado (aguardando envio ao GitHub junto com a v0.4)
- **Data:** 2026-11-13
- **Origem:** revisão STRIDE × CIAND (`claude/seguranca-modelo-ameacas.md` no Projeto)

## Decisões

| Ameaça | Decisão | Onde |
|---|---|---|
| T1 · rotas administrativas abertas sem token | Fail-closed: em produção o servidor não sobe sem `ADMIN_TOKEN` de 32+ caracteres (valores de exemplo recusados). Fora de produção, sem token, só sobe com `ALLOW_INSECURE_DEV=1` e escutando em `127.0.0.1`. Timeouts e teto de conexões no `node:http`. | `src/server/security.ts`, `src/server/main.ts` |
| T2 · injeção de segredos via dados do usuário | Valores vindos de variáveis têm `{{` e `}}` neutralizados (`{ {`, `} }`) antes de chegar ao worker. Só o texto escrito no fluxo pode referenciar `{{secrets.*}}`. | `src/core/context.ts` |
| T3 · SSRF nas integrações | Só `https`; sem credenciais na URL; allowlist `INTEGRATION_ALLOWED_HOSTS` (obrigatória em produção, aceita `*.dominio`); bloqueio de loopback, privados, CGNAT, link-local/metadados, ULA, IPv4 mapeado em IPv6 e NAT64, inclusive após resolver o DNS; redirecionamentos seguidos manualmente (até 3), revalidados a cada salto e sem repassar `Authorization`/`Cookie` para outro host. | `src/integrations/http-runner.ts` |
| T5 · path traversal no import | `flow.id` restrito a `^[\w-]{1,64}$` no validador; o `import-bundle` confina toda escrita a `flows/` e `tenants/`. | `src/core/validator.ts`, `scripts/import-bundle.ts` |

## Consequências

- **Quebra intencional de configuração:** quem rodava sem `ADMIN_TOKEN` agora precisa definir um token ou usar `ALLOW_INSECURE_DEV=1` localmente. O `render.yaml` já gera o token e define `INTEGRATION_ALLOWED_HOSTS`.
- Integrações para `http://` ou rede interna só funcionam com `INTEGRATION_ALLOW_PRIVATE_NETWORK=1`, ignorado em produção (usado pelo teste e2e com servidores falsos em 127.0.0.1).
- Um valor digitado com `{{ }}` chega ao destino como `{ { }}`: mudança de dado aceita em troca de eliminar a classe de injeção.
- Proteção de DNS é por resolução antes da chamada; um rebinding com TTL zero entre a checagem e a conexão ainda é teoricamente possível. Mitigação complementar: allowlist estrita em produção.

## Verificação

- `test/security.test.ts`: 13 testes negativos (T1, T2, T3, T5). Durante o desenvolvimento, eles pegaram um desvio real: `https://[::ffff:127.0.0.1]/` é normalizado pela URL para `::ffff:7f00:1`, que escapava da primeira versão do bloqueio.
- Suíte completa: 72/72 na base v0.3 (59 + 13). Na v0.4 o esperado é 86/86 (73 + 13).
