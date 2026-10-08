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
linha do tempo (com anexos e estado de integridade), também sem escrever;
`rdsc-projections.ts` imprime em JSONL o snapshot de um processo (registros, gates e
mudanças desde um marcador), também sem escrever. Os quatro
leem por `src/compose.ts#composeReader` (só o lado de leitura, sem serviço de escrita) e recusam
dado 0.x com exit 2.

## Key Files
| File | Description |
|---|---|
| `build.ts` | Builda com `esbuild` os dois entrypoints (`server`: `src/server.ts`, `bash-guard`: `hook/bash-guard.ts`) para ESM `node24`, bundled, extensão `.mjs`. Sempre resolve a partir da raiz do repo (`import.meta.dirname`), nunca do cwd, pra garantir os mesmos bytes independente de quem chama. Exporta `build()` (usado por `install.ts` com `write: false` para pegar os bytes em memória) e `repoRoot` |
| `install.ts` | Instalador/verificador versionado. `node scripts/install.ts` builda os bundles, verifica o artefato preparado antes de trocar qualquer coisa (hook nega `D`/permite o resto; servidor sobe e anuncia as 12 tools), copia para `~/.local/lib/hexlog/<versão>/` com troca atômica, grava `manifest.json` (sha256, commit, `dirty`), registra as 4 regras de deny + o hook `PreToolUse` em `~/.claude/settings.json` (backup em `settings.json.bak-hexlog`), copia as skills de `skills/` para `~/.claude/skills/<nome>/` (`writeSkillFolder`) e registra o servidor MCP via `claude mcp add`/`remove`. A saída é só o resumo `hexlog <versão>: installed|reinstalled|repaired` (ou `already installed and intact; nothing to do`), os dois sha256, `settings.json: updated|already correct` e as linhas `warning: ...`. `node scripts/install.ts --check` só verifica, sem tocar em nada: ignora `--archive-0x` e nem chama `detectLegacy`, então um `<D>` ilegível (`EACCES`, `ENOTDIR`) não o derruba. Regra de `permissions.deny` de um `<D>` antigo que o guard tira é impressa (`removed deny rule: <regra>`), nunca em silêncio. Com dado 0.x em `<D>` (`adapters/fs/data-format.ts#detectLegacy`), sem flag lista o que `src/archive.ts#inspectLegacy` arquivaria e sai 2 sem alterar `<D>` nem a instalação; `--archive-0x` roda `archiveLegacy` e segue para a instalação (imprime arquivos e caminho do `.tar`, ou `removed N empty 0.x directories` quando só havia diretórios vazios; `ArchiveError`: stderr, exit 1, sem instalar). A listagem cita `<D>/archive/` porque o nome do `.tar` só existe depois de `archiveLegacy`. Argumento desconhecido é recusado com exit 1 antes de qualquer escrita (decisão da issue #71, fora do plano; coberta em `test/guard.spec.ts`, describe B3) |
| `cli-error.ts` | `formatCliError(prefix, error)`: a linha `<prefix> failed: CODE: message (detalhes)` e o exit code (2 para `LEGACY_DATA` e `PROCESS_CORRUPTED`, 1 para o resto) dos quatro scripts de leitura; a recusa de dado 0.x vem de `src/errors.ts#legacyDataError`, a mesma do kernel MCP (P11). Omite o detalhe que só repete a mensagem (`project not found (project not found)`) e mantém o `processo:` do `PROCESS_CORRUPTED`. `openReadOnly()` abre o `composeReader` sobre o `<D>` de `XDG_DATA_HOME` e lança `LEGACY_DATA` com dado 0.x (o preâmbulo único dos quatro scripts). `parseCliArgs(argv, options)` é o `node:util#parseArgs` estrito: opção desconhecida ou sem valor devolve `undefined`, e o script imprime o uso com exit 1 |
| `escape-controls.ts` | `escapeControls(text)`: troca C0 (menos LF e TAB), DEL, C1 e os controles bidi por `\uXXXX` visível (minúsculo, como o `JSON.stringify`). Mora em módulo próprio porque importar `timeline.ts` executaria o `main`; o `timeline.ts` e o `rdsc-projections-run.ts` o usam |
| `insights.ts` | Relatório markdown read-only (integridade da cadeia, linha do tempo e sinais da `key`, SE8: possível duplicata sem chave, chave em excesso (G4: lote de 1 registro com `key` cuja impressão nenhum outro lote repete) e percentual de lotes com chave por tipo) sobre os registros do hexlog, lidos por `composeReader` (`loadProcess` para os elos crus; `list` e `listProjects` do `ProcessReader` para enumerar sem ler o manifesto, então um `process.json` ilegível vira só a linha do processo e o relatório dos demais sai inteiro). Cadeia quebrada imprime `N valid records` e, sem nenhum elo válido, `timeline: unavailable (chain broken)`. A chave em excesso é um proxy: o reenvio com a mesma `key` devolve `replayed` sem gravar, então o log não registra "nunca teve reenvio"; as seções de gates e forks do 0.x saíram porque `evaluate_gate` não grava mais. Uso: `node scripts/insights.ts [projeto[/processo]]`; lê o diretório de dados via `dataDir`/`XDG_DATA_HOME`. Exit pela regra única dos quatro scripts (tabela abaixo); `main` devolve o maior código dos processos. Argumento desconhecido ou a mais sai com o uso e exit 1. Sem script `npm` dedicado; nunca escreve no diretório de dados |
| `export.ts` | Exportação read-only dos registros de um processo em JSONL, uma linha por registro (inclui os não vigentes), lidos por `composeReader` em uma única consulta sem laço de cursor (o teto de 64 MiB por processo limita a memória). Uso: `node scripts/export.ts <project>/<process> [--fields a,b,c]`; `--fields` projeta só as chaves pedidas e recusa nome fora das chaves de `QueryRecord`; `--fields` sem valor, flag desconhecida e argumento a mais saem com o uso e exit 1. Cadeia adulterada ou dado 0.x saem com 2 (SL1, P11); demais erros saem com `export failed: ...` e exit 1. Sem script `npm` dedicado; nunca escreve no diretório de dados |
| `timeline.ts` | Linha do tempo read-only de targets por consulta de alcance projeto com registros não vigentes, lida por `composeReader`, sem teto de página nem de texto por entrada, numa consulta só sem laço de cursor (o teto de 64 MiB vale por processo e o alcance projeto soma todos eles, limite aceito, pendência aberta sem ADR): o caminho para ler anexo grande. Uso: `node scripts/timeline.ts <project> <target-prefix>... [--full] [--json] [--raw]`. Texto legível por padrão (uma seção por target, marca `[superseded by <id>]`/`[revoked by <id>]`, relações de entrada e saída); `--full` imprime cada anexo entre `----- attachment <hash> (<n> bytes) -----` e `----- end -----`; `--json` é JSONL (`kind: "record"`). A saída (texto e `--json`) passa uma vez por `escapeControls` na string final antes do `process.stdout.write`: ESC, CSI, OSC, U+009B, U+009D e os controles bidi saem como `\uXXXX` visível, e o `--json` volta ao original no `JSON.parse`. `--raw` imprime o byte exato (o `--full --raw` entre os delimitadores é idêntico ao anexo) e fica por conta de quem lê. Um anexo com a linha `----- end -----` ainda forja o delimitador no modo texto. Exit 0 íntegro, 2 cadeia, `process.json` ou anexo quebrado e dado 0.x, 1 uso incorreto ou erro (`timeline failed: CODE: msg`). Sem script `npm` dedicado; nunca escreve no diretório de dados |
| `rdsc-projections.ts`, `rdsc-projections-run.ts` | Snapshot read-only de um processo em JSONL, lido por `composeReader`, que não decodifica nem imprime o conteúdo do anexo (só o hash e o `attachmentStatus` do registro). Uso: `node scripts/rdsc-projections.ts <project> <process> [--gate <name>]... [--gate-per-target <gate>:<regex>]... [--since <marker-json>]`. Linhas, nesta ordem: `meta`, um `record` por registro (ordem do log, `current` booleano), os `gate` (cada `--gate` com `target: null`, depois cada `--gate-per-target` com os rótulos em ordem natural), `changes` (só com `--since`) e `end` (contadores de `record` e `gate` emitidos; as linhas de erro de gate contam). O módulo `-run` exporta `run` (síncrono, sobre um leitor estreito injetável: `queryRecords`, `evaluateGate` e `loadProcess`) e `parseRdscArgs`, sem efeito ao importar; o entrypoint só liga o `main`, porque o jest roda em CJS e não importa um arquivo que executa o `main` ao carregar (o mesmo motivo de `escape-controls.ts`). Duas leituras do processo (todos os registros e só os vigentes) conferidas pelo `marker`: se um `register` cai no meio, repete até 3 vezes e, esgotadas, `INTERNAL` com `marker changed on 3 consecutive reads` e exit 1, comportamento esperado sob rajada de `register`, não defeito. `current` vem da segunda leitura. `attachmentStatus` é o estado do blob na leitura, vindo de um re-hash do blob (`adapters/fs/attachment-store.ts#statusOf`) feito nas duas leituras de cada tentativa, e não acompanha o `marker`. **Exceção ao teto de saída (`saidas-com-teto`, premissa de `docs/directives/estrategia.md`):** as duas leituras pedem `limit: Number.MAX_SAFE_INTEGER` numa chamada só, sem laço de cursor, e o teto de 64 MiB por processo limita a memória; a exceção vale só para os scripts de leitura em `scripts/` (`insights.ts`, `export.ts`, `timeline.ts` e este) e nunca para as tools MCP, que seguem com teto. Gate ausente do manifesto sai como linha `{"kind":"gate","gate":"<nome>","error":"GATE_NOT_FOUND"}` e gate com pergunta `scope: "project"` como `PROJECT_SCOPE_UNSUPPORTED` (o marcador nomeia só este processo), as duas com exit 0 e uma linha só, mesmo com `--gate-per-target`. `--gate-per-target` avalia cada rótulo (primeiro segmento do target, antes do primeiro `.`) dos registros vigentes que casa o regex, em `Intl.Collator('en', { numeric: true })` com desempate por unidade de código; o `evaluateGate` reverifica o log a cada chamada, então N rótulos custam N verificações. `--since` aceita só `{"<process>": <id>\|null}`: JSON inválido, outra chave, chave extra ou valor errado saem 1 com o uso; id que não existe no log lido (inclusive de outro processo) gera `changes` com `baseline: false` e listas vazias, exit 0. Saída montada inteira em memória e escrita de uma vez: em qualquer falha o stdout fica vazio. Toda linha passa por `escapeControls`. Falha: `rdsc-projections failed: CODE: msg` em stderr. Sem script `npm` dedicado; nunca escreve no diretório de dados |

### Exit codes dos scripts de leitura
| Exit | `export.ts` | `timeline.ts` | `insights.ts` | `rdsc-projections.ts` |
|---|---|---|---|---|
| 0 | íntegro | íntegro | íntegro (ou sem processos, sem filtro) | íntegro, **inclusive anexo ausente ou corrompido** (`attachmentStatus` no `record`), gate não fixado ou de escopo projeto (linha de erro) e `baseline: false` |
| 1 | uso incorreto, campo inválido, erro | uso incorreto, nome inválido, erro | uso incorreto, filtro sem resultado, falha de leitura de um processo (linha `insights failed: CODE: msg` sob o título dele) | uso incorreto (regex inválido, `<gate>:<regex>` incompleto, `--since` malformado), projeto ou processo inexistente (`PROCESS_NOT_FOUND`: lê com scope `process`, não `PROJECT_NOT_FOUND` como o `timeline`) e `INTERNAL` na exaustão das 3 leituras |
| 2 | dado 0.x (`LEGACY_DATA`) e `PROCESS_CORRUPTED` (cadeia adulterada incluída) | dado 0.x, `PROCESS_CORRUPTED` e anexo ausente ou corrompido | dado 0.x (`LEGACY_DATA`), `PROCESS_CORRUPTED` (cadeia adulterada ou `process.json` ilegível) e anexo ausente ou corrompido | dado 0.x (`LEGACY_DATA`) e `PROCESS_CORRUPTED` (cadeia adulterada ou `process.json` ilegível) |

Regra única dos quatro: 2 é dado quebrado (o operador resolve no dado, não no comando), 1 é o resto e 0 é íntegro. Diferença deliberada: anexo ausente ou corrompido é dado quebrado para o `timeline` e o `insights` (saem 2), mas o `rdsc-projections` não decodifica o anexo (só o re-hash do blob) e só avisa pelo `attachmentStatus` (sai 0), por contrato do pedido (o gravador que consome o snapshot só avisa). O `insights` agrega: `processReport` devolve o `exitCode` de cada processo (`formatCliError` na falha de leitura; 2 para cadeia ou anexo quebrado) e `main` devolve o maior, então um processo ilegível por `IO_ERROR` (1) junto com uma cadeia quebrada (2) sai 2. A falha de leitura imprime `formatCliError` (código e detalhes) sob o título do processo e não derruba os demais. Um `process.json` ilegível entra na enumeração (`ProcessReader#list` só confere que o manifesto existe) e sai como linha `PROCESS_CORRUPTED` do processo, não como erro da listagem (issue #75, N3).

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
  - `test/rdsc-projections-cli.spec.ts`: roda `scripts/rdsc-projections.ts` como
    processo real (`spawnSync`) contra um `XDG_DATA_HOME` temporário e importa
    `scripts/rdsc-projections-run.ts` direto para o leitor roteirizado (repetição e
    exaustão das 3 leituras); describes `saída do snapshot`, `chaves por kind`,
    `--gate`, `--gate-per-target`, `--since`, `apoio vencido e controles`,
    `anexos` (ausente e corrompido saem 0), `exit 1: uso e leitura recusada`,
    `exit 2: dado que o operador resolve` e `leitor roteirizado`.
  - `test/escape-controls.spec.ts`: `escapeControls` sobre cada classe de
    controle (C0, DEL, C1, bidi), o que passa intacto (LF, TAB, acento, emoji,
    BOM) e a idempotência.
- `import.meta.main`/`import.meta.dirname` são usados nos dois scripts para
  o modo executável direto — incompatíveis com o transform CJS do ts-jest,
  por isso `src/installation.ts` tem a sua `hasDynamicRequire` em vez de
  importar de `build.ts`.

## Dependencies
### Internal
- `build.ts`: nenhuma (só resolve caminhos da raiz do repo)
- `install.ts`: `./build.ts` (`build`, `repoRoot`), `../src/adapters/fs/data-format.ts` (`detectLegacy`), `../src/adapters/fs/io.ts` (`readIfPresent`), `../src/archive.ts` (`archiveLegacy`, `inspectLegacy`), `../src/directory.ts`, `../src/guard.ts`, `../src/installation.ts`
- `cli-error.ts`: `../src/compose.ts` (`composeReader`), `../src/directory.ts`, `../src/errors.ts` (`HexlogError`, `legacyDataError`)
- `escape-controls.ts`: nenhuma
- `rdsc-projections.ts`: `./cli-error.ts` (`formatCliError`, `openReadOnly`), `./rdsc-projections-run.ts`
- `rdsc-projections-run.ts`: `./cli-error.ts` (`parseCliArgs`), `./escape-controls.ts`, `../src/domain/ids.ts` (`Name`, `RecordId`, tipo `Marker`), `../src/errors.ts` (`HexlogError`), `../src/compose.ts` e `../src/queries/query-service.ts` (só tipos)
- `insights.ts`: `./cli-error.ts`, `../src/directory.ts` (`dataDir`, só para a mensagem de "No processes found"), `../src/domain/chain.ts` (tipo `Link`)
- `export.ts`: `./cli-error.ts`, `../src/domain/ids.ts`, `../src/queries/query-service.ts` (tipo `QueryRecord`)
- `timeline.ts`: `./cli-error.ts`, `./escape-controls.ts`, `../src/domain/ids.ts`, `../src/queries/query-service.ts`

### External
- `esbuild`
- `@modelcontextprotocol/client` (`Client`, `StdioClientTransport`; devDependency)
- `es-toolkit` (core e `es-toolkit/compat`)
- `node:fs`, `node:os`, `node:path`, `node:child_process` (`execFileSync`), `node:util` (`parseArgs`, em `cli-error.ts`)

## Manual Notes

## Diretrizes

- [fronteiras.md](../docs/directives/fronteiras.md): scripts de leitura só por `composeReader`, execução externa injetada
- [instalacao-e-hooks.md](../docs/directives/instalacao-e-hooks.md): instalador, bundles fixos, skills dinâmicas e o efeito de mudar o hook ou o servidor
- [qualidade-e-testes.md](../docs/directives/qualidade-e-testes.md): comandos antes de concluir
