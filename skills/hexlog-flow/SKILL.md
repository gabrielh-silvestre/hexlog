---
name: hexlog-flow
description: "Use to register hexlog records and cross-reference them against what is already recorded, for a repository that already has `.hexlog/flow.md` configured — picks the right tool (`register`, `query`, `evaluate_gate`, `verify_chain`, `attach`, `read_attachment`, `list`) based on the current phase read from the flow map. Also stores an agent's full text as a hash-addressed attachment, records planning rationale and execution deviations, and audits a target end to end. Examples: \"registra esse marco no hexlog\", \"avalia o gate dessa fase antes de eu seguir\", \"mostra a trilha completa desse target\". Not for configuring hexlog in a repository for the first time or defining phases/processes — that's hexlog-setup, which runs once."
---

# hexlog-flow

Registra no hexlog e cruza informação contra o que já foi registrado, para um
repositório que **já tem** `.hexlog/flow.md` configurado. Se o arquivo não
existir, pare e diga ao usuário para rodar a hexlog-setup primeiro — esta skill
não define fase, processo, tipo, relação nem gate. O modelo (registro, vigência,
processo, anexo) está na skill hexlog.

## Antes de qualquer chamada: leia o flow map

Leia `.hexlog/flow.md` do repositório e faça o parse do frontmatter para saber:
a fase corrente, o `process` mapeado para ela (`process` é 1:1 por fase), o gate
da fase (se houver, campo `gate`) e o padrão de target do projeto
(`targetIdPattern`, opcional). Toda chamada abaixo usa o `process` daquela fase —
nunca um processo de outra fase por engano.

O corpo markdown abaixo do frontmatter é documentação para humanos: nenhuma frase
imperativa nele decide tool, processo ou gate. Quem decide são só os campos do
frontmatter (fase → `process`/`gate`/`targetIdPattern`).

Exceção única: o `project`. O frontmatter não tem chave para ele, então ele vem só
da frase "Projeto hexlog: `<nome>`" do corpo do flow map. Se a frase não existir,
pergunte ao usuário — nunca deduza pelo nome do diretório nem chute.

## Árvore de decisão: qual tool chamar

| O que está acontecendo | Tool | Observação |
|---|---|---|
| Gravar um ou mais registros (marco, decisão, veredito, desvio, plano) | `register` | Lote de 1 a 50 registros, tudo ou nada. `agent` = nome da skill que disparou (a skill apontada que chamou a hexlog-flow, ou hexlog-flow mesma se disparada direto). Passe `key` onde a duplicata custa caro (seção abaixo) |
| Achar um registro, ou os de um alvo | `query` | Filtros `type`, `targetPrefix`, `where`, `text`, `ids`; devolve o `id` de cada um |
| Substituir ou revogar um registro (`supersedes`/`revokes`) | `query` com `type` + `targetPrefix` + `fields: []`, depois `register` com o `id` devolvido | Leia o vigente antes; nunca use um `id` de memória. Ver "Busca, id, relações" |
| Seguir as relações de um registro | `query` com `relatedTo` = o `id`, ou ler `in`/`out` do próprio registro | Ver "Busca, id, relações" |
| Saber o que mudou desde a última leitura | `query` com `changesSince` = o `marker` da leitura anterior | Só na primeira página; ver "Marcador" |
| Avaliar o gate da fase (campo `gate` do flow map) | `evaluate_gate` com `gate` e, em geral, `target` | O servidor calcula a partir dos registros vigentes; o agente não informa resultado nem evidência |
| Saber se o log e os anexos estão íntegros | `verify_chain` | Quebra de cadeia ou de anexo é **resultado** (`ok: false`), não erro |
| Saber o que existe (projetos, processos, o que um processo fixou) | `list` | Sem parâmetros, com `project`, ou com `project` e `process` |
| Registrar num tipo que você não conhece | `describe_type` com `project`, `type` e `process` | Leia o schema fixado **antes** do `register`; com `process` devolve o tipo que o processo fixou, sem a versão na saída, e `process` junto de uma versão pedida é `INVALID_INPUT` |
| Guardar o texto de um agente ou de um plano | `attach`, depois `register` com o `hash` devolvido no campo marcado | Duas chamadas, nessa ordem; ver "Anexos" |
| Ler um anexo | `read_attachment` com `hash` | Em páginas: repita com `offset` = o `next` até não vir `next` |
| Auditar um alvo ponta a ponta | `query` com `scope: "project"`, `targetPrefix` e `includeNonCurrent: true` | Ordem por instante, processo e sequência; pagine com `cursor`. Depois `verify_chain` por processo |

