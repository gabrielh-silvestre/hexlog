---
phases: [descoberta, planejamento, execucao, revisao, verificacao]
process:
  descoberta: omc-discover
  planejamento: omc-plan
  execucao: omc-exec
  revisao: omc-review
  verificacao: omc-verify
skills:
  descoberta: [oh-my-claudecode:deep-interview]
  planejamento: [oh-my-claudecode:plan, oh-my-claudecode:ralplan]
  execucao: [oh-my-claudecode:ralph, oh-my-claudecode:autopilot, oh-my-claudecode:team, oh-my-claudecode:execute]
  revisao: [oh-my-claudecode:review, review-pr, deliver-phase]
  verificacao: [oh-my-claudecode:verify]
gate:
  descoberta: spec-crystallized
  planejamento: execution-approved
  execucao: completion-verified
  revisao: review-approved
  verificacao: verified
editedSkills: []
---

# Fluxo do OMC neste repositório

Projeto hexlog: `hexlog-teste`

Mapa de teste da 1.0 (nome descartável; o mapa real volta a `hexlog`). Três tipos
de registro, uma relação e um gate por fase. O `agent` de cada registro é o nome da
skill que o disparou.

Tipos:

- `milestone`: `milestoneType` (`phase-started`, `phase-completed`, `spec-written`,
  `plan-drafted`, `handoff`, `cancelled`, `escalated`), `summary` e `report` opcional
  (hash de anexo, relatório integral do agente).
- `verdict`: `claim` (o que se julga), `result` (`approve`, `reject`, `iterate`,
  `request-changes`, `pending`, `pass`, `fail`, `inconclusive`, `not-verifiable`),
  `rationale` e `report` opcional.
- `deviation`: `trigger`, `symptom` e `cause` de um desvio do plano.

Relação `judges` (`verdict` → `milestone`, kind `answers`): o veredito responde ao
marco que julga. Um veredito novo sobre o mesmo target usa `supersedes` no anterior,
e o gate só enxerga o veredito vigente.

Targets seguem a sintaxe default (rótulos `a.b.c`, minúsculos com hífen): o slug da
spec ou do plano, sem diretório nem extensão. A execução reutiliza o target do plano.

## descoberta → `omc-discover`

Skill `deep-interview`. Marco `spec-written` ao gravar a spec; veredito
`spec-crystallized` com `pass` ou `fail`. Gate `spec-crystallized`: veredito vigente
`spec-crystallized` com `pass`.

## planejamento → `omc-plan`

Skills `plan` e `ralplan`. Marco `plan-drafted` a cada redação do plano; marco
`escalated` se o loop esgotar; veredito `plan-review` (`approve`, `iterate`, `reject`
ou `request-changes`) e veredito `execution-approval`. Gate `execution-approved`:
veredito vigente `execution-approval` com `approve`.

## execucao → `omc-exec`

Skills `ralph`, `autopilot`, `team` e `execute`. Marcos `phase-started`,
`phase-completed`, `handoff`, `cancelled` e `escalated`; vereditos `qa-cycle`,
`team-verify`, `regression-check` e `completion-verified`; `deviation` em retry,
contorno ou reject de reviewer. Gate `completion-verified`: veredito vigente
`completion-verified` com `approve`.

## revisao → `omc-review`

Skills `review`, `review-pr` e `deliver-phase` (consultiva: o gate registra, não
bloqueia). Veredito `review` (`approve`, `request-changes` ou `reject`), com o
relatório no `report`; um re-review depois das correções usa `supersedes`. Gate
`review-approved`: veredito vigente `review` com `approve`.

## verificacao → `omc-verify`

Skill `verify`. Veredito `verified` (`pass`, `fail`, `inconclusive` ou
`not-verifiable`). Gate `verified`: veredito vigente `verified` com `pass`.
