# Tipos de auditoria: racional do planejamento e desvios da execução

Contrato dos cinco tipos custom que deixam o processo auditável por um humano depois
da execução: `planner-adr`, `architect-review`, `critic-findings` e
`plan-iteration-diff` (o porquê do planejamento) e `deviation` (o desvio do caminho
feliz na execução). Carregue este arquivo antes de registrar qualquer um deles e
antes de escolher o `result` do `plan-review`.

## Quando vale

Só num processo que fixou os cinco tipos (`list` com `project` e `process` mostra o
que ele fixou). Tipo fora do snapshot dá `TYPE_NOT_PINNED`: nesse caso a trilha não
se aplica, e o que se registra é só o marco ou o veredito do fluxo normal.

## Os cinco tipos

| Tipo | Registre quando | `attachment` |
|---|---|---|
| `planner-adr` | O planejador entrega um plano (iteração 1) ou um plano revisado (iteração 2 em diante): opções, decisão e porquê | O arquivo do plano (`path`) |
| `architect-review` | Depois que o Critic da mesma iteração devolveu: antítese, tradeoffs e síntese do architect | O relatório integral do architect (`text`) |
| `critic-findings` | Logo depois do `architect-review`: veredito e achados do Critic | O relatório integral do Critic (`text`) |
| `plan-iteration-diff` | Só da iteração 2 em diante: o que mudou no plano e qual achado motivou cada mudança | Opcional |
| `deviation` | Um desvio do caminho feliz na execução terminou (ver "Desvios") | Opcional: o texto do `## Deviations` do executor |

Os cinco tipos exigem `target` (`hex:target:<id>`, o mesmo dos marcos e vereditos do
fluxo) e `source` (quem escreveu o texto, até 100 caracteres, ex.:
`oh-my-claudecode:architect`; o `agent` do `register` continua sendo a skill que
disparou). Campos de cada tipo, além desses dois: `?` = opcional; `[n..m]` = tamanho
do array; `(n)` = máximo de caracteres:

```
planner-adr          iteration (>=1), principles?[0..5](200), drivers?[0..5](200),
                     options?[0..6]{name(80), pros(250), cons(250)}, chosen(240),
                     why(1000), attachment (hash do plano)
architect-review     iteration (>=1), antithesis(1500), tradeoffs[1..5](350),
                     synthesis(1500), verdict(200, texto livre),
                     attachment (hash do relatório integral)
critic-findings      iteration (>=1), verdict (reject|revise|accept-with-reservations|accept),
                     justification(1200),
                     findings[0..12]{severity (critical|major|minor), finding(220), whyItMatters(220)},
                     attachment (hash do relatório integral)
plan-iteration-diff  iteration (>=2), changed[1..10]{change(250), motivatedBy{finding(250), event?}},
                     supersedes[1..4] (ids completos), attachment?
deviation            trigger (verification-failure|plan-deviation|reviewer-reject|
                              blocked-dependency|agent-failure|other),
                     symptom(700), cause(700),
                     attempts[0..8]{action(200), result(200)},
                     alternatives[0..5]{option(200), whyDiscarded(200)},
                     outcome{status (resolved|worked-around|escalated|scope-cut|user-stop),
                             decidedBy (executor|lead|orchestrator|user), affected(200)},
                     attachment?, relatedEvent? (id completo)
```

Os campos são resumos: o texto integral vai no anexo. `findings` vem por severidade
decrescente; o que não couber fica só no anexo. O `verdict` do `architect-review` é
texto livre e não vira veredito no `state`. O schema fixado no processo é a fonte de
verdade: se este arquivo e o servidor divergirem, vale o servidor (`INVALID_EVENT`
aponta o campo).

## Ordem das chamadas: `attachment` antes de `register`

O `register` de um tipo que declara `attachment` exige o blob já gravado. Sempre:

1. `attachment` com `text` (texto que veio de um agente) ou `path` (arquivo `.md`
   em `.omc/plans`, como o plano); guarde o `hash` devolvido.
2. `register` do tipo, com `data.attachment` = esse `hash`.

Numa iteração de planejamento:

1. O planejador entrega o plano:
   - Iteração 1, depois do marco `plan-drafted`: `attachment` com `path` do arquivo do
     plano; `planner-adr` com esse `hash`. Guarde o `id` que o `register` devolveu.
   - Iteração 2 em diante, nesta ordem: `attachment` com `path` do plano **revisado**
     (o conteúdo mudou, então o `hash` é outro); `planner-adr` da nova iteração citando
     esse `hash` novo, nunca o da iteração 1 (guarde o `id` devolvido);
     `plan-iteration-diff` com `supersedes` = o `id` que o `register` do `planner-adr`
     da iteração anterior devolveu. Cada item de `changed[].motivatedBy` cita o achado
     e o id completo do evento que o levantou.
2. O architect devolve: `attachment` com `text` = o relatório integral. Guarde só o
   `hash` e escreva o breadcrumb `target=<slug> iter=<N> architect=<hash>` em
   `.omc/state/hexlog-audit-pending.txt`: uma linha por target, e ao escrever você
   substitui só a linha deste target, sem tocar nas dos outros.
   **Nenhum evento ainda.**
3. O Critic devolve (ele não consulta o hexlog): `architect-review` com o `hash`
   guardado, e então apague só a linha deste target do breadcrumb; `attachment` com
   `text` = o relatório integral do Critic; `critic-findings`; `plan-review`. O
   `architect-review` só vem depois do Critic para que a revisão do architect não
   esteja legível enquanto o Critic trabalha.
