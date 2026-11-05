# ADR 0015: Telemetria opcional por OpenTelemetry

**Status:** Aceito

**Data:** 2026-11-05

**Deciders:** Gabriel Baldino (aceite do ADR)

---

## Context

O servidor expõe 12 tools por um único `execute`, que só deixa o log `tool` (`name`, `ms` e `code?`) no stderr. O dono não consegue ranquear o uso das tools, medir erro por `code` nem achar uma chamada lenta. O Claude Code já usa `OTEL_EXPORTER_OTLP_ENDPOINT` para a própria telemetria e os processos MCP a herdam, então a telemetria do hexlog precisa de chave própria.

Restrições que moldam a decisão:

- As 12 tools e o formato em disco não mudam (`ferramentas-fixas`, `log-so-acrescenta`): a telemetria só observa.
- A privacidade do log `tool` vale como está ([invariantes.md](invariantes.md), seção Tools): o nome de `project` e `process` só pode aparecer onde o dono escolhe mandar, e nunca o conteúdo da entrada.
- As camadas só dependem das de baixo (`camadas-com-direcao`), e o SDK do OpenTelemetry é infraestrutura que `adapters/` isolaria.
- Nenhum ADR 0007 a 0009 trata de telemetria; só `docs/pesquisa/frentes/16-effect.md` cita o termo (`troca-confere-adrs`).

## Decision

1. **Chave própria e exporters configurados à mão.** Telemetria opcional por OTLP/HTTP, ligada só por `HEXLOG_OTEL_ENDPOINT` (e `HEXLOG_OTEL_HEADERS` para cabeçalhos). A variável genérica `OTEL_*` nunca liga nem configura: a construção dos exporters ocorre com `OTEL_*` fora de `process.env`, com `url`, `headers` e temporalidade cumulativa explícitos. Sem a chave, o adaptador é um `noopTelemetry` e nada de rede nem de encerramento é instalado.
2. **Um span por chamada e três métricas.** O span `tool <nome>` e as métricas `hexlog.tool.calls`, `hexlog.tool.errors` e `hexlog.tool.duration`, via `TracerProvider` e `MeterProvider` sem `register()`, sem detectores de recurso e sem `console`. O detalhe dos atributos está em [telemetria.md](../telemetria.md).
3. **Contrato e implementação separados.** `Telemetry` (com `CallProbe` e `LoadReport`) mora em `src/ports.ts` (só tipos, porque é a porta que `adapters/` implementa); a implementação e o `noopTelemetry` ficam em `src/adapters/telemetry/`; o gancho é `mcp/kernel.ts#execute`; a ligação é `compose.ts#composeTelemetry` e `compose.ts#composeShutdown`.
4. **Regra de capacidades transversais em `fronteiras.md`.** Logger e telemetria formam uma lista fechada: o logger e a telemetria valem para `commands/`, `queries/`, `mcp/` e `adapters/`, para que o dono possa instrumentar processo, dados e métricas conforme o projeto evolui (decisão do dono de 2026-11-05); `domain/` e `shared/` seguem puros e ficam de fora. O contrato mora abaixo de quem o usa, a implementação num lugar só e injetada, e nenhuma camada importa a implementação. De `ports.ts`, `mcp/` importa só os tipos `Telemetry` e `CallProbe`, e de `shared/` só `logger.ts`, travado por `eslint.boundaries.js`. `@opentelemetry/*` fica restrito a `adapters/telemetry/` nas camadas com bloco de `eslint.boundaries.js`; na raiz de `src/` (`compose.ts`, `server.ts`), em `scripts/` e em `hook/` é convenção. A regra nova estreita `services-direction` sem reescrevê-la e não toca `mcp-calls-services-only` nem `adapters-implement-ports-only`: a trava do SDK em `adapters/` vem de `capabilities-lint`.
5. **Processo e tamanho do log.** `hexlog.log.lines` (contagem de linhas, sem interpretar registros) e `hexlog.log.bytes`, do processo alvo; soma dos distintos quando não há alvo e há mais de um. O caminho é `AsyncLocalStorage` mais a opção `onLoad` do `createProcessStore`, que só existe com a telemetria ligada.
6. **Superfícies de privacidade.** Com o endpoint definido, só o span leva `project` e `process` em claro; o log `tool`, `tool-over-cap`, `telemetry-*` e as métricas não os levam (o `batch-replayed` existente continua com `project` e `process`). `details[].code` vai só ao span, em `hexlog.error.detail_codes`, **só como array** (até 20 códigos distintos, com `hexlog.error.detail_codes_omitted` acima disso); não há escalar. O conteúdo da entrada, o `path` e a `message` não vão a superfície nenhuma, e o span em erro leva `setStatus(ERROR)` sem mensagem e sem `recordException`. A consulta por elemento do array está em [telemetria.md](../telemetria.md). A regra mora em `invariantes.md` como `telemetry-surfaces`, e `tool-log-fields` não é emendada.
7. **Falha do backend.** Probe no boot por `HEAD` com `fetch` global e prazo de 1.000 ms; qualquer resposta HTTP (404 e 405 inclusive) conta como alcançável. O boot não espera o probe. Aviso `telemetry-degraded` por chamada enquanto o probe falhou ou o último envio de qualquer sinal falhou, sem espera de rede. Chamada feita com o probe pendente não avisa, então 1.000 ms é o limite da janela sem aviso; com 401 ou 403 o aviso só aparece depois do primeiro lote de envio.
8. **Encerramento.** `end` e `close` do stdin como gatilho, `beforeExit` de reserva e `SIGTERM` e `SIGINT` (143 e 130). Orçamento do EOF: fechar o transporte (250 ms) mais `shutdown` (1.500 ms, dentro dos quais as chamadas em voo esperam até 500 ms), 1.750 ms no pior caso, e `proc.exit()`; sai antes do `SIGTERM` que o cliente de referência manda 2.000 ms depois do EOF. O `shutdown` dos providers faz o envio final, então não há `forceFlush` separado. Um sinal durante um encerramento já pendente sai na hora. `bindShutdown` fica em `adapters/telemetry/` como helper de ciclo de vida que não implementa porta, como `adapters/fs/io.ts` e `atomic.ts`.
9. **Tensão declarada no encerramento.** Com a telemetria ligada, uma tool que não termina dentro do drain depois do EOF pode não ser gravada, e o `proc.exit()` mata a tool em voo; desligada, o processo sai quando o transporte fecha. Isso contraria a letra de "a resposta da tool nunca muda por causa da telemetria" quando a tool em voo é um `register`: ele deixa de gravar. A escrita é síncrona e o lock órfão é roubado por pid ([invariantes.md](invariantes.md), seção Log e cadeia). A resposta da tool em voo se perde com a telemetria desligada também, porque o transporte fecha no EOF.
10. **O instalador preserva o `env`** da entrada MCP ao refazê-la, para que a atualização não apague a telemetria; imprime só os nomes das chaves ([instalacao-e-hooks.md](instalacao-e-hooks.md)).
11. **Política de dependências.** Sete pacotes diretos em `^X.Y.Z`, uma versão de cada no lock; o conjunto `@opentelemetry/*` sobe só em PR agrupado próprio (`opentelemetry`), fora do `minor-and-patch` e do auto-merge, de merge manual, porque os exporters pinam versões exatas. Transitivos fora dos sete: `otlp-exporter-base`, `otlp-transformer`, `sdk-logs` e `semantic-conventions`; o caso do lock em `test/package.spec.ts` cobre os 11 pacotes.

