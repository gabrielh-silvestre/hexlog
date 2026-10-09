# shared

**Parent context:** `../AGENTS.md`
**Generated:** 2026-10-07 · **Updated:** 2026-10-07

## Purpose

Código compartilhado entre `commands/` e `queries/`: o carregador que lê e verifica o log de um processo, o tipo de logger e dois helpers puros (versões vigentes de definição e corte de texto por caracteres). Não faz I/O próprio: lê pelas portas de `../ports.ts`.

## Key Files

| File | Description |
|------|-------------|
| `loader.ts` | Leitura e verificação do log: `parseLog`, `isValidLine` (o predicado único de leitura e escrita; devolve `LineCheck` `valid`, `torn` ou `rejected`), `formatLine`, `verifyProcess` (puro, sobre o log cru, com corte opcional em um marcador), `checkExpectedHead` (pura: confere um `expectedHead` contra os elos válidos e acrescenta a quebra `head-not-found`) e `loadVerified` (lê pelo `ProcessReader` e verifica). Devolve `VerifiedProcess` com `chain` (`Chain`, `Break`), `batches` por chave e `end`. Exporta o teto `MAX_BREAKS`. |
| `logger.ts` | `Logger` e `LogRecord`: o único tipo de logger; quem compõe decide para onde a linha vai. |
| `latest.ts` | `latestVersions`: nomes de definição do projeto com a versão vigente e todas as versões em ordem crescente, ignorando a pasta de nome sem versão. |
| `pages.ts` | `sliceChars`: corta texto em `[offset, offset + limit)` sem partir par surrogate; `isHighSurrogate` e `isLowSurrogate`: a faixa de cada metade do par, também usada por `queries/read-attachment.ts`. |

## Dependencies

### Internal

- `../domain/`: `chain.ts`, `ids.ts`, `manifest.ts` e `record.ts` no `loader.ts`; `ids.ts` no `latest.ts`.
- `../errors.ts`: `HexlogError` no `loader.ts`.
- `../ports.ts`: `ProcessReader`, `ProcessRef`, `RawProcess` no `loader.ts`; `DefinitionReader` e `DefinitionKind` no `latest.ts`.

### External

- `zod`: forma da linha do log em `loader.ts`.
- `es-toolkit`: `isUndefined` em `loader.ts` e `latest.ts`.

## Manual Notes

## Diretrizes

- [fronteiras.md](../../docs/directives/fronteiras.md)
- [invariantes.md](../../docs/directives/invariantes.md)
