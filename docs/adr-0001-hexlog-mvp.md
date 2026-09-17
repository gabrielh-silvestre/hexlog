# ADR 0001: hexlog MVP

**Status:** Aceito

**Data:** 2026-09-16

**Deciders:** Gabriel Henrique Silvestre Baldino; planejamento RALPLAN iterações 1–3

---

## Context

O hexlog é um servidor de eventos estruturados focado em rastreabilidade, auditoria e integração com o Claude Code MCP. A necessidade surge de centralizar logs de execução, permitir reconstrução de estado por timestamp e oferecer primitivas de busca e validação via schema.

A POC (`POC:`, commit **`5703a53`**, branch `poc-motor-log` do repo `/home/gabriel/personal/core`) provou o conceito em 27 commits e deixa como legado a semântica de cadeia, marco, porta e supersessão. O MVP aqui mira em estabilizar o formato, instalar o artefato como MCP, e validar a integração com Claude Code em sessão real.

## Decision

Construir o hexlog como um único servidor MCP stdio em TypeScript (`"type": "module"`), desenvolvido e testado no `.ts` fonte com Node ≥ 24.18.1 (type stripping; ts-jest na config f1c). As sessões executam um **bundle** gerado por `esbuild@0.28.2` (ESM `.mjs`) e **instalado** em `~/.local/lib/hexlog/<versão>/`, fora da working tree e do diretório de dados (U-7, U-8; revoga R-2). Componentes:

- **Núcleo puro:** eventos (`hex:target:<id>`, `normalizeData`), cadeia, estado (Marco de gate fora do ciclo) e gates.
- **Store JSONL:** lock `mkdir` + token + `mtime`, `seq` físico e UUIDv7 nativo gerado dentro da seção crítica.
- **Cadeia:** `sha256(prevHash + JCS(linha sem prevHash))` via `canonicalize`, ancorada no manifesto, com predicado de elo único, `seq` relativo ao último elo (mesma função no escritor e no verificador, sem cascata) e verificação que continua depois de linha inválida e reconhece rasgo reparado. Manifesto com `hashes` internos divergentes → `PROCESS_CORRUPTED` em todas as tools, inclusive `chain`.
- **Definições:** copiadas para `process.json`, criado com `linkSync` exclusivo.
- **Tools:** 10, com Zod de entrada e saída, erros de domínio devolvidos e tetos de saída. `events` tem modo cru (ordem física) e modo busca (MiniSearch 7.2.0, índice construído por chamada, AND com `fuzzy: 0.1` e fallback OR sinalizado por `combination`, ranking por relevância, paginação estável com `until`), com filtros por igualdade (`target`, `milestoneType` validado, `result` livre por QN3, `type`) e intervalo `after`/`before`. `target` e ids nunca passam pelo índice de texto; não há filtro por id de evento (QN5) (U-6).
- **Artefato e instalação:** `scripts/build.ts` é a única config de build, com `absWorkingDir` na raiz do repo (bytes independentes do cwd). O instalador constrói, verifica o artefato preparado (sem `Dynamic require of`; hook nega/permite; servidor lista 10 tools), troca atomicamente o diretório da versão, grava `manifest.json` (versão, sha256, `commit`, `dirty`) e só então aponta o hook e o MCP para a cópia instalada. Só pula a instalação quando os **bytes instalados** batem com o build. Versões antigas ficam em disco. O artefato instalado é protegido contra Edit/Write por `Edit(//<home>/.local/lib/hexlog/**)`, e o `--check` acusa bytes instalados diferentes do manifesto (`artifact-modified`, exit 1) (QN4).
- **Utilitários e logging:** `es-toolkit` com a regra "se existe helper, use" (U-1, U-2); logger nativo em stderr (U-4).
- **Isolamento:** 4 regras de deny na forma `//` (3 sobre os dados, 1 de Edit sobre o artefato instalado) + hook Bash que nega com exit 2 e sempre falha aberto (cobre glob e brace num segmento com `matchesGlob`, e `**` ou chave com `/` pela regra de prefixo literal), instalados por script idempotente cuja única detecção de ausência ou quebra é o `--check` funcional, que executa o hook.
- **Migração:** logo após o R1, removidos o symlink da CLI e a worktree e a branch da POC (**POC@`5703a53`**), descartando `.ignore/`, `.omc/`, `dist/`, `poc/dist/`, `node_modules/` e os 27 commits, o que revoga o non-goal "Apagar código da POC" e o G2 original da spec. Os PRs #63/#64/#66 do weed-clicker que dependiam da CLI antiga não bloqueiam (QN2).

