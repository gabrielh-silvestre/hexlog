## Frente 13: Logging estruturado enxuto

- Data: 2026-09-16. Pedido do usuário (preferência por lib enxuta).
- Contrato avaliado: plano §4.15 (stderr exclusivo, uma linha JSON por evento, níveis `debug|info|aviso|erro`, campo `evento`, sem filtro de nível, sem perda em `exit`/SIGTERM, logger espião nos testes, logger do Ajv no mesmo canal).
- Probes em `scratchpad/logging/` (instalação isolada por pacote, versões exatas).

### Ranking por tamanho
| lib | versão | unpacked | instalado c/ deps | deps transitivas | bundle min/gzip | import mediana (ms) |
|---|---|---|---|---|---|---|
| **nativo** | — | ~0,4 KB (15 linhas) | 0 | 0 | 135 B / 151 B | 29 (baseline Node) |
| loglevel | 1.9.2 | 86 KB | 144 KB | 0 | 3,7 KB / 1,6 KB | 37 |
| roarr | 7.21.7 | 105 KB | 612 KB | 3 | 19,3 KB / 6,5 KB | 41,5 |
| adze | 2.3.0 | 354 KB | 780 KB | 2 | 28,0 KB / 8,7 KB | 56,5 |
| **@logtape/logtape** | 2.3.5 | 810 KB | 1,1 MB | **0** | 33,1 KB / 10,4 KB | 44 |
| **pino** | 10.3.1 | 664 KB | 2,6 MB | 12 | 60,8 KB / 20,8 KB | 48 |
| consola | 3.4.2 | 322 KB | 448 KB | 0 | 74,6 KB / 22,7 KB | 58,5 |
| tslog | 5.2.0 | 984 KB | 1,4 MB | 0 | 66,1 KB / 22,7 KB | 58 |
| winston | 3.19.0 | 275 KB | 3,4 MB | 27 | não medido | — |
| bunyan | 1.8.15 | 201 KB | 7,2 MB | 19 (inclui `nan`) | não medido | — |

`evlog@2.29.0`: 1,86 MB unpacked, fora do critério. `@std/log`: E404 no npm (JSR/Deno).

### Encaixe no contrato
| lib | fd 2 sem stdout | níveis custom | sem filtro | síncrono/sem perda | worker | node .ts | jest+ts-jest | mapper? | espião |
|---|---|---|---|---|---|---|---|---|---|
| **nativo** | sim | sim | sim | sim (`process.stderr.write` síncrono em pipe no Linux) | não | sim | sim | não | fácil |
| **pino** | sim com `pino.destination({fd:2, sync:true})` (testado) | sim (`customLevels` + `formatters.level`, testado) | sim | **só com `sync:true`**; padrão assíncrono via thread-stream | só se `sync:false` | sim (CJS) | sim, sem mapper | não | médio |
| **logtape** | sim, sink custom (testado) | sim, mapeado no sink | sim (`lowestLevel:'trace'`) | sim (sink síncrono) | não | sim | sim, sem mapper (dual) | não | fácil |
| consola | não: padrão divide stdout (debug/info) × stderr (warn/error) | não | padrão filtra debug | provável | não | sim | sim | não | fácil |
| tslog | **não: tudo no stdout, até `error`** | fixos | com `minLevel:0` | print duplo | não | sim | **falha** (ESM-only) | sim | médio |
| roarr | **silencioso por padrão**; com `ROARR_LOG=true` escreve no **stdout** | fixos | sim | síncrono, destino errado | não | sim | sim | não | médio |
| adze | divide canais e filtra debug por padrão | sim, verboso | não por padrão | não testado | não | sim | **falha** (ESM-only) | sim | difícil |
| loglevel | divide canais; **sem log estruturado** (só string) | não | sim com `trace` | provável | não | sim | sim | não | fácil |

