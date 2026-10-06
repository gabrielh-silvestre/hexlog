# Exemplo trabalhado: o fluxo OMC como tipos, relações e gate

O hexlog não traz tipo, relação nem gate: o projeto os define. Este arquivo mostra
um conjunto completo para o fluxo de planejamento e execução do OMC — o plano com
suas revisões, as revisões do architect e do Critic, os desvios da execução e o
gate que diz se o plano está pronto —, com a ordem das chamadas. Use-o como modelo
para o projeto. O `list` com `project` e `process` diz só os nomes fixados no
processo; o schema de um tipo volta por `describe_type` (com `process`, o fixado), e
o de relações e gates, por tool nenhuma. Se este arquivo divergir do que o projeto
definiu, vale o servidor (`describe_type` mostra o schema; `INVALID_RECORD` aponta
os campos, todos os do lote de uma vez).

O exemplo é ilustrativo: ele é mais rico que o fixture de testes do repositório
(test/fixtures/domains/omc.ts), que é só a configuração mínima testada e não usa a
relação `rejects`. As convenções abaixo (veredito `accept` e `accept-with-reservations`
do Critic viram `approves`, `revise` e `reject` viram `rejects`, desvio fechado por
revisão no mesmo lote com `settles`, revisão do architect ligada ao plano por
`complements`) valem como documentação; nenhum spec confere o exemplo contra as
definições.

Tipo, relação ou gate que o processo não fixou dá `TYPE_NOT_PINNED`,
`INVALID_RECORD` (`unknown-relation-name`) ou `GATE_NOT_FOUND`: nesse caso a
trilha não se aplica, e o que se registra é só o que o processo conhece.

## Os três tipos

Todo campo que guarda hash de anexo tem `format: "attachment"` (a palavra-chave que
`domain/definitions.ts#attachmentFields` procura). Os campos que um gate filtra com
`where` ficam no primeiro nível de `data` e são escalares.

```
define_type({ project, name: "plan", schema: {
  type: "object",
  properties: {
    summary:    { type: "string" },
    isRevision: { type: "boolean" },
    diff:       { type: "string" },
    document:   { type: "string", format: "attachment" }
  },
  required: ["isRevision", "document"],
  if:   { properties: { isRevision: { const: true } } },
  then: { properties: { diff: { type: "string" } }, required: ["diff"] }
} })

define_type({ project, name: "review", schema: {
  type: "object",
  properties: {
    reviewer: { enum: ["architect", "critic", "lead", "orchestrator", "user"] },
    verdict:  { enum: ["accept", "accept-with-reservations", "revise", "reject"] },
    summary:  { type: "string" },
    report:   { type: "string", format: "attachment" }
  },
  required: ["reviewer", "summary"]
} })

define_type({ project, name: "deviation", schema: {
  type: "object",
  properties: {
    trigger:  { enum: ["verification-failure", "plan-deviation", "reviewer-reject",
                       "blocked-dependency", "agent-failure", "other"] },
    symptom:  { type: "string" },
    cause:    { type: "string" },
    attempts: { type: "array", items: { type: "object",
                properties: { action: { type: "string" }, result: { type: "string" } },
                required: ["action", "result"] } },
    alternatives: { type: "array", items: { type: "object",
                properties: { option: { type: "string" }, whyDiscarded: { type: "string" } },
                required: ["option", "whyDiscarded"] } },
    status:    { enum: ["resolved", "worked-around", "escalated", "scope-cut", "user-stop"] },
    decidedBy: { enum: ["executor", "lead", "orchestrator", "user"] },
    report:    { type: "string", format: "attachment" }
  },
  required: ["trigger", "symptom", "cause", "status", "decidedBy"]
} })
```

O `diff` é um **campo condicional** do `plan`: a cláusula condicional o exige quando
`isRevision` é verdadeiro, então uma revisão sem diff é recusada na gravação
(`INVALID_RECORD`) e a trilha fica completa por construção. O validador é estrito:
a propriedade `diff` se declara de novo dentro da cláusula then. O `diff` diz o que mudou
e qual achado motivou cada mudança.

## Os nomes de relação e o gate

```
define_relation({ project, name: "approves", kind: "supports",    from: ["review"], to: ["plan"] })
define_relation({ project, name: "rejects",  kind: "contradicts", from: ["review"], to: ["plan"] })
define_relation({ project, name: "settles",  kind: "answers",     to: ["deviation"] })

define_gate({ project, name: "plan-ready", questions: [
  { kind: "approved", of: { type: "plan" }, by: { type: "review" } },
  { kind: "no_pending", pending: { type: "deviation" }, resolvedBy: { kind: "answers" } }
] })
```

O gate cobra a **prontidão**: só a revisão vigente do plano precisa de aprovação
(`domain/gate.ts#evaluateGate`); a completude das revisões substituídas vem do
schema. `approved` passa quando todo plano vigente tem um `supports` vigente de um
`review` e nenhum `contradicts` vigente; `no_pending`, quando todo `deviation`
vigente tem um registro que o responde (`answers`).

