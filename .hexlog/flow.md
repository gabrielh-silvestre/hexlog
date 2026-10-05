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
  revisao: [oh-my-claudecode:review]
  verificacao: [oh-my-claudecode:verify]
gate:
  descoberta: spec-crystallized
  planejamento: execution-approved
  execucao: completion-verified
  revisao: review-approved
  verificacao: verified
versions:
  types:
    architect-review: "1.0"
    critic-findings: "1.0"
    deviation: "1.0"
    plan-iteration-diff: "1.0"
    planner-adr: "1.0"
  vocabulary:
    hexlog: "1.0"
  gates:
    completion-verified: "1.0"
    execution-approved: "1.0"
    review-approved: "1.0"
    spec-crystallized: "1.0"
    verified: "1.0"
editedSkills:
  - oh-my-claudecode:deep-interview
  - oh-my-claudecode:plan
  - oh-my-claudecode:ralplan
  - oh-my-claudecode:ralph
  - oh-my-claudecode:autopilot
  - oh-my-claudecode:team
  - oh-my-claudecode:verify
  - oh-my-claudecode:execute
  - oh-my-claudecode:review
---

# Fluxo do OMC (fork `omc-hexlog`) neste repositório

Piloto: as skills do fork `gabrielh-silvestre/oh-my-claudecode` (branch `hexlog`)
registram marcos e vereditos nos processos abaixo. Projeto hexlog: `hexlog`,
vocabulário do owner `hexlog` v1.0. O `agent` de cada evento é o nome da skill
que o disparou.

Vocabulário:

- `milestoneType`: `phase-started`, `phase-completed`, `spec-written`,
  `plan-drafted`, `handoff`, `cancelled`, `escalated`
- `result`: `approve`, `reject`, `iterate`, `request-changes`, `pending`,
  `pass`, `fail`, `inconclusive`, `not-verifiable`

Targets são livres (padrão default `[^\s:]+`): o slug da spec, do plano ou do
team, sem o diretório nem a extensão — ex. `hex:target:deep-interview-auth-flow`.
Na trilha de auditoria, a raiz do target é o slug do plano: a execução (ralph,
autopilot, team) reutiliza o target do plano. A spec da descoberta tem target
próprio; para auditar a trilha inteira, `timeline` com os dois (`<spec> <plano>`).

## descoberta → `omc-discover`

Skill: `deep-interview` (o `deep-dive` foi retirado no OMC 5.0.0).

| Ponto | Evento | Claim / tipo | Result |
|---|---|---|---|
| Spec gravada em `.omc/specs/` (`deep-interview:390-490`) | milestone + verdict | `spec-written` / `spec-crystallized` | `pass` (PASSED) \| `fail` (BELOW_THRESHOLD_EARLY_EXIT) |
| Execution bridge (`deep-interview:496-523`) | verdict | `execution-approval` | `approve` (rota na evidência) \| `request-changes` \| `pending` |

Gate `spec-crystallized`: veredito ativo `spec-crystallized=pass` na spec, sem
`fail` ativo. No `deep-interview` (`:504`, `:752`), a rota ralplan→autopilot
para em `pending approval`.

## planejamento → `omc-plan`

Skills: `plan` e `ralplan` (alias de `plan --consensus`).

| Ponto | Evento | Claim / tipo | Result |
|---|---|---|---|
| Plano inicial (`plan:94-99`, `ralplan:45-50`) | milestone | `plan-drafted` | — |
| ADR do Planner, a cada redação (`plan:136`, `:111`, `ralplan:69`, `:58`, `autopilot:118`) | tipo | `planner-adr` | — |
| Re-draft da iteração ≥ 2 (`plan:111`, `ralplan:58`) | tipo | `plan-iteration-diff` | — |
| Relatório do Architect, anexado no Step 3 e registrado depois do Critic (`plan:137-138`, `ralplan:70-71`) | tipo | `architect-review` | — |
| Relatório do Critic (`plan:138`, `:150`, `ralplan:71`, `autopilot:118`) | tipo | `critic-findings` | — |
| Revisão Architect → Critic (`ralplan:52-56`, `plan:105-106`) | verdict | `plan-review` | `approve` \| `iterate` \| `reject` \| `request-changes` (só `plan --review`, `plan:150`) |
| Loop esgotado em 5 iterações (`plan:109-115`) | milestone | `escalated` | — |
| Aprovação de execução (`plan:121-127`, `ralplan:63-65`) | verdict | `execution-approval` | `approve` \| `request-changes` \| `reject` \| `pending` |