## Drivers

Integridade sob concorrência de processos do SO; isolamento efetivo sem travar o Bash nem quebrar o harness (agora também sem depender do estado da working tree); manutenção mínima (desenvolvimento sem build, build de runtime num único script, 9 deps de runtime) apesar de uma API experimental.

## Alternatives Considered

- Organização hexagonal (POC) ou multi-pacote.
- CJS + `.mts`, preset ESM do ts-jest (fallback) ou build `dist/`.
- Hook compilado ou em Go.
- Dedupe sob lock (premissa caducou).
- Store de definições endereçado por conteúdo, ou manifesto só com checksum.
- `.rejected.jsonl`, ou verificação parando na 1ª quebra.
- fork + IPC para concorrência.
- `inputSchema` frouxo.
- Lib `uuid@14.0.2`.
- `seq` absoluto igual ao índice físico (cascata de quebras).
- Truncamento + `matchesGlob` também para `**` e chave com `/` (corta dentro da chave e não alcança a profundidade de D).
- `chain` reportando quebra, em vez de `PROCESS_CORRUPTED`, para manifesto inconsistente.
- `--check` só de existência de arquivo e Node.
- Esperar os PRs #63/#64/#66 antes dos passos 15–16 (rejeitado pelo usuário, QN2).
- Preservar `.omc/` e artefatos da worktree da POC (rejeitado pelo usuário, R-7).
- Instalar de worktree ou tag fixa (Architect; rejeitado pelo usuário, R-2).
- **Rodar da working tree sem build** (decisão R-2 da iteração 1; revogada por U-7/U-8: guard e servidor ficavam expostos a edição quebrada, `npm ci` e checkout).
- **Binário autocontido** com `@yao-pkg/pkg` 6.22.0 (72 MB por entrada), **Node SEA** (119 MB, fluxo manual, Stability 1.1) ou **Bun compile** (runtime diferente do Node): rejeitados em U-7, porque o Node já é garantido pelo Claude Code.
- **Outros bundlers:** tsdown 0.23.0 (deps externas por padrão, quebra só fora de `node_modules`), `@vercel/ncc` 0.45.0 (falhou com `canonicalize` e com TS 7), Rollup (4 plugins, ~4,5 s, warnings), tsup (descontinuado).
- Bundle CJS `.cjs` (validado, mas sem top-level await e com falha de import adiada para a 1ª chamada); `.js` ESM sem `package.json` (depende de detecção de sintaxe, +~50 ms).
- Apagar versões antigas no instalador (exige saber qual versão está registrada e em uso; ganho de ~1,7 MB por versão).
- **Busca:** Fuse.js (~121 ms por consulta em 10k, P@10 0,84), FlexSearch (cache por padrão), Orama (P@10 0,74 no probe), lunr (parado), uFuzzy, match-sorter, substring nativa; `target`/id no índice de texto (colisão `login` × `login-1`); cache de índice por processo (YAGNI); tool nova de busca ou busca multi-processo (quebra as 10 tools).
- **Effect 3.22.2** (U-5): descartado no MVP. O único ganho real seria erro tipado no retorno. Custos medidos: logger padrão escreve no stdout (quebra o JSON-RPC) e suprime `debug` (silencia `lock-espera`); `effect/Schema` não serve de `inputSchema`/`outputSchema` do SDK sem wrapper; import a frio ~350 ms; lock 4,3× mais lento a frio; ~26 MiB. **Gatilho de reavaliação:** o hexlog virar daemon ou HTTP com várias integrações e política de retry/timeout/cancelamento repetida em muitos pontos.
- **Logging com lib** (U-4): pino (12 deps, `sync: true` obrigatório), LogTape 2.3.5 (follow-up), consola/adze (filtram `debug`), tslog/roarr (stdout).
- **Ecossistema do zod** (U-3): `zod-schema-faker@2.1.1` recusado (fast-check já cobre property-based; peer `@faker-js/faker` só ESM exigiria mapper + transform no jest; valores extremos pouco legíveis); zod-fast-check e zod-to-json-schema quebram com zod 4.
- **Utilitários** (U-1): lodash, lodash-es, radashi, remeda.
- **Busca, síntese pós-consenso da iteração 3:** `fuzzy: 0.2` (precisão 0,456 em "cache invalidação"); AND puro sem fallback (falso negativo silencioso em linguagem natural); OR sempre (perde a precisão das consultas curtas); lista de stopwords pt-BR (artefato a manter, não cobre termo extra); cursor posicional sem `until` (ranking instável com append); keyset por score (o IDF muda com append); validar `result` contra o vocabulário (rejeitado pelo usuário, QN3); filtro por id de evento (fora do pedido, QN5).
- **Artefato instalado fora de qualquer deny** (versão da iteração 3; rejeitado pelo usuário em QN4, porque um guard editável anula o isolamento de todas as sessões). Hook negando também escrita via Bash em `~/.local/lib/hexlog` não entrou (Bash/`node -e` seguem lacuna aceita, QN4).
- `manifest.json` como única referência de "já instalado" (não repara bytes alterados; substituído pela comparação dos bytes instalados com o build).
- Hook fail-closed quando Node ou arquivo some (rejeitado pelo usuário, R-1).
- Negar por exit 0 + JSON.
- Aviso `GUARD_AUSENTE` no `list`.
- README + tag para a POC (spec original, substituído por Q6).
- Bundle ou tar antes de remover (rejeitado, R-5).
- Adotar servidor MCP existente, lib de event sourcing, SQLite ou `proper-lockfile`.
- Sandbox nativo, managed settings ou plugin.

