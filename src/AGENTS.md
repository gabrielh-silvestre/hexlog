<!-- Parent: ../AGENTS.md -->
<!-- Generated: 2026-09-17 | Updated: 2026-09-17 -->

# src

## Purpose
Código-fonte TypeScript do servidor MCP stdio `hexlog`: expõe exatamente 12 tools para agentes registrarem seu histórico de trabalho (Marcos, Vereditos, gates, anexos) num log JSONL append-only com cadeia de hash por processo, mais o instalador que versiona o artefato e instala o hook de isolamento Bash no Claude Code.

## Key Files
| File | Description |
|---|---|
| `search.ts` | Índice de texto MiniSearch sob demanda (§4.17): `indexableText`, `search` (AND com fallback OR), filtros estruturados (`isCandidate`) |
| `chain.ts` | Núcleo da cadeia de hash: `sha256hex`, `hashLine`, `anchor`, `isValidLink` (predicado único escritor/verificador), `verifyChain` (com o estado dos anexos já verificado pelo chamador), `attachmentRefs` (hashes de anexo que o log referencia) |
| `attachments.ts` | Anexos endereçados por sha256 dos bytes em `<projeto>/attachments/<sha256>` (ADR 0006): `putAttachmentText`, `putAttachmentPath` (só `.md` direto em `<cwd>/.omc/plans`: `O_NOFOLLOW`, `nlink` 1, caminho do fd conferido depois do `open`, erros sem caminho absoluto), `readAttachmentPage`, `checkAttachment` (re-hash sempre; symlink, FIFO, diretório ou arquivo acima do teto contam como `corrupted`) e `checkAttachmentMemoized` (memo por `ino`/`size`/`mtimeMs`/`ctimeMs`, só para o `state`) |
| `pages.ts` | `sliceChars`: corte de texto em caracteres sem partir par surrogate, puro (usado por `attachments.ts` e `timeline.ts`) |
| `timeline.ts` | Projeção pura da timeline (`projectTimeline`): processos já carregados por target, em ordem cronológica, com superados, estado da cadeia e dos anexos, avisos e paginação. Sem I/O |
| `timeline-tools.ts` | Loader da timeline (`loadTimelineInput`, `loadTimeline`: I/O, verifica cadeia e anexos) e registro das 2 tools `attachment` e `timeline` |
| `storage.ts` | I/O de baixo nível: `resolveSafePath` (defesa contra path escape), `writeJsonAtomic` (tmp+fsync+rename), `readJson`, `ioError`, nomes reservados |
| `definitions.ts` | Persistência versionada (semver `major.minor`) de tipos/vocabulário/gates custom e do `process.json` fixado: `registerType` (valida com Ajv2020), `registerVocabulary`, `registerGate`, `decideVersion`, `writeVersionExclusive`, `createProcess`, `loadProcess`, `listProjects`, `readProject` |
| `directory.ts` | `dataDir(env)`: resolve `$XDG_DATA_HOME/hexlog` ou `~/.local/share/hexlog` |
| `errors.ts` | `HexlogError` (classe de erro de domínio com `code`/`details`), `ErrorCode` (25 códigos), `issueDetails` (Zod → JSON Pointer) |
| `state.ts` | Projeção pura do Estado (§4.8): `projectState` (active/conflicts/orphans/toReview/invalidReferences/warnings/forks), `validateField` (vocabulário) |
| `events.ts` | Esquemas Zod do envelope de evento e dos tipos nativos: `EventLine`, `MilestoneData`, `VerdictData`, `GateMilestoneData`, `parseId`, `normalizeData` |
| `definition-tools.ts` | Registra as 5 tools de definição: `list`, `register_type`, `register_vocabulary`, `register_gate`, `create_process` |
| `event-tools.ts` | Registra as 5 tools de eventos: `register`, `evaluate_gate`, `state`, `events`, `chain`. O `register` de tipo custom valida `attachment` (blob existe e íntegro) e `supersedes` (ids existem no processo e são custom) |
| `gates.ts` | Os 5 gates embutidos (`no-orphans`, `no-conflicts`, `no-forks`, `chain-intact`, `no-invalid-references`): `evaluateBuiltin`, `buildGateMilestoneData` |
| `guard.ts` | Regras de deny + hook PreToolUse em `settings.json`: `expectedRules`, `applyGuard`, `verifyGuard`. Puro, só usado por `scripts/install.ts` |
| `installation.ts` | Instalação versionada do artefato em `~/.local/lib/hexlog/<versão>/`: `installArtifact`, `registerGuard`, `verifyInstallation`. Puro, só usado por `scripts/install.ts` |
| `log.ts` | Append ao JSONL sob lock exclusivo por diretório: `appendBatch` (N elos numa única aquisição de lock; `append` é o wrapper de 1 item), `readText`, `acquireLock`/`releaseLock` |
| `mcp.ts` | Monta o `McpServer`: `createServer`, `execute` (envelope de erro + log de toda tool), esquemas Zod compartilhados |
| `server.ts` | Ponto de entrada: `serveStdio(() => createServer(...))` |
| `node-types.d.ts` | Augmentation de `node:crypto` com `randomUUIDv7` (ainda não coberto por `@types/node` 24.8.1) |
| `version.ts` | `export const VERSION = '0.4.0'` |

