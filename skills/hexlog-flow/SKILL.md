---
name: hexlog-flow
description: 'Registra no hexlog e cruza o que já foi registrado, num repositório cuja skill do projeto já diz qual projeto, processo e gate usar: escolhe a tool certa para a fase (`register`, `query`, `evaluate_gate`, `verify_chain`, `attach`, `read_attachment`, `list`, `describe_type`), guarda o texto integral de um agente como anexo endereçado por hash, registra o raciocínio do plano e os desvios da execução e audita um target de ponta a ponta. Use quando o pedido for gravar um registro, avaliar o gate ou mostrar a trilha de um target ("registra essa fase no hexlog", "avalia o gate dessa fase antes de eu seguir", "mostra a trilha completa desse target"). Configurar o hexlog num repositório pela primeira vez e definir fases, tipos e gates é com a hexlog-setup.'
---

# hexlog-flow

Registra no hexlog e cruza informação contra o que já foi registrado. Esta skill é a mecânica das tools: fase, tipo, relação e gate vêm da skill do projeto (definidos pela hexlog-setup), e ela só abre o processo da unidade de trabalho quando o ciclo de vida manda. O modelo (registro, vigência, processo, anexo) está na skill hexlog.

## De onde vêm projeto, processo e gate

Quem diz qual `project`, qual `process`, qual `gate` e qual padrão de target (`targetPattern`, opcional) usar é a skill do projeto que invocou esta. Ela traz a tabela de fases do repositório, e toda chamada abaixo usa o `process` da unidade corrente. Ao abrir, continuar ou fechar uma unidade de trabalho, leia `references/unit-lifecycle.md` (achar ou criar o processo, registrar cada fase, fechar a unidade).

Sem skill do projeto, pergunte ao usuário o `project`, o `process` e o `gate`, ou mande rodar a hexlog-setup. Nunca deduza o `project` pelo nome do diretório: ele vem do usuário ou da skill do projeto. O `.hexlog/flow.md` das versões antigas está aposentado: rode a hexlog-setup para gerar a skill do projeto.

## Qual tool chamar

| O que está acontecendo | Tool | Observação |
|---|---|---|
| Gravar um ou mais registros (fase, decisão, desvio, plano) | `register` | Lote de 1 a 50 registros, tudo ou nada. `agent` = o nome da skill que disparou (a skill do projeto que chamou a hexlog-flow, ou hexlog-flow se disparada direto). `key` onde a duplicata custa caro (seção "`key`") |
| Achar um registro, ou os de um target | `query` | Filtros `type`, `targetPrefix`, `where`, `text`, `ids`; devolve o `id` de cada um |
| Substituir ou revogar um registro (`supersedes`/`revokes`) | `query` com `type` + `targetPrefix` + `fields: []`, depois `register` com o `id` devolvido | Leia o vigente antes e use o `id` dessa resposta (seção "Busca, id e relações") |
| Seguir as relações de um registro | `query` com `relatedTo` = o `id`, ou `relations: "full"` e ler `in`/`out` do próprio registro | Seção "Busca, id e relações" |
| Saber o que mudou desde a última leitura | `query` com `changesSince` = o `marker` da leitura anterior | Só na primeira página (seção "Marcador, cursor e novidades") |
| Avaliar o gate da unidade (o `gate` do modelo, dado pela skill do projeto) | `evaluate_gate` com `gate` e, em geral, `target` | O servidor calcula a partir dos registros vigentes e devolve resultado e evidência. A resposta é enxuta por padrão (seção "Leitura enxuta") |
| Saber se o log e os anexos estão íntegros | `verify_chain` | Quebra de cadeia ou de anexo volta como **resultado** (`ok: false`). Para detectar cauda apagada, passe `expectedHead` = o `head` da verificação mais recente (`head-not-found`), guardado fora do log do hexlog (arquivo, corpo de PR): um `head` gravado no log some junto com a cauda |
| Saber o que existe (projetos, processos, o que um processo fixou) | `list` | Sem parâmetros, com `project`, ou com `project` e `process` |
| Registrar num tipo desconhecido | `describe_type` com `project`, `type` e `process` | Leia o schema fixado **antes** do `register`; com `process` devolve o tipo que o processo fixou, sem a versão na saída, e `process` junto de uma versão pedida é `INVALID_INPUT` |
| Guardar o texto de um agente ou de um plano | `attach`, depois `register` com o `hash` devolvido no campo marcado | Duas chamadas, nessa ordem (seção "Anexos") |
| Ler um anexo | `read_attachment` com `hash` | Em páginas: repita com `offset` = o `next` até acabar o `next` |
| Auditar um target ponta a ponta | `query` com `scope: "project"`, `targetPrefix` e `includeNonCurrent: true` | Ordem por instante, processo e sequência; pagine com `cursor` até acabar o `cursor`, e só então conclua que um registro falta (página cortada é só uma página). Depois `verify_chain` por processo |

