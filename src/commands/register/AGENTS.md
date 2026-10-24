# register

**Parent context:** `../AGENTS.md`
**Generated:** 2026-10-07 · **Updated:** 2026-10-07

## Purpose

Peças do `register` de `commands/process.ts`, divididas pelo momento da recusa: `static.ts` roda antes do lock e só olha a entrada e o manifesto; `state.ts` roda sob o lock da origem, de forma síncrona, e decide a linha única do lote. Qualquer recusa sai antes de gravar.

## Key Files

| File | Description |
|------|-------------|
| `static.ts` | Recusas que só dependem da entrada e do manifesto: `checkBatchShape` (1 a 50 itens, apelidos únicos, `@alias` só para item anterior), `relationNames`, `prepareBatch` (tipo fixado de todos os registros antes do schema, que junta todas as violações de schema de cada registro; `as` para `kind`; `cross-process-currency`), `isAliasRef` e o tipo `PreparedItem` |
| `state.ts` | `RegisterInput`, `RegisterResult` e `createDecide`: sob o lock confere a cadeia, busca a `key` (`replayed` ou `IDEMPOTENCY_CONFLICT`), lê os destinos de outro processo, chama `checkAttachments`, aplica as regras de relação e o ciclo, e monta e valida a linha com `formatLine`/`isValidLine` |
| `attachments.ts` | `checkAttachments`: cada anexo citado em campo marcado existe e está íntegro (`ATTACHMENT_NOT_FOUND`/`ATTACHMENT_CORRUPTED`), e hash de anexo guardado em campo sem a marca é recusado (`unmarked-attachment`); consulta cada hash uma vez por chamada |
| `errors.ts` | `ruleRefusal` (`not-current` vira `FORK_REJECTED`, as demais `INVALID_RECORD`) e o mapa `RULE_MESSAGES`; fica aqui porque tipa por `RuleCode` e `Violation` de `domain/`, o que `../../errors.ts` não pode importar. Os demais erros do `register` (`invalidRecord`, `relationNotFound`, `withPath`) vêm de `../../errors.ts` |

## Dependencies

### Internal
- `../process.ts`: único chamador (o `register` usa `checkBatchShape`, `prepareBatch`, `relationNames` e `createDecide`)
- `../../domain/` (`chain.ts`, `ids.ts`, `manifest.ts`, `record.ts`, `relations.ts`, `definitions.ts`): hash de elo, tipos, `resolveKind` e as regras de relação
- `../../ports.ts`: `AttachmentReader`, `ProcessReader`, `RawProcess` e `Decision`
- `../../shared/loader.ts`: `verifyProcess`, `loadVerified`, `formatLine` e `isValidLine`
- `../../errors.ts`: `HexlogError`, `domainError` e `internalError`, as fábricas de erro do `register` (`invalidInput`, `invalidRecord`, `typeNotPinned`, `brokenChain`, `cycleRejected`, `keyConflict`, `relationNotFound`, `attachmentNotFound`, `attachmentCorrupted`), `withPath` e `capDetails`

### External
- `es-toolkit`: predicados e helpers (`isUndefined`, `omitBy`, `invert`, `memoize`, `once`)

## Manual Notes
