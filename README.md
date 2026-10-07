# Gestor de Automações

Framework de bots de atendimento **agnóstico de canal**, baseado em fluxos declarativos (JSON) interpretados por um **State Engine** orientado a eventos. Os fluxos do curso Caixa Rápido (pré-atendimento, atendimento por setor, iniciadores de conversa, integração com planilha, transbordo) viram arquivos em `flows/`. Você parametriza cada bot novo sem mexer no código.

- **Zero dependências de runtime.** Usa Node.js ≥ 22.18, que roda TypeScript nativamente, mais `node:sqlite` e `node:http`.
- **Canais:** Webchat (widget incluso), WhatsApp Cloud API (com modelos aprovados), Instagram (DMs e gatilho por comentário) e Telegram.
- **Multi-cliente:** o mesmo fluxo atende N clientes. Cada cliente tem um arquivo `tenants/<id>.json` com parâmetros (`{{tenant.nome}}`), horário comercial e feriados, e a lista de fluxos permitidos.
- **Recursos do curso:**
  - saudação por horário;
  - teste A/B (`randomizer`);
  - transmissão por etiqueta (`/admin/broadcast`);
  - opt-out LGPD ("parar" / "voltar");
  - lint "atraso nunca por último" (E003);
  - etiqueta de origem em cada gatilho e links de campanha (`ref`: `t.me/<bot>?start=`, `ig.me/m/<conta>?ref=`, anúncio "clique para o WhatsApp", `?ref=` no webchat);
  - limpeza mensal de contatos inativos preservando a lista VIP (`/admin/contacts/cleanup`);
  - fluxo de atendimento por setor (URA digital) com coleta de KM e lembrete por atraso inteligente.
- **Resiliência:**
  - idempotência de webhooks;
  - Transactional Outbox;
  - retry com backoff e circuit breaker;
  - timeouts;
  - proteção contra loops;
  - fallback com transbordo humano.
- **Transbordo humano:** filas por setor, SLA e console do atendente em `/agent`.

## Studio: controle e customização dos fluxos (sem servidor, custo zero)

O **Studio** é um site estático que roda o *mesmo código do framework* inteiramente no navegador. Ele é publicado automaticamente no GitHub Pages a cada push na `main`, então não depende de nenhum servidor nem de login no claude.ai. O endereço é `https://<usuario>.github.io/gestor-de-automacoes/`.

| Aba | O que faz |
|---|---|
| **Simulador** | Simula uma conversa em WhatsApp, Instagram, Telegram ou Webchat. Os webhooks são montados no formato oficial e passam pelo parser real de cada canal. As chamadas de API saem exatamente como seriam enviadas, e você pode inspecioná-las na aba *Integração*. Também permite avançar o relógio (timeouts e SLA), simular a API de integração em sucesso, falha ou timeout, simular o canal instável e assumir a conversa como atendente. |
| **Fluxos** | Grafo do fluxo com edição de cada nó, validação ao vivo (referências, loops, E003…), criação, duplicação e exclusão. |
| **Clientes** | Parâmetros `{{tenant.*}}`, horário comercial com faixas e feriados, e fluxos permitidos. |
| **Diagnóstico** | 22 roteiros automáticos que provam a integração ponta a ponta nos 4 canais: idempotência, retry 503, integração fora do ar, transbordo, horário, opt-out e comentário no Instagram. |
| **Publicar** | Exporta e importa o pacote de fluxos e clientes, ou publica num servidor do framework quando houver um. |

As edições ficam no navegador. Para torná-las permanentes:

1. Clique em **Exportar pacote**.
2. Rode `npm run import-bundle gestor-automacoes-bundle.json`. O comando valida tudo e só grava se não houver erros.
3. Faça commit.

O CI testa e republica o Studio.

Rodar localmente: `npm run build:studio && npx serve dist-studio`. Qualquer servidor estático funciona, por exemplo `python3 -m http.server -d dist-studio`.

## Na nuvem, a custo zero

| Peça | Onde roda | Custo |
|---|---|---|
| Código | GitHub (repositório público) | 0 |
| Testes a cada push (typecheck, validação dos fluxos, suíte completa) | GitHub Actions (`.github/workflows/ci.yml`) | 0 |
| Studio | GitHub Pages (`.github/workflows/pages.yml`), publicado só se os testes passarem | 0 |
| Servidor do bot, para quando integrar os canais | `Dockerfile` + `render.yaml` (Render, plano gratuito: hiberna sem uso e tem disco efêmero) ou qualquer host Node/Docker | 0 no plano free |