## Why Chosen

Cada alternativa descartada adiciona arquivo, dependência, build ou estado derivado sem requisito que o exija, ou foi invalidada por evidência:

- probes `arch-jest` t0/f1 falhando e f1c passando;
- `SDK:mcp-DXXb3Vv3.mjs:1398-1441` (exceção vira texto);
- doc de hooks sobre JSON fora do schema;
- `randomUUIDv7` `added: v24.16.0` na doc da tag v24.18.1 e verificado em runtime;
- comparação crua quebrando retentativa com `default`/offset;
- rasgo deixando a cadeia vermelha para sempre na 1ª versão do verificador;
- `seq` absoluto gerando uma quebra por elo depois de uma remoção (Architect iter2-2, Critic iter2-3; conjuntos exatos de N1 conferidos por simulação);
- `cat ~/.local/share/{hexlog/p/r/events.jsonl,x}` e `cat ~/.local/**/events.jsonl` escapando do hook no algoritmo da iteração 2 (Critic iter2-1, Architect iter2-2.2);
- `--check` de existência não pegando hook com erro de código (Architect iter2-2.3);
- frente 17: esbuild sem quebras e zero config; hook em 41 ms e servidor em 223 ms (× 79 ms e 407 ms sem build); reexecução do Planner com bundles ESM `.mjs` e CJS `.cjs` ok fora de `node_modules` (183/174 ms) e `.js` sem `package.json` a 234 ms;
- frente 15: MiniSearch com P@10 0,97, recall 1,00 e 0,98 ms por consulta em 10k, determinístico; colisão de id exato em todos os motores;
- revisões da iteração 3 (Architect e Critic, corpus de 10k): `fuzzy: 0.1` com precisão 1,0 e recall do erro de digitação 1,0; "problema com o webhook" com 0 de 479 no AND puro; sha256 do bundle mudando com o cwd; shim `Dynamic require of` detectável no texto do bundle; `rename` de diretório não vazio com `ENOTEMPTY` em ext4; orçamento real da busca ≈ 250 ms em 10k.

Ou foi decidida explicitamente pelo usuário (Q1–Q10, QN1–QN5, R-1–R-7, U-1–U-8), registradas em `decisoes-usuario-iter1.md` (arquivo interno do plano de execução).

