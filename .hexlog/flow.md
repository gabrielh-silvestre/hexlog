---
phases: [descoberta, planejamento, execucao, verificacao]
process:
  descoberta: omc-discover
  planejamento: omc-plan
  execucao: omc-exec
  verificacao: omc-verify
skills:
  descoberta: [oh-my-claudecode:deep-dive, oh-my-claudecode:deep-interview]
  planejamento: [oh-my-claudecode:plan, oh-my-claudecode:ralplan]
  execucao: [oh-my-claudecode:ralph, oh-my-claudecode:autopilot, oh-my-claudecode:team]
  verificacao: [oh-my-claudecode:verify]
gate:
  descoberta: spec-crystallized
  planejamento: execution-approved
  execucao: completion-verified
  verificacao: verified
versions:
  types: {}
  vocabulary:
    hexlog: "1.0"
  gates:
    completion-verified: "1.0"
    execution-approved: "1.0"
    spec-crystallized: "1.0"
    verified: "1.0"
editedSkills:
  - oh-my-claudecode:deep-interview
  - oh-my-claudecode:deep-dive
  - oh-my-claudecode:plan
  - oh-my-claudecode:ralplan
  - oh-my-claudecode:ralph
  - oh-my-claudecode:autopilot
  - oh-my-claudecode:team
  - oh-my-claudecode:verify
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

## descoberta → `omc-discover`

Skills: `deep-dive` (trace → deep-interview) e `deep-interview`.

| Ponto | Evento | Claim / tipo | Result |
|---|---|---|---|
| Spec gravada em `.omc/specs/` (`deep-interview:390-489`, `deep-dive:275-283`) | milestone + verdict | `spec-written` / `spec-crystallized` | `pass` (PASSED) \| `fail` (BELOW_THRESHOLD_EARLY_EXIT) |
| Execution bridge (`deep-interview:495-522`, `deep-dive:318-345`) | verdict | `execution-approval` | `approve` (rota na evidência) \| `request-changes` \| `pending` |

Gate `spec-crystallized`: veredito ativo `spec-crystallized=pass` na spec, sem
`fail` ativo. Atenção: no `deep-dive`, a rota ralplan→autopilot (`:326`) segue
para o autopilot sem novo gate humano; no `deep-interview` (`:503`, `:749`) ela
para em `pending approval`.

## planejamento → `omc-plan`

Skills: `plan` e `ralplan` (alias de `plan --consensus`).

| Ponto | Evento | Claim / tipo | Result |
|---|---|---|---|
| Plano inicial (`plan:94-99`, `ralplan:45-50`) | milestone | `plan-drafted` | — |
| Revisão Architect → Critic (`ralplan:52-56`, `plan:105-106`) | verdict | `plan-review` | `approve` \| `iterate` \| `reject` |
| Loop esgotado em 5 iterações (`plan:109-115`) | milestone | `escalated` | — |
| Aprovação de execução (`plan:121-127`, `ralplan:63-65`) | verdict | `execution-approval` | `approve` \| `request-changes` \| `reject` \| `pending` |

Gate `execution-approved`: veredito ativo `execution-approval=approve` no plano.
`pending`, `request-changes` e `reject` barram (`plan:44`, `:228`).

Rotas sem aprovação humana separada registram a aprovação aqui por conta
própria: a rota 1 do `deep-dive` (ralplan→autopilot) e o `autopilot` invocado
direto (invocar já é aprovar).

Fora do mapeamento: o Pre-Execution Gate do `ralplan` (`:71-141`) é decidido
pelo hook `src/hooks/keyword-detector/index.ts`, não pelo agente; registrá-lo
exige mudar o hook.

## execucao → `omc-exec`

Skills: `ralph`, `autopilot` (chama o ralph na Phase 2, `autopilot:96`) e `team`
(compõe com o ralph, `team:743-794`).

| Ponto | Evento | Claim / tipo | Result |
|---|---|---|---|
| Transição de estágio (`team:385-402`, `autopilot:72-74`) | milestone | `phase-started` / `phase-completed` | — |
| Handoff de estágio (`team:156-178`) | milestone | `handoff` | — |
| Ciclo de QA (`autopilot:102-106`) | verdict | `qa-cycle` | `pass` \| `fail` |
| team-verify (`team:137-138`) | verdict | `team-verify` | `pass` \| `fail` |
| Reviewer/architect (`ralph:100-112`, `autopilot:107-111`, `team:779-786`) | verdict | `completion-verified` | `approve` \| `reject` |
| Regressão pós-deslop (`ralph:121-126`) | verdict | `regression-check` | `pass` \| `fail` |
| Cancelamento / escalada (`ralph:216-219`, `autopilot:148-152`, `team:146-151`) | milestone | `cancelled` / `escalated` | — |

Gate `completion-verified`: veredito ativo `completion-verified=approve` e
nenhum `regression-check=fail` ativo no target.

## verificacao → `omc-verify`

Skill: `verify`.

| Ponto | Evento | Claim / tipo | Result |
|---|---|---|---|
| Verificação automatizada ou manual (`verify:15-17`) | verdict | `verified` | `pass` \| `fail` \| `inconclusive` |
| Sem caminho de verificação (`verify:29`) | verdict | `verified` | `not-verifiable` (evidência do motivo) |

Gate `verified`: veredito ativo `verified=pass`, ou `not-verifiable` com
evidência; nenhum `fail` ativo (`verify:27`).