## Busca, id, relações

Registro se acha por busca e se liga por id:

1. **Busque.** `query` com `type`, `targetPrefix`, `where` (igualdade em campo de
   primeiro nível de `data`, valor escalar) ou `text` (busca textual, até 200
   caracteres, por relevância). Cada registro volta com `id`, `type`, `target`,
   `author`, `data`, `in`, `out`, e `needsReview` e `attachmentStatus` quando se
   aplicam.
2. **Pegue o `id`.** Ele é do servidor (`<processo>:<uuid v7>`): nunca monte um à
   mão. Dentro de um mesmo `register`, um item se refere a outro anterior por
   `@<alias>` (o `alias` do item anterior); alias adiante, repetido ou inexistente
   é `INVALID_INPUT`.
3. **Navegue.** `in` lista quem aponta para o registro (`kind`, `as`, `from`,
   `current`: se a origem é vigente); `out` lista as relações gravadas nele
   (`to`, e `current` quando o destino foi lido). `relatedTo` traz os registros
   ligados a um `id`.

**Antes de `supersedes` ou `revokes`, leia o vigente.** Consulte com `type` +
`targetPrefix`, confira o `target` do registro devolvido (e um campo-chave, se o
tipo tiver um: peça-o em `fields`) e use o `id` dessa resposta, nunca um `id`
lembrado de antes. O `register` recusa destino de outro processo, de outro tipo
ou que não é mais vigente, mas não sabe qual dos vigentes você queria: com
vários registros no mesmo prefixo, ele aceita o errado em silêncio.

`fields` recorta o `data` só na saída: `fields: []` devolve o registro sem `data`
(basta para achar o `id`) e `fields` com nomes traz só esses campos. Como o
registro sai menor, cabem mais por página. Os filtros (`where`, `text`) continuam
vendo o `data` inteiro.

Por padrão a `query` só devolve registro **vigente**. `includeNonCurrent: true`
traz também os substituídos e revogados — é o que a auditoria precisa.

`needsReview` marca um registro vigente cujo apoio morreu: `staleOut` é quando ele
apoia (`supports`) um registro que já foi substituído ou revogado sem que ele
repetisse o apoio; `staleIn` é quando quem o apoiava foi substituído por algo que
não apoia mais. É só aviso: não bloqueia gravação nem entra em gate. Para limpar
um `staleOut`, grave V' com `supersedes` → V e `supports` → a versão atual do que
V apoiava.

## `key`: onde a duplicata custa caro

`key` torna o reenvio seguro: a mesma `key` com o mesmo lote devolve o resultado
guardado com `replayed: true`, sem gravar de novo; a mesma `key` com lote
diferente é `IDEMPOTENCY_CONFLICT` (`commands/register/state.ts#assertSameBatch`). A `key` vale dentro do processo, tem até 200
caracteres e identifica a **intenção**, não a tentativa: derive-a do que o lote
faz (ex.: `<target>:abertura`), nunca gere uma nova para reenviar.

Passe `key` quando uma duplicata custa caro:

- **Abertura**: o registro que abre uma fase, um alvo ou um ciclo (um marco de
  início, a spec gravada).
- **Previsto**: o registro que declara trabalho esperado (itens previstos, um
  plano) — duplicado, parece trabalho a mais.
- **Decisão de seguir**: a aprovação que libera a próxima etapa — duplicada, parece
  duas decisões.

Observação que a duplicata não prejudica pode ir sem `key`. Sem `key`, o reenvio
após um erro incerto pode duplicar, e o `scripts/insights.ts` acusa o lote sem
`key` que repete o de antes.

A `key` é procurada antes das checagens que dependem de estado: o reenvio devolve
`replayed` mesmo que, no intervalo, o destino de um `supports` tenha sido
substituído.

## Regras de relação que o servidor impõe

Cada violação é `INVALID_RECORD` com `details[].code` = a regra e `details[].path`
= `/records/<i>/relations/<j>`, nada gravado (`commands/register/errors.ts#ruleRefusal`):