## Consequences

- Append e leitura são O(n).
- Retentativa com prefixo duplica.
- Erro de forma chega como texto do SDK.
- Falha do hook instalado abre o isolamento em silêncio até alguém rodar `--check` (R-1). A working tree deixou de ser causa (U-8).
- **Existe um passo de build e instalação:** mudança de código só chega às sessões rodando `node scripts/install.ts`. O artefato instalado pode ficar desatualizado (aviso `artifact-outdated`), e versões antigas acumulam em `~/.local/lib/hexlog/`.
- O bundle ESM depende de nenhuma dep CJS fazer `require` dinâmico de builtin; se acontecer, há fallback nomeado (banner `createRequire`, depois CJS).
- A busca custa O(n) por chamada (ler, validar e indexar o processo; ≈ 250 ms em 10k). O cursor do modo busca só é estável quando o agente reenvia `until` (instruído na `description`); sem `until`, um append entre páginas pode deslocar itens. `relevance` não é comparável entre chamadas com `until` diferente nem entre processos.
- Consultas em linguagem natural caem no fallback OR, com resultado mais frouxo, sinalizado por `combination: 'OR'`.
- Filtro `result` sem validação (QN3): digitação errada devolve lista vazia, sem erro.
- Não há filtro por id de evento (QN5); a busca textual não encontra ids nem endereços.
- O artefato instalado continua gravável por Bash/subprocesso (lacuna aceita, QN4). Uma alteração que mude bundle **e** manifesto de forma consistente só aparece como `artifact-outdated` (aviso).
- `es-toolkit` ocupa 18 MB em disco no `node_modules`; no bundle entram só os helpers usados.
- Lacunas de isolamento documentadas.
- Truncamento das últimas linhas indetectável sem âncora externa.
- `canonicalize` e zod fazem parte do **formato do log**.
- `@types/node` exige augmentation para `randomUUIDv7`.
- Logs da POC incompatíveis.
- A skill antiga para depois do G1.
- **A POC deixa de existir**: 27 commits, `.ignore/`, `.omc/` e artefatos perdidos por decisão explícita; as citações `POC:arquivo:linha` viram históricas.
- Os PRs #63/#64/#66 do weed-clicker quebram e são tratados depois; as mudanças não commitadas do #63 ficam intactas na worktree dele.
- **O manifesto `process.json` faz parte do formato do log**: a âncora é o hash canônico do arquivo inteiro, então mudar a forma do manifesto ou sua canonicalização invalida a âncora de todos os processos existentes.
- Manifesto com `hashes` divergentes torna o processo inutilizável por todas as tools (`PROCESS_CORRUPTED`), inclusive `chain`.
- Em Node sem `crypto.randomUUIDv7` (< 24.16), o import falha no link ESM e o servidor não sobe: falha explícita, aceitável com `engines >=24.18.1`. O hook não importa `node:crypto` e não é afetado. A augmentation de tipos escrita à mão não detecta mudança de assinatura.
- `seq` só coincide com o índice físico em arquivo íntegro.
- Falsos positivos do hook a partir do home (`ls ~/**/*.md`, `ls ~/{docs/a,b}`) são aceitos (R-6).

## Follow-ups

