# scripts

**Parent context:** `../AGENTS.md`
**Generated:** 2026-09-17 · **Updated:** 2026-10-07

## Purpose
Entrypoints reais de build, instalação e relatório do hexlog. `build.ts` e
`install.ts` ligam as funções puras de `src/guard.ts` e `src/installation.ts`
a I/O de verdade: `esbuild`, `fs`, `child_process` e o cliente MCP.
`insights.ts` lê os logs já gravados e imprime um relatório, sem escrever
nada; `export.ts` despeja o log de um processo em JSONL, também sem escrever;
`timeline.ts` cruza os processos de um projeto por prefixo de target e imprime a
linha do tempo (com anexos e estado de integridade), também sem escrever. Os três
leem por `src/compose.ts#composeReader` (só o lado de leitura, sem serviço de escrita) e recusam
dado 0.x com exit 2. `release-notes.ts` e `release-notes-cli.ts` são de outro tipo: o `release.yml`
os roda sem `npm ci`, então só usam builtins do Node e leem apenas o `CHANGELOG.md`, sem `src/` e sem dado.

## Key Files
| File | Description |
|---|---|
| `build.ts` | Builda com `esbuild` os dois entrypoints (`server`: `src/server.ts`, `bash-guard`: `hook/bash-guard.ts`) para ESM `node24`, bundled, extensão `.mjs`. Sempre resolve a partir da raiz do repo (`import.meta.dirname`), nunca do cwd, pra garantir os mesmos bytes independente de quem chama. Exporta `build()` (usado por `install.ts` com `write: false` para pegar os bytes em memória) e `repoRoot` |
| `install.ts` | Instalador/verificador versionado. `node scripts/install.ts` builda os bundles, verifica o artefato preparado antes de trocar qualquer coisa (hook nega `D`/permite o resto; servidor sobe e anuncia as 12 tools), copia para `~/.local/lib/hexlog/<versão>/` com troca atômica, grava `manifest.json` (sha256, commit, `dirty`), copia as skills de `skills/` para `~/.claude/skills/<nome>/` (`writeSkillFolder`, antes de tocar o `settings.json`, para uma falha da troca não deixar o guard novo com skills antigas), registra as 4 regras de deny + o hook `PreToolUse` em `~/.claude/settings.json` (backup em `settings.json.bak-hexlog`) e registra o servidor MCP via `claude mcp add`/`remove`. A saída é só o resumo `hexlog <versão>: installed|reinstalled|repaired` (ou `already installed and intact; nothing to do`), os dois sha256, `settings.json: updated|already correct` e as linhas `warning: ...`. `node scripts/install.ts --check` só verifica, sem tocar em nada: ignora `--archive-0x` e nem chama `detectLegacy`, então um `<D>` ilegível (`EACCES`, `ENOTDIR`) não o derruba. Regra de `permissions.deny` de um `<D>` antigo que o guard tira é impressa (`removed deny rule: <regra>`), nunca em silêncio. Com dado 0.x em `<D>` (`adapters/fs/data-format.ts#detectLegacy`), sem flag lista o que `src/archive.ts#inspectLegacy` arquivaria e sai 2 sem alterar `<D>` nem a instalação; `--archive-0x` roda `archiveLegacy` e segue para a instalação (imprime arquivos e caminho do `.tar`, ou `removed N empty 0.x directories` quando só havia diretórios vazios; `ArchiveError`: stderr, exit 1, sem instalar). A listagem cita `<D>/archive/` porque o nome do `.tar` só existe depois de `archiveLegacy`. Argumento desconhecido é recusado com exit 1 antes de qualquer escrita (coberta em `test/guard.spec.ts`, describe B3) |
| `cli-error.ts` | `formatCliError(prefix, error)`: a linha `<prefix> failed: CODE: message (detalhes)` e o exit code (2 para `LEGACY_DATA` e `PROCESS_CORRUPTED`, 1 para o resto) dos três scripts de leitura; a recusa de dado 0.x vem de `src/errors.ts#legacyDataError`, a mesma do kernel MCP. Omite o detalhe que só repete a mensagem (`project not found (project not found)`) e mantém o `processo:` do `PROCESS_CORRUPTED`. `openReadOnly()` abre o `composeReader` sobre o `<D>` de `XDG_DATA_HOME` e lança `LEGACY_DATA` com dado 0.x (o preâmbulo único dos três scripts). `parseCliArgs(argv, options)` é o `node:util#parseArgs` estrito: opção desconhecida ou sem valor devolve `undefined`, e o script imprime o uso com exit 1 |
| `escape-controls.ts` | `escapeControls(text)`: troca C0 (menos LF e TAB), DEL, C1 e os controles bidi por `\uXXXX` visível (minúsculo, como o `JSON.stringify`). Mora em módulo próprio porque importar `timeline.ts` executaria o `main`; só o `timeline.ts` o usa |
| `release-notes.ts` | `releaseNotes(changelog, version, pr?)`: monta o corpo do GitHub Release a partir da seção `## [version]` do `CHANGELOG.md` (parágrafo de abertura, linha "PR da release" se houver PR, subseções com `###` virando `##` fora de cerca de código e bloco de instalação literal); as três buscas (fim da seção por `## `, 1º `###` e rebaixe) seguem a cerca do CommonMark (crases ou til, fecho do mesmo caractere e tamanho igual ou maior, até 3 espaços de recuo) por `outsideFences`; seção ausente ou vazia lança. Só builtins e nenhum import de `src/`, porque o `release.yml` roda sem `npm ci` |
| `release-notes-cli.ts` | CLI fino do `release.yml`: lê o `CHANGELOG.md` da raiz e imprime `releaseNotes`. Uso: `node scripts/release-notes-cli.ts <version> [--pr <number> --repo <owner/repo>]` (`--pr` vazio equivale a sem PR; `--repo` exige `--pr`, mesmo vazio, e o formato `dono/nome`); uso incorreto ou versão sem seção sai com `release-notes failed: ...` e exit 1 |
| `insights.ts` | Relatório markdown read-only (integridade da cadeia, linha do tempo e sinais da `key`: possível duplicata sem chave, chave em excesso (lote de 1 registro com `key` cuja impressão nenhum outro lote repete) e percentual de lotes com chave por tipo) sobre os registros do hexlog, lidos por `composeReader` (`loadProcess` para os elos crus; `list` e `listProjects` do `ProcessReader` para enumerar sem ler o manifesto, então um `process.json` ilegível vira só a linha do processo e o relatório dos demais sai inteiro). Cadeia quebrada imprime `N valid records` e, sem nenhum elo válido, `timeline: unavailable (chain broken)`. A chave em excesso é um proxy: o reenvio com a mesma `key` devolve `replayed` sem gravar, então o log não registra "nunca teve reenvio"; as seções de gates e forks do 0.x saíram porque `evaluate_gate` não grava mais. Uso: `node scripts/insights.ts [projeto[/processo]]`; lê o diretório de dados via `dataDir`/`XDG_DATA_HOME`. Exit pela regra única dos três scripts (tabela abaixo); `main` devolve o maior código dos processos. Argumento desconhecido ou a mais sai com o uso e exit 1. Sem script `npm` dedicado; nunca escreve no diretório de dados |
| `export.ts` | Exportação read-only dos registros de um processo em JSONL, uma linha por registro (inclui os não vigentes), lidos por `composeReader` em uma única consulta sem laço de cursor (o teto de 64 MiB por processo limita a memória). Uso: `node scripts/export.ts <project>/<process> [--fields a,b,c]`; `--fields` projeta só as chaves pedidas e recusa nome fora das chaves de `QueryRecord` (que incluem `inheritedIn` e `inheritedOut`); `--fields` sem valor, flag desconhecida e argumento a mais saem com o uso e exit 1. Cadeia adulterada ou dado 0.x saem com 2; demais erros saem com `export failed: ...` e exit 1. Sem script `npm` dedicado; nunca escreve no diretório de dados. |
| `timeline.ts` | Linha do tempo read-only de targets por consulta de alcance projeto com registros não vigentes, lida por `composeReader`, sem teto de página nem de texto por entrada, numa consulta só sem laço de cursor (o teto de 64 MiB vale por processo e o alcance projeto soma todos eles, limite aceito, pendência aberta sem ADR): o caminho para ler anexo grande. Uso: `node scripts/timeline.ts <project> <target-prefix>... [--full] [--json] [--raw]`. Texto legível por padrão (uma seção por target, marca `[superseded by <id>]`/`[revoked by <id>]`, relações de entrada e saída, e as herdadas como `inherited in:`/`inherited out:` com a `origin`); `--full` imprime cada anexo entre `----- attachment <hash> (<n> bytes) -----` e `----- end -----`; `--json` é JSONL (`kind: "record"`). A saída (texto e `--json`) passa uma vez por `escapeControls` na string final antes do `process.stdout.write`: ESC, CSI, OSC, U+009B, U+009D e os controles bidi saem como `\uXXXX` visível, e o `--json` volta ao original no `JSON.parse`. `--raw` imprime o byte exato (o `--full --raw` entre os delimitadores é idêntico ao anexo) e fica por conta de quem lê. Um anexo com a linha `----- end -----` ainda forja o delimitador no modo texto. Exit 0 íntegro, 2 cadeia, `process.json` ou anexo quebrado e dado 0.x, 1 uso incorreto ou erro (`timeline failed: CODE: msg`). Sem script `npm` dedicado; nunca escreve no diretório de dados |