## Busca, id e relações

Registro se acha por busca e se liga por id:

1. **Busque.** `query` com `type`, `targetPrefix`, `where` (igualdade em campo de primeiro nível de `data`, valor escalar) ou `text` (busca textual, até 200 caracteres, por relevância). Cada registro volta com `id`, `type`, `target`, `author`, `data`, `inCounts: {...}` e `outCounts: {...}` (arestas vigentes por nome de relação; as superadas e revogadas vêm em `nonCurrentInCounts` e `nonCurrentOutCounts`, e a saída `supersedes` ou `revokes` cai sempre nelas; sem aresta, o mapa some), e `needsReview` e `attachmentStatus` quando se aplicam. Para as arestas inteiras, passe `relations: "full"` (`in` e `out`).
2. **Pegue o `id`.** Ele é do servidor (`<processo>:<uuid v7>`): use o que a resposta devolve. Dentro de um mesmo `register`, um item se refere a outro anterior por `@<alias>` (o `alias` do item anterior); alias adiante, repetido ou inexistente é `INVALID_INPUT`.
3. **Navegue.** `relatedTo` traz os registros ligados a um `id`. Com `relations: "full"`, `in` lista quem aponta para o registro (`kind`, `as`, `from`, `current`: se a origem é vigente) e `out` lista as relações gravadas nele (`to`, e `current` quando o destino foi lido).

**Antes de `supersedes` ou `revokes`, leia o vigente.** Consulte com `type` + `targetPrefix`, confira o `target` do registro devolvido (e um campo-chave, se o tipo tiver um: peça-o em `fields`) e use o `id` dessa resposta. O `register` recusa destino de outro processo, de outro tipo, de outro target (só no `supersedes`) ou que já deixou de ser vigente; entre vários vigentes no mesmo prefixo ele aceita qualquer um, então acertar o `id` é com você.

```text
query({ project, process, type: "<tipo>", targetPrefix: "<target>", fields: [] })   // devolve o id do vigente
register({ project, process, agent: "hexlog-flow", key: "<target>:reexecucao-2",
  records: [{ type: "<tipo>", target: "<target>", data: { … },
              relations: [{ to: "<id devolvido>", kind: "supersedes" }] }] })
```

Por padrão a `query` só devolve registro **vigente**; `includeNonCurrent: true` traz também os substituídos e revogados, que é o que a auditoria precisa.

`needsReview` marca um registro vigente cujo apoio morreu: `staleOut` é quando ele apoia (`supports`) um registro que já foi substituído ou revogado sem que ele repetisse o apoio; `staleIn` é quando quem o apoiava foi substituído por algo que deixou de apoiar. É só aviso: a gravação e o gate seguem livres dele. Para limpar um `staleOut`, grave V' com `supersedes` → V e `supports` → a versão atual do que V apoiava. Em processo criado com herança (`create_process` devolve `lineageInheritance: true`), o `supports` herdado fica fora do `needsReview`: leia `references/crossref-rules.md` (seção "Herança de relações pela linhagem") antes de regravar relações de uma unidade superada nesse processo.

