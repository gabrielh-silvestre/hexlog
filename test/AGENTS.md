<!-- Parent: ../AGENTS.md -->
<!-- Generated: 2026-09-17 | Updated: 2026-09-17 -->

# test

## Purpose
Suíte jest/ts-jest do hexlog: testa o `.ts` fonte diretamente (unit, property-based e via MCP real em memória) e cobre com e2e real o que as sessões de fato executam (bundle `.mjs`, hook empacotado, instalador, concorrência de processos).

## Key Files
| File | Description |
|---|---|
| `helpers.ts` | Não é spec. `createEnvironment()`: servidor `hexlog` real + `Client` MCP ligados por `InMemoryTransport` (nunca mocka o servidor); `registerCore()`: vocabulário núcleo mínimo; `expectError()`: asserta erro de domínio estruturado com o código esperado. Base de quase toda spec que chama tools. |
| `directory.spec.ts` | (I1) `dataDir`: `XDG_DATA_HOME` absoluto, vazio ou relativo → fallback `~/.local/share/hexlog`. |
| `log.spec.ts` | `append`: encadeamento de hash, cauda rasgada (JSON incompleto sem `\n`), lock `mkdir`+token (timeout, lock órfão), fencing; e `readText`. |
| `chain.spec.ts` | `hashLine`/`anchor` (golden fixo), `nextSeq`/`expectedPrevHash`, `verifyChain` (log de 5 elos com corrupções pontuais); property test: `JSON.parse(JSON.stringify(l))` preserva o hash. |
| `events.spec.ts` | `Name`, `Target` (`hex:target:*`), `normalizeData` (`dueAt` → UTC `Z`, idempotência via property test), `parseId` (prefixo `project:process:type` vs. id completo com uuid v7). |
| `state.spec.ts` | `projectState` → State: pureza, dedupe por id, supersessão de Vereditos, Marcos órfãos (relógio injetado), `toReview`, ciclo do Marco, Marco de gate não abre/fecha ciclo, avisos por dono, `validateField`, `VocabularySchema`, eventos custom inertes. Fixtures locais duplicadas de propósito com `state.property.spec.ts`. |
| `state.property.spec.ts` | Property tests (`fast-check`) de `projectState`: nunca lança e toda vigência é única ou conflito com 2+ candidatos; idempotência de dedupe; ordem de `active` pela 1ª aparição no log. |
| `gates.spec.ts` | Gates embutidos (os 4 nomes fixos de `BUILTIN_GATE_NAMES`) e gate custom via `buildGateMilestoneData`; prova cortada em 50 itens com o total real preservado. |
| `definitions.spec.ts` | `registerType`/`registerGate` (`INVALID_SCHEMA`, `RESERVED_NAME`), `createProcess`/`loadProcess` (hashes por parte, `PROCESS_CORRUPTED`), vocabulário, `readProject`. |
| `search.spec.ts` | `indexableText` (o que cada tipo de evento indexa/exclui), `stripDiacritics`, `isCandidate`, `search` (ordenação, desempate, fallback `OR`); usa `fixtures/corpus.ts`. |
| `search.budget.spec.ts` | (M13) Orçamento de performance: índice (construção+consulta) ≤ 500 ms e `events{search}` completo ≤ 2000 ms, medianas de 5 rodadas sobre um corpus de 10.000 linhas gerado por `generateCorpus`. |
| `definition-tools.spec.ts` | As 5 tools de definição (`register_type`, `register_vocabulary`, `register_gate`, `create_process`, `list`) contra o servidor MCP real (`createEnvironment`): validação de entrada, `annotations`, gravação em disco. |
| `event-tools.spec.ts` | As 10 tools completas contra o servidor MCP real: `tools/list`, validação de entrada, `register`/`evaluate_gate`/`state`/`events`/`chain`; usa `generateCorpus` para volume (paginação, 150+ vigentes). É a maior spec do repositório. |
| `toolchain.spec.ts` | 3 probes de toolchain: deps carregadas no próprio jest; import real sob Node ESM (`spawnSync` de `fixtures/child-probe.ts`); build real com esbuild (`spawnSync` de `fixtures/build-fixtures.ts`, depois `spawnSync` dos bundles `server-probe.mjs`/`hook-probe.mjs` gerados). |
| `bash-guard.spec.ts` | (I4/I7) Hook `hook/bash-guard.ts` via `spawnSync` direto (stdin JSON do protocolo PreToolUse): nega acesso a `D`, permite o que não alcança `D`, falha aberto em entrada inválida/exceção. Também constrói o bundle real (via `fixtures/build-hook.ts`) e confirma que não contém o shim do esbuild. |
| `guard.spec.ts` | A spec mais pesada (1079 linhas): `applyGuard` idempotente, as 4 regras de deny exatas, `verifyGuard` com o hook real instalado, `installArtifact` versionado (inclusive concorrência real de processos via `fixtures/concurrent-install.ts`) e `install.ts --check` como processo real (substitui `claude mcp add/remove` via `fixtures/fake-mcp-install.ts` e `HEXLOG_REGISTER_MCP`). |
| `stdio.e2e.spec.ts` | (M6/B1/C1) e2e contra o bundle real (`server.mjs`), nunca `src/*.ts`: fala só JSON-RPC 2.0 no stdout via `StdioClientTransport`, uma chamada de cada uma das 10 tools, build reprodutível (mesmo sha256 de cwds diferentes) e 4 servidores concorrentes contra o mesmo diretório de dados. |

## Subdirectories
| Directory | Description |
|---|---|
| `fixtures/` | Corpus determinístico, scripts de build sob demanda e probes executados como processo filho (see `fixtures/AGENTS.md`) |

## For AI Agents
### Working In This Directory
- Specs que chamam tools sempre passam por `helpers.ts#createEnvironment()` (servidor real + `InMemoryTransport`), nunca mockam o servidor MCP.
- Specs que precisam do artefato empacotado (`toolchain`, `bash-guard`, `stdio.e2e`, `guard`) constroem o bundle sozinhas dentro do teste/`beforeAll` — não pressuponha que `npm run build` já rodou.
- Ao adicionar um teste que aceita `code`/`agent`/`data` de uma tool, cheque `expectError()` em `helpers.ts` antes de reimplementar a asserção de erro estruturado.

### Testing Requirements
- Tudo: `npm test` (roda `jest` sobre a suíte inteira).
- Um arquivo: `npx jest test/<arquivo>.spec.ts` (ou `npm test -- test/<arquivo>.spec.ts`).
- Node `>= 24.18.1` (mesmo requisito do projeto, `package.json#engines`).
- Sem timeout customizado: jest usa o padrão (5000 ms por teste). Os specs que constroem bundle ou sobem processos filhos (`toolchain`, `bash-guard`, `guard`, `stdio.e2e`) couberam nesse orçamento nas medições feitas (guard.spec.ts: ~8.5s pra 36 testes; stdio.e2e: ~4s pra 5 testes).
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
- `hook/bash-guard.ts` — testado direto (fonte) e como bundle.

### External
- `jest`, `ts-jest`, `@jest/globals` — runner e transform.
- `fast-check` — property-based testing.
- `@modelcontextprotocol/client` (`Client`, `StdioClientTransport`) e `@modelcontextprotocol/server` (`InMemoryTransport`) — cliente/transporte MCP de teste.

<!-- MANUAL: Any manually added notes below this line are preserved on regeneration -->