### Fluxo autônomo (`flow/`)
CLIs do fluxo guiado por diretrizes deste repositório, chamados pelas skills `flow-run`, `flow-gaps` e `flow-audit` (menos o `gate.ts`, que só é chamado por `mark.ts` e à mão) e por `.claude/hooks/flow-hooks.ts` (só o `marker.ts`). Não entram nos bundles do produto. `gate.ts`, `mark.ts` e `report.ts` leem o log por `composeReader` (`cli-error.ts#openReadOnly`) e precisam de `node_modules`; `marker.ts`, `sync.ts` e `flow.ts` usam só builtins e rodam em worktree sem `npm ci`.
| File | Description |
|---|---|
| `flow/marker.ts` | Só builtins: `slugOf` (slug da branch, que recusa `main`, `develop`, `directives*`, `audits*` e os `RESERVED_PROCESS_NAMES` do domínio), `markerPath` (`<git-common-dir>/hexlog-flow/<slug>.ok`) e os helpers de `git` de que eles precisam |
| `flow/sync.ts` | Planejador do sync das diretrizes (`planSync`, `parsePremises`, `scanPremises`): função pura, sem I/O |
| `flow/flow.ts` | CLI sem dependência com os modos `slug <branch>` e `sync-plan` (lê o `SyncInput` do stdin; para `estrategia`, lê o documento e extrai as premissas) |
| `flow/gate.ts` | `gateFailures` e CLI `pre-pr <slug>`: avalia os gates `pre-pr` e `gaps` fixados no processo (o argumento `pre-pr`, o único aceito, roda os dois); sai 0 com os dois verdes, 1 listando gate, pergunta e ids, 2 com dado 0.x ou log quebrado. Nenhuma skill chama o CLI: é a conferência manual antes do `mark.ts`, que importa `gateFailures` (uso manual documentado em `docs/feedback-loops.md`, seção Rodar na mão); a regra `allow` de `.claude/settings.json` e a entrada do `knip.json` existem por ele |
| `flow/mark.ts` | `mark <slug>`: confere o slug da branch e os gates por `gateFailures` e só então grava o `.ok` (branch e sha da ponta); a árvore suja não importa; recusa sem gravar nada, com exit 1 (2 com dado 0.x ou log quebrado, pelo `formatCliError`); só age como CLI (guard `import.meta.main`, como o `gate.ts`) |
| `flow/report.ts` | `report <slug> [<base>]`: lista as decisões vigentes cuja base merece revisão (o `rests-on` e o `anchored-in` herdados pela linhagem, `inheritedOut`, contam como os gravados); só imprime e sai sempre 0 |