| Regra | `code` |
|---|---|
| Registro não se relaciona consigo mesmo | `self-relation` |
| `supersedes` só entre registros do **mesmo tipo** | `type-mismatch` |
| `supersedes` e `revokes` só valem para registro do **próprio processo** | `cross-process-currency` |
| O mesmo registro não faz `supports` e `contradicts` ao mesmo destino, nem `supersedes` e `revokes` | `supports-and-contradicts`, `supersedes-and-revokes` |
| `as` precisa ser um nome de relação fixado no processo; com `kind` junto, os dois precisam bater | `unknown-relation-name`, `kind-mismatch` |
| As pontas respeitam `from`/`to` do nome de relação, quando declaradas | `endpoint-type` |
| `supports` só aponta para registro **vigente** | `stale-destination`, com `details[0].current` = o `id` da versão atual da linhagem, ou nulo |

Outros códigos: `FORK_REJECTED` quando `supersedes` ou `revokes` aponta para um
registro que já não é vigente (`details[0].current` = a versão atual, ou nulo se
a linhagem foi revogada: revogar encerra a linhagem, e um segundo `revokes` ou um
`supersedes` que a "ressuscitaria" são recusados); `RELATION_NOT_FOUND` quando o
destino não existe (`details[0].code` `missing`) ou o processo dele está corrompido
(`destination-corrupted`, com `process`).

**Citar registro histórico não é `supports`.** Só `supports` confere vigência.
Para citar um registro que já foi substituído ou revogado (a origem de uma
decisão, a iteração anterior), use `derivesFrom` ou `complements`. `contradicts`,
`answers` e `reopens` também não conferem vigência.

**Linhagem não atravessa processo.** Como `supersedes` e `revokes` só valem no
próprio processo, quem substitui um registro grava no processo dele. Um processo
novo não substitui nem revoga nada do antigo; ele o cita por `derivesFrom` ou
`complements`.

## Alcance da leitura: `scope`

`query` e as perguntas de gate leem **um processo** por padrão (`scope:
"process"`). Nesse alcance:

- `in`, `needsReview` e as perguntas `approved`, `no_pending` e
  `no_open_contradiction` só veem relações com as duas pontas no processo; relação vinda de outro processo não
  aparece, e **a resposta não avisa**;
- `out` de um destino em outro processo sai sem `current`.

Quando a evidência pode vir de outro processo (revisão feita noutra fase, apoio
de outro processo), declare `scope: "project"`:

- na `query`, passe `scope: "project"` (o `process` passa a ser opcional): lê e
  verifica todos os processos do projeto;
- na pergunta de gate, o `scope: "project"` vai dentro da pergunta, ao definir o
  gate (`define_gate`); o `evaluate_gate` lê o projeto inteiro se alguma pergunta
  o declara.

No alcance projeto, um processo com cadeia quebrada ou manifesto ilegível falha
fechado: `PROCESS_CORRUPTED` com o processo em `details[0].process`.

## Marcador, cursor e novidades

Toda leitura devolve `marker` (a cabeça de cada processo lido). Passe-o como
`changesSince` para saber o que `entered` e o que `left` (com `reason`) desde
então, e como `marker` do `evaluate_gate` para reproduzir a avaliação sobre os
registros daquele instante. O marcador cobre exatamente os processos que nomeia:
no alcance projeto, o que ele não nomeia é lido como vazio. O `marker` do
`register` nomeia só o processo gravado, então use-o como `changesSince` ou como
`marker` de gate apenas no alcance processo. A lista de novidades vem só na
primeira página; nas seguintes, reenvie o mesmo `changesSince` junto do `cursor`, senão
`INVALID_CURSOR`. Se a resposta traz `changes.omitted`, as listas são parciais e
esse marcador não deve ser reusado: releia tudo (`cursor`, e `includeNonCurrent`
para o que saiu). Cursor, marcador ou `changesSince` que não casam com o dado
dão `INVALID_CURSOR` ou `MARKER_NOT_FOUND`. O marcador só vale para o alcance que o
emitiu: o de um projeto que nomeia outros processos, num gate só de processo, dá `MARKER_NOT_FOUND`, e o de um
processo num gate com pergunta de projeto lê os demais processos como vazios.

## Erros incertos e reenvio

