# ADR-003: Correções de segurança (v0.4.1)

- **Status:** implementado — T1 a T16 tratadas (aguardando envio ao GitHub junto com a v0.4)
- **Data:** 2026-11-13
- **Origem:** revisão STRIDE × CIAND (`claude/seguranca-modelo-ameacas.md` no Projeto)

## Decisões

| Ameaça | Decisão | Onde |
|---|---|---|
| T1 · rotas administrativas abertas sem token | Fail-closed: em produção o servidor não sobe sem `ADMIN_TOKEN` de 32+ caracteres (valores de exemplo recusados). Fora de produção, sem token, só sobe com `ALLOW_INSECURE_DEV=1` e escutando em `127.0.0.1`. Timeouts e teto de conexões no `node:http`. | `src/server/security.ts`, `src/server/main.ts` |
| T2 · injeção de segredos via dados do usuário | Valores vindos de variáveis têm `{{` e `}}` neutralizados (`{ {`, `} }`) antes de chegar ao worker. Só o texto escrito no fluxo pode referenciar `{{secrets.*}}`. | `src/core/context.ts` |
| T3 · SSRF nas integrações | Só `https`; sem credenciais na URL; allowlist `INTEGRATION_ALLOWED_HOSTS` (obrigatória em produção, aceita `*.dominio`); bloqueio de loopback, privados, CGNAT, link-local/metadados, ULA, IPv4 mapeado em IPv6 e NAT64, inclusive após resolver o DNS; redirecionamentos seguidos manualmente (até 3), revalidados a cada salto e sem repassar `Authorization`/`Cookie` para outro host. | `src/integrations/http-runner.ts` |
| T5 · path traversal no import | `flow.id` restrito a `^[\w-]{1,64}$` no validador; o `import-bundle` confina toda escrita a `flows/` e `tenants/`. | `src/core/validator.ts`, `scripts/import-bundle.ts` |

## Correções P1 e P2 (mesma versão)

| Ameaça | Decisão | Onde |
|---|---|---|
| T4 · IDOR no webchat | Sessão emitida pelo servidor: `POST /webchat/:tenant/session` devolve `userId` aleatório (128 bits) e token HMAC-SHA256. Mensagens, histórico e tempo real exigem o token (`x-webchat-token`; no SSE, `wt=` na URL, que só dá acesso à própria conversa). | `src/server/http.ts`, `public/webchat.html` |
| T6 · token administrativo na URL e no navegador | Token só no cabeçalho. O SSE do console usa ticket aleatório de uso único (60 s) obtido em `POST /handoff/stream-ticket`. O console guarda o token em `sessionStorage` e apaga o que versões antigas gravaram. | `http.ts`, `public/agent.html` |
| T7 · DoS | Limites por IP e por conversa no webchat, por IP nas sessões novas e nas falhas de login (429 + `Retry-After`); teto de SSE por IP e total; `requestTimeout`, `headersTimeout`, `maxConnections`. `TRUST_PROXY=1` usa o IP de `X-Forwarded-For`. | `http.ts`, `main.ts` |
| T8 · ReDoS | Validador recusa padrões com mais de 200 caracteres, quantificador aninhado e alternância repetida; regex de fluxo só avalia os primeiros 500 caracteres da mensagem. | `validator.ts`, `input-validators.ts`, `registry.ts` |
| T9 · PII em repouso | AES-256-GCM nos blobs de sessões, contatos, tickets, outbox e jobs com `DATA_ENCRYPTION_KEY`; arquivo do banco em 0600; linhas antigas continuam legíveis e são regravadas cifradas. Console mascara CPF. Retenção: rota de limpeza da v0.4. | `src/storage/sqlite.ts`, `agent.html` |
| T10 · não repúdio | `ADMIN_TOKENS="nome:token,…"` (um por operador) e trilha `audit` com operador, ação, alvo e IP em toda ação administrativa e de atendimento, inclusive falhas de login e hash SHA-256 do fluxo publicado. | `http.ts`, `security.ts` |
| T11 · tenant pela URL | Webchat só atende tenants de `WEBCHAT_TENANTS` (padrão: `TENANT_ID`). | `http.ts`, `main.ts` |
| T12 · cabeçalhos | CSP com hash dos scripts/estilos inline (sem `unsafe-inline`), `frame-ancestors 'none'`, `X-Frame-Options`, `Referrer-Policy`, `Permissions-Policy`, COOP/CORP e HSTS atrás de HTTPS. | `http.ts` |
| T13 · link de mídia | Validador exige `https://` (ou variável) em `media.url`; widget só cria link/imagem https com `rel=noopener`. | `validator.ts`, `webchat.html` |
| T14 · CI | Actions fixadas por SHA, `permissions: contents: read`, CodeQL (security-extended) e Dependabot. | `.github/` |
| T15 · verify token | Comparação em tempo constante no challenge da Meta. | `whatsapp.ts`, `instagram.ts` |
| T16 · Studio | Segredos de teste não são gravados no navegador. | `studio/state.js` |
| Extra | Dockerfile: código do root (somente leitura para o processo), só `/app/data` gravável (0700). Studio: correções de exibição do inspetor (`simview.js`). | `Dockerfile`, `studio/simview.js` |

## Consequências

- **Webchat:** integrações próprias que chamavam `POST /webchat/:tenant/messages` com `userId` livre precisam primeiro pedir a sessão (`/session`) e enviar o token. Para testes locais existe `WEBCHAT_AUTH=off` (proibido em produção).
- **Quebra intencional de configuração:** quem rodava sem `ADMIN_TOKEN` agora precisa definir um token ou usar `ALLOW_INSECURE_DEV=1` localmente. O `render.yaml` já gera o token e define `INTEGRATION_ALLOWED_HOSTS`.
- Integrações para `http://` ou rede interna só funcionam com `INTEGRATION_ALLOW_PRIVATE_NETWORK=1`, ignorado em produção (usado pelo teste e2e com servidores falsos em 127.0.0.1).
- Um valor digitado com `{{ }}` chega ao destino como `{ { }}`: mudança de dado aceita em troca de eliminar a classe de injeção.
- Proteção de DNS é por resolução antes da chamada; um rebinding com TTL zero entre a checagem e a conexão ainda é teoricamente possível. Mitigação complementar: allowlist estrita em produção.

## Verificação

- `test/security.test.ts`: 13 testes negativos (T1, T2, T3, T5).
- `test/security-http.test.ts`: 14 testes negativos (T4, T6, T7, T8, T9, T10, T11, T12, T13, T15). Durante o desenvolvimento, eles pegaram um desvio real: `https://[::ffff:127.0.0.1]/` é normalizado pela URL para `::ffff:7f00:1`, que escapava da primeira versão do bloqueio.
- Suíte completa na v0.4.1: **100/100** (73 da v0.4 + 27 de segurança). Studio: 22/22 no Chromium. Servidor em modo produção testado: sobe só com token forte, webchat exige sessão, admin sem token = 401, banco em 0600.