Todas as definições entram **antes** do `create_process`.

O `target` do `plan`, do `review` e do `deviation` do mesmo item é o do plano ou uma
subárvore dele (`<alvo>.revisao`): o `evaluate_gate` herda o `target` nos seletores
sem `targetPrefix`, e um `review` fora dessa subárvore não conta como aprovador
(`domain/gate.ts#evaluateGate`), então o gate volta `passed: false`.

Se o flow map usa um processo por fase, o `deviation` tem dois casos. O de
planejamento (o loop que desistiu, `escalated`) fica no processo de planejamento, e
o gate o vê sem `scope`. O de execução vive no processo da fase de execução, e só
entra num gate de outro processo se a pergunta `no_pending` declara `scope:
"project"` (o alcance processo não vê relação de outro processo nem avisa).

## Ordem das chamadas: `attach` antes de `register`

O `register` de um registro que cita anexo exige o blob já guardado. Sempre:

1. `attach` com `path` (arquivo `.md`/`.txt` que já existe, como o plano) ou `text`
   (texto que veio de um agente); guarde o `hash` devolvido.
2. `register` com esse `hash` no campo marcado (`document`, `report`).

Numa iteração de planejamento:

1. **O planejador entrega o plano.**
   - Iteração 1: `attach` com o `path` do plano; `register` de um `plan` com
     `isRevision: false` e `document` = o `hash`. Guarde o `id` devolvido.
   - Iteração 2 em diante: `attach` com o `path` do plano **revisado** (o conteúdo
     mudou, então o `hash` é outro); `register` de um `plan` com `isRevision:
     true`, `diff` e o `hash` novo, com as relações `supersedes` → o `id` do plano
     anterior e `derivesFrom` → o `review` do Critic que motivou a revisão
     (`derivesFrom`, porque esse `review` pode já não ser o vigente). Use a `key`
     `<alvo>:plano-<n>`.
2. **O architect devolve.** `attach` com `text` = o relatório integral. Guarde só o
   `hash` e escreva o breadcrumb `target=<alvo> iter=<n> architect=<hash>` em
   `.omc/state/hexlog-audit-pending.txt`: uma linha por target, e ao escrever você
   substitui só a linha deste target. **Nenhum registro ainda.**
3. **O Critic devolve** (ele não consulta o hexlog). `attach` com `text` = o
   relatório integral do Critic. Depois, **um só `register`** com os dois `review`
   (o lote é atômico): o do architect (`reviewer: "architect"`, `report` = o `hash`
   guardado, relação `complements` → o plano) e o do Critic (`reviewer: "critic"`,
   `verdict`, `report`, e a relação do quadro abaixo). Apague só a linha deste
   target do breadcrumb. O architect só entra depois do Critic para que a revisão
   dele não esteja legível enquanto o Critic trabalha.
4. **Fim do loop de plan ou ralplan, antes de executar.** `attach` com o `path` do
   plano final (depois de aplicadas as melhorias, se houve); `evaluate_gate` com
   `gate: "plan-ready"` e `target` = o alvo do plano. `passed: false` barra a
   execução: a `evidence` de cada pergunta diz o que falta (`unsupported`,
   `contradictions`, `unresolved`). Se vier `omitted`, a lista é parcial: um
   `select` ou `where` mais estreito alcança o resto. Audite o alvo (abaixo) e registre agora a
   lacuna que achar, dizendo no `summary` que o registro foi tardio.

O passo 4 vale só para o fluxo plan/ralplan. O planejamento interno do autopilot
não tem architect: ali se registra o `plan` (anexo por `path`) e, só se um Critic de
fato retornou, o `review` dele.

Sessão que morre entre os passos 2 e 3: o `hash` está no breadcrumb. Leia o blob
com `read_attachment` (em páginas, até esgotá-las) para remontar o `review` do
architect tardio; registre-o dizendo isso no `summary` e apague só a linha deste
target. Sem breadcrumb, recupere o relatório entregue (não o recap) e refaça o
`attach` (idempotente); nunca reexecute o architect.

`path` negado (`INVALID_INPUT` com `outside-allowed-root`: o plano não está no
diretório de trabalho do servidor): copie o plano com cp para dentro dele e
anexe a cópia. Se ainda for negado, registre um `deviation` (`trigger` `other`,
`status` `worked-around`) e anexe por `text` um texto-ponteiro com o caminho, o
tamanho em bytes e o sha256 da cópia, no lugar do plano.

## Fonte do texto anexado

O anexo de uma revisão do architect ou do Critic é o relatório integral que o
agente entregou ao orquestrador, colado sem resumir, cortar nem reformatar:

- o retorno da Task; ou
- o corpo do `SendMessage` ao lead, quando o agente tem `name`, sem o invólucro
  `<teammate-message>`.