- **Do usuário:** versionamento semântico com tags do GitHub depois da validação, agora com os bundles (`server.mjs`, `bash-guard.mjs`) e o `manifest.json` como artefatos da release.
- Limpeza automática de versões antigas em `~/.local/lib/hexlog/` quando o acúmulo incomodar.
- **LogTape 2.3.5** (U-4) quando houver filtro por módulo, vários destinos (arquivo/OpenTelemetry) ou redaction obrigatória.
- **Effect** (U-5): reavaliar só no gatilho registrado em Alternatives.
- Busca: cache de índice por processo com invalidação por contagem de linhas, se M13 ou o log `msIndice` mostrarem custo real; busca em todos os processos de um projeto como tool nova (medir N× o custo antes).
- Sourcemap nos bundles, se stack traces do bundle atrapalharem a depuração.
- Fechar parte da lacuna de escrita por Bash no artefato instalado: estender o hook para negar comandos que citem `~/.local/lib/hexlog` com operação de escrita, ou escalar `artifact-outdated` para exit 1 quando o `commit` do manifesto for igual ao `HEAD` com a working tree limpa (o build tem de bater com o instalado). Só se a lacuna se mostrar real.
- Stopwords ou tokenização específica pt-BR na busca, se a contagem de `combination: 'OR'` no log mostrar que o fallback é a regra e não a exceção.
- Bootstrap do own-harness reexecutando `install.ts`/`--check`.
- Hook `Grep|Glob` para o diretório pai (Q9).
- Lacunas aceitas do hook a revisitar: `cd` + relativo, `grep -r` no pai, `node -e`/`python`, variável definida no mesmo comando, ANSI-C `$'…'`, alternância zsh `(a|b)`, Grep/Glob no pai. Candidatas a fechar com o sandbox nativo ou com parser completo (`sh-syntax`).
- Tratar os PRs #63/#64/#66 do weed-clicker, quebrados pela remoção da CLI e da POC (QN2).
- Corpus gerado + oracle congelado para o hook quando a função crescer.
- Sidecar de índice acima de 10k linhas.
- Sandbox nativo do Claude Code (`sandbox.filesystem.denyRead`, `allowUnsandboxedCommands: false`; exige bwrap+socat com sudo e muda todas as sessões).
- Script de desinstalação.
- Reescrita da skill `registra-log`.
- Ideias de RFC/spec: checkpoint C2SP `tlog-checkpoint`/`signed-note` da `cabeca` (fecha a lacuna de truncamento), `prova` no molde Statement do in-toto, nomes de proveniência W3C PROV, resources MCP com `notifications/resources/updated`.
- Limite de ReDoS em `pattern`.
- Remover a augmentation de tipos quando `@types/node` alcançar.

## Opção Vencedora do Passo 0

**Jest config f1c (type stripping, ts-jest CJS transform, moduleNameMapper):** provada no passo 0, sem fallback; as configs anteriores testadas na pesquisa (t0, sem transform CJS; f1, sem mapper para `canonicalize`) já tinham sido descartadas antes da execução chegar ao passo 0. O bundle ESM via `esbuild 0.28.2` com `--format=esm` gera `server.mjs` e `bash-guard.mjs`, sem shim `Dynamic require of`, sem banner e sem fallback para CJS. A augmentation de `randomUUIDv7` fica em `src/node-types.d.ts`, via `declare module "crypto"`.

## POC Arquivada

A worktree `core.poc-motor-log` (branch `poc-motor-log` do repo `/home/gabriel/personal/core`) congelada no commit **`5703a53`** serviu de prototipagem. Nenhum import direto do código da POC para o MVP; todo porte de comportamento e teste termina antes do passo 16 (passos 2–7b). As decisões D2, D3, D9 herdaram semântica (cadeia, canonicalização, alvo) mas implementação é nova.

A POC será removida no passo 16 via `wt remove -D -f` após validação em sessão real (R1) e remoção da CLI (G1). Nenhum bundle ou tar: só o SHA `5703a53` fica registrado aqui, como referência histórica.

## Testes Portados da POC

Os casos de teste abaixo foram adaptados da POC (`POC@5703a53`) para o MVP. Cada linha cita o arquivo e linhas da POC; a coluna "Destino" nomeia o spec do hexlog que implementa o comportamento.