## Início rápido

```bash
node -v                # precisa ser >= 22.18
cp .env.example .env   # ajuste ADMIN_TOKEN e, se quiser, WhatsApp/Telegram
npm start              # http://localhost:3000  -> webchat de teste
                       # http://localhost:3000/agent -> console do atendente
npm test               # suíte completa (unitário + ponta a ponta)
npm run validate       # valida os fluxos em flows/
```

`npm run typecheck` exige instalar as dependências de desenvolvimento antes (`npm i`): `typescript` e `@types/node`. Elas não são necessárias para rodar o framework.

## Arquitetura

```
Canal ─> Webhook (HMAC/secret + ACK imediato) ─> InboundEvent normalizado
      ─> StateEngine (serializado por conversa, idempotente)
            └─ commit ATÔMICO: sessão + contato + evento + comandos (outbox)
      ─> OutboxDispatcher ─┬─> ChannelAdapter.send (WhatsApp / Telegram / Webchat)
                           ├─> runHttp (integrações: retry, timeout, circuit breaker) ─> integration_result
                           ├─> Scheduler (timeouts, wait, SLA) ─> timer
                           └─> HandoffService (tickets, console do atendente) ─> handoff_accepted/closed
```

| Pasta | Responsabilidade |
|---|---|
| `src/core` | Motor, DSL, validador, handlers de nós, contexto de variáveis. **Não conhece canais nem faz I/O de rede.** |
| `src/storage` | Interface `Storage` com duas implementações: `MemoryStorage` (testes) e `SqliteStorage` (produção, instância única) |
| `src/runtime` | Dispatcher da outbox, scheduler, transbordo e composição (`createBotApp`) |
| `src/channels` | Adapters: webchat, whatsapp, instagram, telegram |
| `src/integrations` | Executor HTTP resiliente |
| `src/server` | Servidor HTTP e ponto de entrada |
| `flows/` | Seus bots (JSON versionado) |

### Ciclo de um turno

1. **Idempotência.** Se o `eventId` já foi processado, o evento é descartado. Isso cobre as reentregas de webhook que a Meta faz.
2. **Sessão.** Carrega a sessão. Se não houver nenhuma, o gatilho é resolvido (keyword, regex ou default) e uma sessão é criada **presa à versão atual** do fluxo.
3. **Eventos internos obsoletos.** Timers e resultados de integração cujo token é diferente do ponto de espera atual são descartados.
4. **Intents globais.** "atendente", "menu", "sair" etc. têm precedência sobre o nó atual. Em perguntas de texto livre, só vale o casamento exato.
5. **Execução.** O evento vai para o nó atual, e o motor avança pelo grafo até um nó que espera algo (`input`, `router`, `wait`, `integration` ou `handoff`).
6. **Commit atômico.** Os efeitos só são executados depois do commit, pela outbox.

## DSL de fluxos

```json
{
  "id": "meu-bot", "version": 1, "start": "inicio",
  "triggers": [
    { "kind": "ref", "values": ["promo-outubro"], "tags": ["origem_promo_outubro"] },
    { "kind": "keyword", "values": ["oi", "menu"] },
    { "kind": "default", "tags": ["origem_organico"] }
  ],
  "globals": { "intents": { "atendente": { "match": ["atendente"], "goto": "humano" } } },
  "nodes": { "inicio": { "type": "message", "text": "Olá {{contact.first_name}}!", "next": "..." } }
}
```

### Gatilhos

| `kind` | Quando dispara | Observações |
|---|---|---|
| `ref` | A conversa chega por um link de campanha: `t.me/<bot>?start=<ref>`, `ig.me/m/<conta>?ref=<ref>`, anúncio "clique para o WhatsApp" (`source_id`) ou `ref` no webchat | Tem prioridade sobre os demais e **reinicia a automação** se já houver conversa em andamento (exceto em atendimento humano). O valor fica em `session.ref` |
| `comment` | Comentário em post/Reel do Instagram | Opcional: `mediaIds` restringe a publicações |
| `keyword` / `regex` | Texto da primeira mensagem | Casamento tolerante (sem acento, plural, 1 erro de digitação) |
| `default` | Nenhum outro gatilho casou | Comentários nunca caem no default |

