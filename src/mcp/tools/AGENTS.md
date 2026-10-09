# tools

**Parent context:** `../AGENTS.md`
**Generated:** 2026-10-07 · **Updated:** 2026-10-07

## Purpose
As 12 tools do servidor, agrupadas em quatro famílias. Cada arquivo exporta `register<X>Tools(server, deps)`, que chama `defineTool` uma vez por tool com o schema de entrada, o `outputSchema` e as anotações, e um `run` que repassa a entrada validada ao serviço.

## Key Files
| File | Description |
|------|-------------|
| `process.ts` | `registerProcessTools`: `create_process` e `register` (só o `register` leva `_meta` `anthropic/alwaysLoad`; o `Author` é montado aqui, com o `client` do envelope). Tools de escrita |
| `definition.ts` | `registerDefinitionTools`: `define_type`, `define_relation` e `define_gate`, uma operação de `DefinitionService` cada. Tools de escrita |
| `attachment.ts` | `registerAttachmentTools`: `attach` (escrita; `text` ou `path`) e `read_attachment` (leitura; `offset` e `maxChars` limitados por `PAGE_CHARS_CAP`) |
| `query.ts` | `registerQueryTools`: `query`, `evaluate_gate`, `verify_chain`, `list` e `describe_type`, todas de leitura (`readOnlyHint`). Exporta `queryPage` (única porta de `queryRecords`, que passa `maxChars` e corta `changes`) ; `gatePage` (corta `evidence`) é interna |

## Dependencies

### Internal
- `../kernel.ts`: `defineTool`, `ToolDeps`, anotações e `MarkerRecord`
- `../../queries/query-service.ts`: `QueryService` e `PAGE_CHARS_CAP`
- `../../domain/`: schemas de entrada reaproveitados (`Name`, `Hash`, `Author`, `BatchItem`, `Selector`, `RecordType` etc.)

### External
- `@modelcontextprotocol/server`: tipo `McpServer`
- `zod` e `es-toolkit`

## Manual Notes
