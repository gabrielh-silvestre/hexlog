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
| `server-probe.ts` | Entrypoint de probe para o bundle esbuild do servidor: um `McpServer` stdio mínimo com 1 tool (`echo`) que importa as mesmas deps de runtime do servidor real (`ajv`, `ajv-formats`, `canonicalize`, `es-toolkit`, `minisearch`, `shell-quote`, `randomUUIDv7`) pra provar que o bundle não tem `Dynamic require of`. `jsonc-parser` fica de fora de propósito — é dependência só do instalador. Construído via `build-fixtures.ts`. |
| `hook-probe.ts` | Entrypoint de probe para o bundle esbuild do hook: importa `shell-quote`, `es-toolkit` e `src/directory.ts` (`dataDir`), sai com código diferente conforme reconhece (ou não) o comando recebido em `argv[2]`. Construído via `build-fixtures.ts`. |
| `build-fixtures.ts` | Roda como processo Node real (`spawn`, nunca importado pelo jest): chama `build()` de `scripts/build.ts` com `entryPoints` customizados apontando para `server-probe.ts` e `hook-probe.ts`. Necessário porque `scripts/build.ts` usa `import.meta.dirname`/`import.meta.main`, incompatíveis com o transform CJS do ts-jest. |
| `build-hook.ts` | Mesmo motivo/mecanismo de `build-fixtures.ts`, mas constrói só `bash-guard.mjs` com a config de produção real (`build()` sem `entryPoints` customizados). Usado por `bash-guard.spec.ts`. |
| `concurrent-install.ts` | Processo filho para o teste de concorrência de `installArtifact` (`guard.spec.ts`): hook e servidor são buffers sintéticos e as duas checagens são stubs — só a troca atômica de `installArtifact` importa aqui. Usa uma barreira em arquivo (`mkdir` + busy-wait síncrono) para garantir que os processos irmãos cheguem juntos na instalação, em vez de torcer pela concorrência real do SO. |
| `fake-mcp-install.ts` | Substitui `claude mcp add`/`remove` via `HEXLOG_REGISTER_MCP`: grava `mcpServers.hexlog` em `~/.claude.json` na mesma forma real (`command`+`args`+`env`), sem exigir o binário `claude`. Usado por `guard.spec.ts`. |

## For AI Agents
### Working In This Directory
- Todo arquivo aqui, exceto `corpus.ts`, é pensado para rodar como **processo filho** (`spawn`/`spawnSync`), nunca `import`ado pelo jest — várias APIs usadas (`import.meta.dirname`/`main`) não sobrevivem ao transform CJS do ts-jest.
- `argv`/`env` de cada probe são o contrato com quem o spawna: mudar a assinatura de um fixture exige atualizar a chamada correspondente em `test/*.spec.ts` no mesmo commit.
- `server-probe.ts` e `child-probe.ts` existem para provar que o **manifesto de deps de runtime** (§2.2) sobrevive ao bundle/ao ESM real; ao adicionar uma dependência de runtime ao servidor, replique-a aqui.

### Testing Requirements
- Estes arquivos não têm spec própria — são exercitados pelas specs de `test/` (ver `../AGENTS.md`).
- Para rodar um probe isolado fora do jest: `node test/fixtures/<arquivo>.ts <args>` (Node ≥ 24 faz type-stripping nativo do `.ts`, sem build). Exemplo verificado: `node test/fixtures/hook-probe.ts "echo hi"` → `{"tokens":["echo","hi"],"data":"..."}`, exit 0.
- `build-fixtures.ts`/`build-hook.ts` esperam um `outdir` em `argv[2]`: `node test/fixtures/build-fixtures.ts /tmp/saida`.
- `concurrent-install.ts` espera 5 argumentos posicionais (`home version variant processId totalProcesses`) e só termina quando `totalProcesses` processos irmãos escreverem na mesma barreira — não rode um só isoladamente sem simular os demais.

### Common Patterns
- Nome do arquivo indica o papel: `*-probe.ts` roda como processo filho pra inspecionar um artefato; `build-*.ts` só invoca `scripts/build.ts#build()` fora do jest; `fake-mcp-install.ts`/`concurrent-install.ts` são stand-ins/cenários pro instalador real testado em `guard.spec.ts`.
- `corpus.ts` é a única fonte de dados de volume: specs que precisam de muitas linhas (`search.spec.ts`, `search.budget.spec.ts`, `event-tools.spec.ts`) chamam `generateCorpus()` em vez de montar eventos um a um.

## Dependencies
### Internal
- `scripts/build.ts#build()` — chamado pelos dois `build-*.ts`.
- `src/installation.ts#installArtifact` — exercitado por `concurrent-install.ts`.
- `src/directory.ts#dataDir` — exercitado por `hook-probe.ts`.
- `hook/bash-guard.ts` — bundle gerado por `build-hook.ts`.

### External
- `@modelcontextprotocol/server` (`McpServer`, `serveStdio`) — usado por `server-probe.ts`/`child-probe.ts`.
- `ajv`, `ajv-formats`, `canonicalize`, `es-toolkit`, `minisearch`, `shell-quote`, `zod` — deps de runtime replicadas nos probes para provar que sobrevivem ao bundle.
- `fast-check` — usado por `corpus.ts` (`fc.sample`) para gerar o corpus determinístico.

<!-- MANUAL: Any manually added notes below this line are preserved on regeneration -->