- **`tags`** em qualquer gatilho: etiquetas aplicadas ao contato quando aquele gatilho inicia a conversa. É a "etiqueta de origem" do curso, útil para medir qual campanha ou palavra-chave trouxe o contato e para filtrar transmissões.
- **Prioridade entre fluxos:** a ordem da lista `flows` do cliente (tenant) define qual fluxo vence quando dois gatilhos casam. Sem lista, vale a ordem de carga.
- **`"optIn": true` no fluxo:** o fluxo só serve de entrada para clientes que o listam em `flows`. Use em fluxos verticais (ex.: `atendimento-setor`) para que seus gatilhos genéricos não capturem conversas de outros clientes.

### Variáveis

| Escopo | Duração | Exemplo |
|---|---|---|
| `contact.*` | Permanente, entre conversas (os "campos personalizados") | `contact.full_name`, `contact.tags` |
| `session.*` | Dura a conversa | `session.motivo` |
| `flow.*` | Local ao fluxo ou subfluxo; restaurada ao voltar do subfluxo | `flow.data` |
| `system.*` | Somente leitura | `channel`, `userId`, `now`, `date`, `time`, `hour`, `weekday` (0 = domingo), `greeting` (Bom dia/Boa tarde/Boa noite), `inBusinessHours` (true/false; null sem configuração), `lastMessage` |
| `tenant.*` | Somente leitura; vem do arquivo do cliente | `{{tenant.nome}}`, `{{tenant.endereco}}`, `{{tenant.linkAgenda}}` |
| `secrets.*` | Resolvidos **somente** no executor HTTP (vêm de `SECRET_<NOME>`); nunca aparecem em logs ou sessões | `{{secrets.leads_webhook_url}}` |

Um template que ocupa o valor inteiro (`"{{session.x}}"`) preserva o tipo original do dado (número, objeto).

### Tipos de nó

| Tipo | Campos principais | Comportamento |
|---|---|---|
| `message` | `text` e/ou `media {kind,url,caption,filename}`, `next` | Envia e segue |
| `input` | `prompt`, `saveTo`, `validator`, `errorMessage`, `maxAttempts` (3), `timeoutSec` + `onTimeout`, `onInvalid` | Pergunta livre com validação. Validadores disponíveis: `any`, `minLength`, `email`, `phone`, `number{min,max}`, `date` (DD/MM/AAAA → ISO), `cpf`, `regex` |
| `router` | `prompt`, `options[{id,label,match[],next}]`, `display` (`buttons`\|`list`\|`text`), `saveTo`, `maxAttempts`, `onExhausted`, `timeoutSec` + `onTimeout` | Menu (os "iniciadores de conversa"). Reconhece o clique, o número digitado, o rótulo e variações (sem acento, plural, 1 erro de digitação) |
| `condition` | `branches[{when,next}]`, `default` | `when`: `{var, op, value}` com `op` = `eq`, `neq`, `contains`, `gt`, `gte`, `lt`, `lte`, `exists`, `notExists`, `in` ou `hasTag`; combinações via `{all:[...]}` e `{any:[...]}` |
| `set` | `assign {caminho: valor}`, `addTags`, `removeTags`, `next` | Atribui variáveis e tags |
| `integration` | `request {method,url,headers,body}`, `saveTo`, `timeoutMs`, `retry {max,backoffMs}`, `next`, **`onError` obrigatório** | HTTP assíncrono e resiliente. Em caso de falha, grava `flow.lastError` |
| `wait` | `seconds`, `next` | Pausa persistente, feita pelo scheduler |
| `handoff` | `queue`, `message`, `contextVars`, `slaSec` + `onSlaTimeout`, `next` (opcional) | Transbordo humano. Com `next`, volta ao bot quando o atendente encerra; sem `next`, a conversa termina |
| `subflow` | `flowId`, `next` | Executa outro fluxo reutilizável e retorna |
| `end` | `message` | Encerra a conversa ou retorna ao fluxo pai |
| `randomizer` | `variants[{id, weight, next}]` (mínimo 2) | Teste A/B: sorteia uma variante por peso, grava `session.ab_<nó>`, aplica a etiqueta `ab:<nó>:<variante>` e registra a métrica `randomizer.<fluxo>.<nó>.<variante>` |

Complementos:

- **`message` com `template {name, language, components}`:** envia um modelo aprovado no WhatsApp, obrigatório fora da janela de 24h (broadcast e lembretes). Nos outros canais, o `text` do nó é enviado como alternativa.
- **`router` com `silent: true`:** não reenvia o menu ao entrar; só espera a resposta. Use depois de um modelo com botões cujos payloads sejam os ids das opções.