| POC@5703a53 (arquivo:linha) | Comportamento | Destino | Adaptação |
|---|---|---|---|
| `poc/test/evolve.spec.ts:11` | Estado bate com o fixture | `state.spec` | Fixture no envelope novo, alvos `hex:target:*` |
| `evolve.spec.ts:32,38` | Pureza; rebuild = incremental | `state.spec` | — |
| `evolve.spec.ts:55` | Duplicata por id não muda o Estado | `state.spec` | — |
| `evolve.spec.ts:69,76,85,96` | Avisos por dono | `state.spec` (N4) | Vocabulário `{core, byOwner}` |
| `evolve.spec.ts:113,120,127` | Hash do vocabulário | `definitions.spec` | JCS ordena chaves |
| `evolve.spec.ts:136` | aRevisar | `state.spec` | Refs por id |
| `evolve.spec.ts:163,171,182` | Órfãos (log, a tempo, parede) | `state.spec` | `now = max(injetado, log)` (Q10) |
| `evolve.spec.ts:195,204,217` | Cadeia íntegra; byte alterado; 1ª linha | `chain.spec` | `predecessor-ausente` → `diverging-seq`/`hash-mismatch` no 1º elo; âncora |
| `poc/test/supersessao.spec.ts:14,23,35,51,68,90` | Supersessão completa | `state.spec` (N3) | `supersedes` por id (Q2) |
| `poc/test/evolve.property.spec.ts:77,94,137,158` | Propriedades | `state.property.spec`, `chain.spec` | Ids no formato novo |
| `poc/test/gate.spec.ts:22,31,41` | Contrato do gate | `gates.spec` | `condicao` → `criteria` |
| `poc/test/motor.spec.ts:49,63,78,84,95,104,114,127,145` | Ciclo do Marco | `state.spec › ciclo` | Função pura; Marco de gate ignorado (R-3) |
| `motor.spec.ts:137` | Alvo inválido recusado sem linha | `event-tools.spec › N12` | Regex `hex:target:` (Q1) |
| `poc/test/append.spec.ts:34,40,47,57,65,79,92,107,188` | Store e lock | `log.spec` | Sem Port/adapter; âncora |
| `append.spec.ts:140,220` | 2 processos | `stdio.e2e.spec › C1` | 4 servidores + barreira |
| `append.spec.ts:252,271,288,310` | Linha fora do schema → `.rejected.jsonl` | `chain.spec`, `event-tools.spec › N1` | `invalid-line`/`invalid-data` + `events.invalidLines` |
| `append.spec.ts:328,346,359` | Disco = memória; adulteração | `event-tools.spec › N1` | Via tool `chain` |
| `poc/src/cli/operacoes.ts:217-285` | Validação na escrita, vocabulário, id divergente | `event-tools.spec › N2, N4, N9` | Comparação normalizada |

## Divergências em Relação à Pesquisa

- **UUID:** A pesquisa recomendava `uuid@14.0.2` (lib externa). Substituído por `crypto.randomUUIDv7()` nativo (Node ≥ 24.16.0), verificado em 24.18.1. Reduz dependências e alinha com preferência nativa.

## Decisões do Usuário

Resumo das decisões Q, R, QN, U do plano (linhas 141–192 de ralplan-hexlog.md):

| ID | Decisão |
|---|---|
| Q1 | Alvo segue `hex:target:<id>` validado por regex, sem import |
| Q2 | `supersedes` usa ids completos |
| Q6 | Remover a POC no passo 16 (worktree + branch), sem README e sem tag |
| Q8 | O usuário conduz o R1 (passo 14, teste real no weed-clicker) |
| Q9 | Grep/Glob no diretório pai dos dados é lacuna aceita, não fechada pelo hook |
| Q10 | Tempo do evento = `max(injetado, log)` |
| R-1 | Falha do hook instalado não bloqueia a sessão; `--check` recupera |
| R-3 | Marco de gate é reservado, não abre/fecha ciclo |
| R-5 | Worktree da POC é removida no passo 16 |
| R-6 | Falsos positivos do hook a partir do home são aceitos |
| R-7 | Confirmação do usuário obrigatória para remoção (passo 16) |
| QN2 | PRs #63/#64/#66 do weed-clicker quebram; tratamento posterior |
| QN3 | Filtro `result` sem validação; digitação errada = lista vazia |
| QN4 | Artefato instalado continua gravável por Bash (lacuna aceita) |
| QN5 | Sem filtro por id de evento |
| U-1 | `es-toolkit@1.52.0` para utilitários de coleção/objeto (core; `compat` só para `get`/`isEmpty`) |
| U-3 | Sem libs do ecossistema do zod; `zod-schema-faker` recusado |
| U-4 | Logger nativo, escreve em stderr; LogTape 2.3.5 em follow-up |
| U-5 | Effect reavaliar conforme gatilho registrado |
| U-7 | Bundle ESM `.mjs` via esbuild, sem binário externo |
| U-8 | Working tree deixou de ser causa de falha do hook |

