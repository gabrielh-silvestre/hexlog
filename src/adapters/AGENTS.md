# adapters

**Parent context:** `../AGENTS.md`
**Generated:** 2026-10-07 · **Updated:** 2026-10-07

## Purpose

Implementações das portas declaradas em `src/ports.ts`: disco (`fs/`), validação de JSON Schema e busca textual. É a única camada que toca I/O ou biblioteca de infraestrutura; as regras de negócio ficam em `domain/` e nos serviços.

## Key Files

| File | Description |
|------|-------------|
| `validator.ts` | `createValidator` (porta `Validator`): ajv estrito 2020-12 com `ajv-formats`, o formato `attachment` e os do `FORMAT_CATALOG`; `checkSchema` valida o schema de um tipo (inclui a recusa de `pattern` e `patternProperties` com `pattern-not-allowed`) e `validate` confere o `data` de um registro, ignorando `pattern` e `patternProperties` (ajv neutro, sem construir nem executar regex do schema) |
| `search.ts` | `createSearchIndex` (porta `SearchIndex`): índice MiniSearch em cache por processo, validado por contagem e impressão do último registro, com orçamento de caracteres indexados; `search` devolve os `RecordId` por relevância e `terms` os termos distintos da consulta |

## Subdirectories

| Directory | Purpose |
|-----------|---------|
| `fs/` | Adaptadores de disco: stores de processo, definição e anexo, lock por processo, gravação atômica e formato em disco (see `fs/AGENTS.md`) |

## Dependencies

### Internal

- `../ports.ts`: as portas que cada adaptador implementa
- `../domain/`, `../errors.ts`: tipos, `HexlogError` e hash (`sha256hex`)
- `../shared/logger.ts`: só `fs/lock.ts` o usa

### External

- `ajv`, `ajv-formats`: `validator.ts`
- `minisearch`: `search.ts`
- `es-toolkit`: helpers em todos os arquivos
- `zod`: `fs/definition-store.ts` e `fs/lock.ts`

## Manual Notes

## Diretrizes

- [fronteiras.md](../../docs/directives/fronteiras.md): `adapters/` só implementa portas e não importa `commands/`, `queries/` nem `mcp/`
- [invariantes.md](../../docs/directives/invariantes.md): log append-only, lock por processo e anexos imutáveis
