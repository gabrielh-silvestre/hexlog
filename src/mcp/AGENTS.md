# mcp

**Parent context:** `../AGENTS.md`
**Generated:** 2026-10-07 · **Updated:** 2026-10-07

## Purpose
Camada MCP do hexlog: expõe os serviços de `commands/` e `queries/` como as 12 tools do servidor `hexlog`. Não contém regra de negócio: cada tool valida a entrada e repassa ao serviço; o kernel cuida de validação, erro estruturado e log para todas elas.

## Key Files
| File | Description |
|------|-------------|
| `kernel.ts` | Folha da camada. `execute` (toda chamada passa por ele e nunca lança ao SDK: `LEGACY_DATA`, chave `__proto__` e aninhamento acima de 64 níveis, validação zod, `HexlogError` e `INTERNAL`; resposta acima do dobro de `PAGE_CHARS_CAP` vira o warn `tool-over-cap`), `defineTool` (registra uma tool com `name` e schema declarados uma vez), `advertise` (ponte zod → SDK), `ToolDeps`, `Services`, `READ_ANNOTATIONS`, `WRITE_ANNOTATIONS` e `MarkerRecord` |
| `server.ts` | `createServer`: monta o `McpServer` `hexlog` (versão de `version.ts`) e registra as quatro famílias de tools; aqui nada toca disco |

## Subdirectories
| Directory | Purpose |
|-----------|---------|
| `tools/` | As quatro famílias de tools, um `register<X>Tools` por arquivo (see `tools/AGENTS.md`) |

## Dependencies

### Internal
- `../commands/` e `../queries/query-service.ts`: os serviços que as tools chamam (`Services`)
- `../domain/`, `../errors.ts`, `../shared/logger.ts` e `../version.ts`
- Montada por `../server.ts` via `../compose.ts`; `kernel.ts` não importa `tools/`

### External
- `@modelcontextprotocol/server`: `McpServer` e os tipos do SDK
- `zod`: schemas de entrada e saída das tools
- `es-toolkit`: helpers de checagem de ausência

## Manual Notes