Qualquer nó aceita `onError`, usado se o handler lançar uma exceção. Sem ele, entra o fallback global.

### Validação estática (antes de publicar)

Um fluxo só é publicado se passar em todas estas verificações:

- schema de cada nó;
- referências a nós inexistentes;
- subfluxos não registrados;
- `saveTo` em escopo que não pode ser gravado;
- regex inválida;
- opções duplicadas;
- `integration` sem `onError`;
- **loops sem ponto de espera** (que seriam infinitos).

Nós inalcançáveis geram apenas aviso, assim como os limites dos canais: rótulo de opção com mais de 20 caracteres (truncado nos botões do WhatsApp/Instagram) e espera maior que 24h seguida de texto livre (fora da janela do WhatsApp, só modelo aprovado). Publicar uma versão já existente com conteúdo diferente é recusado: incremente `version`.

## Canais

### WhatsApp Cloud API

1. Crie um app na Meta for Developers com o produto WhatsApp. Anote o Phone Number ID, o token permanente (System User) e o App Secret.
2. Preencha as variáveis `WHATSAPP_*` no `.env`.
3. Configure o webhook para `https://SEU_DOMINIO/whatsapp/webhook`, use o mesmo `WHATSAPP_VERIFY_TOKEN` e assine o campo `messages`.
4. Toda chamada é validada via `X-Hub-Signature-256` (HMAC do corpo bruto). O servidor responde 200 imediatamente e processa de forma assíncrona e idempotente.
5. Menus com até 3 opções viram botões; de 4 a 10, lista; acima de 10, texto numerado.

A janela de 24h do WhatsApp continua valendo: fora dela, só modelos aprovados (templates) podem ser enviados. O motor inicia uma nova sessão depois de `sessionTtlSec` (24h).

### Instagram (DM e "comenta QUERO")

1. Use um app da Meta com o produto Instagram, ligado a uma conta profissional.
2. Preencha as variáveis `INSTAGRAM_*` no `.env`.
3. Configure o webhook em `/instagram/webhook` e assine os campos `messages` e `comments`.
4. Comentários só disparam fluxos com gatilho `{"kind":"comment","values":["quero"],"mediaIds":["<id do post>"]}`. Eles nunca caem no fluxo default.
5. **Primeira resposta a um comentário:** vai como *private reply*, que é única por comentário. O motor aglutina automaticamente as mensagens desse primeiro turno numa só: os textos são unidos, a mídia vira legenda + link e os botões da última escolha são mantidos (`engineConfig.commentSingleReply`, ligado por padrão). Ainda assim, prefira que o fluxo de isca envie **uma** mensagem com botões e espere a resposta, como em `flows/isca-instagram.json`. Se `INSTAGRAM_COMMENT_PUBLIC_REPLY` estiver definido, o bot também responde publicamente no post.
6. **Link `ig.me/m/<conta>?ref=<ref>`:** quem abre a conversa pelo link entra direto no fluxo com gatilho `ref` correspondente, mesmo sem digitar nada.

### Telegram

```bash
curl "https://api.telegram.org/bot$TELEGRAM_BOT_TOKEN/setWebhook?url=https://SEU_DOMINIO/telegram/webhook&secret_token=$TELEGRAM_WEBHOOK_SECRET"
```

- Links `t.me/<bot>?start=<ref>` chegam como `/start <ref>` e disparam o gatilho `ref`.
- Cliques em botões são confirmados com `answerCallbackQuery`, para o botão não ficar "carregando".

### Webchat

- `POST /webchat/:tenant/messages`, com corpo `{userId, text | optionId | ref, name?}`. Use `ref` para identificar a página ou campanha de onde o visitante abriu o chat.
- `GET /webchat/:tenant/stream?userId=` (SSE) e `GET /webchat/:tenant/history?userId=`.
- O widget de referência fica em `public/webchat.html`.

## Clientes (tenants): como criar um bot novo

Crie `tenants/<cliente>.json`. O `id` do tenant é o que aparece na URL do webchat (`/webchat/<cliente>/...`) e em `TENANT_ID` para os webhooks.

