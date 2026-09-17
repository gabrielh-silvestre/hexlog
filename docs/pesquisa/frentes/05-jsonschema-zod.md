## Frente: JSON Schema → Zod

### Perguntas respondidas
- **Drafts/target:** `z.fromJSONSchema(schema, { defaultTarget })` aceita `"draft-2020-12"` (default), `"draft-7"`, `"draft-4"`, `"openapi-3.0"` (`from-json-schema.d.ts`).
- **Keywords (código-fonte `from-json-schema.ts`, tag v4.6.5):**
  - *Aplicados*: `type, enum, const, anyOf, oneOf, allOf, not({}→never), properties, required, additionalProperties, patternProperties, propertyNames, min/maxProperties, items, prefixItems, additionalItems, min/maxItems, uniqueItems, contains, min/maxContains, min/maxLength, pattern, format, minimum, maximum, exclusive*, multipleOf, default, contentEncoding/MediaType/Schema, nullable, readOnly, $ref (local), $defs/definitions`.
  - *Lançam erro na conversão*: `not:{...}` não-vazio, `unevaluatedItems`, `unevaluatedProperties`, `if/then/else`, `dependentSchemas/dependentRequired`, tipo desconhecido (`Unsupported type: X`), `$ref` não-local.
  - *Ignorados silenciosamente*: keyword com typo ou custom — sem erro no registro nem no evento.
- **`$ref` externo:** rejeitado nativamente (`"External $ref is not supported, only local refs (#/...) are allowed"`).
- **`format`:** `email→z.email()`, `uri/uri-reference→z.url()`, `uuid/guid→z.uuid()`, `date-time→z.iso.datetime({offset:true})` (bug #6296 corrigido; offset `+02:00` aceito), `date→z.iso.date()`, mais ipv4/ipv6/mac/cidr/hostname/duration/time.
- **`additionalProperties:false`:** `.strict()` → issue `{code:"unrecognized_keys", keys:[...]}`.
- **Composição:** `oneOf→z.xor()`, `anyOf→z.union()`, `allOf→z.intersection()` (allOf inferido, não testado).
- **Recursão via `$ref`:** `z.lazy()` com detecção de ciclo — árvore auto-referenciada validada.
- **Experimental:** docstring "semi-experimental. Its behavior is liable to change." 168 issues mencionam `fromJSONSchema`; fixes em curso na 4.6.x → pin exato justificado.
- **Gaps do `fromJSONSchema` sozinho (probe):** `required` com tipo errado (string) é ignorado sem erro; array `[]` como schema raiz não lança; keyword com typo não lança.

### Candidatos
| Candidato | Versão/release | Licença | Manutenção | ESM/TS/Node24 | Deps | Encaixe | Veredito |
|---|---|---|---|---|---|---|---|
| zod (`fromJSONSchema`) | 4.6.5 / 2026-09-13 | MIT | 209M dl/sem | ESM+CJS | 0 | 12/12 casos OK | **Nativo do Zod** |
| Ajv (`ajv/dist/2020`) + ajv-formats | 8.20.0 (2026-04-24) / 3.0.1 (2024-03-30) | MIT | 273M + 96M dl/sem | CJS, Node 24 OK | 0 / 1 peer | Gate de validade do schema em `registrar_tipo`; pega os 3 gaps | **Adotar (só gate)** |
| json-schema-to-zod | 2.8.1 (2026-04-01) | ISC | 1.6M dl/sem | ok | 0 | Codegen, não runtime | Descartado |
| @n8n/json-schema-to-zod | 1.15.0 (2026-09-15) | própria | 54K dl/sem | depende de zod ^3.25 | 1 | Zod v3 | Descartado |
| zod-from-json-schema | 0.5.6 (2026-07-16) | MIT | 2M dl/sem | zod ^4.0.17 | 1 | Reimplementa o nativo | Descartado |

### Decisão recomendada
- **Validação do evento:** nativo `z.fromJSONSchema` (12/12 no probe).
- **Gate de validade do schema em `registrar_tipo`:** Ajv 2020 em strict mode (default) + ajv-formats; `ajv.compile(schema)` em try/catch antes de converter. Pega typo (`strict mode: unknown keyword: X`), `required` malformado e raiz não-objeto via meta-schema 2020-12. Reimplementar isso à mão seria reinventar o Ajv.
- **`$ref` externo:** nenhum código extra (Ajv e Zod rejeitam).
- **Colisão com marco/veredito:** regra da aplicação.

### Evidência
- Probe `scratchpad/jsonschema-zod/probe.mjs` com `zod@4.6.5 ajv@8.20.0 ajv-formats@3.0.1`: 12/12 corretos no `fromJSONSchema` (válido simples, additionalProperties:false, enum inválido, date-time com offset e inválida, $ref local aninhado, $ref externo → throw, type:banana → throw, keyword desconhecido → aceito sem erro, oneOf, recursão, boolean-schema true/false). Ajv: additionalProperties/enum/date-time corretos; $ref externo e type:banana rejeitados no `compile()`; keyword desconhecido rejeitado só em strict.
- Fonte: `raw.githubusercontent.com/colinhacks/zod/v4.6.5/packages/zod/src/v4/classic/from-json-schema.ts` e `core/json-schema-processors.ts`.
- Issues: #6296 (date-time offset, closed), #6463/#6494/#6323/#6304 (keywords antes ignorados, entraram na 4.6.0).

### Riscos e armadilhas
- `ZodError.issues[].path` é array, não JSON Pointer → `"/" + path.join("/")` (escapar `~` e `/` conforme RFC 6901). Ajv já dá `instancePath` como JSON Pointer.
- Input não-objeto (`null`, string) gera `TypeError` interno feio → try/catch, nunca expor a mensagem bruta.
- Ajv default é draft-07 → importar `ajv/dist/2020` explicitamente.
- `default` do JSON Schema: não confirmado se aplica `.default()` no parse.
- `const` e `type` array (`["string","null"]`): inferidos do código, não testados.

### Perguntas em aberto
Nenhuma.
