## Frente 14: Ecossistema do zod

- Data: 2026-09-16. Pedido do usuário ("libs do ecossistema do zod que possam ser úteis").
- Restrição: zod `4.6.5` exato. Probes em `scratchpad/zod-ecossistema/` (`test-zfc.mjs`, `test-schema-faker.mjs`, `test-native-jsonschema.mjs`).

### Mapa por categoria
| Categoria | Candidatos | Compatível com zod 4.6.5? | Veredito |
|---|---|---|---|
| a. Geração de dados | zod-fast-check, @anatine/zod-mock, zod-fixture, zod-schema-faker | só **zod-schema-faker** (subpath `/v4`) | adotar zod-schema-faker (dev) |
| b. Formatação de erro | zod-validation-error | sim (peer `^3.25 \|\| ^4`) | nativo (`z.treeifyError`/`z.prettifyError`) cobre; decisão anterior mantida |
| c. Conversão de schema | `z.toJSONSchema` nativo, zod-to-json-schema, zod-to-ts | zod-to-json-schema **não** (morto p/ zod 4); zod-to-ts sim, sem caso de uso | nativo cobre |
| d. Utilitários | `zod/mini`, `.brand()`, `.deepPartial()` | `zod/mini` sim, sem problema a resolver; `.deepPartial()` removido no zod 4; `.brand()` nativo | não adotar |
| e. Integração MCP | nenhum relevante | SDK v2 já converte zod → JSON Schema | nada útil |
| f. Env/config | znv, @t3-oss/env-core | znv só zod 3; t3-env sim, overkill | não adotar |

### Candidatos detalhados
| lib | versão | peer zod | último release | downloads/sem | licença | unpacked | deps | ESM/CJS | jest | uso no hexlog |
|---|---|---|---|---|---|---|---|---|---|---|
| zod-fast-check | 0.10.1 | `^3.18.0` (+ `fast-check >2.23 <4`) | 2023-09-13 (morto) | 163k | MIT | 26 KB | — | CJS | n/a | **quebra** |
| @anatine/zod-mock | 3.14.0 | `^3.21.4` | 2025-04-04 | 145k | MIT | 56 KB | randexp | — | — | só zod 3 |
| zod-fixture | 2.5.2 | `>=3.0.0` (não testado c/ v4) | 2024-03-09 | 32k | MIT | 111 KB | randexp | — | não probado | risco alto |
| **zod-schema-faker** | 2.1.1 | `^3.25.0 \|\| ^4.0.0` | 2026-03-09 | 30,6k | MIT | 124 KB | peer `@faker-js/faker ^10`, randexp | ESM+CJS (`require` em `.` e `./v4`) | sim, sem mapper | fixtures a partir de schemas zod 4 e de `z.fromJSONSchema` |
| zod-validation-error | 5.0.0 | `^3.25.0 \|\| ^4.0.0` | 2025-11-03 | 35,5M | MIT | 245 KB | — | ESM+CJS | sim | fora de escopo |
| zod-to-json-schema | 3.25.2 | `^3.25.28 \|\| ^4` (README nega suporte real) | 2026-03-27 | 45M | ISC | 219 KB | — | — | — | **não usar** |
| zod-to-ts | 2.1.0 | `^3.25.0 \|\| ^4.0.0` | 2026-06-06 | 1,36M | MIT | 61 KB | typescript peer | — | — | sem caso de uso |
| znv | 0.5.0 | `^3.24.2` | 2025-03-24 | 47k | MIT | 114 KB | — | — | — | só zod 3 |
| @t3-oss/env-core | 0.13.11 | `^3.24.0 \|\| ^4.0.0` | 2026-03-22 | 2,9M | MIT | 133 KB | peers opcionais | — | — | overkill |

### Probes
1. **zod-fast-check** + zod 4.6.5 + fast-check 4.10.1: `ERESOLVE` (peers `fast-check <4`, `zod ^3.18`). Forçado: `inputArbitraryFor is not a function` (API real `.inputOf()`); corrigido → `'ZodObject' schemas are not supported`. Causa: lê `_def.typeName` (zod 3); zod 4 usa `_zod.def.type`.
2. **zod-schema-faker 2.1.1**: import padrão (`.`) usa `zod/v3` e falha em schema zod 4 (`Unsupported schema type: undefined`, até em `z.string()`). Com **`zod-schema-faker/v4` + `setFaker(faker)`**: 100/100 no `safeParse` em 96 ms (schema strict com regex `hex:alvo:`, `z.iso.datetime()`, enum). Valores "extremos" (datas no ano 9797, strings com muitos caracteres especiais): bons para fuzz, ruins como exemplo legível (usar `custom()`). **Não gera `fc.Arbitrary`**: não substitui fast-check em property-based, só gera N exemplos válidos.
3. **`z.toJSONSchema` nativo × zod-to-json-schema**: nativo gera draft 2020-12 completo (pattern, format, enum, `additionalProperties:false`); a lib devolve `{"$schema":"http://json-schema.org/draft-07/schema#"}` vazio sem erro. README instalado: "As of November 2025, this project will no longer be actively maintained… does NOT mean it supports v4 schemas."
4. **`z.fromJSONSchema` ida e volta**: ok, e rejeita inválido.
5. `.deepPartial()` removido no zod 4; `.brand()` existe.

### Recomendação
- **Adotar (devDependency):** `zod-schema-faker@2.1.1`, sempre via `zod-schema-faker/v4` + `setFaker`, com peer `@faker-js/faker` 10.x exato.
- **Nativo do zod 4 cobre:** `z.toJSONSchema`, `z.treeifyError`/`z.prettifyError`/`z.formatError`, JSON Pointer a partir de `issue.path` (código próprio trivial), `.brand()`.
- **Nada útil:** zod-fast-check, @anatine/zod-mock, znv, zod-to-json-schema, zod-to-ts, @t3-oss/env-core, zod-fixture (sem probe).

### Riscos e armadilhas
- Peer `^3 || ^4` não garante suporte real (zod-to-json-schema falha em silêncio).
- zod-schema-faker: import padrão quebra com zod 4; só `/v4` funciona.
- zod-fast-check parece a opção óbvia, mas está morto e quebra em runtime.
- Faker gera valores extremos; para fixtures legíveis, `custom()`.

### Evidência
`npm view <pkg> versions peerDependencies license dist.unpackedSize dependencies time.modified --json`; `api.npmjs.org/downloads/point/last-week/<pkg>`; https://zod.dev/ecosystem, https://zod.dev/json-schema, https://zod.dev/v4; README instalado de `zod-to-json-schema`.