## Drivers

Premissas de [estrategia.md](estrategia.md): `audita-decisoes-de-agentes` e `melhoria-continua` (medir o uso para melhorar o processo), `camadas-com-direcao` (contrato abaixo de quem o usa, SDK só em `adapters/telemetry/`, regra de capacidades escrita e aprovada), `ferramentas-fixas` (nenhuma tool nova), `log-so-acrescenta` (nada em `.v1/`), `entrada-do-agente-contida` (aviso só com valores enumerados, nunca mensagem de exceção nem endpoint), `libs-em-faixa-caret` e `troca-confere-adrs`. Nenhuma premissa é contradita, e `estrategia.md` não é editado. Mais três critérios desta decisão: fronteiras e privacidade com a regra escrita, ponto único com processo e tamanho, e custo previsível com saída em tempo limitado e configuração não capturada.

## Alternatives considered

1. Contrato em `shared/`: rejeitada, tocaria também `services-direction` e o mapa de camadas.
2. Middleware em `server.ts`: rejeitada, deixaria a decisão de observar fora do ponto único das 12 tools.
3. SDK direto no kernel: rejeitada, o SDK ficaria acessível a `mcp/` e a regra de capacidades perderia o sentido.
4. `sdk-node`: rejeitada, registra provedores globais e lê `OTEL_*`.
5. Carga preguiçosa do SDK por `import()`: rejeitada, o lint barra `import()` nas camadas com bloco e a economia (cerca de 12 ms) não pagou a exceção.
6. `createOtlpHttpExportDelegate` no lugar do scrub de `OTEL_*`: rejeitada, depende de API interna do exportador.
7. Arquivo próprio de telemetria no disco: rejeitada, criaria formato em disco novo e fora de `.v1/`.
8. Nome do processo como rótulo de métrica: rejeitada, cardinalidade e privacidade; o nome só vai ao span.
9. Tamanho do log devolvido pelos serviços: rejeitada, mudaria contrato público.
10. Contagem de registros em vez de linhas: rejeitada, exigiria interpretar o log inteiro.
11. Exceção por recurso em vez da regra de capacidades: rejeitada, cada recurso novo reabriria a fronteira.
12. `forceFlush` mais `shutdown`: rejeitada, o envio cumulativo repetido gasta uma ida e volta do orçamento do EOF sem ganho.
13. Segurar o `serveStdio` até o probe resolver: rejeitada, custaria de 300 a 500 ms no boot; o estado de envio cobre o caso a partir do primeiro lote.
14. Contrato estrutural em `mcp/kernel.ts`: rejeitada, o kernel passaria a declarar um tipo que o adaptador implementa.
15. "Logs primeiro" (`detailCodes`, `lines` e `bytes` no log `tool`, lidos por um coletor, sem SDK): rejeitada, a decisão do dono é OTLP como destino único e o nome do processo só no span.
16. Exporters protobuf: contingência, se o backend pedir.
17. `detail_codes` como array mais um escalar do desfecho: rejeitada, o array basta e a consulta por elemento está documentada.