## Leitura enxuta

Toda resposta fica no seu contexto até o fim da sessão: peça só o que a próxima decisão usa.

- **Achar um `id` ou conferir que o registro existe:** `fields: []`, e o registro volta sem `data`. Precisa de um campo: `fields` com o nome dele. `fields` recorta o `data` só na saída (os filtros `where` e `text` continuam vendo o `data` inteiro), e quem omite `fields` recebe o `data` inteiro, que numa decisão chega a milhares de caracteres.
- **Arestas:** `relations: "none"` quando a leitura dispensa as arestas. O padrão (`counts`) já diz se há apoio ou citação; `relations: "full"` serve para ler `in`/`out`, regravar relações ou conferir `current`.
- **Reler o que já leu:** guarde o `marker` e releia com `changesSince` e `limit: 0`. Voltam só os ids que entraram ou saíram; abra o `data` deles por `ids`. Se vier `changes.omitted`, releia tudo.
- **Alcance curto:** `targetPrefix` do target, `type` e `limit` pequenos. `scope: "project"` fica para cruzar processos, junto de `targetPrefix` ou `ids`.
- **Gate:** por padrão (`evidence: "failing"`) a resposta traz só `counts: {...}` e os ids do que reprova. Vários targets vão em `targets: [...]`, numa chamada, só com `counts`; para os ids de um target reprovado, avalie-o sozinho com o `marker` do lote. `evidence: "full"` quando precisar de todas as listas de ids.

## `key`: onde a duplicata custa caro

`key` torna o reenvio seguro: a mesma `key` com o mesmo lote devolve o resultado guardado com `replayed: true`, sem gravar de novo; a mesma `key` com lote diferente é `IDEMPOTENCY_CONFLICT` (`errors.ts#keyConflict`). A `key` vale dentro do processo, tem até 200 caracteres e identifica a **intenção**, não a tentativa: derive-a do que o lote faz (ex.: `<target>:abertura`) e reenvie sempre com a mesma.

Passe `key` quando uma duplicata custa caro:

- **Abertura**: o registro que abre uma fase, um target ou um ciclo (um registro de início, a spec gravada).
- **Previsto**: o registro que declara trabalho esperado (itens previstos, um plano): duplicado, parece trabalho a mais.
- **Decisão de seguir**: a aprovação que libera a próxima etapa: duplicada, parece duas decisões.

A observação que a duplicata deixa intacta pode ir sem `key`. Sem `key`, o reenvio após um erro incerto pode duplicar, e o `scripts/insights.ts` acusa o lote sem `key` que repete o de antes.

A `key` é procurada antes das checagens que dependem de estado: o reenvio devolve `replayed` mesmo que, no intervalo, o destino de um `supports` tenha sido substituído.

## Regras de relação que o servidor impõe

Cada violação é `INVALID_RECORD` com `details[].code` = a regra e `details[].path` = `/records/<i>/relations/<j>`, e o lote fica sem gravar (`commands/register/errors.ts#ruleRefusal`):

| Regra | `code` |
|---|---|
| Origem e destino são registros distintos | `self-relation` |
| `supersedes` liga registros do **mesmo tipo** | `type-mismatch` |
| `supersedes` liga registros do **mesmo target** | `target-mismatch` |
| `supersedes` e `revokes` valem para registro do **próprio processo** | `cross-process-currency` |
| Por destino, o mesmo registro escolhe entre `supports` e `contradicts`, e entre `supersedes` e `revokes` | `supports-and-contradicts`, `supersedes-and-revokes` |
| `as` é um nome de relação fixado no processo e basta sozinho; com `kind` junto, os dois batem, e o `kind-mismatch` devolve o `kind` certo em `details[].kind` | `unknown-relation-name`, `kind-mismatch` |
| As pontas respeitam `from`/`to` do nome de relação, quando declaradas | `endpoint-type` |
| `supports` aponta para registro **vigente** | `stale-destination`, com `details[0].current` = o `id` da versão atual da linhagem, ou nulo |

