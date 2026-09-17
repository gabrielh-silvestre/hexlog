<!-- Parent: ../AGENTS.md -->
<!-- Generated: 2026-09-17 | Updated: 2026-09-17 -->

# frentes

## Purpose
Os 17 relatórios individuais da pesquisa de libs e padrões do hexlog, um por frente de investigação.

## Key Files
| File | Description |
|---|---|
| `01-mcp-existentes.md` | Servidores MCP de log/auditoria existentes cobrem hash chain, decision log/ADR ou memory, mas nenhum combina hash chain + schemas custom + escrita multi-processo + isolamento de leitura. Veredito: construir, aproveitando ideias específicas de cada candidato. |
| `02-sdk-v2.md` | API real do SDK v2 do MCP: adota `@modelcontextprotocol/server@2.0.0` com `registerTool`/schemas em Zod e transporte `serveStdio`; testes via `InMemoryTransport.createLinkedPair()`; zod 4.6.5 exato satisfaz o peer `^4.2.0` do SDK numa única cópia. |
| `03-jsonl-lock.md` | JSONL append-only com lock multi-processo: lock e append nativos (`mkdir`+token+`mtime`, desenho da POC), dedupe/seq construído reaproveitando o padrão de `appendEvento`; SQLite descartado por decisão do usuário de manter JSONL. |
| `04-hash-chain.md` | Hash chain e JSON canônico: comparação entre função caseira (bug ao hashear `Date`) e a lib `canonicalize` (0 deps, fail-fast); recomendação é adotar a lib. |
| `05-jsonschema-zod.md` | JSON Schema → Zod: validação do evento via `z.fromJSONSchema` nativo (12/12 no probe); gate de validade do schema registrado via Ajv 2020 strict + ajv-formats, porque `fromJSONSchema` sozinho aceita schema com keyword digitada errada. |
| `06-isolamento-claude-code.md` | Isolamento no Claude Code: adota `permissions.deny` com `Read`/`Edit` na forma `//<caminho>/**` mais um hook Bash construído em TS para cobrir `cat`/`jq`/variáveis de ambiente que o deny sozinho não pega; sandbox nativo e forma de distribuição do hook ficam como decisão do usuário. |
| `07-event-sourcing.md` | Event sourcing em TypeScript: nenhuma lib de ES ativa oferece JSONL local com escrita multi-processo e cadeia de hash por evento — todas assumem backend externo. Recomendação: construir o núcleo com o padrão Decider (`decide`/`evolve`) sem lib, como a POC já fazia. |
| `08-hook-instalacao.md` | Hook Bash e instalação idempotente: parser do hook via `shell-quote`; runtime `.ts` direto no Node 24 sem build (depois substituído pelo bundle esbuild, ver ADR); edição de `settings.json` via `jsonc-parser` com checagem de idempotência; escrita atômica nativa (tmp+rename) com backup e `--check`. |
| `09-testes.md` | Stack de testes: jest 30.5.1 + ts-jest 29.4.12 (preset CJS, sem `--experimental-vm-modules`); property-based com fast-check puro; concorrência via fork + barreiras IPC portadas da POC; MCP via `InMemoryTransport` mais um teste stdio real. |
| `10-utilitarios.md` | Utilitários pequenos: resolução XDG nativa em 3 linhas, erro estruturado nativo a partir de `error.issues`, datas nativas normalizadas para UTC `Z`; geração de id de evento fica como decisão de design de quem gera o UUID. |
| `11-rfcs-especificacoes.md` | RFCs e especificações: recomenda modelar erro pela ideia de RFC 9457 combinada com `isError`/`structuredContent`/`outputSchema` do MCP, arquivo em JSON Lines (jsonlines.org), `id` do envelope em UUIDv7 (RFC 9562), e o campo `prova` do Veredito no molde Statement do in-toto. |
| `12-alternativas-lodash.md` | Alternativas enxutas ao lodash (pós-consenso): compara es-toolkit 1.52.0, radashi 12.9.4 e lodash-es 4.18.1 por tamanho/encaixe/manutenção; es-toolkit vence pelo menor bundle tree-shaken, apesar dos 18 MB em disco e de `get`/`keyBy` exigirem `es-toolkit/compat`. |
| `13-logging-estruturado.md` | Logging estruturado enxuto (pós-consenso): recomenda logger nativo de ~15 linhas (zero import, zero deps) em vez de uma lib, por cumprir 100% do contrato com um espião trivial nos testes. |
| `14-ecossistema-zod.md` | Ecossistema do zod (pós-consenso): a frente recomendou adotar `zod-schema-faker@2.1.1` para geração de fixtures, mas o zod 4 nativo já cobre `toJSONSchema`/`treeifyError`/`prettifyError`/`.brand()`; a decisão final (U-3 no ADR) rejeitou `zod-schema-faker` e nenhuma lib do ecossistema foi adotada. |
| `15-busca-logs.md` | Busca nos logs (pós-consenso): recomenda MiniSearch 7.2.0 sobre Fuse.js por melhor P@10 (0,97 × 0,84), mesmo recall e ~124× mais velocidade por consulta em 10k linhas, com 0 deps e suporte dual ESM/CJS. |
| `16-effect.md` | Effect, ganhos e custos (pós-consenso): não adotar no MVP como planejado — o único encaixe (lock) já está resolvido nativo e 4× mais rápido a frio, sem espaço para os ganhos de erro tipado/DI/TestClock se pagarem; reconsiderar só se o hexlog crescer para daemon/HTTP com integrações repetidas. |
| `17-bundle-executavel.md` | Bundle e executável autocontido (pós-consenso): recomenda esbuild 0.28.2 (build de 65 ms, zero config, sem quebras com Ajv/canonicalize/es-toolkit) sobre não empacotar, já que o Node está garantido no ambiente do Claude Code; decisão do usuário adotou o bundle esbuild com cópia instalada. |

## For AI Agents
### Working In This Directory
- Cada relatório aqui é o registro de uma comparação já feita (candidatos, evidência, riscos, decisão recomendada); não reabra a comparação do zero — leia o relatório da frente relevante antes de sugerir trocar a lib ou abordagem.
- A recomendação de uma frente individual (fase inicial ou pós-consenso) não é sempre a decisão final: a síntese em `../hexlog-pesquisa-libs.md` e o ADR 0001 (`../../adr-0001-hexlog-mvp.md`) podem ter revertido a recomendação por decisão explícita do usuário (ex.: frente 14, `zod-schema-faker` recusado por U-3). Confira sempre a tabela "Decisão por componente" antes de citar uma frente como decisão vigente.

### Common Patterns
- Cada relatório segue a mesma estrutura: pergunta(s) respondida(s), candidatos comparados, decisão recomendada, evidência, riscos e armadilhas, perguntas em aberto.

## Dependencies
### Internal
Sustenta a tabela "Decisão por componente" em `../hexlog-pesquisa-libs.md` e, por ela, as escolhas de dependências registradas no ADR 0001 e implementadas em `src/`.

<!-- MANUAL: Any manually added notes below this line are preserved on regeneration -->