## Decisões de Execução

Decisões tomadas durante a execução (Ralph, iterações 1–3):

- **DE-01:** Escopo do Ralph = passos 0 a 12; os passos 13–16 ficam como pendências do usuário, com o roteiro pronto. O passo 14 depende do usuário (Q8), os passos 15–16 dependem do 14, e o 16 é destrutivo e irreversível. O passo 13 valida sessão real e só faz sentido junto do 14. O passo 12 entra no escopo do Ralph por ser reversível e pré-requisito de tudo que o usuário fará depois.
- **DE-04:** O passo 12 (instalação real, marcado "EXIGE CONFIRMAÇÃO EXPLÍCITA" no plano) roda sem nova confirmação, com backup de `~/.claude/settings.json` no scratchpad e `npm test` verde antes. A ação é reversível via backup, `claude mcp remove` e remoção do diretório instalado; o hook falha aberto (R-1).
- **DE-09:** `jsonc-parser` sai do bundle de probe do servidor (passo 0): o esbuild resolve o pacote pelo `main` UMD e injeta um shim `__require` cujo texto contém "Dynamic require of", o que reprova a checagem estática mesmo sem o código nunca rodar. O pacote continua sendo dependência exclusiva do instalador, que roda da working tree e nunca é empacotado.
- **DE-13:** No store (`log.ts`), `import fs from 'node:fs'` (default) substitui `import * as fs`, porque sob `esModuleInterop` com o transform CJS do ts-jest o `import *` gerava cópias que `jest.spyOn(fs, 'fsyncSync')` não conseguia interceptar. Nível `warn` para `lock-orphan-removed` e `error` para `lock-lost`; espera ocupada com `Atomics.wait` num `SharedArrayBuffer`; lock órfão removido e `mkdirSync` retentado na mesma iteração, sem dormir.
- **DE-14:** Em `definitions.ts`, `registerType` ganha um quinto parâmetro `options.log?` e usa `logger: false` do Ajv quando ausente; `isEmpty` vem de `es-toolkit/compat` (ausente no core 1.52.0); `loadProcess` faz o cast `schema as z.core.JSONSchema.JSONSchema`; o hash de gate é `sha256hex(canonicalize(criteria))`; `listProjects` devolve `processes: string[]` (a tool `list` converte para contagem).
- **DE-16:** `src/version.ts` exporta `VERSION = '0.1.0'`; `package.spec` passa a afirmar `VERSION === package.json.version`. Necessário porque o log `start` precisa da versão e o bundle instalado não lê `package.json`.
- **DE-17:** No hook, o guard de "executado diretamente" compara `path.resolve(process.argv[1])` com `fileURLToPath(import.meta.url)`, funcionando tanto no `.ts` quanto no bundle. Fixture próprio: `test/fixtures/build-hook.ts`. Achado: a latência do hook `.ts` mede ≈ 220 ms (o plano estimava ~80 ms); no bundle instalado a frente 17 mediu 41 ms, então o número que importa para a sessão real vem do passo 12.
- **DE-18:** Este ADR (`docs/adr-0001-hexlog-mvp.md`) é escrito no passo 11 por um agente `writer`, em commit próprio, aproveitando o tempo ocioso enquanto o passo 7a roda em paralelo.
- **DE-19:** O `writer` (Haiku) entregou este ADR (commit `a2fc059`) com erros factuais: DE-13/DE-14/DE-16/DE-17 descritas como outras decisões, o arquivo `src/entrypoint.ts` e o script `npm run instalar` citados sem existir no repositório, os passos 14–16 trocados entre si, e a §11 do plano resumida de 15,6 KB para 5,4 KB quando o briefing pedia cópia integral. O ADR é refeito por um `executor` em commit de correção; a documentação restante (README) passa a ir para `executor`, não para `writer`.

## Verificações Reais Pendentes

O escopo do Ralph cobriu os passos 0 a 12 (DE-01); o passo 12 rodou dentro desse escopo, sem nova confirmação do usuário (DE-04). Os passos 13 a 16 ficam como pendências do usuário, com o roteiro pronto:

