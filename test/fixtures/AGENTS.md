<!-- Parent: ../AGENTS.md -->
<!-- Generated: 2026-09-17 | Updated: 2026-10-05 -->

# fixtures

## Purpose
Corpus determinístico de volume (`records-corpus.ts`), scripts que constroem bundles sob demanda (fora do transform do jest) e probes/stand-ins executados como processo filho pelas specs de `test/`.

## Key Files
| File | Description |
|---|---|
| `build-entry.ts` | Roda como processo Node real (`spawn`, nunca importado pelo jest): chama `build()` de `scripts/build.ts` com os `entryPoints` passados como pares `nome=arquivo` em argv. Necessário porque `scripts/build.ts` usa `import.meta.dirname`/`import.meta.main`, incompatíveis com o transform CJS do ts-jest. Usado por `bash-guard.spec.ts` e `guard.spec.ts` (`bash-guard`) e por `stdio.e2e.spec.ts` (`server`). |
| `concurrent-install.ts` | Processo filho para o teste de concorrência de `installArtifact` (`guard.spec.ts`): hook e servidor são buffers sintéticos e as duas checagens são stubs — só a troca atômica de `installArtifact` importa aqui. Usa `spinBarrier` (barreira em arquivo: `mkdir` + busy-wait síncrono, com timeout de 5 s) em dois pontos: `.barrier` antes de `installArtifact`, para os processos irmãos largarem juntos, e `.barrier2` dentro do stub `verifyServer`, depois de `installArtifact` ler `existedBefore` e antes da troca atômica (`swapArtifact`), para que nenhum termine a troca antes de todos terem lido o estado. Com o 6º argumento opcional `interleave`, congela `Date.now` e intercala os dois `renameSync` do backup (o processo 2 tenta depois de o 1 mover `versionDir` e termina antes de o 1 seguir), para o teste (h3) provar que o nome do backup não depende do relógio. |
| `boundaries/` | Árvore `src/**` de fixtures lintada por `boundaries.spec.ts` (nunca importada nem spawnada): uma violação por regra de `eslint.boundaries.js`, arquivos limpos e arquivos-âncora que o `tsc` tipa. Fora do `eslint .` do repo (`eslint.config.js` a ignora). |
| `legacy-0x/` | Árvore de dado 0.x (projeto `alpha`: `main/process.json` + `events.jsonl`, `schemas/note/1.0.json` e o `schemas/note.json` legado, `vocabulary/core/1.0.json`, `gates/custom-gate/1.0.json`, `attachments/<sha256>`) gerada pelas tools 0.x reais (D-14); `detectLegacy` a reconhece. Nunca importada nem spawnada: `archive.spec.ts` a copia para um diretório temporário. Fora do `prettier` (`.prettierignore`); locks e diretório vazio são plantados em tempo de teste. Origem em `../AGENTS.md`. |
| `domains/` | `omc.ts` e `rdsc.ts`: configuração de cada fluxo (tipos, nomes de relação e gates) como dado (`types`, `relations`, `gates`); usados por `domain/gate.spec.ts`, `adapters/definition-store.spec.ts`, `domains.spec.ts` e `queries/gate.spec.ts`. Importados direto pelo jest, não rodam como processo filho. |
| `fake-mcp-install.ts` | Substitui `claude mcp add`/`remove` via `HEXLOG_REGISTER_MCP`: grava `mcpServers.hexlog` em `~/.claude.json` na mesma forma real (`command`+`args`+`env`), sem exigir o binário `claude`. Usado por `guard.spec.ts`. |
| `chain-line.ts` | `chainLine`: lote de `count` elos encadeados a partir do fim do log, numa linha só; `linkAt`: elo com os campos de teste (`overrides` troca qualquer um), base de `chainLine` e de `chainOf` em `shared/loader.spec.ts`; `emptyManifest`: manifesto sem definições fixas com os três hashes do conjunto vazio, único construtor do manifesto vazio (inclusive em `records-corpus.ts`). Importado pelo jest (`adapters/process-store.spec.ts`) e pelos filhos `crash-writer.ts` e `lock-holder.ts`. |
| `attachment-probe.ts` | Processo filho do `AttachmentStore` real, com um argumento JSON (`AttachmentProbeArgs`): roda `status` ou `putPath` e imprime `{result}` ou `{error: {code, details}}`. Existe para o FIFO: um `open` sem `O_NONBLOCK` trava a thread de quem chama, então o pai (`adapters/attachment-store.spec.ts`) o roda com `execFileSync` e `timeout`. |
| `fixture-args.ts` | Só tipos: o argumento JSON de cada filho (`LockHolderArgs`, um por modo de `lock-holder.ts`, `CrashWriterArgs` e `AttachmentProbeArgs`). Pai e filho importam o mesmo contrato com `import type`, que some na execução. |
| `crash-writer.ts` | Processo filho do kill -9 (TF1, SE3b), com um argumento JSON (`CrashWriterArgs`): grava lotes de 10 registros sem parar pelo `ProcessStore` real e imprime a `key` de cada lote antes de gravar; o pai mata com SIGKILL no meio do lote. Usado por `adapters/process-store.spec.ts`. |
| `lock-holder.ts` | Processo filho do lock por pid (P2, TF2, TF4) e do `register` concorrente (SE5) em cinco modos, cada um com um argumento JSON (`LockHolderArgs`): `rounds`, `hold`, `write`, `write-gated` e `register` (sobre o `compose` real). Usado por `adapters/lock.spec.ts` e `commands/register.concurrency.spec.ts`. |
| `records-corpus.ts` | `writeRecordsCorpus`: corpus 1.0 determinístico gravado direto em `<dataDir>/.v1/` (cadeia por `hashLink`, linhas por `formatLine`), sem passar pelo `ProcessStore`; a opção `gates` fixa gates no manifesto de cada processo (o hash dos gates acompanha). Importado direto pelo jest (`adapters/load.budget.spec.ts`, `adapters/search.spec.ts`, `adapters/search.budget.spec.ts`, `queries/query.budget.spec.ts` e `queries/project.budget.spec.ts`), não spawnado. |

