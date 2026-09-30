<!-- Parent: ../AGENTS.md -->
<!-- Generated: 2026-09-17 | Updated: 2026-09-17 -->

# test

## Purpose
Suíte jest/ts-jest do hexlog: testa o `.ts` fonte diretamente (unit, property-based e via MCP real em memória) e cobre com e2e real o que as sessões de fato executam (bundle `.mjs`, hook empacotado, instalador, concorrência de processos).

## Key Files
| File | Description |
|---|---|
| `helpers.ts` | Não é spec. `createEnvironment({ cwd? })`: servidor `hexlog` real + `Client` MCP ligados por `InMemoryTransport` (nunca mocka o servidor; `cwd` é a âncora do `path` de `attachment`); `registerCore()`: vocabulário núcleo mínimo; `expectError()`: asserta erro de domínio estruturado com o código esperado; `createTempDir(prefix)`: cria `hexlog-<prefix>-XXXXXX` sob `os.tmpdir()` e registra em `cleanup.ts` (único caminho permitido para diretório temporário de teste; `createEnvironment` já o usa). Base de quase toda spec que chama tools. |
| `cleanup.ts` | Não é spec. `setupFilesAfterEnv` do jest: guarda o registro de `registerTempDir` (consumido por `helpers.ts#createTempDir`) e apaga tudo no `afterAll`, inclusive com teste vermelho. Só importa `node:fs` e `@jest/globals`: puxar `src/` aqui carrega o módulo antes do `jest.mock` de um spec. |
| `global-setup.ts` | Não é spec. `globalSetup` do jest: cria `hexlog-suite-*` com `mkdtempSync` sob o `TMPDIR` recebido e exporta `process.env.TMPDIR` para ele, herdado pelos workers. É, com `helpers.ts`, o único lugar de `test/` que pode chamar `mkdtempSync`. |
| `global-teardown.ts` | Não é spec. `globalTeardown` do jest: se `hexlog-suite-*` não estiver vazio, falha a execução listando o que sobrou, depois apaga o diretório (só age em basename `hexlog-suite-`, nunca num `TMPDIR` real). Vale com e sem `-t`. |
| `boundaries.spec.ts` | Travas de fronteira de `eslint.boundaries.js` (`boundaryBlocks`) pela API `ESLint` sobre `fixtures/boundaries/`: imports proibidos em `domain`/`shared`/`commands`/`queries`, `commands` ↔ `queries`, `max-lines` 800 só em `commands`/`queries` e `src/mcp/kernel.ts` sem importar `./tools/**`. |
| `new-tree.ts` | Não é spec. `repoRoot`, `srcRoot`, `NEW_TREE_DIRS` e `listNewTreeFiles(extraFiles?)`: lista os `.ts` que já existem da árvore nova de `src/` (`domain`, `shared`, `commands`, `queries`, `adapters`, `mcp`, `compose.ts`, `archive.ts`), ancorados em `src/` da raiz (as fixtures de `fixtures/boundaries/src` espelham nomes de camada). Usado por `tree-isolation.spec.ts` e `no-flow-terms.spec.ts`. |
| `tree-isolation.spec.ts` | (P6) Por AST, a árvore nova e a entry de prévia só importam da raiz `errors.ts`, `directory.ts` e `version.ts` (ou da própria árvore): nenhum import da raiz legada; a entry de prévia fora de `src/` alcança a árvore nova por caminho relativo. |
| `no-flow-terms.spec.ts` | (D1) Por AST, nenhum identificador nem literal da árvore nova usa termo de fluxo (`phase`, `plan`, `critic`, `milestone`, `verdict`, `claim`, `omc` e similares), com separação por camelCase. |
| `domain/ids.spec.ts` | `src/domain/ids.ts`: `Name`, `Hash`, `Instant`, `Target`, `RecordId`, `alias`, `processOf` e `RESERVED_PROCESS_NAMES`. |
| `domain/record.spec.ts` | `src/domain/record.ts`: `HexRecord`, `Author`, `Relation`/`RelationInput`, `BatchItem` e os tetos `DATA_MAX_CHARS` e `BATCH_MAX`. |
| `domain/chain.spec.ts` | `src/domain/chain.ts`: `sha256hex`, `fingerprint`, `hashLink`, `anchor` e `isValidLink`, sem fs. |
| `domain/relations.spec.ts` | `src/domain/relations.ts`: `checkRelation` (regras e `details[].code`), `hasCycle`, `buildVigency`, `lineages` e `needsReview`. |
| `domain/vigency.property.spec.ts` | Property tests (`fast-check`) das funções de `src/domain/relations.ts` (`buildVigency`, `checkRelation`, `hasCycle`, `lineages`, `needsReview`). |
| `domain/definitions.spec.ts` | `src/domain/definitions.ts`: schemas `RecordType`/`RelationName`/`Gate`, semver (`bumpVersion`), classificação de mudança de tipo e de relação e `attachmentFields`. |
| `domain/gate.spec.ts` | `src/domain/gate.ts`: `GateQuestion`, `Selector`, `matchesSelector`/`matchesTargetPrefix` e `evaluateGate`. |
| `directory.spec.ts` | (I1) `dataDir`: `XDG_DATA_HOME` absoluto, vazio ou relativo → fallback `~/.local/share/hexlog`. |
| `log.spec.ts` | `append`/`appendBatch`: encadeamento de hash, cauda rasgada (JSON incompleto sem `\n`), lock `mkdir`+token (timeout, lock órfão), fencing; lote gravado numa única aquisição de lock, falha de escrita no meio do lote com o lock liberado no `finally`, troca de token no meio do lote interrompe o resto; e `readText`. |
| `chain.spec.ts` | `hashLine`/`anchor` (golden fixo), `nextSeq`/`expectedPrevHash`, `verifyChain` (log de 5 elos com corrupções pontuais; com o `Map` de anexos, `attachment-missing`/`attachment-corrupted`) e `attachmentRefs`, sem fs; property test: `JSON.parse(JSON.stringify(l))` preserva o hash. |
| `events.spec.ts` | `Name`, `Target` (`hex:target:*`), `normalizeData` (`dueAt` → UTC `Z`, idempotência via property test), `parseId` (prefixo `project:process:type` vs. id completo com uuid v7). |
| `state.spec.ts` | `projectState` → State: pureza, dedupe por id, supersessão de Vereditos, Marcos órfãos (relógio injetado), `toReview`, ciclo do Marco, Marco de gate não abre/fecha ciclo, avisos por dono, `validateField`, `VocabularySchema`, eventos custom inertes. Fixtures locais duplicadas de propósito com `state.property.spec.ts`. |
| `state.property.spec.ts` | Property tests (`fast-check`) de `projectState`: nunca lança e toda vigência é única ou conflito com 2+ candidatos; idempotência de dedupe; ordem de `active` pela 1ª aparição no log. |
| `gates.spec.ts` | Gates embutidos (os 5 nomes fixos de `BUILTIN_GATE_NAMES`) e gate custom via `buildGateMilestoneData`; prova cortada em 50 itens com o total real preservado. |
| `definitions.spec.ts` | `registerType`/`registerGate` (`INVALID_SCHEMA`, `RESERVED_NAME`), `createProcess`/`loadProcess` (hashes por parte, `PROCESS_CORRUPTED`), vocabulário, `readProject`, `listValidProcesses` (o diretório `attachments/` não é processo). |
| `search.spec.ts` | `indexableText` (o que cada tipo de evento indexa/exclui), `stripDiacritics`, `isCandidate`, `search` (ordenação, desempate, fallback `OR`); usa `fixtures/corpus.ts`. |
| `search.budget.spec.ts` | (M13) Orçamento de performance: índice (construção+consulta) ≤ 500 ms e `events{search}` completo ≤ 2000 ms, medianas de 5 rodadas sobre um corpus de 10.000 linhas gerado por `generateCorpus`. |
| `definition-tools.spec.ts` | As 5 tools de definição (`register_type`, `register_vocabulary`, `register_gate`, `create_process`, `list`) contra o servidor MCP real (`createEnvironment`): validação de entrada, `annotations`, gravação em disco. |
| `event-tools.spec.ts` | As 12 tools completas contra o servidor MCP real: `tools/list`, validação de entrada, `register`/`evaluate_gate`/`state`/`events`/`chain`; usa `generateCorpus` para volume (paginação, 150+ vigentes). Também cobre os anexos no `register` (`attachment` inexistente/adulterado, `supersedes` de tipo custom), a integridade dos blobs em `chain`/`state` e as tools `attachment` e `timeline`. É a maior spec do repositório. |
| `skill-coherence.spec.ts` | Coerência de `skills/hexlog/SKILL.md` × código real: extratores próprios (crase fora de bloco cercado, nome de tool em `server.registerTool(`, constantes `SCREAMING_SNAKE_CASE`, catálogo de `ErrorCode`, nomes de função declarados em `src/**/*.ts` (varredura recursiva), citações `arquivo.ts#símbolo` com diretório opcional relativo a `src/`, citações `arquivo.ts:N(-M)?`) testados isolados sobre string literal; depois cruza cada tool/código/função citados contra `definition-tools.ts`/`event-tools.ts`/`timeline-tools.ts`/`definitions.ts`/`src/`, e cada citação `arquivo:linha` contra o trecho real (detecta deslocamento de linha). |
| `toolchain.spec.ts` | 3 probes de toolchain: deps carregadas no próprio jest; import real sob Node ESM (`spawnSync` de `fixtures/child-probe.ts`); build real com esbuild (`spawnSync` de `fixtures/build-entry.ts`, depois `spawnSync` dos bundles `server-probe.mjs`/`hook-probe.mjs` gerados). |
| `package.spec.ts` | (N7/S6/N11/M5/M6) Invariantes de manifesto e superfície contra o repo real: sem dependências banidas (`xstate`, `hexnucleus`, `core.poc-motor-log`, `uuid`) nem import fora do repo em `src/`/`hook/`/`scripts/`/`test/`; `zod` fixado em `4.6.5`; `dependencies`/`devDependencies`/`engines.node` batem exatamente com o manifesto de §2.2 (sem faixas `^`/`~`); `VERSION` de `src/version.ts` bate com `package.json.version`; `.gitignore` contém `dist/`; sem `bin`; nenhum arquivo de `src/` importa módulo de servidor de rede nem chama `.listen(`; sem diretório `cli`; sem `console`/`process.stdout.write` em `src/`; `src/directory.ts` só importa `node:*` e `es-toolkit`. |
| `bash-guard.spec.ts` | (I4/I7) Hook `hook/bash-guard.ts` via `spawnSync` direto (stdin JSON do protocolo PreToolUse): nega acesso a `D`, permite o que não alcança `D`, falha aberto em entrada inválida/exceção. Também constrói o bundle real (via `fixtures/build-entry.ts`) e confirma que não contém o shim do esbuild. |
| `guard.spec.ts` | `applyGuard` idempotente, as 4 regras de deny exatas, `verifyGuard` com o hook real instalado, `installArtifact` versionado (inclusive concorrência real de processos via `fixtures/concurrent-install.ts`) e `install.ts --check` como processo real (substitui `claude mcp add/remove` via `fixtures/fake-mcp-install.ts` e `HEXLOG_REGISTER_MCP`). |
| `stdio.e2e.spec.ts` | (M6/B1/C1) e2e contra o bundle real (`server.mjs`), nunca `src/*.ts`: fala só JSON-RPC 2.0 no stdout via `StdioClientTransport`, uma chamada de cada uma das 12 tools, put de ≥ 200 KB por `text` e por `path` (com o `cwd` do processo filho), `get` paginado, `timeline` e `scripts/timeline.ts --full` com o mesmo texto e adulteração vista sem `--full` (Q1), build reprodutível (mesmo sha256 de cwds diferentes) e 4 servidores concorrentes contra o mesmo diretório de dados. |
| `insights.spec.ts` | CLI somente-leitura `scripts/insights.ts` via `spawnSync`: filtro posicional (`projeto`/`projeto/processo`), integridade da cadeia, contagem de gates por nome (pass/fail), timeline (duração, eventos por dia, marcos por tipo, maiores intervalos entre eventos), garante que não escreve no `dataDir` (hash/mtime iguais antes/depois) e falha limpo (sem stack trace) com `process.json` corrompido. |
| `export.spec.ts` | CLI somente-leitura `scripts/export.ts` via `spawnSync`: sem `--fields` a saída repete as linhas do arquivo na ordem física; `--fields` projeta só as chaves pedidas e campo desconhecido falha com exit ≠ 0; processo inexistente falha no stderr; linha inválida é omitida sem quebrar o comando; não escreve no `dataDir` (hash/mtime iguais antes/depois). |
| `attachments.spec.ts` | (S1/Q1/Q2) `src/attachments.ts` direto, sem servidor: round-trip byte-idêntico por `text` e por `path` (pt-BR, emoji, CRLF, BOM, NUL), dedupe (inclusive 8 processos concorrentes e blob adulterado), teto de 1 MiB em bytes, cada `detail` de `INVALID_INPUT` (`path` fora de `<cwd>/.omc/plans`, symlink, hardlink, diretório trocado por symlink entre o `realpath` e o `open`, FIFO, arquivo que cresce entre `fstat` e leitura, erros sem caminho absoluto), blob que é symlink/FIFO/diretório, páginas sem partir par surrogate e o memo do `state` (`ctime`/`ino` pegam adulteração que preserva `size` e `mtime`). |
| `timeline.spec.ts` | (S3) Projeção pura `projectTimeline`, sem fs: ordem e desempate entre processos, subárvore de target, superados (Veredito e custom, um custom nunca marca Veredito), resumo por tipo, `attachment.status` e cadeia quebrada sem `full`, tetos (por entrada, de página, 100 avisos), paginação e pureza. |
| `timeline-cli.spec.ts` | CLI somente-leitura `scripts/timeline.ts` via `spawnSync`: `--full` com texto ≥ 200 KB idêntico entre os delimitadores, `--json` nas formas `chain`/`entry`, exit 2 com cadeia ou blob quebrado, uso incorreto (exit 1) e árvore do `dataDir` intacta. |
| `audit-types.spec.ts` | (S2/Q3) Os cinco schemas de `.hexlog/types/*.json` : instância de pior caso ×1 e ×2 com as medidas exatas (margem mínima de 927 caracteres sob 16.000), rejeições, `create_process` fixa os cinco, `architect-review` não altera `state` nem `no-conflicts`, e o cenário de integração de duas iterações de ralplan na ordem de chamadas que o fork OMC exige. |