Outros códigos: `FORK_REJECTED` quando `supersedes` ou `revokes` aponta para um registro que já deixou de ser vigente (`details[0].current` = a versão atual, ou nulo se a linhagem foi revogada: revogar encerra a linhagem, e um segundo `revokes` ou um `supersedes` que a "ressuscitaria" são recusados); `RELATION_NOT_FOUND` quando o destino é inexistente (`details[0].code` `missing`) ou o processo dele está corrompido (`destination-corrupted`, com `process`).

**Para citar um registro histórico**, já substituído ou revogado (a origem de uma decisão, a iteração anterior), use `derivesFrom` ou `complements`: só `supports` confere vigência, e `contradicts`, `answers` e `reopens` a dispensam.

**A linhagem fica em cada processo.** Como `supersedes` e `revokes` só valem no próprio processo, quem substitui um registro grava no processo dele. Um processo novo cita o antigo por `derivesFrom` ou `complements`.

## Alcance da leitura: `scope`

`query` e as perguntas de gate leem **um processo** por padrão (`scope: "process"`). Nesse alcance:

- `in` (ou `inCounts: {...}` e `nonCurrentInCounts`), `needsReview` e as perguntas `approved`, `no_pending` e `no_open_contradiction` veem só relações com as duas pontas no processo; a relação vinda de outro processo fica invisível, **sem aviso na resposta**;
- com `relations: "full"`, `out` de um destino em outro processo sai sem `current`.

Quando a evidência pode vir de outro processo (revisão feita noutra fase, apoio de outro processo), declare `scope: "project"`:

- na `query`, passe `scope: "project"` (o `process` passa a ser opcional): lê e verifica todos os processos do projeto;
- na pergunta de gate, o `scope: "project"` vai dentro da pergunta, ao definir o gate (`define_gate`); o `evaluate_gate` lê o projeto inteiro se alguma pergunta o declara.

No alcance projeto, um processo com cadeia quebrada ou manifesto ilegível falha fechado: `PROCESS_CORRUPTED` com o processo em `details[0].process`.

## Marcador, cursor e novidades

Toda leitura devolve `marker` (a cabeça de cada processo lido). Passe-o como `changesSince` para saber o que `entered` e o que `left` (com `reason`) desde então, e como `marker` do `evaluate_gate` para reproduzir a avaliação sobre os registros daquele instante. O marcador cobre exatamente os processos que nomeia: no alcance projeto, o que fica fora dele é lido como vazio. O `marker` do `register` nomeia só o processo gravado, então serve de `changesSince` ou de `marker` de gate apenas no alcance processo.

A lista de novidades vem só na primeira página (`limit: 0` devolve só ela, sem registros); nas seguintes, reenvie o mesmo `changesSince` junto do `cursor`, ou vem `INVALID_CURSOR`. Se a resposta traz `changes.omitted`, as listas são parciais: descarte esse marcador e releia tudo (`cursor`, e `includeNonCurrent` para o que saiu). Cursor, marcador ou `changesSince` que divergem do dado dão `INVALID_CURSOR` ou `MARKER_NOT_FOUND`. O marcador só vale para o alcance que o emitiu: o de um projeto que nomeia outros processos, num gate só de processo, dá `MARKER_NOT_FOUND`, e o de um processo num gate com pergunta de projeto lê os demais processos como vazios.

## Erros e reenvio

