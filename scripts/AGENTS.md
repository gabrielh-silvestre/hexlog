<!-- Parent: ../AGENTS.md -->
<!-- Generated: 2026-09-17 | Updated: 2026-09-17 -->

# scripts

## Purpose
Entrypoints reais de build, instalação e relatório do hexlog. `build.ts` e
`install.ts` ligam as funções puras de `src/guard.ts` e `src/installation.ts`
a I/O de verdade: `esbuild`, `fs`, `child_process` e o cliente MCP.
`insights.ts` lê os logs já gravados e imprime um relatório, sem escrever
nada; `export.ts` despeja o log de um processo em JSONL, também sem escrever;
`timeline.ts` cruza os processos de um projeto por prefixo de target e imprime a
linha do tempo (com anexos e estado de integridade), também sem escrever. Os três
leem por `src/compose.ts#composeReader` (só o lado de leitura, sem serviço de escrita) e recusam
dado 0.x com exit 2.

## Key Files
| File | Description |
|---|---|
| `build.ts` | Builda com `esbuild` os dois entrypoints (`server`: `src/server.ts`, `bash-guard`: `hook/bash-guard.ts`) para ESM `node24`, bundled, extensão `.mjs`. Sempre resolve a partir da raiz do repo (`import.meta.dirname`), nunca do cwd, pra garantir os mesmos bytes independente de quem chama. Exporta `build()` (usado por `install.ts` com `write: false` para pegar os bytes em memória) e `hasDynamicRequire()` (detecta o shim de `require` dinâmico que o esbuild injeta para dependência CJS não embutida) |
| `install.ts` | Instalador/verificador versionado. `node scripts/install.ts` builda os bundles, verifica o artefato preparado antes de trocar qualquer coisa (hook nega `D`/permite o resto; servidor sobe e anuncia as 11 tools), copia para `~/.local/lib/hexlog/<versão>/` com troca atômica, grava `manifest.json` (sha256, commit, `dirty`), registra as 4 regras de deny + o hook `PreToolUse` em `~/.claude/settings.json` (backup em `settings.json.bak-hexlog`) e o servidor MCP via `claude mcp add`/`remove`. `node scripts/install.ts --check` só verifica, sem tocar em nada: ignora `--archive-0x` e nem chama `detectLegacy`, então um `<D>` ilegível (`EACCES`, `ENOTDIR`) não o derruba. Regra de `permissions.deny` de um `<D>` antigo que o guard tira é impressa (`removed deny rule: <regra>`), nunca em silêncio. Com dado 0.x em `<D>` (`adapters/fs/data-format.ts#detectLegacy`), sem flag lista o que `src/archive.ts#inspectLegacy` arquivaria e sai 2 sem alterar `<D>` nem a instalação; `--archive-0x` roda `archiveLegacy` e segue para a instalação (imprime arquivos e caminho do `.tar`, ou `removed N empty 0.x directories` quando só havia diretórios vazios; `ArchiveError`: stderr, exit 1, sem instalar). A listagem cita `<D>/archive/` porque o nome do `.tar` só existe depois de `archiveLegacy`. Argumento desconhecido é recusado com exit 1 antes de qualquer escrita (decisão da issue #71, fora do plano; coberta em `test/guard.spec.ts`, describe B3) |
| `cli-error.ts` | `formatCliError(prefix, error)`: a linha `<prefix> failed: CODE: message (detalhes)` e o exit code (2 para `LEGACY_DATA` e `PROCESS_CORRUPTED`, 1 para o resto) dos três scripts de leitura; a recusa de dado 0.x vem de `src/errors.ts#legacyDataError`, a mesma do kernel MCP (P11). Omite o detalhe que só repete a mensagem (`project not found (project not found)`) e mantém o `processo:` do `PROCESS_CORRUPTED`. `openReadOnly()` abre o `composeReader` sobre o `<D>` de `XDG_DATA_HOME` e lança `LEGACY_DATA` com dado 0.x (o preâmbulo único dos três scripts). `parseCliArgs(argv, options)` é o `node:util#parseArgs` estrito: opção desconhecida ou sem valor devolve `undefined`, e o script imprime o uso com exit 1 |
| `escape-controls.ts` | `escapeControls(text)`: troca C0 (menos LF e TAB), DEL, C1 e os controles bidi por `\uXXXX` visível (minúsculo, como o `JSON.stringify`). Mora em módulo próprio porque importar `timeline.ts` executaria o `main`; só o `timeline.ts` o usa |
| `insights.ts` | Relatório markdown read-only (integridade da cadeia, linha do tempo e sinais da `key`, SE8: possível duplicata sem chave, chave em excesso (G4: lote de 1 registro com `key` cuja impressão nenhum outro lote repete) e percentual de lotes com chave por tipo) sobre os registros do hexlog, lidos por `composeReader` (`loadProcess` para os elos crus; `list` e `listProjects` do `ProcessReader` para enumerar sem ler o manifesto, então um `process.json` ilegível vira só a linha do processo e o relatório dos demais sai inteiro). Cadeia quebrada imprime `N valid records` e, sem nenhum elo válido, `timeline: unavailable (chain broken)`. A chave em excesso é um proxy: o reenvio com a mesma `key` devolve `replayed` sem gravar, então o log não registra "nunca teve reenvio"; as seções de gates e forks do 0.x saíram porque `evaluate_gate` não grava mais. Uso: `node scripts/insights.ts [projeto[/processo]]`; lê o diretório de dados via `dataDir`/`XDG_DATA_HOME`. Exit pela regra única dos três scripts (tabela abaixo); `main` devolve o maior código dos processos. Argumento desconhecido ou a mais sai com o uso e exit 1. Sem script `npm` dedicado; nunca escreve no diretório de dados |
| `export.ts` | Exportação read-only dos registros de um processo em JSONL, uma linha por registro (inclui os não vigentes), lidos por `composeReader` em uma única consulta sem laço de cursor (o teto de 64 MiB por processo limita a memória). Uso: `node scripts/export.ts <project>/<process> [--fields a,b,c]`; `--fields` projeta só as chaves pedidas e recusa nome fora das chaves de `QueryRecord`; `--fields` sem valor, flag desconhecida e argumento a mais saem com o uso e exit 1. Cadeia adulterada ou dado 0.x saem com 2 (SL1, P11); demais erros saem com `export failed: ...` e exit 1. Sem script `npm` dedicado; nunca escreve no diretório de dados |
| `timeline.ts` | Linha do tempo read-only de targets por consulta de alcance projeto com registros não vigentes, lida por `composeReader`, sem teto de página nem de texto por entrada, numa consulta só sem laço de cursor (o teto de 64 MiB vale por processo e o alcance projeto soma todos eles, limite aceito, pendência aberta sem ADR): o caminho para ler anexo grande. Uso: `node scripts/timeline.ts <project> <target-prefix>... [--full] [--json] [--raw]`. Texto legível por padrão (uma seção por target, marca `[superseded by <id>]`/`[revoked by <id>]`, relações de entrada e saída); `--full` imprime cada anexo entre `----- attachment <hash> (<n> bytes) -----` e `----- end -----`; `--json` é JSONL (`kind: "record"`). A saída (texto e `--json`) passa uma vez por `escapeControls` na string final antes do `process.stdout.write`: ESC, CSI, OSC, U+009B, U+009D e os controles bidi saem como `\uXXXX` visível, e o `--json` volta ao original no `JSON.parse`. `--raw` imprime o byte exato (o `--full --raw` entre os delimitadores é idêntico ao anexo) e fica por conta de quem lê. Um anexo com a linha `----- end -----` ainda forja o delimitador no modo texto. Exit 0 íntegro, 2 cadeia, `process.json` ou anexo quebrado e dado 0.x, 1 uso incorreto ou erro (`timeline failed: CODE: msg`). Sem script `npm` dedicado; nunca escreve no diretório de dados |

### Exit codes dos scripts de leitura
| Exit | `export.ts` | `timeline.ts` | `insights.ts` |
|---|---|---|---|
| 0 | íntegro | íntegro | íntegro (ou sem processos, sem filtro) |
| 1 | uso incorreto, campo inválido, erro | uso incorreto, nome inválido, erro | uso incorreto, filtro sem resultado, falha de leitura de um processo (linha `insights failed: CODE: msg` sob o título dele) |
| 2 | dado 0.x (`LEGACY_DATA`) e `PROCESS_CORRUPTED` (cadeia adulterada incluída) | dado 0.x, `PROCESS_CORRUPTED` e anexo ausente ou corrompido | dado 0.x (`LEGACY_DATA`), `PROCESS_CORRUPTED` (cadeia adulterada ou `process.json` ilegível) e anexo ausente ou corrompido |

Regra única dos três: 2 é dado quebrado (o operador resolve no dado, não no comando), 1 é o resto e 0 é íntegro. O `insights` agrega: `processReport` devolve o `exitCode` de cada processo (`formatCliError` na falha de leitura; 2 para cadeia ou anexo quebrado) e `main` devolve o maior, então um processo ilegível por `IO_ERROR` (1) junto com uma cadeia quebrada (2) sai 2. A falha de leitura imprime `formatCliError` (código e detalhes) sob o título do processo e não derruba os demais. Um `process.json` ilegível entra na enumeração (`ProcessReader#list` só confere que o manifesto existe) e sai como linha `PROCESS_CORRUPTED` do processo, não como erro da listagem (issue #75, N3).

## For AI Agents
### Working In This Directory
- A lógica de negócio dos dois scripts vive em `src/guard.ts`
  (`expectedRules`, `applyGuard`, `verifyGuard`, `hookProbes`,
  `sha256`) e `src/installation.ts` (`installArtifact`, `registerGuard`,
  `needsMcpRegistration`, `verifyInstallation`) — esses módulos são puros e
  testáveis, sem chamar `esbuild`/`claude` de verdade (`src/installation.ts`
  já chama `fs` real: é quem grava os arquivos instalados). `install.ts` é só
  a fiação: injeta `runRealHook`, `countTools` (sobe o servidor num
  `HOME` descartável e conta `tools.length`) e `registerMcp` (`claude mcp
  remove`+`add`, substituível por `HEXLOG_REGISTER_MCP=<script>` nos testes).
- Mudar `hook/bash-guard.ts` ou `src/server.ts` na working tree não afeta
  nenhuma sessão em andamento nem nova até rodar `node scripts/install.ts`
  de novo: sessões sempre executam a cópia versionada em
  `~/.local/lib/hexlog/<versão>/`.
- Instalação é idempotente pelos bytes instalados (compara sha256 do build
  atual contra o instalado) e trata concorrência entre dois instaladores
  rodando ao mesmo tempo via troca atômica (`renameSync`) com fallback em
  `ENOTEMPTY`/`EEXIST`/`ENOENT`.
- Os 2 bundles (`server`, `bash-guard`) são um conjunto fixo e nomeado (tipo
  `Bundles` em `src/installation.ts`): um terceiro entrypoint exige tocar
  `build.ts`, `Bundles`, `installArtifact` e
  `verifyInstallation`. Já as skills são dinâmicas: `skillNames()` lê as
  pastas de `skills/` e `writeSkillFolder` copia cada uma para um diretório
  temporário e troca para `~/.claude/skills/<nome>/` via `swapDirectory`
  (mesmo mecanismo de `swapArtifact`, com rollback se a troca falhar no
  meio: o destino nunca fica ausente ou parcial). Sobrescreve sem backup.
  Skill nova não toca `install.ts`.

### Testing Requirements
- `npm test` (jest) roda tudo, incluindo:
  - `test/toolchain.spec.ts`: builda os probes com o `esbuild` real
    e confere que nenhum bundle contém o shim `Dynamic require of`, e que o
    hook empacotado (`hook-probe.mjs`) sai com o código esperado.
  - `test/package.spec.ts` (N11): `dependencies`/`devDependencies` do
    `package.json` batem exatamente com o manifesto do projeto (sem
    `^`/`~`/faixas), `engines.node` é `>=24.18.1`.
  - `test/guard.spec.ts`: `B2` chama `installArtifact`/`registerGuard`
    direto; `B3` roda `scripts/install.ts --check` como processo real
    (`spawnSync`), sempre com `HOME` temporário — nunca o `HOME` real.
  - `test/insights.spec.ts`: roda `scripts/insights.ts` como processo real
    (`spawnSync`) contra um `XDG_DATA_HOME` temporário; describes `filtro
    posicional`, `sinais da chave (SE8)`, `cadeia adulterada (SL1)` (inclui o
    `process.json` truncado e o caso misto de exit 1 e 2), `uso incorreto`, `dado
    0.x (P11)` e a trava de que nada foi escrito no diretório de dados.
  - `test/export.spec.ts`: roda `scripts/export.ts` como processo real
    (`spawnSync`) contra um `XDG_DATA_HOME` temporário; describes `sem
    --fields`, `--fields`, `uso incorreto e processo inexistente`,
    `integridade` (SL1), `dado 0.x` (P11) e `read-only`.
  - `test/timeline-cli.spec.ts`: roda `scripts/timeline.ts` como processo real
    (`spawnSync`) contra um `XDG_DATA_HOME` temporário; describes `--full`
    (com `--raw`, texto ≥ 200 KB idêntico entre os delimitadores), `escape de
    terminal` (sem `--raw`, com `--raw` e com `--json`), `texto legível`,
    `--json`, `read-only`, `integridade` (exit 2), `dado 0.x` (P11) e
    `uso incorreto e erros`.
  - `test/escape-controls.spec.ts`: `escapeControls` sobre cada classe de
    controle (C0, DEL, C1, bidi), o que passa intacto (LF, TAB, acento, emoji,
    BOM) e a idempotência.
- `npm run typecheck` (`tsc --noEmit`) e `npm run build` (`node
  scripts/build.ts`, equivalente ao passo 1 do instalador) também cabem
  aqui antes de qualquer PR que toque nestes dois arquivos.

### Common Patterns
- `import.meta.main`/`import.meta.dirname` são usados nos dois scripts para
  o modo executável direto — incompatíveis com o transform CJS do ts-jest,
  por isso `src/installation.ts` duplica `hasDynamicRequire` em vez de
  importar de `build.ts`.
- Toda execução externa (`runHook`, `verifyServer`, `clock`, `log`)
  é passada por parâmetro para as funções de `src/`, nunca chamada direto —
  é isso que torna `installArtifact`/`verifyInstallation` testáveis sem
  processo real.

## Dependencies
### Internal
- `build.ts`: nenhuma (só resolve caminhos da raiz do repo)
- `install.ts`: `./build.ts`, `../src/directory.ts`, `../src/guard.ts`, `../src/installation.ts`
- `cli-error.ts`: `../src/compose.ts` (`composeReader`), `../src/directory.ts`, `../src/errors.ts` (`HexlogError`, `legacyDataError`)
- `escape-controls.ts`: nenhuma
- `insights.ts`: `./cli-error.ts`, `../src/directory.ts` (`dataDir`, só para a mensagem de "No processes found"), `../src/domain/chain.ts` (tipo `Link`)
- `export.ts`: `./cli-error.ts`, `../src/domain/ids.ts`, `../src/queries/query-service.ts` (tipo `QueryRecord`)
- `timeline.ts`: `./cli-error.ts`, `./escape-controls.ts`, `../src/domain/ids.ts`, `../src/queries/query-service.ts`

Os três scripts de leitura nunca importam `src/adapters/**` nem `src/mcp/**`: `eslint.boundaries.js` (`scriptsBlock`) barra os dois, com exceção para `install.ts` e `build.ts`, e `test/boundaries.spec.ts` trava.

### External
- `esbuild`
- `@modelcontextprotocol/client` (`Client`, `StdioClientTransport`; devDependency)
- `es-toolkit` (core e `es-toolkit/compat`)
- `node:fs`, `node:os`, `node:path`, `node:child_process`, `node:util` (`parseArgs`, em `cli-error.ts`)

<!-- MANUAL: Any manually added notes below this line are preserved on regeneration -->