## For AI Agents
### Working In This Directory
- **Cadeia de hash (§4.6):** `hashLine(l) = sha256hex(l.prevHash + JCS(omit(l, 'prevHash')))`; `anchor(manifest) = sha256hex(JCS(manifest))` é a raiz. `isValidLink` é o único predicado usado tanto para escrever (`log.ts`) quanto para verificar (`chain.ts`) — não duplique essa lógica. A cauda do arquivo sem `\n` final é sempre descartada (`split('\n').slice(0, -1)`).
- **Append-only, sem tool de edição/remoção:** `log.ts` só abre o arquivo em modo `'a'` (append) e faz `fsyncSync` antes de fechar. Não existe tool nem função que reescreva ou remova uma linha do `events.jsonl`; qualquer alteração externa é detectada pela tool `chain`.
- **Lock por diretório (`log.ts`):** `append` cria `<arquivo>.lock/` via `mkdirSync` (falha `EEXIST` se já existe) e grava um token em `holder`. Retry a cada 10ms até 5000ms (`LOCK_TIMEOUT`); lock com `mtime` > 10s é considerado órfão e removido. Antes de escrever, `append` confere se o token em `holder` ainda é o seu — senão lança `LOCK_LOST`. A espera é assíncrona; a seção crítica (montar + escrever a linha) é síncrona, sem `await`.
- **Exatamente 12 tools**, fixado e exportado por `installation.ts` (`TOOLS_COUNT = 12`, lido pelos stubs de contagem dos testes) e verificado pelo instalador antes de trocar o artefato: 5 em `definition-tools.ts` + 5 em `event-tools.ts` + 2 em `timeline-tools.ts` (`attachment`, `timeline`).
- **Anexos (`attachments.ts`, ADR 0006):** o blob é imutável e nunca sobrescrito (escrita por `link` exclusivo; `EEXIST` relê e compara o hash). Cadeia e `timeline` re-hasheiam o blob sempre; só o caminho do `state` usa o memo. O `verifyChain` não faz I/O: recebe o `Map` hash → estado montado pelo loader com `attachmentRefs`.
- **Versionamento de definições (`definitions.ts`):** `registerType`/`registerVocabulary`/`registerGate` gravam `<nome>/<versão>.json` em vez de sobrescrever — versão `major.minor`, decidida por `decideVersion` (unchanged/minor/major/`BREAKING_CHANGE`) e persistida por `writeVersionExclusive`. O arquivo legado `<nome>.json` **nunca** é apagado, reescrito nem materializado por cópia: continua sendo a fonte da versão `1.0` para sempre, e o diretório de versões começa em `1.1` quando existe. `process.json` ganha o bloco opcional `versions` (`FixedVersions`), fixado na criação e **fora** de `verifyHashes` — adulterável sem disparar `PROCESS_CORRUPTED`.
- **Registro de tool:** toda chamada passa por `execute()` (`mcp.ts`), que nunca deixa uma exceção chegar ao SDK — `HexlogError` vira `{code, message, details}`, qualquer outra exceção vira `INTERNAL` (stack só no log `internal-error`, nunca na resposta). `execute` também emite sempre um log `tool` com `name`/`project`/`process`/`ms`/`code?`, nunca o conteúdo de `data`.
- **Convenção de erro (`errors.ts`):** todo erro de domínio é uma instância de `HexlogError` com um dos 25 códigos de `ErrorCode` (ex.: `INVALID_INPUT`, `CONFLICTING_ID`, `VOCABULARY_VIOLATED`, `LOCK_TIMEOUT`). Erros de validação Zod viram `details[]` via `issueDetails`, com `path` em formato JSON Pointer (RFC 6901).
- **Nomes reservados:** `milestone`/`verdict` como nome de tipo, `schemas`/`vocabulary`/`gates`/`attachments` como nome de processo, e os 5 nomes de gate embutido — todos rejeitados com `RESERVED_NAME` (`definitions.ts`).
- **Módulos de instalação são puros e isolados:** `guard.ts` e `installation.ts` não são importados por `server.ts` nem pelo hook; só por `scripts/install.ts` (fora de `src/`). Toda execução externa (spawn do hook, subida do servidor, relógio) entra por parâmetro injetado — nunca chamada direta a `child_process`/`Date.now` dentro da lógica testável.