| Situação | O que fazer |
|---|---|
| `IO_ERROR` no `register` (`details[0].code` = o errno em minúsculas, como no ENOSPC) | **Resultado incerto**: o lote pode ter ficado inteiro no disco. Reenvie com a **mesma** `key`: devolve `replayed: true` ou grava. Sem `key`, o reenvio pode duplicar. Um `replayed` depois de um fsync que falhou deixa em aberto se o lote chegou ao disco, e o servidor deixa esse caso como está |
| `LOCK_TIMEOUT` com `lock-busy` ou `lock-lost` (`errors.ts#lockTimeout`) | Retentável com a mesma `key`. `lock-busy`: um dono vivo segurou o processo além da espera (15 s). `lock-lost`: o lote ficou sem gravar |
| `LOCK_TIMEOUT` com `holder-unreadable` | **Só o usuário resolve**: o dono do lock está ilegível. Pare e peça ao usuário que remova o lock |
| `INTERNAL` no `register` | Resultado incerto: reenvie com a **mesma** `key` |
| Cancelamento ou tempo estourado no `register`, e o reenvio com `key` dá `ATTACHMENT_NOT_FOUND` | **O lote pode ter sido gravado**: a chamada original ainda pode esperar o lock e gravar se o anexo for guardado antes de ela pegá-lo. Guarde o anexo (`attach`, idempotente) e reenvie com a mesma `key`: devolve `replayed: true` (a original gravou) ou grava |
| `PROCESS_CORRUPTED` com `broken-chain` ou `unreadable-manifest` | Pare e avise o usuário: o reparo é dele. `verify_chain` mostra onde a cadeia quebrou (com `unreadable-manifest`, falha do mesmo jeito) |
| `PROCESS_TOO_LARGE` | O log de um processo passou do teto; `details[0].process` diz qual, e pode ser o de um destino de relação, diferente do seu. Pare e avise o usuário; a saída é abrir a unidade em processo novo, com o próximo sufixo (`references/unit-lifecycle.md`, passo 3; o anterior fica aposentado e a linhagem fica no processo antigo, ver "Regras de relação") |
| `type` fora do que o processo fixou, inclusive um definido depois do `create_process` | `TYPE_NOT_PINNED`: o processo existente só conhece o que fixou ao nascer. Pare e avise o usuário |
| `data` fora do schema fixado | `INVALID_RECORD` com as violações de schema de cada registro inválido do lote (todas até um teto de custo; acima dele, uma por subschema mais um aviso de lista incompleta que manda ler o tipo com `describe_type`), cada uma com seu `path` (`/records/<i>/data/...`, até 50 `details`) e, em limite de tamanho, o valor medido no fim do texto do detalhe (`(got N)`); corrija o que veio e reenvie. Entram na lista a violação de schema e as recusas de relação que dependem só da entrada (`unknown-relation-name`, `kind-mismatch`, `cross-process-currency`, com `path` `/records/<i>/relations/<n>`, depois as de schema); `unmarked-attachment` e as regras de relação que dependem do estado param na primeira |
| Gate pedido ausente do que o processo fixou, inclusive um definido depois do `create_process` | `GATE_NOT_FOUND`: pare e avise o usuário |
| `key` reenviada com lote diferente do guardado | `IDEMPOTENCY_CONFLICT` |
| Dado 0.x em `<D>` | `LEGACY_DATA`: só um humano resolve (ver a skill hexlog) |
| Filtro inválido na `query` | `INVALID_FILTER` (`process` ausente, `text` sem termo, `limit: 0` fora do `changesSince`) ou `INVALID_INPUT` (`text` ou `limit` acima do teto) |
| `PROCESS_NOT_FOUND` ou `PROJECT_NOT_FOUND` | O modelo do projeto está desatualizado: pare e avise o usuário |
| `TYPE_NOT_FOUND` em `create_process` | O modelo ainda precisa ser aplicado neste hexlog: pare e mande rodar a hexlog-setup |
| `read_attachment` ou `register` com hash sem blob | `ATTACHMENT_NOT_FOUND` |

## Anexos