## Subdirectories
| Directory | Description |
|---|---|
| `fixtures/` | Corpus determinístico, scripts de build sob demanda e probes executados como processo filho (see `fixtures/AGENTS.md`) |

## For AI Agents
### Working In This Directory
- Specs que chamam tools sempre passam por `helpers.ts#createEnvironment()` (servidor real + `InMemoryTransport`), nunca mockam o servidor MCP.
- Specs que precisam do artefato empacotado (`toolchain`, `bash-guard`, `stdio.e2e`, `guard`) constroem o bundle sozinhas dentro do teste/`beforeAll` — não pressuponha que `npm run build` já rodou.
- Ao adicionar um teste que aceita `code`/`agent`/`data` de uma tool, cheque `expectError()` em `helpers.ts` antes de reimplementar a asserção de erro estruturado.
- `helpers.ts#createTempDir` só dentro de hook ou teste, nunca na coleta do `describe`: a coleta roda até com `-t`, e o `afterAll` de `cleanup.ts` não roda num arquivo sem teste selecionado, então o diretório vazaria.

### Testing Requirements
- Tudo: `npm test` (roda `jest` sobre a suíte inteira).
- Um arquivo: `npx jest test/<arquivo>.spec.ts` (ou `npm test -- test/<arquivo>.spec.ts`).
- Node `>= 24.18.1` (mesmo requisito do projeto, `package.json#engines`).
- Sem timeout customizado: jest usa o padrão (5000 ms por teste). Os specs que constroem bundle ou sobem processos filhos (`toolchain`, `bash-guard`, `guard`, `stdio.e2e`) couberam nesse orçamento nas medições feitas (guard.spec.ts: ~10.5s pra 40 testes; stdio.e2e: ~4s pra 5 testes).
- `search.budget.spec.ts` é sensível à máquina: os limites (500ms/2000ms) têm folga generosa sobre as medianas observadas (~250ms/~430ms), mas podem estourar num CI muito mais lento.
- Nenhum requer `npm run build` prévio; os que precisam de bundle o geram por conta própria via processo filho (ver Common Patterns).