```json
{
  "id": "oficina", "name": "Oficina Exemplo", "timezone": "America/Sao_Paulo",
  "params": { "nome": "Oficina Exemplo", "endereco": "Rua das Oficinas, 50", "horarioTexto": "seg a sáb, 8h–17h",
              "textoPlanos": "Revisão a partir de R$ 390", "labelAgendar": "Agendar revisão" },
  "flows": ["pre-atendimento", "agendamento"],
  "businessHours": { "days": { "1": [["08:00","12:00"],["13:00","17:00"]], "6": [["08:00","12:00"]] },
                     "holidays": ["2026-12-25"] }
}
```

A ordem de `flows` é também a prioridade de entrada: a oficina lista `atendimento-setor` antes de `pre-atendimento`, então um "oi" cai na URA por setor.

Os fluxos compartilhados usam apenas `{{tenant.*}}` e `system.inBusinessHours`. Assim, um bot novo é só um arquivo de configuração, sem fluxo novo. O arquivo `tenants/default.json` é usado para tenants sem configuração própria.

## Transmissão (broadcast) e opt-out

**Transmissão.** Dispare um fluxo para todos os contatos com uma etiqueta:

```bash
curl -X POST localhost:3000/admin/broadcast -H "x-admin-token: $ADMIN_TOKEN" -H 'content-type: application/json' \
  -d '{"broadcastId":"retorno-out-2026","flowId":"reengajamento","tag":"lead_agendamento","tenantId":"clinica"}'
```

- É idempotente por `broadcastId`: reexecutar não duplica envios.
- Não interrompe conversas em andamento.
- Ignora contatos que pediram opt-out.

**Limpeza de contatos (mensal, como ensina o curso).** Remove quem não interage há N dias, exceto contatos com etiquetas protegidas (ex.: lista VIP) e conversas em andamento. Por segurança, só apaga com `"dryRun": false` explícito:

```bash
curl -X POST localhost:3000/admin/contacts/cleanup -H "x-admin-token: $ADMIN_TOKEN" -H 'content-type: application/json' \
  -d '{"inactiveDays":30,"keepTags":["vip","lead_agendamento"],"tenantId":"clinica"}'          # prévia
# ... confira a lista "removed" e repita com "dryRun": false
```

A data da última interação fica em `contact.last_seen_at`, atualizada a cada mensagem do usuário.

**Opt-out (LGPD).** Os termos exatos "parar", "descadastrar" e "stop" silenciam o bot para aquele contato e fecham qualquer transbordo aberto. "voltar" ou "reativar" desfaz o opt-out. Os termos são configuráveis em `engineConfig.optOut`.

## Transbordo humano

O console está em `/agent` e pede o `ADMIN_TOKEN`. Por lá o atendente vê a fila, o contexto que o bot coletou e a transcrição, e pode assumir, responder e encerrar o ticket. API equivalente:

- `GET /handoff/tickets?queue=&status=`
- `POST /handoff/tickets/:id/accept|reply|close`
- `GET /handoff/stream` (SSE)

## Administração e observabilidade

| Rota | Função |
|---|---|
| `GET /health` | Liveness |
| `GET /metrics` | Contadores e latências p50/p95. Exemplos: `engine.turn_ms`, `engine.fallback.*`, `engine.events.duplicate`, `integration.failed`, `outbox.dead` |
| `GET/POST /admin/flows`, `POST /admin/flows/validate` | Publicação a quente, com validação |
| `GET /admin/sessions/:conversationId` | Estado da conversa, para depuração |
| `GET /admin/dead-letters` | Comandos que falharam em definitivo |
| `POST /admin/contacts/cleanup` | Limpeza de contatos inativos (prévia por padrão) |

Os logs são JSON por linha, com `conversationId`, `flow@version`, `nodeId` e `eventId`. Chaves como `token`, `secret` e `authorization` são mascaradas automaticamente.

## Como estender

- **Novo tipo de nó:**
  1. Implemente `NodeHandler` (`onEnter` / `onEvent`) em `src/core/nodes/`.
  2. Registre-o em `nodes/index.ts`.
  3. Adicione o schema em `validator.ts`.

  O loop do motor não muda.
- **Novo canal (Instagram, Messenger...):**
  1. Implemente `ChannelAdapter.send`.
  2. Crie um parser `payload → InboundEvent[]`.
  3. Adicione a rota de webhook.
- **Escala horizontal:** implemente `Storage` sobre Postgres. As queries do `SqliteStorage` são SQL padrão, e o controle de concorrência já usa `rev` otimista. Com várias instâncias, use também uma fila particionada por `conversationId` (por exemplo, Redis Streams ou SQS FIFO com `MessageGroupId`) em vez do `KeyedMutex`, que só serializa dentro de um processo.
