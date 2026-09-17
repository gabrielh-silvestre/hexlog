## Frente: API real do SDK v2 do MCP (`@modelcontextprotocol/server` 2.0.0)

### Pacotes
| Pacote | Versão / release | Licença | Papel | ESM/TS/Node 24 | Deps | Veredito |
|---|---|---|---|---|---|---|
| `@modelcontextprotocol/core` | 2.0.0 (2026-07-27, GA) | MIT | Schemas Zod compartilhados | ESM+CJS, Node ≥20 | `zod ^4.2.0` | Transitivo |
| `@modelcontextprotocol/server` | 2.0.0 | MIT | `McpServer`, `registerTool`, stdio | idem | `zod ^4.2.0`, `core@2.0.0` | **Adotar** |
| `@modelcontextprotocol/client` | 2.0.0 | MIT | `Client`, transportes | idem | zod, jose, cross-spawn, eventsource(-parser), pkce-challenge, core | **Adotar só em devDependencies (testes)** |
| `@modelcontextprotocol/node` | 2.0.0 | MIT | Adaptador HTTP Node↔Web (hono) | idem | `@hono/node-server` | Não usar |
| `/hono`, `/express`, `/fastify` | 2.0.0 | MIT (não reverificado) | Adaptadores HTTP | idem | peer do framework | Não usar |
| `@modelcontextprotocol/server-legacy` | 2.0.0 | MIT | Bridge v1 | — | — | Não usar |
| `@modelcontextprotocol/codemod` | 2.0.0 | MIT | Codemod v1→v2 | — | — | Não usar |
| `zod` | 4.6.5 (2026-09-13) | MIT | Validação | ok | — | **Exato**, sem conflito |
| `@modelcontextprotocol/sdk` (v1) | 1.30.0 | MIT | Legado | — | — | Não usar |

Não existem pacotes `/types`, `/inmemory`, `/stdio` avulsos (404).

### Decisão recomendada
- **Server:** `@modelcontextprotocol/server@2.0.0`. GA há ~7 semanas, sem patch. `McpServer.registerTool(name, {title?, description?, inputSchema?, outputSchema?, annotations?, icons?, _meta?}, cb)`, schemas em Zod.
- **stdio:** `import { serveStdio } from '@modelcontextprotocol/server/stdio'`; cliente: `import { StdioClientTransport } from '@modelcontextprotocol/client/stdio'`.
- **Testes:** `InMemoryTransport.createLinkedPair()` + `Client` (devDependency).
- **zod 4.6.5 exato:** satisfaz `^4.2.0`; `npm ls --all` mostra 1 cópia (14 pacotes, 24 MB).

### Evidência
- `npm view @modelcontextprotocol/{server,core,client,node} ...` (2026-09-16); `list_releases` em modelcontextprotocol/typescript-sdk: 8 tags `@2.0.0` em 2026-07-27, `prerelease:false`.
- Probe `scratchpad/sdk-v2` (`--save-exact`): 0 vulnerabilidades.
- `probe.mjs` com `InMemoryTransport.createLinkedPair()`:
  ```
  get-weather: isError: undefined  structuredContent: {"city":"Tokyo","celsius":21}
  boom (handler throw): isError: true  content: [{"type":"text","text":"kaboom"}]
  bad-output (viola outputSchema): isError: true  content: [... "Output validation error: Invalid structured content for tool bad-output: ..."]
  ```
- `validateToolOutput` (dist instalado): retorna cedo se `result.isError`; sem `structuredContent` com outputSchema → `ProtocolError`; schema inválido → `ProtocolError`. Capturado pelo mesmo try de `executeToolHandler` → vira `{content:[text], isError:true}`, não erro JSON-RPC.
- `ToolAnnotationsSchema`: `{title?, readOnlyHint?, destructiveHint?, idempotentHint?, openWorldHint?}`.
- `CallToolResultSchema`: `{content: array default [], structuredContent?: unknown, isError?: boolean}`.
- `claude mcp add --help`: `claude mcp add --scope user <name> -- <command> [args...]` (stdio default; `user` → `~/.claude.json`).
- Migração v1→v2 (`docs/migration/upgrade-to-v2.md`): `server.tool(...)` → `server.registerTool(name, {description, inputSchema: z.object(shape)}, cb)`; `McpError`→`ProtocolError`; `ErrorCode`→`ProtocolErrorCode`; `InMemoryTransport` exportado de `/client` e `/server` com estado separado — **não misturar as pontas entre pacotes**.

### Riscos e armadilhas
- `outputSchema` só valida quando `isError` ≠ true → erro `{codigo, mensagem, detalhes[]}` em `structuredContent` é seguro mesmo com outputSchema de sucesso.
- `content` tem default `[]`; SDK injeta texto quando `structuredContent` não é objeto (SEP-2106).
- Exemplos v1 na web usam `server.tool(...)`/`McpError` — não copiar.
- Claude Code: limite `MAX_MCP_OUTPUT_TOKENS` (default 25000) e `_meta["anthropic/maxResultSizeChars"]` por tool — relevante para `eventos` em logs grandes (paginar). Renderização de `structuredContent`/`isError` na UI não documentada em detalhe.

### Perguntas em aberto
Nenhuma.