Gate `execution-approved`: veredito ativo `execution-approval=approve` no plano.
`pending`, `request-changes` e `reject` barram (`plan:44`, `:240`).

Rotas sem aprovação humana separada registram a aprovação aqui por conta
própria: o `autopilot` invocado direto (invocar já é aprovar).

Fora do mapeamento: o Pre-Execution Gate do `ralplan` (`:82-152`) é decidido
pelo hook `src/hooks/keyword-detector/index.ts`, não pelo agente; registrá-lo
exige mudar o hook.

## execucao → `omc-exec`

Skills: `ralph`, `autopilot` (chama o ralph na Phase 2, `autopilot:96`), `team`
(compõe com o ralph, `team:754-805`) e `execute` (só quando invocada direto,
fora de ralph/autopilot/team, `execute:23-28`). O `execute` não registra
`completion-verified`, então o gate da fase `execucao` não fecha por essa rota;
a aprovação fica nos gates `review-approved` (`revisao`) e `verified`
(`verificacao`).

| Ponto | Evento | Claim / tipo | Result |
|---|---|---|---|
| Transição de estágio (`team:396-413`, `autopilot:72-74`) | milestone | `phase-started` / `phase-completed` | — |
| Handoff de estágio (`team:167-189`) | milestone | `handoff` | — |
| Ciclo de QA (`autopilot:102-106`) | verdict | `qa-cycle` | `pass` \| `fail` |
| team-verify (`team:137-138`) | verdict | `team-verify` | `pass` \| `fail` |
| Reviewer/architect (`ralph:100-112`, `autopilot:107-111`, `team:790-797`) | verdict | `completion-verified` | `approve` \| `reject` |
| Regressão pós-deslop (`ralph:121-126`) | verdict | `regression-check` | `pass` \| `fail` |
| Cancelamento / escalada (`ralph:226-229`, `autopilot:159-163`, `team:146-151`) | milestone | `cancelled` / `escalated` | — |
| Desvio: retry, contorno, reject de reviewer, dependência bloqueada, escalada (`ralph:92`, `:134`, `:136`, `:139`, `autopilot:120`, `:122`, `:125`, `team:155`, `:157`, `:159`) | tipo | `deviation` | — |

Gate `completion-verified`: veredito ativo `completion-verified=approve` e
nenhum `regression-check=fail` ativo no target.

## revisao → `omc-review`

Skill: `review` (advisory: o gate registra o resultado, não bloqueia o fluxo).

| Ponto | Evento | Claim / tipo | Result |
|---|---|---|---|
| Relatório completo do review (`review:23`) | attachment | — | — |
| Veredito do review (`review:23`) | verdict | `review` | `approve` \| `request-changes` \| `reject` |

Gate `review-approved`: veredito ativo `review=approve`; `request-changes` ou
`reject` ativos barram. Um re-review depois das correções supera o anterior.

## verificacao → `omc-verify`

Skill: `verify`.

| Ponto | Evento | Claim / tipo | Result |
|---|---|---|---|
| Verificação automatizada ou manual (`verify:15-17`) | verdict | `verified` | `pass` \| `fail` \| `inconclusive` |
| Sem caminho de verificação (`verify:30`) | verdict | `verified` | `not-verifiable` (evidência do motivo) |

Gate `verified`: veredito ativo `verified=pass`, ou `not-verifiable` com
evidência; nenhum `fail` ativo (`verify:28`).