### Manutenção
| lib | versão | data | licença | downloads/sem | issues | stars | tipos | ESM/CJS |
|---|---|---|---|---|---|---|---|---|
| pino | 10.3.1 | 2026-08-15 | MIT | 36.264.845 | 172 | 18.200 | sim | CJS |
| logtape | 2.3.5 | 2026-09-14 | MIT | 323.615 | 12 | 1.997 | sim | dual |
| consola | 3.4.2 | 2025-03-18 | MIT (pkg) | 39.427.660 | 92 | 7.325 | sim | dual |
| tslog | 5.2.0 | 2026-09-11 | MIT | 1.372.136 | 0 | 1.741 | sim | ESM-only |
| roarr | 7.21.7 | 2026-07-26 | BSD-3-Clause (pkg) | 8.321.283 | 18 | 1.137 | sim | CJS |
| adze | 2.3.0 | 2026-01-15 | Apache-2.0 | 19.625 | 12 | 284 | sim | ESM-only |
| loglevel | 1.9.2 | 2024-09-06 | MIT | 16.436.366 | 19 | 2.748 | sim | CJS |
| winston | 3.19.0 | 2026-04-24 | MIT | 19.636.775 | 532 | 24.521 | sim | CJS |
| bunyan | 1.8.15 | 2025-06-28 (repo parado desde 2023) | Other | 2.883.930 | 291 | 7.208 | DT | CJS |

### Recomendação
1. **Nativo (~15 linhas)** — cumpre 100% do contrato, zero import, zero deps, espião trivial.
   ```ts
   type Nivel = 'debug' | 'info' | 'aviso' | 'erro';
   export function log(nivel: Nivel, evento: string, campos: Record<string, unknown> = {}) {
     process.stderr.write(JSON.stringify({ ts: new Date().toISOString(), nivel, evento, ...campos }) + '\n');
   }
   // ajv: { log: m => log('debug','ajv',{m}), warn: m => log('aviso','ajv',{m}), error: m => log('erro','ajv',{m}) }
   ```
2. **@logtape/logtape 2.3.5** — única lib zero-deps que passa em tudo com um sink de ~6 linhas; dual, sem atrito no jest. Traz categorias hierárquicas, redaction e configuração central.
   ```ts
   import { configure, getLogger } from '@logtape/logtape';
   const NIVEL: Record<string, string> = { trace: 'debug', debug: 'debug', info: 'info', warning: 'aviso', error: 'erro', fatal: 'erro' };
   await configure({
     sinks: { stderr: r => process.stderr.write(JSON.stringify({ ts: new Date(r.timestamp).toISOString(), nivel: NIVEL[r.level], ...r.properties }) + '\n') },
     loggers: [{ category: [], sinks: ['stderr'], lowestLevel: 'trace' }],
   });
   export const log = getLogger(['hexlog']);
   ```
3. **pino 10.3.1** — mais rápido, child loggers, serializers de erro. Contras: 12 deps / 2,6 MB; `sync:true` obrigatório.
   ```ts
   import pino from 'pino';
   const NIVEL: Record<string, string> = { warn: 'aviso', error: 'erro' };
   export const log = pino({
     level: 'debug',
     formatters: { level: label => ({ nivel: NIVEL[label] ?? label }) },
     timestamp: () => `,"ts":"${new Date().toISOString()}"`,
   }, pino.destination({ fd: 2, sync: true }));
   ```

### Evidência
- `npm view <pkg> version license dist.unpackedSize dependencies repository.url time.modified --json`; `du -sh node_modules`; `npm ls --all`.
- esbuild `--bundle --minify --platform=node --format=esm` sobre uso mínimo; `wc -c` + `gzip -c | wc -c`.
- 10× `node --input-type=module -e "await import('<pkg>')"`, mediana.
- Probes de canal com `1>stdout.out 2>stderr.out`: tslog stdout 274 B / stderr 0; roarr 0/0 sem env e 4 linhas JSON no stdout com `ROARR_LOG=true`; consola 55 B stdout (debug+info) / 72 B stderr; logtape e pino (`sync:true`, `fd:2`) stdout 0 B.
- jest 30.5.1 + ts-jest 29.4.12 CJS: pino, logtape, consola, loglevel, roarr passam; tslog e adze falham com `Must use import to load ES Module`.
- SIGTERM: com 400 ms, pino (sync e async) e nativo sobreviveram; com 30 ms pino não chegou a terminar o `require` (custo de import, não perda de escrita). Risco de thread-stream sob carga: documentado pelo pino, não provado aqui.

### Riscos e armadilhas
- pino sem `sync:true` usa worker (risco de perda documentado).
- roarr silencioso por padrão e escreve no stdout.
- tslog e adze ESM-only → quebram no jest CJS.
- consola e adze filtram `debug` por padrão → silenciariam `lock-espera` (barreira do C1).
- loglevel sem log estruturado.
- bunyan abandonado (addon nativo); winston pesado.