| Situação | O que fazer |
|---|---|
| `IO_ERROR` no `register` (`details[0].code` = o errno em minúsculas, como no ENOSPC) | **Resultado incerto**: o lote pode ter ficado inteiro no disco. Reenvie com a **mesma** `key`: devolve `replayed: true` ou grava. Sem `key`, o reenvio pode duplicar. Um `replayed` depois de um fsync que falhou não garante o lote no disco; a 1.0 não corrige esse caso |
| `LOCK_TIMEOUT` com `lock-busy` ou `lock-lost` (`adapters/fs/lock.ts#lockTimeout`) | Retentável com a mesma `key`. `lock-busy`: um dono vivo segurou o processo além da espera (15 s). `lock-lost`: nada foi gravado |
| `LOCK_TIMEOUT` com `holder-unreadable` | **Não se resolve repetindo.** O dono do lock não pode ser lido: pare e peça ao usuário que remova o lock |
| `INTERNAL` no `register` | Resultado incerto: reenvie com a **mesma** `key` |
| Cancelamento ou tempo estourado no `register`, e o reenvio com `key` dá `ATTACHMENT_NOT_FOUND` | **Não prova que o lote ficou fora.** A chamada original pode ainda esperar o lock e grava se o anexo for guardado antes de ela pegá-lo. Guarde o anexo (`attach`, idempotente) e reenvie com a mesma `key`: devolve `replayed: true` (a original gravou) ou grava |
| `PROCESS_CORRUPTED` com `broken-chain` | Não grave nem tente reparar. Avise o usuário; `verify_chain` mostra onde a cadeia quebrou |
| `PROCESS_CORRUPTED` com `unreadable-manifest` | Não grave nem tente reparar. Avise o usuário: `verify_chain` falha do mesmo jeito |
| `PROCESS_TOO_LARGE` | O log de um processo passou do teto; `details[0].process` diz qual, e pode ser o de um destino de relação, não o seu. Pare e peça ao usuário um processo novo e a atualização do flow map: esta skill não cria processo (a linhagem não atravessa; ver acima) |

## Anexos

- **Arquivo `.md` ou `.txt` que já existe no repositório** (plano, spec, relatório
  gravado em disco) se anexa por `path`, sem reescrever o texto: o blob é cópia
  exata e o conteúdo não passa pelo modelo. `path` é relativo ao diretório de
  trabalho do servidor (ou absoluto), fica dentro dele e fora de `<D>`, termina
  em `.md` ou `.txt` (minúsculo) e é arquivo regular, sem symlink, de até 1 MiB
  e UTF-8 válido. Recusa: `INVALID_INPUT` com `details[0].code`
  `outside-allowed-root` (também quando o diretório do `path` não resolve),
  `inside-data-dir`, `bad-extension`, `not-regular` (symlink ou hardlink),
  `not-found`, `too-big`, `invalid-utf8` ou `bad-args` (inclui arquivo vazio). Com
  `outside-allowed-root`, copie o arquivo com cp (não o reescreva) para dentro do
  diretório do servidor e anexe a cópia.
- **Texto que não existe em arquivo** (relatório que um agente devolveu) se anexa
  por `text`, colado sem resumir, cortar nem reformatar. `text` ou `path`, nunca
  os dois. O `text` é recusado em `/text` quando vazio (`bad-args`), com
  surrogate solto (`lone-surrogate`) ou acima de 1 MiB em bytes UTF-8 (`too-big`).
- `attach` é idempotente: o mesmo conteúdo dá o mesmo `hash` (`deduplicated:
  true`). O hash é o sha256 dos bytes: qualquer reformatação muda o hash.
- O registro cita o anexo no campo cujo schema tem `format: "attachment"`. O
  `register` confere os anexos antes de gravar: `ATTACHMENT_NOT_FOUND` se o blob
  não existe (chame `attach` antes), `ATTACHMENT_CORRUPTED` se os bytes mudaram
  depois de gravados (não regrave por cima: avise o usuário).
- O `data` de um registro cabe em até 16.000 caracteres canônicos (o JSON
  canônico do objeto, contado em unidades UTF-16: um emoji vale 2); acima disso
  o `register` recusa com `INVALID_INPUT`, sem gravar nada. Texto grande vai
  por `attach`, e o registro cita só o `hash`.
- `query` devolve `attachmentStatus` (`ok`, `missing` ou `corrupted`) por hash
  citado, e `verify_chain` lista o anexo ausente ou corrompido em
  `attachmentBreaks`.

### Anexo sem marca: `unmarked-attachment`