## Why chosen

É a única opção que cobre as 12 tools por um ponto, entrega processo e tamanho sem mudar contrato público, toca o mínimo de regras de fronteira, mantém cada peça na camada que o mapa de camadas lhe dá, mantém o SDK atrás de `adapters/telemetry/` e de `compose.ts` e não herda configuração alheia.

## Consequences

- O import estático do SDK pesa em todo processo que compõe: o bundle do servidor cresce 237.021 bytes (de 1.910.761 para 2.147.782, teto de 300 KB) e o boot custa cerca de 12 ms, mesmo desligada, também nos scripts que importam `compose.ts`. O bundle não contém "Dynamic require of" (repetir a conferência quando o grupo `@opentelemetry/*` subir de versão).
- `ToolDeps` ganha o campo `telemetry`, e a opção `onLoad` do `createProcessStore` é nova.
- Nenhuma regra crítica existente tem o texto reescrito: `tool-log-fields`, `adapters-implement-ports-only` e `mcp-calls-services-only` ficam como estão, e `services-direction` é estreitada pela regra nova `capabilities-scope`. A regra nova `telemetry-surfaces` entra em `invariantes.md` e a de capacidades transversais em `fronteiras.md` (cinco regras, em nove bullets de até 400 caracteres). Quatro regras comuns de [qualidade-e-testes.md](qualidade-e-testes.md) são emendadas e uma regra nova entra em `instalacao-e-hooks.md`.
- `src/` passa a usar `fetch` global (o teste de módulo de rede não muda).
- O Dependabot passa a ter um grupo de merge manual, e o security update de um pacote do OpenTelemetry também espera merge manual.
- O `claude mcp get hexlog` mostra o `env` em claro: um segredo em `HEXLOG_OTEL_HEADERS` fica legível no `~/.claude.json`.
- Limites aceitos: perda de telemetria em `kill -9`, atraso do estado de envio (uma falha de um só sinal fica mascarada pelo sucesso do outro), lote final perdido com backend lento e timer atrasado por trabalho síncrono, como a contagem de linhas de um log grande (de 6 a 15 ms por processo de 64 MiB).

## Follow-ups

Componente de decisão sobre as tools (adiado); resultado do `evaluate_gate`, sequência de chamadas com repetição por sessão, telemetria de hooks, scripts de fluxo, cadeira do dono e instalador, e cache da busca; reprobe periódico do backend; convenções semânticas de MCP nos nomes dos atributos; exporters protobuf se o backend pedir.

Collector local do OpenTelemetry na frente do backend, anotado como opção e fora desta implementação (decisão do dono de 2026-11-05). O hexlog manda para `localhost` e o coletor faz lote, retry e fila em disco (`file_storage`, distribuição `otelcol-contrib`), o que reduz a perda de telemetria no encerramento do processo e tira a credencial do backend do `env` do `~/.claude.json`. O custo é um processo e um arquivo de configuração que o dono mantém. Entra em [telemetria.md](../telemetria.md) como seção opcional com um exemplo de configuração, sem teste com coletor real.