## For AI Agents
### Working In This Directory
- Todo arquivo aqui, exceto `records-corpus.ts`, `chain-line.ts`, `fixture-args.ts`, `boundaries/`, `domains/` e `legacy-0x/`, é pensado para rodar como **processo filho** (`spawn`/`spawnSync`), nunca `import`ado pelo jest — várias APIs usadas (`import.meta.dirname`/`main`) não sobrevivem ao transform CJS do ts-jest.
- `argv`/`env` de cada probe são o contrato com quem o spawna (nos filhos de lock e de kill -9, um único argumento JSON tipado em `fixture-args.ts`): mudar a assinatura de um fixture exige atualizar a chamada correspondente em `test/*.spec.ts` no mesmo commit.

### Testing Requirements
- Estes arquivos não têm spec própria — são exercitados pelas specs de `test/` (ver `../AGENTS.md`).
- `build-entry.ts` espera um `outdir` em `argv[2]` e ao menos um par `nome=arquivo` depois: `node test/fixtures/build-entry.ts /tmp/saida bash-guard=hook/bash-guard.ts`.
- `concurrent-install.ts` espera 5 argumentos posicionais (`home version variant processId totalProcesses`, mais `interleave` opcional) e só termina quando `totalProcesses` processos irmãos passarem pelas duas barreiras (`.barrier` e `.barrier2`) — não rode um só isoladamente sem simular os demais.

### Common Patterns
- Nome do arquivo indica o papel: `attachment-probe.ts` roda como processo filho pra inspecionar o `AttachmentStore`; `build-entry.ts` só invoca `scripts/build.ts#build()` fora do jest; `fake-mcp-install.ts`/`concurrent-install.ts` são stand-ins/cenários pro instalador real testado em `guard.spec.ts`.
- `records-corpus.ts` é a única fonte de dados de volume: specs que precisam de muitos registros (`adapters/load.budget.spec.ts`, `adapters/search.spec.ts`, `queries/query.budget.spec.ts`, `queries/project.budget.spec.ts`, `insights.spec.ts`, `export.spec.ts`) chamam `writeRecordsCorpus()` em vez de montar registros um a um.

## Dependencies
### Internal
- `scripts/build.ts#build()` — chamado por `build-entry.ts`.
- `src/installation.ts#installArtifact` — exercitado por `concurrent-install.ts`.
- `hook/bash-guard.ts` — bundle gerado por `build-entry.ts`.

<!-- MANUAL: Any manually added notes below this line are preserved on regeneration -->