O `register` recusa (`commands/register/attachments.ts#checkAttachments`) com
`INVALID_RECORD` e `details[0].code` `unmarked-attachment` um campo **sem** `format: "attachment"` cujo valor é o hash de um anexo que
existe (`details[0].path` = `/records/<i>/data/<campo>`; nada gravado). O processo
fixou o tipo sem a marca e é imutável: `create_process` não refixa, então ele
nunca mais grava esse hash nesse campo. Duas saídas, nesta ordem de preferência:

1. **Citar o hash por outro tipo já fixado no processo que tenha a marca.** É a
   saída quando a linhagem (`supersedes`/`revokes`) precisa continuar, porque essas
   relações não atravessam processos. Só existe quando o campo sem marca é
   **opcional** na versão fixada do tipo: o sucessor (mesmo tipo) **omite o
   campo**, e um registro do tipo marcado guarda o hash. O sucessor se liga a
   esse registro por `derivesFrom` ou `complements`, com o registro do tipo
   marcado antes dele no mesmo lote (`@alias`). Os tipos do exemplo são
   hipotéticos: `plan-legacy` (fixado com o campo `file` sem marca, opcional) e
   `evidence-file` (marcado, com o campo `file`):

   ```
   records: [
     { alias: "file", type: "evidence-file", target: "x.y", data: { file: "<hash>" } },
     { type: "plan-legacy", target: "x.y", data: { isRevision: true, diff: "…" },
       relations: [ { to: "<id do plan-legacy vigente>", kind: "supersedes" },
                    { to: "@file", kind: "derivesFrom" } ] }
   ]
   ```

2. **Processo novo**, fixando a versão marcada do tipo (definida com `breaking:
   true`, porque acrescentar `format` é quebra). É a saída quando nenhum tipo
   marcado está fixado no processo, ou quando o campo é `required` na versão fixada
   (o sucessor teria de preencher o campo, e o único valor verdadeiro é o hash que
   a guarda recusa). O processo novo **não substitui nem revoga** registros do
   antigo: a linhagem fica presa no processo velho.

## Mudança de gate

Quem muda um gate (`define_gate`) julga se a mudança o aperta: pergunta nova ou
seletor mais estreito em `approved` ou `occurred` vai com `breaking: true`. O
servidor não detecta quebra de gate. O gate novo só vale para processos criados
depois dele; o processo que já existe segue com o gate fixado.

## Armadilhas

| Situação | Resultado |
|---|---|
| `type` fora do que o processo fixou, inclusive um definido depois do `create_process` | `TYPE_NOT_PINNED`: o processo existente não recebe definição nova. Pare e avise o usuário; não repita `define_type` em loop |
| `data` fora do schema fixado | `INVALID_RECORD` com a primeira violação de schema de cada registro inválido do lote, cada uma com seu `path` (`/records/<i>/data/...`, no máximo 50 `details`); corrija e reenvie, e a próxima violação aparece. Só a violação de schema é agregada: `unmarked-attachment` e as regras de relação continuam parando na primeira |
| Gate pedido que o processo não fixou, inclusive um definido depois do `create_process` | `GATE_NOT_FOUND`: pare e avise o usuário |
| Reenviar uma `key` com lote diferente do guardado | `IDEMPOTENCY_CONFLICT` |
| Dado 0.x em `<D>` | `LEGACY_DATA`: só um humano resolve (ver a skill hexlog) |
| Filtro inválido na `query` | `INVALID_FILTER` (`process` ausente, `text` sem termo) ou `INVALID_INPUT` (`text` ou `limit` acima do teto) |
| `PROCESS_NOT_FOUND` ou `PROJECT_NOT_FOUND` | O flow map está desatualizado: pare e avise o usuário |
| `read_attachment` ou `register` com hash sem blob | `ATTACHMENT_NOT_FOUND` |

## Referências

- `references/audit-types.md` — exemplo trabalhado do fluxo OMC como tipos, nomes
  de relação e gate: plano com revisões, revisões do architect e do Critic,
  desvios, anexos e a ordem das chamadas. Carregue antes de registrar qualquer um
  desses registros.
- `references/crossref-rules.md` — as três regras de cruzamento, com exemplo de
  cada uma. Carregue antes de decidir se um registro substitui outro, ou se uma
  lacuna do processo vira pergunta de gate.
- `references/target-format.md` — sintaxe do `target` e como o projeto pode
  restringi-la com `targetIdPattern`. Carregue ao montar um `target` novo, não ao
  reusar um já existente.