Nunca o resumo da notificação de ociosidade (idle_notification), um recap final nem
um texto de trabalho do agente. O hash é o sha256 dos bytes: qualquer reformatação
muda o hash, e a trilha deixa de provar que aquele foi o texto do agente.

## Contrato de fluxo do Critic

`verdict` é o rótulo da linha `VERDICT:` do Critic, copiado em minúsculas e sem
tradução; rótulo fora do `enum` dá `INVALID_RECORD`, então releia a linha. O que o
orquestrador faz com o rótulo é a decisão dele, e vira registro:

| Rótulo do Critic | O que o orquestrador faz | Relação do `review` do Critic com o plano |
|---|---|---|
| `accept` | fecha o loop | `approves` |
| `accept-with-reservations` | aplica as melhorias, grava o plano revisado (`isRevision: true`, `diff` com as melhorias) e fecha o loop; as reservas ficam no `summary` e no `report`. A aprovação do plano final vem de um `review` do `lead` ou do `orchestrator` que `approves` a revisão, com `derivesFrom` → o `review` do Critic | `approves` |
| `revise` ou `reject`, com iteração restante | redige de novo e abre a iteração seguinte (`plan` com `supersedes`) | `rejects` |
| `revise` ou `reject`, no teto de iterações | não abre iteração: grava um `deviation` (`status` `escalated`) e **não** aprova o plano; o gate `plan-ready` fica barrado | `rejects` |
| `plan --review` (só o Critic, sem loop) | devolve o veredito ao usuário; sem re-redação nem nova iteração | `approves` (`accept`, `accept-with-reservations`) ou `rejects` (`revise`, `reject`), com o `summary` "returned to the user" |

`supports` só aponta para registro vigente: o `review` aprova a revisão que está
vigente **agora**. Se o plano for substituído depois, a aprovação antiga deixa de
valer: o plano novo exige o seu próprio `review`, e o `review` antigo, ainda
vigente, ganha `needsReview` com `staleOut` (apoia um plano substituído). A
aprovação do usuário é um `review` com `reviewer: "user"` que `approves` o plano
vigente, com `key` (decisão de seguir).

## Desvios (`deviation`)

**Granularidade.** Uma ocorrência = sintoma → tentativas → desfecho, registrada
quando termina (resolvida ou terminal), com as tentativas em ordem em `attempts`.
Não é um registro por tentativa nem por linha de log.

**Causa e desfecho.** `trigger` diz a causa; `status`, como acabou; `decidedBy` diz
quem decidiu (`executor`, `lead` do team, `orchestrator` ou `user`):

| Situação | `trigger` | `status` |
|---|---|---|
| Retry depois de falha de verificação | `verification-failure` | `resolved`; `worked-around` se contornou sem corrigir; `escalated` se parou aí |
| Desvio do plano | `plan-deviation` | `resolved` ou `worked-around` |
| Corte de escopo | a causa que levou ao corte | `scope-cut` |
| Reject de reviewer | `reviewer-reject` | `resolved` |
| Dependência bloqueada | `blocked-dependency` | `resolved`, `worked-around` ou `scope-cut` |
| Teammate travado ou caído | `agent-failure` | `resolved`, `worked-around` ou `escalated` |
| Escalada (o loop desistiu) | a causa | `escalated` |
| Parada que exige o usuário | a causa | `user-stop`, com `decidedBy` `user` |
| Causa sem nome | `other` | o que couber |

**Fechar o desvio.** O gate cobra que todo `deviation` vigente tenha um registro que
o responda. Quem decide o desfecho (o orchestrator, o lead ou o usuário) grava, no
mesmo lote, um `review` com a relação `settles` → o `deviation` (por `@alias`).
Um `escalated` ou `user-stop` sem resposta é o que mantém o gate barrado, de
propósito.

**Anexo e origem.** Quando o desvio veio do `## Deviations` do executor, anexe esse
texto integral em `report`. O registro que gerou o sintoma, quando se sabe, entra
como relação `complements` → o `id` dele.

**Quem registra.** Só quem recebe o resultado do executor registra os desvios dele:
o ralph (inclusive quando o autopilot o chama) ou o lead do team. A skill externa
registra só os loops próprios. O executor não chama tools do hexlog, e o mesmo
incidente não é registrado duas vezes.

## Auditar um alvo ponta a ponta

`query` com `scope: "project"`, `targetPrefix` = o alvo e `includeNonCurrent: true`
traz os registros de todos os processos do projeto, vigentes e substituídos, em
ordem de instante. É paginado (`limit` até 200): repita com `cursor` até não vir
`cursor`, e só depois de esgotar as páginas dá para concluir que um registro falta
— página cortada não é lacuna. Confira que cada iteração tem o `plan`, o `review` do
architect e o do Critic. Depois, `verify_chain` em cada processo: `ok: false` ou
`attachmentBreaks` não vazio é motivo para parar e avisar o usuário.
