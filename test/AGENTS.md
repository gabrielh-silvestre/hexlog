<!-- Parent: ../AGENTS.md -->
<!-- Generated: 2026-09-17 | Updated: 2026-09-17 -->

# test

## Purpose
Suíte jest/ts-jest do hexlog: testa o `.ts` fonte diretamente (unit, property-based e via MCP real em memória) e cobre com e2e real o que as sessões de fato executam (bundle `.mjs`, hook empacotado, instalador, concorrência de processos).

## Key Files
| File | Description |
|---|---|
| `helpers.ts` | Não é spec. `criarAmbiente()`: servidor `hexlog` real + `Client` MCP ligados por `InMemoryTransport` (nunca mocka o servidor); `registrarNucleo()`: vocabulário núcleo mínimo; `esperarErro()`: asserta erro de domínio estruturado com o código esperado. Base de quase toda spec que chama tools. |
| `diretorio.spec.ts` | (I1) `dirDados`: `XDG_DATA_HOME` absoluto, vazio ou relativo → fallback `~/.local/share/hexlog`. |
| `log.spec.ts` | `anexar`: encadeamento de hash, cauda rasgada (JSON incompleto sem `\n`), lock `mkdir`+token (timeout, lock órfão), fencing; e `lerTexto`. |
| `cadeia.spec.ts` | `hashLinha`/`ancora` (golden fixo), `proximoSeq`/`prevHashEsperado`, `verificarCadeia` (log de 5 elos com corrupções pontuais); property test: `JSON.parse(JSON.stringify(l))` preserva o hash. |
| `eventos.spec.ts` | `Nome`, `Alvo` (`hex:alvo:*`), `normalizarDados` (`prazoExecucao` → UTC `Z`, idempotência via property test), `analisarId` (prefixo `projeto:processo:tipo` vs. id completo com uuid v7). |
| `estado.spec.ts` | `projetar` → Estado: pureza, dedupe por id, supersessão de Vereditos, Marcos órfãos (relógio injetado), `aRevisar`, ciclo do Marco, Marco de gate não abre/fecha ciclo, avisos por dono, `validarCampo`, `VocabularioSchema`, eventos custom inertes. Fixtures locais duplicadas de propósito com `estado.property.spec.ts`. |
| `estado.property.spec.ts` | Property tests (`fast-check`) de `projetar`: nunca lança e toda vigência é única ou conflito com 2+ candidatos; idempotência de dedupe; ordem de `vigentes` pela 1ª aparição no log. |
| `gates.spec.ts` | Gates embutidos (os 4 nomes fixos de `GATES_EMBUTIDOS`) e gate custom via `montarDadosMarcoGate`; prova cortada em 50 itens com o total real preservado. |
| `definicoes.spec.ts` | `registrarTipo`/`registrarGate` (`SCHEMA_INVALIDO`, `NOME_RESERVADO`), `criarProcesso`/`carregarProcesso` (hashes por parte, `PROCESSO_CORROMPIDO`), vocabulário, `lerProjeto`. |
| `busca.spec.ts` | `textoIndexavel` (o que cada tipo de evento indexa/exclui), `semAcento`, `ehCandidato`, `buscar` (ordenação, desempate, fallback `OR`); usa `fixtures/corpus.ts`. |
| `busca.orcamento.spec.ts` | (M13) Orçamento de performance: índice (construção+consulta) ≤ 500 ms e `eventos{busca}` completo ≤ 2000 ms, medianas de 5 rodadas sobre um corpus de 10.000 linhas gerado por `gerarCorpus`. |
| `ferramentas-definicoes.spec.ts` | As 5 tools de definição (`registrar_tipo`, `registrar_vocabulario`, `registrar_gate`, `criar_processo`, `listar`) contra o servidor MCP real (`criarAmbiente`): validação de entrada, `annotations`, gravação em disco. |
| `ferramentas-eventos.spec.ts` | As 10 tools completas contra o servidor MCP real: `tools/list`, validação de entrada, `registrar`/`avaliar_gate`/`estado`/`eventos`/`cadeia`; usa `gerarCorpus` para volume (paginação, 150+ vigentes). É a maior spec do repositório. |
| `toolchain.spec.ts` | 3 probes de toolchain: deps carregadas no próprio jest; import real sob Node ESM (`spawnSync` de `fixtures/filho-probe.ts`); build real com esbuild (`spawnSync` de `fixtures/construir-fixtures.ts`, depois `spawnSync` dos bundles `servidor-probe.mjs`/`hook-probe.mjs` gerados). |
| `guarda-bash.spec.ts` | (I4/I7) Hook `hook/guarda-bash.ts` via `spawnSync` direto (stdin JSON do protocolo PreToolUse): nega acesso a `D`, permite o que não alcança `D`, falha aberto em entrada inválida/exceção. Também constrói o bundle real (via `fixtures/construir-hook.ts`) e confirma que não contém o shim do esbuild. |
| `guarda.spec.ts` | A spec mais pesada (967 linhas): `aplicarGuard` idempotente, as 4 regras de deny exatas, `verificarGuard` com o hook real instalado, `instalarArtefato` versionado (inclusive concorrência real de processos via `fixtures/instalar-concorrente.ts`) e `instalar.ts --check` como processo real (substitui `claude mcp add/remove` via `fixtures/instalar-mcp-falso.ts` e `HEXLOG_REGISTRAR_MCP`). |
| `stdio.e2e.spec.ts` | (M6/B1/C1) e2e contra o bundle real (`servidor.mjs`), nunca `src/*.ts`: fala só JSON-RPC 2.0 no stdout via `StdioClientTransport`, uma chamada de cada uma das 10 tools, build reprodutível (mesmo sha256 de cwds diferentes) e 4 servidores concorrentes contra o mesmo diretório de dados. |

