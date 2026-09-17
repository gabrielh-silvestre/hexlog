## Frente 16: Ganhos (e custos) de usar Effect no hexlog

- Data: 2026-09-16. Pedido do usuário: "quero entender quais seriam os ganhos".
- Probes em `scratchpad/effect/` (`lock-native.ts`, `lock-effect.ts`, `driver.ts`, `worker-*.ts`, `lock.test.ts`, `bundle-sample.ts`).

### Estado do projeto
| Item | Valor | Fonte |
|---|---|---|
| `effect` estável | `3.22.2` (`latest`) | `npm view effect dist-tags` |
| `effect` v4 | `4.0.0-rc.115` (`rc`), não GA | GitHub releases |
| `@effect/platform` / `-node` | `0.97.2` / `0.108.2` | `npm view` |
| `@effect/schema` | `0.75.5`, **deprecated** (fundido em `effect/Schema`) | `npm view @effect/schema deprecated` |
| Licença | MIT | `npm view` |
| Downloads/semana | `effect` 24.534.616; `@effect/platform` 1.092.669; zod 209.218.437 | api.npmjs.org |
| Unpacked | 27.163.958 bytes (~25,9 MiB), só `effect` | `npm view dist.unpackedSize` |
| Bundle típico | 222,7 KB min / 75.284 B gzip (`Effect.gen` + `Data.TaggedError` + `Schedule` + `acquireRelease` + `retry` + `log`) | esbuild |
| Import a frio | mediana ~350 ms (0,34–0,37 s) × zod ~80 ms | `node -e "await import('effect')"` ×10 |
| Módulo | dual ESM/CJS real | testado |
| GitHub | 16.085 stars, 746 forks, 255 issues | `search_repositories` |
| Deps | `fast-check`, `@standard-schema/spec` | `npm view dependencies` |

### Ganhos lado a lado
- **a. Erros tipados no retorno:** `Effect<A, LockTimeoutError | LockPerdidoError, never>` com `Data.TaggedError`; handler que esquece de tratar `LOCK_PERDIDO` não compila. No nativo, o catálogo `{codigo}` (§4.13) documenta, mas nada impede um `throw` fora dele. **Ganho real, único relevante.**
- **b. Liberação garantida:** `Effect.acquireUseRelease` cobre sucesso, erro e interrupção de fibra. `try/finally` nativo cobre sucesso e erro; o hexlog não usa fibras → **não se aplica**.
- **c. Retry + timeout:** `Effect.retry(Schedule.spaced('10 millis'))` + `Effect.timeoutFail(5 s)` é declarativo e composável; para "10 ms fixo até 5 s" o laço nativo é trivial → ganho só se a política crescer (backoff, jitter).
- **d. `TestClock`:** **nenhum ganho** — o plano já passa `agora` como parâmetro de função pura.
- **e. DI com `Context.Tag`/`Layer`:** **marginal** — 1 ponto de entrada (`serveStdio`); testes usam MCP real (`InMemoryTransport`).
- **f. Logger:** **ganho negativo por padrão.** Verificado: `Effect.log` escreve no **stdout** (`console.log`) → quebra o JSON-RPC (M6); `Effect.logDebug` é **suprimido** (mínimo Info) → silencia `lock-espera` (barreira do C1). Exige `Logger.replace` + `Logger.withMinimumLogLevel(LogLevel.All)`.
- **g. `effect/Schema` × zod:** o SDK MCP v2 aceita Standard Schema, mas `standardSchemaToJsonSchema` (`src-CX2iR2pK.mjs:5293-5306`) lança `Schema library "effect" does not implement StandardJSONSchemaV1` se `vendor !== "zod"` e faltar `~standard.jsonSchema`; `Schema.standardSchemaV1` não tem `jsonSchema` → exige wrapper. Sem equivalente a `z.fromJSONSchema` usado no plano. Fica zod.
- **h. O que o nativo não resolve bem:** nada no domínio do hexlog. O ganho estrutural do Effect é compor política transversal (retry + timeout + cancelamento + telemetria) em muitos efeitos; o hexlog tem um lugar só (o lock).

### Custos
| Custo | Evidência | Impacto |
|---|---|---|
| Import a frio | 350 ms × 80 ms (zod) | +~270 ms por start de servidor (1 por sessão) |
| Tamanho | 73,5 KB gzip para 5 primitivas; ~26 MiB em `node_modules` | mais código para o V8 compilar a cada boot |
| "Colorir" o código | todo chamador vira Effect ou `Effect.runPromise` na borda | SDK espera `Promise` → `runPromise` em toda tool; 2 estilos |
| Type stripping | reproduzido: `acquireRelease` sem `Effect.scoped` rodou em `node arq.ts` e só falhou em runtime (`Service not found: effect/Scope`); `tsc --noEmit` pegou | a garantia de tipos só vale com `tsc` sempre |
| jest/ts-jest CJS | 2/2 verdes, **sem mapper** | sem atrito extra |
| Curva de aprendizado | `Effect`, `Layer`, `Context`, `Schedule`, `Fiber`, `Scope`, canais `A,E,R` | 1 mantenedor, ramp-up real |
| Código gerado por LLM | não medido; superfície grande, erro de canal `R` passa no `node` | risco |
| Stack traces | `FiberFailure`/`Cause` encapsulando o `Error` | debug mais indireto |

### Probe do lock
| | Nativo | Effect |
|---|---|---|
| Linhas | 51 | 57 |
| 4 forks × 50 linhas | 200/200, 0 lock órfão | 200/200, 0 lock órfão |
| Tempo total | **182 ms** | **780 ms** (~4,3×; import por fork) |
| `node arq.ts` | ok | ok |
| jest + ts-jest CJS sem mapper | ok | ok |

Ambos: mkdir atômico + token, retry 10 ms, timeout 5 s (`LOCK_TIMEOUT`), fencing (`LOCK_PERDIDO`), liberação garantida.

### Veredito por cenário
- **(i) MVP como planejado:** não adotar. Único encaixe (lock) já resolvido nativo, 4× mais rápido a frio; erros tipados/DI/TestClock sem onde se pagar; `effect/Schema` colide com o SDK.
- **(ii) hexlog crescendo (daemon, HTTP, integrações com retry/circuit-breaker repetidos):** reconsiderar quando for real.
- **(iii) Adoção parcial (só borda ou só testes):** pior dos dois mundos — paga import e dependência sem herdar os ganhos.

### Riscos e armadilhas
1. Logger padrão do Effect no stdout quebra MCP stdio.
2. `logDebug` suprimido por padrão.
3. `effect/Schema` não serve como `inputSchema`/`outputSchema` sem wrapper (quebra em runtime na listagem).
4. Vazamento de `Scope`/canal `R` invisível sob `node arq.ts`.
5. Números de bundle/import de amostra pequena (5 primitivas).

### Evidência
`npm view effect ...`; `api.npmjs.org/downloads/point/last-week/{effect,@effect/platform,zod}`; GitHub `list_releases`/`search_repositories`; `grep` em `@modelcontextprotocol/server/dist/*.mjs` (`standardSchemaToJsonSchema`, `src-CX2iR2pK.mjs:5265-5310`); interceptação de `process.stdout.write`; esbuild + gzip; jest 2/2; `tsc --noEmit` no bug de `Scope`.
