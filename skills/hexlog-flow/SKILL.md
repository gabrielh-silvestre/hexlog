---
name: hexlog-flow
description: "Use to register hexlog milestones/verdicts and cross-reference them against the process's current State for a repository that already has `.hexlog/flow.md` configured — picks the right tool (`register`, `evaluate_gate`, `events`, `chain`, `state`) based on the current phase read from the flow map. Examples: \"registra esse marco no hexlog\", \"avalia o gate dessa fase antes de eu seguir\". Not for configuring hexlog in a repository for the first time or defining phases/processes — that's hexlog-setup, which runs once."
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

## Árvore de decisão: qual tool chamar

| O que está acontecendo | Tool | Observação |
|---|---|---|
| Um marco ou decisão novo, sem gate envolvido | `register` | `agent` = nome da skill que disparou (a skill apontada que chamou a hexlog-flow, ou hexlog-flow mesma se disparada direto) |
| Avaliar um dos 5 gates embutidos (`no-orphans`, `no-conflicts`, `chain-intact`, `no-invalid-references`, `no-forks`) | `evaluate_gate` sem `result` | O servidor calcula a partir do Estado — nunca informe `result` para gate embutido |
| Avaliar o gate custom da fase corrente (campo `gate` do flow map) | `evaluate_gate` com `name` (valor do campo `gate`) e `result: {passed, evidence}` | Gate custom sem `result` informado lança `INVALID_EVALUATION` (`event-tools.ts#resolveGate`) |
| Precisa do histórico completo de um target | `events` | Filtra por `target` (`hex:target:<id>` — regex em `events.ts#Target`, ver `references/target-format.md`) |
| Precisa da cadeia de vereditos que se superam | `chain` | Segue `supersedes` até a raiz |
| Precisa do Estado vigente do processo (o que está aberto, quem venceu cada target) | `state` | Aceita `withData: true` pra trazer o `data` do Verdict vigente junto |

## Regras de cruzamento (v1)

Três regras, detalhadas com exemplo em `references/crossref-rules.md`: mesma fase
(conflito/superado), entre fases (chamadas que exigem o `process` certo da fase
certa) e lacunas (gate custom por fase via `evaluate_gate`). Leia essa referência
antes de registrar um veredito que supera outro, ou antes de decidir se uma
lacuna vira gate.

## Armadilhas

| Situação | Resultado |
|---|---|
| Tipo custom usado em `register` fora do snapshot fixado do processo | `TYPE_NOT_PINNED` (`event-tools.ts#registerEvent`) |
| `milestoneType` ou `decisions[].action` fora do vocabulário fixado | `VOCABULARY_VIOLATED` (`event-tools.ts#ensureVocabulary`) |
| `result` de um Veredito fora do vocabulário fixado | aviso `UNKNOWN_VOCABULARY` (`event-tools.ts#unknownResultWarning`), não bloqueia |
| `milestoneType: "gate"` ou chave `gate` num `register` fora de `evaluate_gate` | `RESERVED_FIELD` (`event-tools.ts#registerEvent`) |
| Reenviar um id completo com conteúdo diferente do já gravado | `CONFLICTING_ID` (`event-tools.ts#retryWithFullId`) — reenviar com o **mesmo** conteúdo é retentativa idempotente, não erro |
| Gate custom sem `result` | `INVALID_EVALUATION` (`event-tools.ts#resolveGate`) |

## Referências

- `references/crossref-rules.md` — as três regras de cruzamento v1, com exemplo de
  cada uma. Carregue antes de decidir se um marco conflita com outro, ou se uma
  lacuna do processo vira gate custom.
- `references/target-format.md` — formato de `hex:target:<id>` e como o `<id>`
  pode ser customizado pelo `targetIdPattern` do flow map. Carregue ao montar um
  `target` novo, não ao reusar um já existente em `events`/`chain`.