### Testing Requirements
```sh
npm test          # jest: testa o .ts fonte diretamente
npm run typecheck # tsc --noEmit
npm run build     # esbuild -> bundles .mjs (mesmo passo 1 do instalador)
```
- `npm ci` precisa ser completo (sem `--omit=dev`): `esbuild` e `@modelcontextprotocol/client` são dependências de desenvolvimento usadas pelo instalador/testes.
- Specs em `test/` espelham os módulos: `chain.spec.ts`, `attachments.spec.ts`, `timeline.spec.ts` + `timeline-cli.spec.ts`, `audit-types.spec.ts`, `search.spec.ts` + `search.budget.spec.ts`, `definitions.spec.ts`, `directory.spec.ts`, `state.spec.ts` + `state.property.spec.ts` (fast-check), `events.spec.ts`, `definition-tools.spec.ts` (cobre também `mcp.ts`), `event-tools.spec.ts`, `gates.spec.ts`, `guard.spec.ts` (cobre também `installation.ts` e `server.ts`), `bash-guard.spec.ts`, `log.spec.ts`, `package.spec.ts`, `toolchain.spec.ts`.
- `stdio.e2e.spec.ts` sobe o servidor a partir do bundle `.mjs` já construído — é o único jeito de testar o artefato que as sessões de fato executam. Rode `npm run build` antes se o teste e2e depender de um bundle atualizado.

### Common Patterns
- Toda escrita em `schemas/`, `vocabulary/`, `gates/` e `process.json` usa `writeJsonAtomic`/`writeThenLinkExclusive`/`writeVersionExclusive` (`storage.ts`/`definitions.ts`): arquivo temporário no mesmo diretório, `fsync`, depois `rename`/`link` — nunca escrita direta no arquivo final. A escrita de uma versão (`<nome>/<versão>.json`) é sempre exclusiva por `linkSync` (`writeVersionExclusive`), nunca `writeJsonAtomic`: `writeJsonAtomic` termina em `rename`, que sobrescreveria em silêncio sob corrida entre dois `register_*` concorrentes no mesmo alvo. Em `EEXIST`, o retry refaz a decisão inteira (vigente, `unchanged`, quebra, bump), não só o número da versão.
- Hash de conteúdo sempre por `sha256hex(canonicalize(valor) ?? '')` (JCS): mesmo padrão em `chain.ts`, `definitions.ts` e na comparação de idempotência de `register` (`event-tools.ts`). **Exceção:** o hash de um anexo (`attachments.ts`) é o `sha256hex` dos **bytes** UTF-8 do texto, não do JCS — o blob é texto opaco, não um objeto JSON (ADR 0006).
- Toda função pura que decide algo (`evaluateBuiltin`, `projectState`, `verifyChain`, `projectTimeline`, `search`) recebe dados já carregados e devolve um valor — nenhuma delas faz I/O; o I/O fica nas bordas (`log.ts`, `storage.ts`, `definitions.ts`).
- Toda lista de saída tem teto e devolve o total real ao lado (ex.: `breaks`/`repairedLines` em 100, seções de `state` em 100, `events` por página de 24.000 caracteres canônicos).
- `isNil`/`isNotNil`/`isEmpty` (es-toolkit) em vez de checagem manual de `undefined`/`null`/comprimento, em todo o código.

