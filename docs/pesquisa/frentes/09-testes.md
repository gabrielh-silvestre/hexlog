## Frente: Stack de testes (jest + ts-jest, Node 24, property-based, multi-processo, MCP, hook)

### Perguntas respondidas
1. **jest + ts-jest / ESM vs CJS:** trivial. `@modelcontextprotocol/{server,client,core}@2.0.0` e `zod@4.6.5` são dual package (`exports` com `require`); `fast-check@4.10.1` resolve sob `require`. **ts-jest modo CJS padrão (sem preset ESM, sem `--experimental-vm-modules`, sem `moduleNameMapper`) passa.** O `NODE_OPTIONS=--experimental-vm-modules` da POC é herança de xstate/memfs/bullmq — descartar.
2. **fast-check:** 4.10.1, MIT. `fc.assert(fc.property(...))` dentro de `test()` basta; `@fast-check/jest` é só açúcar. `jest --show-seed` para reproduzir.
3. **Concorrência multi-processo:** POC (`poc/test/fork-helpers.ts`) usa `fork()` com IPC e barreiras por mensagem (sem sleep). Para o código sob teste no filho, a POC usa `ts.transpileModule()` → CJS num tmp dir espelhando a árvore + launcher `.js`. Alternativa nativa: `fork()` de `.ts` com `import` **falha** sob `"type": "commonjs"` (type stripping não decide module kind); **`.mts` funciona sem flag**, testado com 3 processos reais.
4. **Servidor MCP:** doc v2 (`ts.sdk.modelcontextprotocol.io/v2/testing`): tools via `InMemoryTransport.createLinkedPair()` (não misturar cópias de `/server` e `/client`). Literal: **"Stdio has no in-process shortcut"** → 1 teste real com `StdioClientTransport` (`@modelcontextprotocol/client/stdio`) spawnando o servidor. `@modelcontextprotocol/inspector@2.7.0` (MIT, 2026-09-16), `npx @modelcontextprotocol/inspector --cli` para smoke em CI (`docs/cli-smoke-testing.md`: connect→list→call→assert, `--format json`).
5. **Hook:** `spawn`/`execFileSync` + JSON no stdin + assert em stdout/exit code. Mesma ressalva `.ts`/`.mts`.
6. **Probe:** 3 suites, 5 testes verdes (~2,5 s) em Node 24.18.1: `McpServer` + tool via InMemoryTransport, fork de filho `.mts` (1× e 3× concorrente), property de fast-check. Zero flags, zero preset ESM.

### Candidatos
| Candidato | Versão / release | Licença | Manutenção | ESM/TS/Node 24 | Deps | Encaixe | Veredito |
|---|---|---|---|---|---|---|---|
| jest | 30.5.1 (2026-09-01) | MIT | ativa | dual | — | runner decidido | Adotar |
| ts-jest | 29.4.12 (2026-07-22) | MIT | ativa | CJS basta | peer jest ^29/^30, ts >=4.3 <7 | transform | Adotar |
| fast-check | 4.10.1 (2026-09-15) | MIT | ativa | dual | 0 | property-based | Adotar |
| @fast-check/jest | 2.3.0 | MIT | ativa | — | @fast-check/worker | açúcar | Não adotar |
| @modelcontextprotocol/{server,client} | 2.0.0 | MIT | oficial | dual, node≥20 | zod ^4.2.0 | SDK v2 | Adotar (client só dev) |
| @modelcontextprotocol/inspector | 2.7.0 (2026-09-16) | MIT | oficial | ESM-only CLI | — | smoke E2E | Adotar pontual (npx) |
| Type stripping nativo | Node 24.18.1 | — | — | `.mts` ok; `.ts` falha sob commonjs | 0 | driver de filho | Nativo (`.mts`) |
| `ts.transpileModule` (padrão POC) | via `typescript` | — | — | robusto | 0 | código de produção no filho | Adotar (portar) |
| ts-node | — | — | — | — | dep nova | desnecessário | Não adotar |

### Decisão recomendada
- **Runner:** jest 30.5.1 + ts-jest 29.4.12, preset padrão CJS, sem `--experimental-vm-modules`.
- **Property-based:** fast-check puro + `--show-seed`.
- **Concorrência:** portar fork + barreiras IPC da POC, generalizado para N≥3 (pai espera N `ready` antes do `go`); código de produção no filho via `ts.transpileModule` (ou `.mts` quando o filho for só driver).
- **MCP:** InMemoryTransport para as 10 tools; 1 teste stdio real; smoke opcional com inspector `--cli`.
- **Hook:** spawn + stdin JSON.

### Evidência
- Probe `scratchpad/testes/` (`package.json`, `tsconfig.json`, `jest.config.js`, `mcp-server.spec.ts`, `child.ts`/`child.mts`, `child-fork.spec.ts`, `fastcheck.spec.ts`); `npm ls --depth=0`: jest@30.5.1, ts-jest@29.4.12, typescript@5.9.2, @types/node@24.8.1, fast-check@4.10.1, @modelcontextprotocol/{server,client}@2.0.0, zod@4.6.5. `npx jest --no-coverage` → 3 suites, 5 testes verdes.
- Docs: typescript-sdk `docs/migration/upgrade-to-v2.md`, `ts.sdk.modelcontextprotocol.io/v2/testing`, inspector README + `docs/cli-smoke-testing.md`, `jestjs.io/docs/30.0/ecmascript-modules`, ctx7 `/kulshekhar/ts-jest`, `/dubzzz/fast-check`.
- POC (só leitura): `poc/test/fork-helpers.ts`, `poc/test/append.spec.ts:140-230`.

### Riscos e armadilhas
- `.ts` forkado com `import` falha sem `"type": "module"` → `.mts` ou transpilar. (Interação com a decisão de rodar o hook `.ts` direto: definir `type` do package.json no passo 0.)
- Não misturar `InMemoryTransport` de `/server` e `/client`.
- stdio v2: `maxBufferSize` 10 MB e **ignora silenciosamente linhas de stdout não-JSON** → testar que o servidor nunca escreve log no stdout.
- `tsconfig` precisa `"types": ["node"]` (senão `Buffer` quebra no `.d.mts`).
- Scripts de install pendentes de `@parcel/watcher`/`unrs-resolver` (só para `--watch`).

### Perguntas em aberto
Nenhuma.
