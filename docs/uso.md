# Uso

Caminho de um projeto novo e mapa das 12 tools. A referência de cada tool está em [tools.md](tools.md).

## Uso em 5 passos

Com o hexlog instalado e as sessões reiniciadas, o caminho de um projeto novo é:

1. `define_type`: um tipo de registro, como JSON Schema. Projeto sem nenhuma definição
   recusa o `create_process` (`TYPE_NOT_FOUND`).
2. Opcional: `define_relation` (nomes de relação com os tipos permitidos nas pontas) e
   `define_gate` (perguntas sobre os registros).
3. `create_process`: cria o processo e fixa a versão vigente de cada definição.
4. `register`: grava lotes de registros, com `key` para repetir a chamada com segurança.
   Num tipo que você não conhece, leia o schema antes com `describe_type`.
5. `query` para ler os registros vigentes e `evaluate_gate` para checar um gate.

Adotar uma definição nova, ou uma versão nova, exige um processo novo: o manifesto não
repina, e `create_process` sobre um processo que já existe devolve `created: false` e
`stale`. As skills instaladas guiam o resto: `hexlog` (instalação e diagnóstico),
`hexlog-setup` (roda uma vez por repositório, entrevista o fluxo e grava o mapa em
`.hexlog/flow.md`) e `hexlog-flow` (registra marcos e vereditos contra esse mapa).

## Exemplo completo

Um projeto `alpha` com um tipo `note`, um gate que pergunta se existe ao menos uma nota e um processo `run-1`. As chamadas abaixo são as entradas das tools, na ordem dos 5 passos, e podem ser feitas pelo próprio agente.

Primeiro definimos o tipo e o gate, ambos como versão `1.0`:

```json
// define_type
{ "project": "alpha", "name": "note",
  "schema": { "type": "object", "properties": { "text": { "type": "string" } },
              "required": ["text"], "additionalProperties": false } }

// define_gate
{ "project": "alpha", "name": "has-note",
  "questions": [{ "kind": "occurred", "select": { "type": "note" } }] }
```

Com as definições no projeto, `create_process` cria o processo e fixa a versão de cada uma, dessa forma o `register` seguinte já valida `data` contra o schema de `note`:

```json
// create_process
{ "project": "alpha", "process": "run-1" }

// register
{ "project": "alpha", "process": "run-1", "agent": "executor",
  "key": "run-1-nota-inicial",
  "records": [{ "type": "note", "target": "run.step", "data": { "text": "primeira nota" } }] }
```

O `register` devolve os ids dos registros (`run-1:<uuid v7>`) e o `marker`, a cabeça do processo. Repetir a chamada com a mesma `key` devolve o mesmo resultado com `replayed: true`, sem gravar de novo. Para ler e checar:

```json
// query: registros vigentes do processo
{ "project": "alpha", "process": "run-1", "type": "note" }

// query com fields: cada nota sai sem o `data` (listagem leve, p.ex. para achar o id vigente)
{ "project": "alpha", "process": "run-1", "type": "note", "targetPrefix": "run.step", "fields": [] }

// evaluate_gate: passed: true, com os ids que sustentam a resposta em evidence
{ "project": "alpha", "process": "run-1", "gate": "has-note" }

// verify_chain: confere a cadeia de hash do log
{ "project": "alpha", "process": "run-1" }
```

## As 12 tools

| Tool | O que faz | Escreve |
|---|---|---|
| `list` | Descoberta: projetos, ou um projeto com processos e definições, ou o que um processo fixou | nada |
| `describe_type` | Lê o schema de um tipo: o fixado no processo (com `process`) ou a versão vigente ou pedida do projeto | nada |
| `define_type` | Define um tipo de registro (JSON Schema) como versão imutável | `<projeto>/types/<nome>/<versão>.json` |
| `define_relation` | Define um nome de relação (`kind` e tipos permitidos nas pontas) | `<projeto>/relations/<nome>/<versão>.json` |
| `define_gate` | Define um gate: uma lista de perguntas sobre os registros | `<projeto>/gates/<nome>/<versão>.json` |
| `create_process` | Cria um processo, fixando a versão vigente de cada definição | `process.json` |
| `register` | Grava um lote de registros, atômico, com relações e `key` de idempotência | `records.jsonl` |
| `query` | Lê registros vigentes de um processo ou do projeto, com filtros, relações, projeção de `data` por `fields` e mudanças desde um marcador | nada |
| `evaluate_gate` | Calcula um gate fixado no processo e devolve a evidência | nada |
| `verify_chain` | Verifica a cadeia de hash do log e os anexos citados | nada |
| `attach` | Guarda um texto como anexo imutável, por `text` ou `path` | `<projeto>/attachments/<sha256>` |
| `read_attachment` | Lê uma página de um anexo por hash | nada |

Nomes (projeto, processo, tipo, relação, gate, alias) seguem `[a-z0-9][a-z0-9-]{0,62}`.
Um `target` são nomes separados por `.`, com até 200 caracteres
(`checkout.pagamento.pix`); o prefixo de um `target` casa na fronteira de `.`:
`a.b` casa `a.b` e `a.b.c`, não `a.bc`. O id de um registro é `<processo>:<uuid v7>`
e só o servidor o atribui. `author` sai do envelope da chamada: `agent` e `model`
vêm do agente, `client` vem do cliente MCP (ou `unknown`).

Toda entrada é estrita: chave desconhecida é `INVALID_INPUT` com
`unrecognized_keys`. Os tetos de tamanho estão em
[`tetos-dominio-v1.md`](tetos-dominio-v1.md).