## Dependencies
### Internal
Ponto de entrada: `server.ts` → `directory.ts` (resolve dir de dados) + `mcp.ts` (`createServer`).
`mcp.ts` registra as tools chamando `definition-tools.ts`, `event-tools.ts` e `timeline-tools.ts`, e fornece a todos o envelope `execute()` e os esquemas Zod comuns.
`timeline-tools.ts` chama `attachments.ts` (I/O dos blobs), `definitions.ts` (carregar processos), `log.ts`, `chain.ts`, `event-tools.ts` (`readLines`, `validateProcessData`) e `timeline.ts` (projeção pura). `attachments.ts` depende de `chain.ts` (`sha256hex`), `storage.ts` e `errors.ts`; `event-tools.ts` também chama `attachments.ts`.
`definition-tools.ts` chama `definitions.ts` (persistência) e `gates.ts` (lista de gates embutidos).
`event-tools.ts` é o módulo mais conectado: chama `definitions.ts` (carregar processo), `log.ts` (`append`/`readText`), `chain.ts` (`isValidLink`/`verifyChain`), `state.ts` (`projectState`), `gates.ts` (avaliação), `search.ts` (modo busca) e `events.ts` (validação/normalização de `data`).
`definitions.ts`, `chain.ts`, `log.ts`, `state.ts`, `gates.ts` e `search.ts` dependem de `events.ts` (esquema `EventLine`); `definitions.ts`, `chain.ts` e `log.ts` também dependem de `errors.ts` (`HexlogError`). `storage.ts` é a base de I/O usada por `definitions.ts`.
`guard.ts` e `installation.ts` formam um subgrafo isolado (instalação), consumido só por `scripts/install.ts` fora de `src/`.

### External
| Pacote | Uso em `src/` |
|---|---|
| `@modelcontextprotocol/server` | `McpServer`, `serveStdio` — servidor MCP e registro de tools (`mcp.ts`, `server.ts`, `definition-tools.ts`/`event-tools.ts`) |
| `zod` | Esquemas de validação de entrada/saída de toda tool e dos eventos (`events.ts`, `mcp.ts`, `state.ts`, `gates.ts`, `definition-tools.ts`/`event-tools.ts`) |
| `canonicalize` | Serialização JCS para hash determinístico (`chain.ts`, `definitions.ts`, `events.ts`, `event-tools.ts`) |
| `ajv` (`ajv/dist/2020.js`) + `ajv-formats` | Valida schema JSON custom antes de aceitar em `register_type` (`definitions.ts`) |
| `minisearch` | Índice de texto do modo busca de `events` (`search.ts`) |
| `es-toolkit` (+ `es-toolkit/compat`) | Utilitários (`isNil`, `isEmpty`, `groupBy`, `keyBy`, `pick`, `uniqBy`, `omit`, `orderBy`, `round`, `get`) usados em quase todo módulo |
| `jsonc-parser` | Parse/edição de `settings.json` preservando comentários/formatação (`guard.ts`) |
| `shell-quote` | Parse/quote do `command` do hook PreToolUse (`guard.ts`) |

<!-- MANUAL: Any manually added notes below this line are preserved on regeneration -->
