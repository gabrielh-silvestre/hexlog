# domain

**Parent context:** `../AGENTS.md`
**Generated:** 2026-10-07 · **Updated:** 2026-10-07

## Purpose

Domínio puro do hexlog: esquemas Zod dos registros, da cadeia de hash, do manifesto, das definições (tipo, relação, gate) e as funções que decidem sobre dados já carregados (vigência, regras de relação, gate, classificação de mudança de definição). Nenhum arquivo faz I/O.

## Key Files

| File | Description |
|------|-------------|
| `ids.ts` | Tipos de identificador: `Name`, `Hash`, `Instant`, `Target`, `RecordId` (`<processo>:<uuidv7>`), `Marker`, `TypeNames` (lista de tipos não vazia e sem repetição), `alias`, `processOf`. Também `RESERVED_PROCESS_NAMES` e `isReservedProcessName`, o predicado único de nome de processo reservado. |
| `record.ts` | `HexRecord`, `Author`, `Relation`, `RelationInput` (`kind` ou `as`, descrito por `KindOrAs`), `RelationKind` (os 8 tipos de relação crus), `AliasRef` e `BatchItem`. `withCanonicalLimit` aplica o teto em caracteres canônicos e vale também para `definitions.ts`. Tetos: `DATA_MAX_CHARS`, `BATCH_MAX`, `RELATIONS_MAX`. |
| `chain.ts` | Cadeia de hash: `sha256hex`, `hashOfJcs`, `fingerprint` (impressão do lote), `hashLink`, `anchor` (hash do manifesto, raiz da cadeia) e `isValidLink`, que confere um elo contra `Expected` e recusa com `LinkRejection` (`invalid-line`, `diverging-seq` ou `hash-mismatch`). Define `Link`, `Batch`, `BatchKey` e os tetos `BATCH_KEY_MAX` e `BATCH_ALIASES_MAX`. |
| `manifest.ts` | `Manifest`: schema estrito do `process.json`, com `project`, `process`, `createdAt`, `fixed` (versões de tipos, relações e gates fixadas no processo) e `hashes` de cada grupo, mais `lineageInheritance?: true`, opcional, gravado só por `create_process` e coberto pela âncora. |
| `definitions.ts` | Schemas `RecordType`, `RelationName` e `Gate` com teto de caracteres canônicos. Semver `major.minor` (`CANONICAL_VERSION`, `parseVersion`, `compareVersions`, `bumpVersion`), `classifyTypeChange` e `classifyRelationChange` (devolvem `Change`), `attachmentFields` e `ATTACHMENT_FORMAT`. Tetos: `RECORD_TYPE_MAX_CHARS`, `RELATION_GATE_MAX_CHARS`, `GATE_QUESTIONS_MAX`. |
| `formats.ts` | Catálogo fechado de formatos que o validador registra além dos do `ajv-formats`: `FORMAT_CATALOG` (hoje só `git-sha`), `isGitSha` (hexadecimal minúsculo de 7 a 40 caracteres) e `catalogNames`. |
| `schema-walk.ts` | Percurso puro dos subschemas de um JSON Schema: `walkSubschemas` (só as palavras-chave que carregam subschema, nunca `const`/`enum`/`default`/`examples`; o `visit` roda antes da descida), `FREE_PATTERN_KEYWORDS` (`pattern` e `patternProperties`), `withoutFreePatterns` (cópia do schema sem essas duas palavras-chave, que o `describe_type` mostra) e `hasKeywordAt` (o ponteiro RFC 6901 resolve num objeto com a palavra-chave). |
| `gate.ts` | Gate declarativo: `GateQuestion` (`approved`, `occurred`, `no_pending`, `no_open_contradiction`), `Selector`, `Where`, `GateScope`, `matchesSelector`, `matchesTargetPrefix` e `evaluateGate`, que devolve `GateResult` com um `QuestionResult` por pergunta; `EvidenceMode` e `summarizeQuestion` reduzem a `evidence` de um `QuestionResult` a `counts` e, só em pergunta reprovada, às listas de diagnóstico (`QuestionSummary`). As perguntas `approved` e `no_pending` aceitam `inherit: true`: somam as relações herdadas (`GateInput.isInheritanceActive` decide por processo) e a `evidence` ganha `inherited`. |
| `inheritance.ts` | Herança de relações pela linhagem de `supersedes`, só na leitura: `buildInheritance` (`supports` sobe o destino, `answers`/`derivesFrom`/`complements`/`reopens` sobem a origem, `contradicts` entre as duas linhagens corta, aresta direta igual vence) devolve `Inheritance` (`into`, `outOf`, `has`) de `InheritedEdge` com `origin`; `NO_INHERITANCE` é a herança vazia. |
| `relations.ts` | Vigência (`buildVigency`: `isCurrent` e `currentOf`, este memoizado), `hasCycle` de `supersedes`, `needsReview` (prova vencida por alcance; o terceiro argumento `Inheritance` faz o `supports` herdado contar como vivo), `checkRelation` e `resolveKind` com as regras de relação (`RuleCode`, `Violation`, `RuleContext`). `incomingOf` indexa as relações de entrada (usado por `gate.ts` e `queries/select.ts`); `pushTo` é o auxiliar de mapa de listas. |

## Dependencies

### Internal

- `../errors.ts`: `HexlogError`, usado por `chain.ts` e `definitions.ts`, e `pointer`, usado por `schema-walk.ts`.

### External

- `zod`: esquemas de todos os arquivos.
- `canonicalize`: JCS em `chain.ts` e `record.ts`.
- `es-toolkit`: predicados e helpers de coleção (`isUndefined`, `isEqual`, `omit` etc.).
- `node:crypto`: `hash` do sha256 em `chain.ts`, o único builtin do Node aqui.

## Manual Notes

## Diretrizes

- [fronteiras.md](../../docs/directives/fronteiras.md)
- [invariantes.md](../../docs/directives/invariantes.md)
