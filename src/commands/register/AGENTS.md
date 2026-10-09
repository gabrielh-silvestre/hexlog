# register

**Parent context:** `../AGENTS.md`
**Generated:** 2026-10-07 · **Updated:** 2026-10-07

## Purpose

Peças do `register` de `commands/process.ts`, divididas pelo momento da recusa: `static.ts` roda antes do lock e só olha a entrada e o manifesto; `state.ts` roda sob o lock da origem, de forma síncrona, e decide a linha única do lote. Qualquer recusa sai antes de gravar.

## Key Files

| File | Description |
|------|-------------|
| `static.ts` | Recusas que só dependem da entrada e do manifesto: `checkBatchShape` (1 a 50 itens, apelidos únicos, `@alias` só para item anterior), `relationNames`, `prepareBatch` (tipo fixado de todos os registros antes do schema, que junta a primeira violação de cada registro; `as` para `kind`; `cross-process-currency`), `isAliasRef` e o tipo `PreparedItem` |
| `state.ts` | `RegisterInput`, `RegisterResult` e `createDecide`: sob o lock confere a cadeia, busca a `key` (`replayed` ou `IDEMPOTENCY_CONFLICT`), lê os destinos de outro processo, chama `checkAttachments`, aplica as regras de relação e o ciclo, e monta e valida a linha com `formatLine`/`isValidLine` |
| `attachments.ts` | `checkAttachments`: cada anexo citado em campo marcado existe e está íntegro (`ATTACHMENT_NOT_FOUND`/`ATTACHMENT_CORRUPTED`), e hash de anexo guardado em campo sem a marca é recusado (`unmarked-attachment`); consulta cada hash uma vez por chamada |
| `errors.ts` | Erros compartilhados do `register`: `invalidRecord`, `ruleRefusal` (`not-current` vira `FORK_REJECTED`, as demais `INVALID_RECORD`), `relationNotFound` e `withPath` (refaz o `path` de erro de porta para o campo certo de `records[i]`) |

## Dependencies

### Internal
- `../process.ts`: único chamador (o `register` usa `checkBatchShape`, `prepareBatch`, `relationNames` e `createDecide`)
- `../../domain/` (`chain.ts`, `ids.ts`, `manifest.ts`, `record.ts`, `relations.ts`, `definitions.ts`): hash de elo, tipos, `resolveKind` e as regras de relação
- `../../ports.ts`: `AttachmentReader`, `ProcessReader`, `RawProcess` e `Decision`
- `../../shared/loader.ts`: `verifyProcess`, `loadVerified`, `formatLine` e `isValidLine`
- `../../errors.ts`: `HexlogError`, `invalidInput`, `brokenChain` e `capDetails`

### External
- `es-toolkit`: predicados e helpers (`isUndefined`, `omitBy`, `invert`, `memoize`, `once`)

## Manual Notes
