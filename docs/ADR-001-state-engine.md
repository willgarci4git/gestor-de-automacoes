# ADR-001: State Engine do Bot Framework

- **Status:** implementado (versão atual: 0.4.0; novos recursos em `ADR-002-consolidacao.md`)
- **Data:** 2026-09-28
- **Stack:** TypeScript sobre Node.js ≥ 22.18, com zero dependências de runtime

## Contexto

O objetivo é um framework para parametrizar bots de atendimento: pré-atendimento, atendimento por setor, iniciadores de conversa, captura de leads e transbordo, todos baseados no curso Caixa Rápido. O framework precisa:

- funcionar em vários canais (WhatsApp, Webchat, Telegram);
- aguentar falhas de APIs externas;
- ser testável sem acesso à rede.

## Decisões

1. **Interpretador próprio sobre uma DSL JSON declarativa** (e não XState, Step Functions ou código imperativo).
   - Os fluxos são dados, editáveis por quem não programa.
   - As conversas ficam paradas por horas entre mensagens e precisam ser serializadas.
   - Com 10 tipos de nó, o interpretador é pequeno e fácil de auditar.
2. **Efeitos como comandos, gravados numa Transactional Outbox.**
   - O motor é síncrono e determinístico: não faz I/O.
   - Sessão, contato, evento processado e comandos são gravados na mesma transação.
   - Isso elimina os dois casos de inconsistência: "enviou, mas não salvou o estado" e "salvou, mas não enviou".
3. **Idempotência por `eventId`.** Protege contra as reentregas de webhook que a Meta faz.
4. **Concorrência controlada em duas camadas:**
   - `KeyedMutex` serializa os eventos de uma mesma conversa dentro do processo;
   - `rev` otimista resolve conflitos entre processos.
5. **Tokens de espera.** Cada ponto de espera gera um token, e eventos de timer ou integração com token diferente são descartados. Assim, não é preciso cancelar jobs.
6. **Sessão presa à versão do fluxo.** Publicar uma versão nova não quebra conversas em andamento.
7. **Validação estática antes de publicar.** Checa referências, schema, `onError` obrigatório em integrações e loops sem ponto de espera.
8. **Intents globais em dois níveis.**
   - Casamento exato em perguntas de texto livre, para que um nome como "Menu Silva" não seja lido como a intent "menu".
   - Casamento flexível nos demais nós.
   - Intents do fluxo raiz valem dentro de subfluxos.
9. **Fallback global.** Mensagem amigável e transbordo humano para erros de nó, loop guard, tentativas esgotadas sem rota e versão ausente.
10. **Secrets resolvidos só no executor HTTP.** Nunca entram na sessão nem nos logs.
11. **Zero dependências de runtime.**
    - Usa `node:sqlite`, `node:http`, `fetch` nativo e TypeScript nativo do Node.
    - Motivo: menor superfície de ataque na cadeia de suprimentos e deploy trivial.
    - Custo: validação de schema escrita à mão, em vez de zod.

## Recursos do curso sobre o motor

Esta base é a **fonte única** do framework. Sobre o motor, foram implementados:

- tenants parametrizáveis (`tenants/*.json`, com o escopo `{{tenant.*}}`);
- horário comercial com faixas e feriados (`system.inBusinessHours`) e saudação (`system.greeting`);
- o nó `randomizer` (teste A/B com etiqueta e métrica);
- opt-out LGPD;
- disparo ativo e broadcast por etiqueta;
- o canal Instagram (DM + gatilho por comentário com private reply);
- modelos do WhatsApp com router silencioso;
- `Retry-After`;
- lint E003.

Não há nó `goto`: `subflow` e as intents globais cobrem esse papel.

## Consequências

- **Escala:** o `SqliteStorage` atende uma instância. Para escalar horizontalmente, é preciso:
  - implementar `Storage` sobre Postgres;
  - usar uma fila particionada por conversa.

  A interface já está pronta para isso.
- **SQLite:** `node:sqlite` ainda está marcado como experimental no Node 22. O aviso é suprimido nos scripts, e a API usada é mínima.
- **Circuit breaker:** o estado half-open deixa passar requisições concorrentes (versão simplificada).

## Indicadores monitorados

| Indicador | Meta | Onde medir |
|---|---|---|
| Latência do turno do motor (p95) | < 150 ms | `/metrics` → `engine.turn_ms` |
| Respostas duplicadas por reentrega | 0 | `engine.events.duplicate` + teste e2e |
| Fallbacks por motivo | Tendência de queda | `engine.fallback.*` |
| Falhas de integração / circuito aberto | Alertar se > 5% | `integration.failed` |
| Dead letters | 0 | `outbox.dead` e `/admin/dead-letters` |
| Acoplamento núcleo → canais | 0 imports | `src/core` não importa `src/channels` |