### Common Patterns
- IDs nos títulos/`describe` (`M#`, `N#`, `S#`, `B#`, `I#`, `C1`, `Q10`, `R-3`, `U-7`) remetem a critérios de aceite do ADR 0001 (mesmo padrão de `docs/AGENTS.md`).
- Property-based tests (`fast-check`, `fc.assert`/`fc.property`) cobrem invariantes de hash e de projeção: `chain.spec.ts`, `events.spec.ts`, `state.property.spec.ts`.
- `state.spec.ts` e `state.property.spec.ts` duplicam as mesmas fixtures locais de propósito — 2 arquivos só, sem um 3º módulo compartilhado.
- Specs de artefato (`toolchain`, `bash-guard`, `stdio.e2e`) nunca importam `scripts/build.ts` direto no jest: `import.meta.dirname`/`import.meta.main` não existem sob o transform CJS do ts-jest, por isso o build roda via `spawnSync`/`spawn` de um fixture `.ts` em processo Node real.

## Dependencies
### Internal
- `src/*` — todo o núcleo testado (log, chain, events, state, gates, definitions, search, mcp).
- `scripts/build.ts` — construído sob demanda pelas specs de artefato, via os fixtures de build.
- `scripts/install.ts` — rodado como processo real por `guard.spec.ts` (`install.ts --check`).
- `scripts/insights.ts` — rodado como processo real por `insights.spec.ts`.
- `hook/bash-guard.ts` — testado direto (fonte) e como bundle.

### External
- `jest`, `ts-jest`, `@jest/globals` — runner e transform.
- `fast-check` — property-based testing.
- `@modelcontextprotocol/client` (`Client`, `StdioClientTransport`) e `@modelcontextprotocol/server` (`InMemoryTransport`) — cliente/transporte MCP de teste.

<!-- MANUAL: Any manually added notes below this line are preserved on regeneration -->
