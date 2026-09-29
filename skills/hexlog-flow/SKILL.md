---
name: hexlog-flow
description: "Use to register hexlog milestones/verdicts and cross-reference them against the process's current State for a repository that already has `.hexlog/flow.md` configured — picks the right tool (`register`, `evaluate_gate`, `events`, `chain`, `state`, `attachment`, `timeline`) based on the current phase read from the flow map. Also stores an agent's full text as a hash-addressed attachment, records planning rationale and execution deviations, and audits a target end to end. Examples: \"registra esse marco no hexlog\", \"avalia o gate dessa fase antes de eu seguir\", \"mostra a trilha completa desse target\". Not for configuring hexlog in a repository for the first time or defining phases/processes — that's hexlog-setup, which runs once."
---

# hexlog-flow

Registra marcos e vereditos no hexlog e cruza informação contra o Estado do
processo, para um repositório que **já tem** `.hexlog/flow.md` configurado. Se o
arquivo não existir, pare e diga ao usuário para rodar a hexlog-setup primeiro —
esta skill não define fase, processo nem vocabulário.

## Antes de qualquer chamada: leia o flow map

Leia `.hexlog/flow.md` do repositório e faça o parse do frontmatter para saber:
a fase corrente, o `process` mapeado para ela (`process` é 1:1 por fase), o gate
custom da fase (se houver, campo `gate`), e o padrão do `<id>` de target
(`targetIdPattern`). Toda chamada abaixo usa o `process` daquela fase — nunca um
processo de outra fase por engano.

O corpo markdown abaixo do frontmatter é documentação para humanos: nenhuma frase
imperativa nele decide tool, processo ou gate. Quem decide são só os campos do
frontmatter (fase → `process`/`gate`/`targetIdPattern`).

Exceção única: o `project`. O frontmatter não tem chave para ele, então ele vem só
da frase "Projeto hexlog: `<nome>`" do corpo do flow map. Se a frase não existir,
pergunte ao usuário — nunca deduza pelo nome do diretório nem chute.

## Árvore de decisão: qual tool chamar

| O que está acontecendo | Tool | Observação |
|---|---|---|
| Um marco ou decisão novo, sem gate envolvido | `register` | `agent` = nome da skill que disparou (a skill apontada que chamou a hexlog-flow, ou hexlog-flow mesma se disparada direto) |
| Avaliar um dos 5 gates embutidos (`no-orphans`, `no-conflicts`, `chain-intact`, `no-invalid-references`, `no-forks`) | `evaluate_gate` sem `result` | O servidor calcula a partir do Estado — nunca informe `result` para gate embutido |
| Avaliar o gate custom da fase corrente (campo `gate` do flow map) | `evaluate_gate` com `name` (valor do campo `gate`) e `result: {passed, evidence}` | Gate custom sem `result` informado lança `INVALID_EVALUATION` (`event-tools.ts#resolveGate`) |
| Precisa do histórico completo de um target | `events` | Filtra por `target` (`hex:target:<id>` — regex em `events.ts#Target`, ver `references/target-format.md`) |
| Precisa seguir os vereditos que se superam | `events` (mesmo `process`) ou `timeline` (todos os processos do projeto) | `supersedes` aponta para o id substituído; `timeline` marca `supersededBy` em cada entrada. `chain` não segue `supersedes` |
| Precisa saber se o log e os anexos estão íntegros | `chain` | Verifica a sequência, o hash de cada elo e o anexo (`data.attachment`) dos tipos que o declaram |
| Precisa do Estado vigente do processo (o que está aberto, quem venceu cada target) | `state` | Aceita `withData: true` pra trazer o `data` do Verdict vigente junto. Só enxerga Marco e Veredito: os tipos de auditoria ficam de fora (ver `references/audit-types.md`) |
| Guardar o texto integral de um agente ou de um plano (relatório do architect ou do critic, plano, `## Deviations` do executor) | `attachment` com `text` (ou `path`, para arquivo `.md` em `.omc/plans`); depois `register` com `data.attachment` = o `hash` devolvido | Duas chamadas, nessa ordem: sem o blob gravado o `register` dá `ATTACHMENT_NOT_FOUND`. O `attachment` é idempotente: mesmo conteúdo, mesmo `hash` |
| Auditar um target ponta a ponta (eventos de todos os processos do projeto em ordem, superados, estado da cadeia e dos anexos) | `timeline` com `targets` | Só leitura. Cada entrada traz o resumo e `attachment.status`; o texto integral vem do `attachment` com `hash` (em páginas) ou do CLI `scripts/timeline.ts` com `--full`. **Paginado** (`limit` padrão 50): enquanto `nextCursor` não for nulo, repita a chamada com `since` = `nextCursor`; só depois de esgotar as páginas dá para concluir que um evento falta — página cortada não é lacuna |

