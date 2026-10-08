# queries

**Parent context:** `../AGENTS.md`
**Generated:** 2026-10-07 · **Updated:** 2026-10-07

## Purpose
Serviço de leitura do hexlog: seis operações (`queryRecords`, `evaluateGate`, `verifyChain`, `list`, `readAttachment`, `describeType`) sobre as portas de leitura. Lê e verifica o log pelo carregador único (`shared/loader.ts#loadVerified`), nunca grava e não faz I/O por conta própria: tudo entra por `ProcessReader`, `DefinitionReader`, `AttachmentReader` e `SearchIndex`.

## Key Files
| File | Description |
|------|-------------|
| `query-service.ts` | `createQueryService` e o tipo `QueryService`: `queryRecords` (filtros, `text`, `fields`, paginação por cursor, `changesSince`), `evaluateGate`, `verifyChain` (com `attachmentBreaks`) e a delegação a `list`, `readAttachment` e `describeType`. Exporta `QUERY_TEXT_MAX_CHARS` e reexporta `PAGE_CHARS_CAP` |
| `read.ts` | `readScope`: lê e verifica o alcance pedido (`ReadTarget`: processo ou projeto), cortando cada processo no `Marker` quando há um; `PROCESS_CORRUPTED` e `MARKER_NOT_FOUND` saem daqui. Exporta também `projectNotFound` |
| `select.ts` | Funções puras sobre uma `Reading`: `inOutputOrder` (ordem de saída por alcance), `buildView` (vigência e relações de entrada), `select` (filtros e relevância do `text`), `leftReason` e `relationsOf` (relações de entrada e saída de um registro) |
| `cursor.ts` | `encodeCursor` e `decodeCursor` (base64url de `CursorPayload`), `invalidCursor` (o `INVALID_CURSOR`) e o teto `CURSOR_MAX_CHARS`; o cursor não autentica, a barreira contra forja é a releitura do serviço |
| `list.ts` | `createList`: definições do projeto (versão vigente e todas) e processos, ou as versões fixadas no manifesto de um processo |
| `read-attachment.ts` | `createReadAttachment`: uma página do texto de um anexo por hash, com `offset` e `maxChars`; exporta `PAGE_CHARS_CAP` (24.000 caracteres) |
| `describe-type.ts` | `createDescribeType`: o schema de um tipo, fixado no processo (com `process`) ou na versão vigente ou pedida do projeto (sem `process`) |

## Dependencies

### Internal
- `../domain/`, `../errors.ts` e `../ports.ts`: tipos puros, erros estruturados e as portas de leitura
- `../shared/`: `loader.ts` (leitura verificada), `latest.ts` e `pages.ts`
- Consumido por `../mcp/tools/` (tools de leitura) e por `../compose.ts` (montagem do serviço)

### External
- `es-toolkit`: helpers de coleção e checagem de ausência
- `zod`: schema do `CursorPayload` (`cursor.ts`)

## Manual Notes