### Exit codes dos scripts de leitura
| Exit | `export.ts` | `timeline.ts` | `insights.ts` |
|---|---|---|---|
| 0 | íntegro | íntegro | íntegro (ou sem processos, sem filtro) |
| 1 | uso incorreto, campo inválido, erro | uso incorreto, nome inválido, erro | uso incorreto, filtro sem resultado, falha de leitura de um processo (linha `insights failed: CODE: msg` sob o título dele) |
| 2 | dado 0.x (`LEGACY_DATA`) e `PROCESS_CORRUPTED` (cadeia adulterada incluída) | dado 0.x, `PROCESS_CORRUPTED` e anexo ausente ou corrompido | dado 0.x (`LEGACY_DATA`), `PROCESS_CORRUPTED` (cadeia adulterada ou `process.json` ilegível) e anexo ausente ou corrompido |

Regra única dos três: 2 é dado quebrado (o operador resolve no dado, não no comando), 1 é o resto e 0 é íntegro. O `insights` agrega: `processReport` devolve o `exitCode` de cada processo (`formatCliError` na falha de leitura; 2 para cadeia ou anexo quebrado) e `main` devolve o maior, então um processo ilegível por `IO_ERROR` (1) junto com uma cadeia quebrada (2) sai 2. A falha de leitura imprime `formatCliError` (código e detalhes) sob o título do processo e não derruba os demais. Um `process.json` ilegível entra na enumeração (`ProcessReader#list` só confere que o manifesto existe) e sai como linha `PROCESS_CORRUPTED` do processo, não como erro da listagem.

