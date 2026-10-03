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
| `RelationName` (`from`/`to`) e `Gate` (`where` das questões) | `canonicalize().length <= 16_000` no objeto inteiro (`RELATION_GATE_MAX_CHARS` em `src/domain/definitions.ts`) | **palpite**: o mesmo número do `RecordType`, ~22 vezes o maior gate real (729 caracteres). Definição é imutável e o dano ao `process.json` seria permanente. A recusa sai como `INVALID_INPUT`, sem código de erro novo |
| `aliases` | `.max(50)` | alinhado a `BATCH_MAX`, para todo item do lote poder ter alias — **palpite** (subiu de 20 na implementação do PR #60, quando 20 conflitou com `BATCH_MAX`) |
| `records.jsonl` (arquivo inteiro, por processo) | 64 MiB | **palpite**: ~56 mil registros de 1,2 KB, ~50 vezes o maior processo medido; sem medição por trás. Recusa com `PROCESS_TOO_LARGE` (27º código do catálogo 1.0, que fecha em 27 depois do corte da F6), implementada em `src/adapters/fs/process-store.ts#createProcessStore` (`readProcess` confere o tamanho com `stat` antes de ler, então `read` e `write` recusam um log acima do teto; `writeLocked` confere `tamanho do arquivo + bytes do lote > 64 MiB` antes de gravar, então o lote que cruzaria o teto é recusado sem gravar e o processo continua legível; exatamente 64 MiB ainda grava e lê). A `message` (inglês) orienta criar um processo novo para seguir registrando (`supersedes`/`revokes` não atravessam processos; rotação do log fica para um ADR futuro). Rever se o TF6 sair de ~500 ms ou se um processo real passar de ~10 MiB. **Custo no `search`:** o índice é montado a cada chamada (~0,12 ms por registro), então um processo no teto, com ~55 mil registros, custa ~6-7 s síncronos; cada sessão paga o próprio índice, ~42 MiB por 10.000 registros |
| `details` do validador (por chamada de `checkSchema`; o `validate` devolve um erro por subschema avaliado: em `anyOf`/`oneOf`/`propertyNames` saem os dos ramos) | 50 | alinhado a `BATCH_MAX` — **palpite**. Os erros são deduplicados por path+code+message e cortados em 50 por `src/errors.ts#capDetails`; ao cortar, o último `Detail` tem `code` `too-many-errors` e a quantidade omitida na `message`. Os omitidos não são recuperáveis (o validador não guarda estado): o agente corrige e reenvia. Sem o teto, 7.000 itens inválidos davam ~400 KB de `details` |
| `text` do `query` | 200 caracteres (`QUERY_TEXT_MAX_CHARS` em `src/queries/query-service.ts`) | precedente (0.x, `SEARCH_MAX_CHARS`) + medição: 2.000 termos de 9 letras deram 92 ms e 3.000 termos de 60 letras (183 KB) deram 2,4 s sobre 5.000 registros; textos de ~200 caracteres, 1 a 3 ms. Recusa `INVALID_FILTER` em `/text` com `code` `too-long`, antes de ler o log; a F5 reusa a constante no `.max()` do zod |
| texto do cursor | 65.536 caracteres (`CURSOR_MAX_CHARS` em `src/queries/cursor.ts`) | **palpite**: um cursor real tem ~2.200 caracteres, e o pior caso (~400 caracteres por processo, sem teto de processos por projeto) passa de 160 processos de nome máximo. Medido sem teto: cursor de 3,85 MB = 947 ms. Recusa `INVALID_CURSOR` com `code` `too-long`, antes do `split` e do sha256 |
| `changes.entered` e `changes.left` no envelope da `query` MCP | 100 cada (`CHANGES_ITEMS_CAP` em `src/mcp/kernel.ts`) | **palpite** do executor da F5: o plano só manda cortar `changes` no envelope. O corte é visível em `changes.omitted` (`entered` e `left` com a contagem cortada). Estimativa de tamanho: página cheia (24.000 caracteres de registros) mais `changes` 100/100 dá 14.000 a 19.000 tokens, abaixo do limite de 25.000 do Claude Code; se passar, o cliente grava o resultado em arquivo, sem perda. Follow-up: paginar `changes` junto dos registros |
| `ids` da `query` MCP | `.max(200)` | alinhado a `LIMIT_MAX` — **palpite** |
| `where` da `query` MCP | no máximo 50 chaves | alinhado a `BATCH_MAX` — **palpite**; igualdades escritas pelo agente |
| `changesSince` da `query` e `marker` do `evaluate_gate` | no máximo 200 chaves | **palpite**: o marcador tem uma chave por processo lido, vazios incluídos, e é devolvido pelo próprio servidor, que não tem teto de processos por projeto. 200 fica acima do ponto em que o cursor (65.536 caracteres) já falharia, então o zod nunca é o primeiro a quebrar. Projeto com mais de 200 processos é limite conhecido, para a F8 |
| `maxChars` de `read_attachment` | `.max(PAGE_CHARS_CAP)` (24.000) | mesmo teto de página da `query` (D-20); sem `maxChars` a tool passa `PAGE_CHARS_CAP` |
| `details` de erro do serviço (`issueDetails`) | 50 | o mesmo corte do validador (`capDetails` em `src/errors.ts`). Sem ele, 200.000 chaves inválidas no cursor deram um erro de 17,7 MB |

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

- **Alternância sobreposta (risco aceito em 2026-10-02):** `(a|aa)+` e `([a-z]|[a-z0-9])+` passam pela `safe-regex2` (falso negativo). O `maxLength` **não** limita o dano: os dois travam o servidor por cerca de 8 s com 27 caracteres, dez vezes abaixo do teto de 256. Aceito porque a ferramenta é de uso exclusivo de agentes e os 3 formatos em uso nos tipos de `.hexlog/types/` são lineares. O fallback linear do V8 não entrou porque só protege regex sem a flag `u` e exigiria reabrir a exclusão de `setFlagsFromString`/`unicodeRegExp`.
- **Falso positivo da `safe-regex2`:** ela recusa repetição dentro de grupo repetido mesmo quando a regex é linear (kebab-case `^[a-z]+(?:-[a-z]+)*$`, `^\d+(\.\d+)?$`) e sintaxe que o `ret` não parseia (lookbehind). Passam classe de caractere única (`^[a-z0-9-]+$`) e sequência sem grupo repetido. A `message` de `src/adapters/validator.ts#patternDetails` já diz isso ao agente.
- **`$ref` com ponteiro JSON para dentro de dado:** `#/const`, `#/default`, `#/enum/0` e `#/examples/0` escondem um `pattern` do percurso. Aceito porque a ferramenta é de uso exclusivo de agentes de IA. A correção barata seria uma allowlist de `$ref`: `#`, `#/$defs/...` e `#/definitions/...`.

O ADR 0009 ainda não existe; esses limites entram na lista da F8, junto de um follow-up: revisar o processo de definição de tipos e avaliar regex ou formatos nomeados prontos, fornecidos pelo hexlog, que o agente só customiza.

### Consequência

Os 5 tipos de auditoria do OMC (`.hexlog/types/*.json`) não declaram `maxLength` em todos os campos com `pattern` (os de `hex:target:` já declaram) e seriam recusados por `checkSchema` numa v1 nova. Follow-up fora do PR-4: nova versão dos tipos com `maxLength`.

## Busca: orçamento do cache e pendências do ADR 0008

Decisões N2 e N3 da revisão do PR #68 (F4 PR-5). O ADR 0008 ainda não existe; estes pontos entram nele na F8.

- **Orçamento em caracteres (N2):** `SEARCH_INDEX_BUDGET_CHARS` = 24.000.000 caracteres de `indexableText` somados entre os processos em cache (`src/adapters/search.ts`), no lugar dos 60.000 registros de 2026-10-02, cuja premissa (~250 MiB, ~7 s) vinha de um corpus de 36 palavras. O MiniSearch retém 8,7 a 12,4 B por caractere nos logs reais, então 24M caracteres são ~250 MiB, o alvo que se manteve. O número é **calibração** a partir desse alvo; 32M aceitaria 265 a 380 MiB. O maior processo real (~1M caracteres) fica ~24 vezes abaixo.
- **Busca fria acima do teto, aceita:** o orçamento só decide o que fica retido; o processo maior que o teto remonta a cada busca, sem truncar nem recusar (~0,3 µs por caractere, ~7 s síncronos a 24M). Pendência da F8: teto de texto por busca fria ou montagem fora do loop do stdio (`addAllAsync`), junto da emenda do "sem cache" do ADR 0008.
- **Alcance projeto sem cache (N3):** o `PROJECT_INDEX` monta um motor efêmero a cada busca, fora do orçamento. Custo medido: ~0,65 a 0,75 s por página com 5.000 registros e 10 processos, dentro do teto frio de 2.000 ms do SL4; a paginação remonta em toda página. Follow-up condicionado ao uso real: slot próprio para o projeto (gatilho: `text` de alcance projeto frequente). Falta um spec de orçamento de projeto com `text` frio (o P7 mede sem `text`).
- **IDF sobre o log inteiro (N1):** o filtro `allowed` restringe o conjunto devolvido (inclusive o fallback `OR`), mas as estatísticas de relevância vêm do log inteiro. Muda só a ordem de relevância, estável sob marcador, filtros e `text` fixos.