## Subdirectories
| Directory | Description |
|---|---|
| `fixtures/` | Corpus determinístico, scripts de build sob demanda e probes executados como processo filho (see `fixtures/AGENTS.md`) |

## For AI Agents
### Working In This Directory
- Specs que chamam tools sempre passam por `helpers.ts#criarAmbiente()` (servidor real + `InMemoryTransport`), nunca mockam o servidor MCP.
- Specs que precisam do artefato empacotado (`toolchain`, `guarda-bash`, `stdio.e2e`, `guarda`) constroem o bundle sozinhas dentro do teste/`beforeAll` — não pressuponha que `npm run build` já rodou.
- Ao adicionar um teste que aceita `codigo`/`agente`/`dados` de uma tool, cheque `esperarErro()` em `helpers.ts` antes de reimplementar a asserção de erro estruturado.

### Testing Requirements
- Tudo: `npm test` (roda `jest` sobre a suíte inteira).
- Um arquivo: `npx jest test/<arquivo>.spec.ts` (ou `npm test -- test/<arquivo>.spec.ts`).
- Node `>= 24.18.1` (mesmo requisito do projeto, `package.json#engines`).
- Sem timeout customizado: jest usa o padrão (5000 ms por teste). Os specs que constroem bundle ou sobem processos filhos (`toolchain`, `guarda-bash`, `guarda`, `stdio.e2e`) couberam nesse orçamento nas medições feitas (guarda.spec.ts: ~8.5s pra 36 testes; stdio.e2e: ~4s pra 5 testes).
- `busca.orcamento.spec.ts` é sensível à máquina: os limites (500ms/2000ms) têm folga generosa sobre as medianas observadas (~250ms/~430ms), mas podem estourar num CI muito mais lento.
- Nenhum requer `npm run build` prévio; os que precisam de bundle o geram por conta própria via processo filho (ver Common Patterns).

### Common Patterns
- IDs nos títulos/`describe` (`M#`, `N#`, `S#`, `B#`, `I#`, `C1`, `Q10`, `R-3`, `U-7`) remetem a critérios de aceite do ADR 0001 (mesmo padrão de `docs/AGENTS.md`).
- Property-based tests (`fast-check`, `fc.assert`/`fc.property`) cobrem invariantes de hash e de projeção: `cadeia.spec.ts`, `eventos.spec.ts`, `estado.property.spec.ts`.
- `estado.spec.ts` e `estado.property.spec.ts` duplicam as mesmas fixtures locais de propósito — 2 arquivos só, sem um 3º módulo compartilhado.
- Specs de artefato (`toolchain`, `guarda-bash`, `stdio.e2e`) nunca importam `scripts/build.ts` direto no jest: `import.meta.dirname`/`import.meta.main` não existem sob o transform CJS do ts-jest, por isso o build roda via `spawnSync`/`spawn` de um fixture `.ts` em processo Node real.

## Dependencies
### Internal
- `src/*` — todo o núcleo testado (log, cadeia, eventos, estado, gates, definições, busca, mcp).
- `scripts/build.ts` — construído sob demanda pelas specs de artefato, via os fixtures de build.
- `hook/guarda-bash.ts` — testado direto (fonte) e como bundle.

### External
- `jest`, `ts-jest`, `@jest/globals` — runner e transform.
- `fast-check` — property-based testing.
- `@modelcontextprotocol/client` (`Client`, `StdioClientTransport`) e `@modelcontextprotocol/server` (`InMemoryTransport`) — cliente/transporte MCP de teste.

<!-- MANUAL: Any manually added notes below this line are preserved on regeneration -->