## Navigation Notes
- A lógica de negócio dos dois scripts vive em `src/guard.ts`
  (`expectedRules`, `applyGuard`, `verifyGuard`, `hookProbes`,
  `mcpRegistered`) e `src/installation.ts` (`installArtifact`, `registerGuard`,
  `verifyInstallation`) — esses módulos são puros e
  testáveis (exceto `runRealHook`, de `src/guard.ts`, o único `spawn`), sem chamar `esbuild`/`claude` de verdade (`src/installation.ts`
  já chama `fs` real: é quem grava os arquivos instalados). `install.ts` é só
  a fiação: injeta `runRealHook`, `countTools` (sobe o servidor num
  `HOME` descartável e conta `tools.length`) e `registerMcp` (`claude mcp
  remove`+`add`, substituível por `HEXLOG_REGISTER_MCP=<script>` nos testes).
- Instalação é idempotente pelos bytes instalados (compara sha256 do build
  atual contra o instalado) e trata concorrência entre dois instaladores
  rodando ao mesmo tempo via troca atômica (`renameSync`) com fallback em
  `ENOTEMPTY`/`EEXIST`/`ENOENT`.
- `npm test` (jest) roda tudo, incluindo:
  - `test/package.spec.ts` (N11): `dependencies`/`devDependencies` do
    `package.json` batem exatamente com o manifesto do projeto (sem
    `^`/`~`/faixas), `engines.node` é `>=24.18.1`.
  - `test/guard.spec.ts`: `B2` chama `installArtifact`/`registerGuard`
    direto; `B3` roda `scripts/install.ts --check` como processo real
    (`spawnSync`), sempre com `HOME` temporário — nunca o `HOME` real.
  - `test/insights.spec.ts`: roda `scripts/insights.ts` como processo real
    (`spawnSync`) contra um `XDG_DATA_HOME` temporário; describes `relatório de
    integridade e linha do tempo` (inclui o filtro projeto/processo e a trava de que
    nada foi escrito no diretório de dados), `linha do tempo`, `sinais da chave
    (SE8)`, `cadeia adulterada (SL1)` (inclui o `process.json` truncado e o caso
    misto de exit 1 e 2), `uso incorreto` e `dado 0.x (P11)`.
  - `test/export.spec.ts`: roda `scripts/export.ts` como processo real
    (`spawnSync`) contra um `XDG_DATA_HOME` temporário; describes `sem
    --fields`, `--fields`, `uso incorreto e processo inexistente`,
    `integridade` (SL1) e `read-only`.
  - `test/timeline-cli.spec.ts`: roda `scripts/timeline.ts` como processo real
    (`spawnSync`) contra um `XDG_DATA_HOME` temporário; describes `--full`
    (com `--raw`, texto ≥ 200 KB idêntico entre os delimitadores), `escape de
    terminal` (sem `--raw`, com `--raw` e com `--json`), `texto legível`,
    `agent hostil`, `muitos registros`, `--json`, `read-only`, `integridade`
    (exit 2) e `uso incorreto e erros`.
  - `test/escape-controls.spec.ts`: `escapeControls` sobre cada classe de
    controle (C0, DEL, C1, bidi), o que passa intacto (LF, TAB, acento, emoji,
    BOM) e a idempotência.
  - `test/release-notes.spec.ts`: `releaseNotes` por tabela (ordem dos blocos,
    rebaixe de `###` fora de cerca, variantes de cerca do CommonMark, seção
    seguinte ignorada, sem abertura, sem PR, seção ausente ou vazia) e `release-notes-cli.ts` como processo real
    (`spawnSync`) sobre o `CHANGELOG.md` do repositório.