4. Fim do loop de plan ou ralplan, antes do `execution-approval`: `attachment` com
   `path` do plano final aprovado (depois de aplicadas as melhorias); `timeline` do
   target para conferir que cada iteração tem `planner-adr`, `architect-review` e
   `critic-findings` (lacuna = registre agora, dizendo em `source` que foi tardio);
   `execution-approval` com esse `hash` na `evidence`. O `timeline` é paginado: repita
   a chamada com `since` = `nextCursor` até `nextCursor` ser nulo antes de declarar
   uma lacuna, porque página cortada não é lacuna. Cadeia ou anexo quebrado na saída:
   pare e avise o usuário.

O passo 4 vale só para o fluxo plan/ralplan. O planejamento interno do autopilot não
tem `architect-review`: ali se registra o `planner-adr` (anexo por `path`) e, só se um
Critic de fato retornou, `critic-findings` e `plan-review`; a conferência não cobra
os outros tipos.

Sessão que morre entre os passos 2 e 3: o `hash` está no breadcrumb. Leia o blob com
`attachment` com `hash` (em páginas, até esgotá-las) para remontar os campos do
`architect-review` tardio; registre-o com `source` dizendo isso e apague só a linha
deste target. Sem breadcrumb, recupere o relatório entregue (não o recap) e refaça o
`attachment` (idempotente); nunca reexecute o architect.

`path` negado (`INVALID_INPUT` com `outside_allowed_root`: o arquivo do plano não está
em `.omc/plans` do diretório de trabalho do servidor): copie o plano para
`.omc/plans/<slug>.iter<N>.md` e tente `path` na cópia. Se ainda for negado, registre
um `deviation` (`trigger` `other`, `outcome.status` `worked-around`) e anexe por `text`
um texto-ponteiro com o caminho, o tamanho em bytes e o sha256 da cópia, no lugar do
plano.

## Fonte do texto anexado

O anexo de `architect-review` e `critic-findings` é o relatório integral que o agente
entregou ao orquestrador, colado sem resumir, cortar nem reformatar:

- o retorno da Task; ou
- o corpo do `SendMessage` ao lead, quando o agente tem `name`, sem o invólucro
  `<teammate-message>`.

Nunca o resumo da notificação de ociosidade (idle_notification), um recap final nem um
texto de trabalho do agente. O hash é o sha256 dos bytes: qualquer reformatação muda o
hash, e a trilha deixa de provar que aquele foi o texto do agente.

## Contrato de fluxo do Critic

`critic-findings.verdict` é o rótulo da linha `VERDICT:` do Critic, copiado em
minúsculas e sem tradução; rótulo fora da escala dá `INVALID_EVENT`, então releia a
linha. `plan-review.result` **não traduz o rótulo**: registra o que o orquestrador
fez com ele. A `evidence` do `plan-review` cita o id completo do `critic-findings` e o
hash do anexo do Critic.

| Rótulo do Critic | O que o orquestrador faz | `result` do `plan-review` |
|---|---|---|
| `accept` | fecha o loop | `approve` |
| `accept-with-reservations` | aplica as melhorias ao plano e fecha o loop, sem nova rodada; as reservas ficam em `findings` | `approve` (`iterate` só se optar por redigir de novo: então existe o `planner-adr` seguinte) |
| `revise` ou `reject`, com iteração restante | redige de novo e abre a iteração seguinte | `iterate` |
| `revise` ou `reject`, no teto de iterações | não abre iteração: marco `escalated` mais um `deviation`; sem `execution-approval` | `reject` |
| `plan --review` (só o Critic, sem loop) | devolve o veredito ao usuário; sem re-redação nem nova iteração | `approve` (`accept` ou `accept-with-reservations`), `request-changes` (`revise`) ou `reject` (`reject`), com `evidence` "returned to the user"; nunca `iterate` |

Conferência, no loop: `iterate` exige o `planner-adr` da iteração seguinte (ou o
`escalated`); `approve` exige o `execution-approval`; `reject` exige o `escalated`.
Em `plan --review`, `request-changes` não tem `planner-adr` seguinte.

## Desvios (`deviation`)

**Granularidade.** Uma ocorrência = sintoma → tentativas → desfecho, registrada quando
termina (resolvida ou terminal), com as tentativas em ordem em `attempts`. Não é um
evento por tentativa nem por linha de log.

**Causa e resolução.** `trigger` diz a causa; `outcome.status`, como acabou;
`decidedBy` diz quem decidiu (`executor`, `lead` do team, `orchestrator` ou `user`):

| Situação | `trigger` | `outcome.status` |
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

**Anexo e `relatedEvent`.** Quando o desvio veio do `## Deviations` do executor,
anexe esse texto integral. `relatedEvent` é opcional: o id completo do evento que
gerou o sintoma, quando se sabe; o carimbo do `deviation` é o do registro, não o do
sintoma.

**Quem registra.** Só quem recebe o resultado do executor registra os desvios dele: o
ralph (inclusive quando o autopilot o chama) ou o lead do team. A skill externa
registra só os loops próprios. O executor não chama tools do hexlog, e o mesmo
incidente não é registrado duas vezes.

## O que `state` omite

`state` só enxerga Marco e Veredito (`state.ts#targetOf` não devolve `target` para os
outros tipos): os cinco tipos ficam de fora dele e dos gates de conteúdo (`no-orphans`,
`no-conflicts`, `no-forks`, `no-invalid-references`). Em especial, o `architect-review`
não tem veredito companheiro e não pode colidir com o `plan-review` no gate
`no-conflicts`. A cadeia e os anexos deles continuam cobertos por `chain` e pelo gate
`chain-intact`. Para ler, use `events` (o filtro `target` acha qualquer tipo; `type`
filtra por um) ou `timeline`.