Dois caminhos para guardar texto com `attach`: um arquivo `.md` ou `.txt` que já existe no repositório (plano, spec, relatório gravado em disco) vai por `path`, e o blob é cópia exata sem o conteúdo passar pelo modelo; o texto que só existe na conversa (o relatório que um agente devolveu) vai por `text`, colado integral, como veio. Passe um dos dois. As regras de `path` e as recusas de `attach` estão em `references/attachments.md` (leia ao montar um `path` ou ao receber `INVALID_INPUT` do `attach`).

- `attach` é idempotente: o mesmo conteúdo dá o mesmo `hash` (`deduplicated: true`). O hash é o sha256 dos bytes, e qualquer reformatação o muda.
- O registro cita o anexo no campo cujo schema tem `format: "attachment"`. O `register` confere os anexos antes de gravar: `ATTACHMENT_NOT_FOUND` se o blob está ausente (chame `attach` antes), `ATTACHMENT_CORRUPTED` se os bytes mudaram depois de gravados (avise o usuário; o blob fica como está).
- O `data` de um registro cabe em até 16.000 caracteres canônicos (o JSON canônico do objeto, contado em unidades UTF-16: um emoji vale 2); acima disso o `register` recusa com `INVALID_INPUT` e o lote fica sem gravar. Texto grande vai por `attach`, e o registro cita só o `hash`.
- `query` devolve `attachmentStatus` (`ok`, `missing` ou `corrupted`) por hash citado, e `verify_chain` lista o anexo ausente ou corrompido em `attachmentBreaks`.

### Anexo sem marca: `unmarked-attachment`

O `register` recusa (`commands/register/attachments.ts#checkAttachments`) com `INVALID_RECORD` e `details[0].code` `unmarked-attachment` o campo sem `format: "attachment"` cujo valor é o hash de um anexo existente (`details[0].path` = `/records/<i>/data/<campo>`; o lote fica sem gravar). O processo fixou o tipo sem a marca e é imutável, então esse campo recusa esse hash para sempre. As duas saídas, com o exemplo, estão em `references/attachments.md` (leia ao receber `unmarked-attachment`): citar o hash por outro tipo já marcado e fixado no processo, ou abrir um processo novo com a versão marcada do tipo.

## Mudança de gate

Quem muda um gate (`define_gate`) julga se a mudança o aperta, porque só ele detecta a quebra: pergunta nova ou seletor mais estreito em `approved` ou `occurred` vai com `breaking: true`. O gate novo vale só para processos criados depois dele; o processo que já existe segue com o gate fixado.

## Referências

Uma linha por ramo; carregue o arquivo quando a condição valer.

- `references/unit-lifecycle.md`: ciclo de vida da unidade de trabalho (achar ou criar o processo, registrar cada fase, fechar a unidade). Leia ao abrir, continuar ou fechar uma unidade.
- `references/target-format.md`: sintaxe do `target` e `targetPattern` do projeto. Leia ao montar um `target` novo; ao reusar um já existente, copie o rótulo.
- `references/crossref-rules.md`: as três regras de cruzamento (mesma unidade, entre fases e unidades, lacuna que vira pergunta de gate) e a herança de relações pela linhagem. Leia ao decidir se um registro substitui outro, ao cruzar fases ou unidades, ao transformar uma lacuna do processo em pergunta de gate, ou ao ler relações de um registro superado em processo com herança.
- `references/attachments.md`: regras de `path` do `attach`, recusas e as saídas do `unmarked-attachment`. Leia ao montar um `path` ou ao receber `INVALID_INPUT` do `attach` ou `unmarked-attachment`.
- `references/audit-types.md`: exemplo trabalhado do fluxo OMC como tipos, nomes de relação e gate (plano com revisões, revisões do architect e do Critic, desvios, anexos, ordem das chamadas). Leia antes de registrar qualquer um desses registros e ao auditar um target desse fluxo.