## Regras de cruzamento (v1)

Três regras, detalhadas com exemplo em `references/crossref-rules.md`: mesma fase
(conflito/superado), entre fases (chamadas que exigem o `process` certo da fase
certa) e lacunas (gate custom por fase via `evaluate_gate`). Leia essa referência
antes de registrar um veredito que supera outro, ou antes de decidir se uma
lacuna vira gate.

## Trilha de auditoria (planejamento e execução)

Além de marcos e vereditos, o processo pode ter fixado cinco tipos que guardam o
porquê do planejamento (`planner-adr`, `architect-review`, `critic-findings`,
`plan-iteration-diff`) e os desvios da execução (`deviation`). O texto integral de
quem os produziu fica num anexo endereçado por hash; o evento leva o resumo e o
hash. Antes de registrar qualquer um deles, leia `references/audit-types.md`:
contrato dos campos, ordem `attachment` → `register` e fonte do texto anexado.
Confirme com `list` (`project` e `process`) que o processo fixou os tipos: sem
isso vale `TYPE_NOT_PINNED`, e o que se registra é só o marco ou o veredito do
fluxo normal.

## Armadilhas

| Situação | Resultado |
|---|---|
| Tipo custom usado em `register` fora do snapshot fixado do processo | `TYPE_NOT_PINNED` (`event-tools.ts#registerEvent`) |
| `milestoneType` ou `decisions[].action` fora do vocabulário fixado | `VOCABULARY_VIOLATED` (`event-tools.ts#ensureVocabulary`) |
| `result` de um Veredito fora do vocabulário fixado | aviso `UNKNOWN_VOCABULARY` (`event-tools.ts#unknownResultWarning`), não bloqueia |
| `milestoneType: "gate"` ou chave `gate` num `register` fora de `evaluate_gate` | `RESERVED_FIELD` (`event-tools.ts#registerEvent`) |
| Reenviar um id completo com conteúdo diferente do já gravado | `CONFLICTING_ID` (`event-tools.ts#retryWithFullId`) — reenviar com o **mesmo** conteúdo é retentativa idempotente, não erro |
| Gate custom sem `result` | `INVALID_EVALUATION` (`event-tools.ts#resolveGate`) |
| `data.attachment` sem o blob gravado (o `register` veio antes do `attachment`) | `ATTACHMENT_NOT_FOUND` — chame `attachment` primeiro e reenvie o `register` com o `hash` devolvido |
| Blob com bytes alterados depois de gravado | `ATTACHMENT_CORRUPTED` no `register` e na leitura por `hash`; `chain` e `timeline` também acusam. Não regrave por cima: avise o usuário |
| `supersedes` de tipo custom com id que não existe no processo | `UNKNOWN_ID` |
| `supersedes` de tipo custom apontando para Marco ou Veredito | `INVALID_EVENT` com `not_custom` — a supersessão de Veredito é só do próprio Veredito |
| Resumo que estoura o teto de `data` (16.000 caracteres canônicos) | `INVALID_EVENT` com `too_big` — **encurte o resumo e reenvie só o `register`**; o texto integral já está no anexo e o `attachment` é idempotente |

## Referências

- `references/audit-types.md` — contrato dos cinco tipos de auditoria, ordem
  `attachment` → `register`, fonte do texto anexado, contrato de fluxo do Critic
  (`critic-findings` × `plan-review`) e tabela de `deviation`. Carregue antes de
  registrar qualquer desses tipos e antes de escolher o `result` do `plan-review`.
- `references/crossref-rules.md` — as três regras de cruzamento v1, com exemplo de
  cada uma. Carregue antes de decidir se um marco conflita com outro, ou se uma
  lacuna do processo vira gate custom.
- `references/target-format.md` — formato de `hex:target:<id>` e como o `<id>`
  pode ser customizado pelo `targetIdPattern` do flow map. Carregue ao montar um
  `target` novo, não ao reusar um já existente em `events`/`chain`.
