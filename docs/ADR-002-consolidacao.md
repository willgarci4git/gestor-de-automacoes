# ADR-002: Recursos da v0.4

- **Status:** implementado
- **Data:** 2026-10-06
- **Versão:** 0.4.0, a única versão mantida e documentada do Gestor de Automações

## Contexto

A v0.3 já cobria o núcleo do curso Caixa Rápido. Faltavam recursos de campanha, de operação e um fluxo do curso. Também era preciso deixar uma única base de código e uma única documentação.

## Decisões

| Recurso | Como funciona | Por quê |
|---|---|---|
| Gatilho por link (`ref`) | Os canais extraem o ref do link: `/start <ref>` (Telegram), `referral.source_id` (anúncio do WhatsApp), `referral.ref` (`ig.me` do Instagram) e `ref` no webchat. Tem prioridade sobre os outros gatilhos e reinicia a automação, exceto em atendimento humano. O valor fica em `session.ref` | Mede a origem de cada campanha (bio, site, anúncio) sem depender do texto digitado |
| Etiqueta de origem por gatilho | `tags` em qualquer gatilho, aplicadas ao contato quando o gatilho inicia a conversa | Regra do curso: "colocar etiqueta para identificar a origem", sem nó extra no fluxo |
| Prioridade de fluxos por cliente | A ordem de `tenants/<id>.json → flows` decide qual fluxo vence quando dois gatilhos casam. `"optIn": true` faz o fluxo servir de entrada só para quem o lista | Fluxos verticais (ex.: oficina) convivem com o tenant `default`, que aceita todos os fluxos |
| Resposta única a comentário | `coalesceSends` no motor: no primeiro turno vindo de comentário, os envios viram uma mensagem só. Configurável em `engineConfig.commentSingleReply` | A Meta aceita uma única resposta privada por comentário |
| Confirmação de clique no Telegram | `TelegramChannel.answerCallback`, chamado no webhook | Sem isso o botão fica "carregando" por segundos |
| Limpeza de contatos | `app.cleanupContacts`, `POST /admin/contacts/cleanup`, `Storage.deleteContact` e `contact.last_seen_at` | Rotina mensal do curso para reduzir custo de disparo. Prévia por padrão; preserva etiquetas VIP e conversas ativas |
| Avisos de limites de canal | O validador avisa sobre rótulo com mais de 20 caracteres e sobre espera maior que 24h seguida de texto livre | Antecipa truncamento de botões e rejeição fora da janela de 24h do WhatsApp |
| Fluxo "atendimento por setor" | `flows/atendimento-setor.json` (`optIn`): URA com veículo e KM, recomendação condicional, link da agenda, atraso inteligente de 10 min, filas por setor e recado fora do horário | Módulo do curso que faltava no catálogo. A oficina passa a entrar por ele |

## Consequências

- A linguagem de fluxos ganha três campos opcionais: `triggers[].kind = "ref"`, `triggers[].tags` e `flow.optIn`. Fluxos existentes continuam válidos sem mudança.
- A interface `Storage` ganha `deleteContact`. Uma futura implementação em Postgres precisa implementá-lo.
- `contact.fields.last_seen_at` passa a ser gravado a cada mensagem do usuário.
- O tenant `oficina` usa `["atendimento-setor", "pre-atendimento"]`. O subfluxo `agendamento` é específico de clínica (especialidades).

## Rastreabilidade

**Resumo do esforço.** Recursos acima implementados, com 14 testes novos e ajuste de 1 teste existente (lista de fluxos).

**Premissas.**

- Zero dependências de runtime e Node ≥ 22.18.
- O núcleo continua sem conhecer canais: o ref chega como `data.ref` e a aglutinação depende só de `data.source = "comment"`.
- Toda mudança é retrocompatível com fluxos e clientes existentes.
- Operações destrutivas (limpeza) são seguras por padrão.

**Indicadores.**

| Indicador | v0.3 | v0.4 |
|---|---|---|
| Testes automatizados (`npm test`) | 59 | 73, todos passando |
| Diagnóstico do Studio (navegador) | 22/22 | 22/22 |
| Type-check (`tsc` estrito) | ok | ok |
| Fluxos válidos no catálogo | 4 | 5 |
| Imports de `src/channels` dentro de `src/core` | 0 | 0 |
| Dependências de runtime | 0 | 0 |
