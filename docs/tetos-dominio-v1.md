# Tetos de tamanho do domínio da v1

Registro da decisão N8 da revisão do PR #60 (F1 da v1, camada pura em `src/domain/`). Este documento existe para que os números possam ser revisitados: diz quais são medidos, quais vêm de precedente e quais são palpite, e com que dado cada um foi escolhido.

## Decisão

Antes desta decisão só `data` (16.000 caracteres) e o lote (`BATCH_MAX`, 50 itens) tinham teto. Sem teto nos demais campos, um agente com bug gravava uma linha de 13,2 MB no log imutável (provado com 200.000 relações). O domínio passa a recusar, e `isValidLink` (`src/domain/chain.ts`) recusa a linha relida que passar dos mesmos tetos.

| Campo | Teto | Origem |
|---|---|---|
| `relations` (por elo e por item de lote) | `.max(100)` | precedente (0.x) + medição |
| `Batch.key` | `.max(200)` | precedente (tools) — **palpite** |
| `RecordType` | `canonicalize().length <= 16_000` | precedente (0.x) + medição |
| `Gate.questions` | `.max(50)` | alinhado a `BATCH_MAX` — **palpite** |
| `aliases` | `.max(50)` | alinhado a `BATCH_MAX`, para todo item do lote poder ter alias — **palpite** (subiu de 20 na implementação do PR #60, quando 20 conflitou com `BATCH_MAX`) |
| `records.jsonl` (arquivo inteiro, por processo) | 64 MiB | **palpite**: ~56 mil registros de 1,2 KB, ~50 vezes o maior processo medido; sem medição por trás. Recusa com `PROCESS_TOO_LARGE` (27º código do catálogo 1.0, que fecha em 27 depois do corte da F6), implementada em `src/adapters/fs/process-store.ts#createProcessStore` (`readProcess` confere o tamanho com `stat` antes de ler, então `read` e `write` recusam um log acima do teto; `writeLocked` confere `tamanho do arquivo + bytes do lote > 64 MiB` antes de gravar, então o lote que cruzaria o teto é recusado sem gravar e o processo continua legível; exatamente 64 MiB ainda grava e lê). A `message` (inglês) orienta criar um processo novo para seguir registrando (`supersedes`/`revokes` não atravessam processos; rotação do log fica para um ADR futuro). Rever se o TF6 sair de ~500 ms ou se um processo real passar de ~10 MiB. **Custo no `search`:** o índice é montado a cada chamada (~0,12 ms por registro), então um processo no teto, com ~55 mil registros, custa ~6-7 s síncronos; cada sessão paga o próprio índice, ~42 MiB por 10.000 registros |
| `details` do validador (por chamada de `checkSchema`; o `validate` devolve um erro por subschema avaliado: em `anyOf`/`oneOf`/`propertyNames` saem os dos ramos) | 50 | alinhado a `BATCH_MAX` — **palpite**. Os erros são deduplicados por path+code+message e cortados em 50 por `src/adapters/validator.ts#toDetails`; ao cortar, o último `Detail` tem `code` `too-many-errors` e a quantidade omitida na `message`. Os omitidos não são recuperáveis (o validador não guarda estado): o agente corrige e reenvia. Sem o teto, 7.000 itens inválidos davam ~400 KB de `details` |

Ficam sem teto, de propósito: `Where`, `from` e `to`. Não há dado nem precedente; revisar junto com a F3/F4.

## O que é palpite e o que não é

- **`relations` e `RecordType`:** têm número herdado do 0.x (`supersedes` limitado a 100; `SCHEMA_MAX_CHARS` de 16.000) e folga comprovada contra o uso real (ver medição).
- **`key`, `questions` e `aliases`:** o 0.x não tem esses campos, então **não há nenhuma medição por trás**. Os números copiam um teto que já existe no projeto: 200 caracteres em `target`/`milestoneType` e 50 em `BATCH_MAX` (que também fixa `questions` e `aliases`). São o valor mais conservador defensável, não um valor observado.

## Medição que sustenta os números

Fotografia de 2026-09-30, servidor 0.4.0, lida com `node scripts/export.ts <projeto>/<processo>` (somente leitura) sobre todos os processos existentes na máquina do autor: 8 projetos, 21 processos, 1.928 eventos, nenhum com erro. Um único usuário; quase tudo é fluxo OMC (milestones e vereditos).

| Medida | p50 | p99 | máximo |
|---|---|---|---|
| Linha inteira (bytes) | 1.075 | 3.460 | 7.371 |
| `data` (caracteres de JSON) | 788 | 3.161 | 6.850 |
| `supersedes` por evento (377 eventos usam) | 1 | 2 | 2 |
| Maior array em `data` (`decisions`) | 1 | 9 | 28 |
| Schema dos 5 tipos de auditoria (JSON compacto) | — | — | 704 a 1.687 |

Folga dos tetos sobre o maior valor observado: `relations` 50 vezes (100 contra 2), `RecordType` cerca de 10 vezes (16.000 contra 1.687), `data` cerca de 2,3 vezes (16.000 contra 6.850).

## Como revisitar

- **Quando:** ao aparecer evento recusado por um destes tetos, ao começar a F3/F4, ou quando houver log de outro usuário ou de fluxo que não seja OMC.
- **Como refazer a medição:** rodar `node scripts/export.ts <projeto>/<processo>` em cada processo (os nomes saem da tool `list`) e agregar, por evento, o tamanho da linha em bytes, `JSON.stringify(data).length`, o tamanho de `data.supersedes` e o comprimento de cada array em `data`. O script de agregação usado em 2026-09-30 não foi versionado; o método acima basta para reproduzi-lo.
- **O que procurar:** qualquer campo cujo máximo real passe de metade do teto. `key`, `questions` e `aliases` ainda precisam da primeira medição real.

## Pattern de schema de tipo (N1: safe-regex2 e maxLength)

Decisão da entrevista de 2026-10-02 sobre ReDoS em `pattern` de schema de tipo. Não é um teto de tamanho como os acima, mas fecha o mesmo tipo de risco: um dado gravado que trava o servidor e não tem volta.

### Por que

Um `pattern` como `^(\w+\s?)*$` trava o servidor, que é de thread única: ~800 ms com 37 caracteres, e o tempo dobra a cada caractere a mais. O tipo gravado por `register_type` é imutável, então um `pattern` patológico aceito hoje fica no log para sempre.

### Alternativas avaliadas

- **Fallback linear do V8:** `v8.setFlagsFromString` no bootstrap mais `unicodeRegExp: false` no ajv.
- **RE2 via `code.regExp` do ajv:** dependência nativa ou WASM.
- **`validate` num worker com timeout:** reabre a porta síncrona do `Validator` (D-25).
- **Análise estática:** `recheck` (5,8 MB, roda em worker) ou `safe-regex2`.
- **Allowlist de formatos nomeados:** migraria os 5 tipos de auditoria do OMC.
- **Aceitar e documentar no ADR:** deixa o servidor travável por um tipo gravado.

### Decisão do usuário

`safe-regex2` 5.1.1 (dependência exata, CJS, 11 KB, depende só de `ret`) em `src/adapters/validator.ts#createValidator`, aplicada em `Validator.checkSchema`, mais:

- `maxLength` ≤ 256 (`src/adapters/validator.ts#PATTERN_MAX_LENGTH`) obrigatório em todo subschema com `pattern`.
- `validate` com `allErrors: false`: o `maxLength` curto-circuita o regex, e o texto longo nem chega a ele.

Motivo: é biblioteca usada em campo e dispensa código próprio de análise de regex. Entra só no bundle do servidor; o hook não a alcança.

### Limites conhecidos, aceitos

- **Alternância sobreposta:** `(a|aa)+` passa pela `safe-regex2` (falso negativo). O `maxLength` limita o dano.
- **`$ref` com ponteiro JSON para dentro de dado:** `#/const`, `#/default`, `#/enum/0` e `#/examples/0` escondem um `pattern` do percurso. Aceito porque a ferramenta é de uso exclusivo de agentes de IA. A correção barata seria uma allowlist de `$ref`: `#`, `#/$defs/...` e `#/definitions/...`.

O ADR 0009 ainda não existe; esses limites entram na lista da F8.

### Consequência

Os 5 tipos de auditoria do OMC (`.hexlog/types/*.json`) não declaram `maxLength` em todos os campos com `pattern` (os de `hex:target:` já declaram) e seriam recusados por `checkSchema` numa v1 nova. Follow-up fora do PR-4: nova versão dos tipos com `maxLength`.