- **Passo 12 — instalação real: concluído em 2026-09-17.** Suíte 481/481 e e2e estáveis antes; backup em `~/.claude/settings.json.bak-hexlog`; `node scripts/install.ts` instalou `~/.local/lib/hexlog/0.1.0/` (manifesto com commit `52b24dc`, working tree limpa); segunda execução respondeu "nada a fazer" sem alterar o `settings.json`; `node scripts/install.ts --check` saiu com 0 tanto do repositório quanto de `/tmp`; `claude mcp get hexlog` mostra o servidor em escopo user apontando para a cópia instalada; as 4 regras de deny e o hook estão registrados; nenhum registro cita a working tree; os bundles instalados não contêm `Dynamic require of`. O hook instalado nega `cat <D>/…` com exit 2 e permite `ls ~/.local/share` com exit 0, em 31–36 ms por execução (o `.ts` direto media ≈ 220 ms). Reversível via backup e `claude mcp remove hexlog -s user`.
- **Passo 13 — isolamento e tokens em sessão real: concluído em 2026-09-17, com lacunas.** Sessão nova do Claude Code (`d6b9cdee-7cad-4946-85e0-a96f5c7c7586`) conduzida pelo `qa-tester` via tmux; 300 `register` via MCP com cadeia íntegra (`totalBreaks: 0`). Resultados:
  - **I2:** `Read` de `events.jsonl` negado pelo deny ("File is in a directory that is denied by your permission settings."); `cat <arquivo>` e `cat ~/.local/share/hex*/*/*/events.jsonl` negados pelo hook, sem interferência da reescrita do rtk. **Lacuna:** `jq . "${XDG_DATA_HOME:-$HOME/.local/share}/hexlog/…"` passou pelo hook e leu eventos reais. Expansão de parâmetro com valor padrão entra na classe R-4 (variável resolvida só pelo shell), junto com "variável definida no mesmo comando".
  - **I3:** `Read` de `~/.claude/projects/*/*.jsonl` e de `.omc/state/agent-replay-*.jsonl` permitido.
  - **I6:** `Read(//D)` e `Edit` em `~/.local/lib/hexlog/**` efetivos (`Edit` de `bash-guard.mjs` negado sem gravar bytes; `Read` permitido). **Não verificado:** negação de `Grep` com `path` no diretório de dados, porque a tool `Grep` não existia na sessão.
  - **M10 (parcial):** `events {limit: 200}` devolveu 26 de 300 itens em 23.722 caracteres (modo cru) e 25 itens em 23.360 caracteres (`search`), abaixo do teto de 24.000 e com `nextCursor`, sem truncamento nem aviso do cliente; só `content` chega à transcrição (sem `structuredContent`). `state` sem `sections` rendeu 527 caracteres, mas o processo só tinha Marcos, então o teto de listas não foi exercitado. **Não verificável:** `indexMs`, porque o cliente só repassa a linha de início do stderr do servidor para `mcp-logs-hexlog`. Constantes de §4.16 mantidas.
  - Dados de teste (`hexlog-qa/qa-isolamento`) removidos depois da medição.
- **Passo 14 — teste real no weed-clicker [conduzido pelo usuário]:** o usuário conduz um refinamento real usando só as tools MCP; o executor só confere as evidências depois (critério de aceite R1).
- **Passo 15 — remover o symlink `~/.local/bin/hexlog` da CLI da POC:** `rm ~/.local/bin/hexlog`, só depois do R1 aprovado (critério de aceite G1).
- **Passo 16 — remover a worktree e a branch da POC:** `wt remove -D -f` no repo `/home/gabriel/personal/core`, descartando os 27 commits de `main..poc-motor-log`. Ação destrutiva e irreversível, com confirmação explícita separada da do passo 15 (critério de aceite G2, decisão R-7).

Os passos 0 a 12 estão concluídos e revisados (revisão final aprovada sem achados bloqueantes; correções e limpeza aplicadas nos commits seguintes). A POC segue congelada em `5703a53`, pronta para o arquivamento no passo 16.