- `import.meta.main`/`import.meta.dirname` são usados nos scripts que rodam como CLI para
  o modo executável direto — incompatíveis com o transform CJS do ts-jest,
  por isso `src/installation.ts` tem a sua `hasDynamicRequire` em vez de
  importar de `build.ts`.

## Dependencies
### Internal
- `build.ts`: nenhuma (só resolve caminhos da raiz do repo)
- `install.ts`: `./build.ts` (`build`, `repoRoot`), `../src/adapters/fs/data-format.ts` (`detectLegacy`), `../src/adapters/fs/io.ts` (`readIfPresent`), `../src/archive.ts` (`archiveLegacy`, `inspectLegacy`), `../src/directory.ts`, `../src/guard.ts`, `../src/installation.ts`
- `cli-error.ts`: `../src/compose.ts` (`composeReader`), `../src/directory.ts`, `../src/errors.ts` (`HexlogError`, `legacyDataError`)
- `escape-controls.ts`: nenhuma
- `release-notes.ts`: nenhuma; `release-notes-cli.ts`: `./release-notes.ts`
- `insights.ts`: `./cli-error.ts`, `../src/directory.ts` (`dataDir`, só para a mensagem de "No processes found"), `../src/domain/chain.ts` (tipo `Link`)
- `export.ts`: `./cli-error.ts`, `../src/domain/ids.ts`, `../src/queries/query-service.ts` (tipo `QueryRecord`)
- `timeline.ts`: `./cli-error.ts`, `./escape-controls.ts`, `../src/domain/ids.ts`, `../src/queries/query-service.ts`
- `flow/marker.ts`: nenhuma; `flow/sync.ts`: nenhuma; `flow/flow.ts`: `./marker.ts`, `./sync.ts`; `flow/gate.ts`: `../cli-error.ts`, `../../src/domain/ids.ts`, `../../src/compose.ts` (só o tipo); `flow/mark.ts`: `./gate.ts`, `./marker.ts`, `../cli-error.ts`, `../../src/errors.ts`; `flow/report.ts`: `../cli-error.ts`, `../../src/domain/ids.ts`

### External
- `esbuild`
- `@modelcontextprotocol/client` (`Client`, `StdioClientTransport`; devDependency)
- `es-toolkit` (só o core; `es-toolkit/compat` não é importado)
- `node:fs`, `node:os`, `node:path`, `node:child_process` (`execFileSync`), `node:util` (`parseArgs`, em `cli-error.ts`)

## Manual Notes

## Diretrizes

- [fronteiras.md](../docs/directives/fronteiras.md): scripts de leitura só por `composeReader`, execução externa injetada
- [instalacao-e-hooks.md](../docs/directives/instalacao-e-hooks.md): instalador, bundles fixos, skills dinâmicas e o efeito de mudar o hook ou o servidor
- [qualidade-e-testes.md](../docs/directives/qualidade-e-testes.md): comandos antes de concluir
