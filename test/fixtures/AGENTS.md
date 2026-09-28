<!-- Parent: ../AGENTS.md -->
<!-- Generated: 2026-09-17 | Updated: 2026-09-17 -->

# fixtures

## Purpose
Corpus determinístico para busca/volume, scripts que constroem bundles sob demanda (fora do transform do jest) e probes/stand-ins executados como processo filho pelas specs de `test/`.

## Key Files
| File | Description |
|---|---|
| `corpus.ts` | `generateCorpus()`/`writeCorpus()`: corpus determinístico (`fc.sample`, seed fixa 42) com cadeia de hash válida, ~40% Marco / ~40% Veredito / ~20% custom, mais as âncoras fixas exigidas pelos ACs M11/M12. Devolve as linhas, o texto JSONL já serializado e o gabarito de termos com os índices esperados por busca textual. Único arquivo daqui importado direto (não spawnado); usado por `search.spec.ts`, `search.budget.spec.ts` e `event-tools.spec.ts`. |
| `child-probe.ts` | Probe de import real sob Node ESM (type stripping), fora do transform do jest: importa todas as deps de runtime do manifesto e imprime só JSON no stdout (qualquer warning apareceria no stderr). Rodado via `spawnSync` direto do `.ts`, sem build. Usado por `toolchain.spec.ts`. |
| `server-probe.ts` | Entrypoint de probe para o bundle esbuild do servidor: um `McpServer` stdio mínimo com 1 tool (`echo`) que importa as mesmas deps de runtime do servidor real (`ajv`, `ajv-formats`, `canonicalize`, `es-toolkit`, `minisearch`, `shell-quote`, `randomUUIDv7`) pra provar que o bundle não tem `Dynamic require of`. `jsonc-parser` fica de fora de propósito — é dependência só do instalador. Construído via `build-entry.ts`. |
| `hook-probe.ts` | Entrypoint de probe para o bundle esbuild do hook: importa `shell-quote`, `es-toolkit` e `src/directory.ts` (`dataDir`), sai com código diferente conforme reconhece (ou não) o comando recebido em `argv[2]`. Construído via `build-entry.ts`. |
| `build-entry.ts` | Roda como processo Node real (`spawn`, nunca importado pelo jest): chama `build()` de `scripts/build.ts` com os `entryPoints` passados como pares `nome=arquivo` em argv. Necessário porque `scripts/build.ts` usa `import.meta.dirname`/`import.meta.main`, incompatíveis com o transform CJS do ts-jest. Usado por `toolchain.spec.ts` (os probes) e `bash-guard.spec.ts`/`guard.spec.ts` (`bash-guard`). |
| `concurrent-install.ts` | Processo filho para o teste de concorrência de `installArtifact` (`guard.spec.ts`): hook e servidor são buffers sintéticos e as duas checagens são stubs — só a troca atômica de `installArtifact` importa aqui. Usa `spinBarrier` (barreira em arquivo: `mkdir` + busy-wait síncrono, com timeout de 5 s) em dois pontos: `.barrier` antes de `installArtifact`, para os processos irmãos largarem juntos, e `.barrier2` dentro do stub `verifyServer`, depois de `installArtifact` ler `existedBefore` e antes da troca atômica (`swapArtifact`), para que nenhum termine a troca antes de todos terem lido o estado. |
| `fake-mcp-install.ts` | Substitui `claude mcp add`/`remove` via `HEXLOG_REGISTER_MCP`: grava `mcpServers.hexlog` em `~/.claude.json` na mesma forma real (`command`+`args`+`env`), sem exigir o binário `claude`. Usado por `guard.spec.ts`. |

## For AI Agents
### Working In This Directory
- Todo arquivo aqui, exceto `corpus.ts`, é pensado para rodar como **processo filho** (`spawn`/`spawnSync`), nunca `import`ado pelo jest — várias APIs usadas (`import.meta.dirname`/`main`) não sobrevivem ao transform CJS do ts-jest.
- `argv`/`env` de cada probe são o contrato com quem o spawna: mudar a assinatura de um fixture exige atualizar a chamada correspondente em `test/*.spec.ts` no mesmo commit.
- `server-probe.ts` e `child-probe.ts` existem para provar que o **manifesto de deps de runtime** (§2.2) sobrevive ao bundle/ao ESM real; ao adicionar uma dependência de runtime ao servidor, replique-a aqui.

### Testing Requirements
- Estes arquivos não têm spec própria — são exercitados pelas specs de `test/` (ver `../AGENTS.md`).
- Para rodar um probe isolado fora do jest: `node test/fixtures/<arquivo>.ts <args>` (Node ≥ 24 faz type-stripping nativo do `.ts`, sem build). Exemplo verificado: `node test/fixtures/hook-probe.ts "echo hi"` → `{"tokens":["echo","hi"],"data":"..."}`, exit 0.
- `build-entry.ts` espera um `outdir` em `argv[2]` e ao menos um par `nome=arquivo` depois: `node test/fixtures/build-entry.ts /tmp/saida bash-guard=hook/bash-guard.ts`.
- `concurrent-install.ts` espera 5 argumentos posicionais (`home version variant processId totalProcesses`) e só termina quando `totalProcesses` processos irmãos passarem pelas duas barreiras (`.barrier` e `.barrier2`) — não rode um só isoladamente sem simular os demais.

### Common Patterns
- Nome do arquivo indica o papel: `*-probe.ts` roda como processo filho pra inspecionar um artefato; `build-entry.ts` só invoca `scripts/build.ts#build()` fora do jest; `fake-mcp-install.ts`/`concurrent-install.ts` são stand-ins/cenários pro instalador real testado em `guard.spec.ts`.
- `corpus.ts` é a única fonte de dados de volume: specs que precisam de muitas linhas (`search.spec.ts`, `search.budget.spec.ts`, `event-tools.spec.ts`) chamam `generateCorpus()` em vez de montar eventos um a um.

## Dependencies
### Internal
- `scripts/build.ts#build()` — chamado por `build-entry.ts`.
- `src/installation.ts#installArtifact` — exercitado por `concurrent-install.ts`.
- `src/directory.ts#dataDir` — exercitado por `hook-probe.ts`.
- `hook/bash-guard.ts` — bundle gerado por `build-entry.ts`.

### External
- `@modelcontextprotocol/server` (`McpServer`, `serveStdio` em `server-probe.ts`; `McpServer`, `StdioServerTransport` em `child-probe.ts`) — usado por ambos os probes.
- `ajv`, `ajv-formats`, `canonicalize`, `es-toolkit`, `minisearch`, `shell-quote`, `zod`, `jsonc-parser` (só em `child-probe.ts`) — deps de runtime replicadas nos probes para provar que sobrevivem ao bundle.
- `fast-check` — usado por `corpus.ts` (`fc.sample`) para gerar o corpus determinístico.

<!-- MANUAL: Any manually added notes below this line are preserved on regeneration -->
