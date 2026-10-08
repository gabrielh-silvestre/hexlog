# commands

**Parent context:** `../AGENTS.md`
**Generated:** 2026-10-07 · **Updated:** 2026-10-07

## Purpose

Serviços de escrita do servidor: cada um recebe as portas por injeção (`createXService(deps)`) e devolve um objeto com as operações que as tools de `mcp/` expõem. Todo `define_*`, `create_process`, `attach` e `register` passa por aqui. A recusa que só depende da entrada acontece antes de qualquer I/O ou lock. Nenhum serviço importa `adapters/`, builtin do Node nem outro serviço de `commands/` ou `queries/`.

## Key Files

| File | Description |
|------|-------------|
| `attachment.ts` | `createAttachmentService` e os tipos `AttachInput`/`AttachmentService`: `attach` aceita exatamente um de `text`/`path` e recusa na ordem `bad-args`, NUL e segmento acima de 255 bytes no `path`, `bad-extension` (só `.md`/`.txt`) e, no `text`, vazio e surrogate solto, antes de chamar `AttachmentStore#putText` ou `putPath` |
| `definition.ts` | `createDefinitionService` (`defineType`, `defineRelation`, `defineGate`) sobre um só motor de versão imutável (`defineVersioned`), com `Defined` (`created` falso no replay, `previousVersion`, `divergentVersions`); `breaking: true` sobe o major, e o retry relê o estado enquanto outro escritor ocupa a versão alvo |
| `process.ts` | `createProcessService` com `createProcess` (idempotente por nome, fixa a versão vigente de cada tipo, relação e gate num manifesto e devolve `stale` se uma definição mudou depois) e `register` (`checkBatchShape` e `prepareBatch` antes do lock, depois `store.write` com o `decide` síncrono, e o log `batch-replayed` no replay); reexporta `RegisterInput` e `RegisterResult` |

## Subdirectories

| Directory | Purpose |
|-----------|---------|
| `register/` | Peças do `register`: regras estáticas (`static.ts`), `decide` sob o lock (`state.ts`), checagem de anexos (`attachments.ts`) e fábricas de erro (`errors.ts`) (see `register/AGENTS.md`) |

## Dependencies

### Internal
- `../domain/` (`chain.ts`, `ids.ts`, `manifest.ts`, `definitions.ts`, `record.ts`, `relations.ts`): tipos, schemas e regras puras que os serviços aplicam
- `../ports.ts`: `DefinitionStore`, `ProcessStore`, `AttachmentStore` e `Validator`, injetados em cada `createXService`
- `../errors.ts`: `HexlogError` e os construtores de erro estruturado
- `../shared/` (`latest.ts`, `loader.ts`, `logger.ts`): versões vigentes, verificação do log e o tipo `Logger`

### External
- `es-toolkit`: predicados e helpers (`isUndefined`, `omitBy`, `isEqual` e afins)
- `zod`: só o tipo `ZodType` em `definition.ts`

## Manual Notes
