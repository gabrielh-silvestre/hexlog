---
name: deliver-phase
description: Drive one phase of the hexlog v1 plan (.omc/plans/ralplan-hexlog-1-0.md §4.3) through its four blocks — execution with pre-PR interview, panel review, item-by-item interview plus fixes, and closing (MINIMAL issue + next-phase handoff) — resuming from artifact state, one block per session. With --autonomo (launched by the deliver-v1 maestro in a Herdr tab), runs the whole phase through the deliver-phase workflow with no human gates, then does the team lead's own check. Use when the user says "deliver-phase", "segue a fase", "próxima fase da v1", "fecha a F3" or runs /deliver-phase with or without a phase. Not for phases F9 (manual runbook) or F10 (external consumers), and not for reviewing PRs outside the v1 chain (that is review-pr).
license: CC-BY-4.0
metadata:
  author: Gabriel Baldino
  version: 1.0.0
---

# deliver-phase

Conduz uma fase da v1 do hexlog em quatro blocos. Cada bloco roda numa sessão própria, aberta na raiz `~/personal/hexlog` (nunca dentro da worktree da fase, que não tem esta skill): a skill descobre o bloco pelos artefatos, roda só ele e termina dizendo o comando exato da próxima sessão. A revisão roda sempre em contexto limpo; nunca revise na mesma sessão que executou. Origem e decisões: [deep-dive-quero-que-visualize-as-ultimas.md](../../../.omc/specs/deep-dive-quero-que-visualize-as-ultimas.md). Registro no hexlog: [flow.md](../../../.hexlog/flow.md), fase `revisao`.

Gates humanos (`AskUserQuestion`, um por turno): cada decisão de entrevista, "commit, push e PR?" no bloco 1, "commit e push?" no bloco 3, e o veredito do `pr-verdict` no bloco 2. Com `--autonomo` não há gate humano: siga só a seção [Modo autônomo](#modo-autônomo---autonomo).

## Fases e branches

Ordem de merge do plano (§4.3). PRs empilhados: a base é a branch da fase anterior, ou `v1` se a anterior já entrou na `v1`.

| Fase | Branch | Base | Target hexlog |
|---|---|---|---|
| F3 | `feat/v1-adapters` | `feat/v1-storage` | `hex:target:v1-f3` |
| F4 PR-4 | `feat/v1-commands` | `feat/v1-adapters` | `hex:target:v1-f4-commands` |
| F4 PR-5 | `feat/v1-queries` | `feat/v1-commands` | `hex:target:v1-f4-queries` |
| F5 | `feat/v1-mcp` | `feat/v1-queries` | `hex:target:v1-f5` |
| F7 | `feat/v1-archive` | `feat/v1-mcp` | `hex:target:v1-f7` |
| F6 | `feat!/v1-cutover` (nome do plano) | `feat/v1-archive` | `hex:target:v1-f6` |
| F8 | `docs/v1-adrs` | `feat!/v1-cutover` | `hex:target:v1-f8` |

F9 e F10 ficam fora. F0–F2 já entregues (#59, #60, #62).

## Passo 0: Detectar fase e bloco

Com argumento (`/deliver-phase F3`), use a fase dada; sem argumento, a fase da branch atual ou, na `main`, a fase mais recente com PR na cadeia (F2/#62 em 2026-10-01), e a seguinte se ela já estiver fechada. Confira na ordem e pare na primeira condição verdadeira:

1. Não há PR da fase (`mcp__github-official__list_pull_requests`, `head` = branch):
   - sem branch/worktree da fase → **bloco 1, início** (exige `.omc/handoffs/v1-f<N>.md`; se faltar, é o bloco 4 da fase anterior que não fechou);
   - worktree com mudanças e sem `.omc/handoffs/v1-f<N>-pendencias.md` decidido → **bloco 1, pendências**.
2. PR existe e `.ignore/reviews/prs/_ledger.json` não tem o PR → **bloco 2**.
3. `.ignore/reviews/prs/PR<n>/open-items.md` sem seção `## Decisões da entrevista` → **bloco 3, entrevista**.
4. Decisões gravadas, mas o head do PR não tem commit `fix(<escopo>): apply review fixes` posterior ao `last_sha` do ledger → **bloco 3, ajuste**.
5. Sem issue `MINIMAL` apontando para o PR (`search_issues`: `MINIMAL "PR #<n>"`) → **bloco 4, issue**.
6. Sem `.omc/handoffs/v1-f<próxima>.md` → **bloco 4, handoff**.
7. Tudo presente → fase fechada; a próxima começa no bloco 1.

Antes de editar: `git status --short --branch` e `wt list` (worktree certa, sobras de outra sessão). Diga ao usuário a fase e o bloco detectados, com a evidência de cada condição, antes de agir.

## Bloco 1: Execução

1. Worktree da fase pela skill `worktrunk` (base da tabela), nunca `git worktree`.
2. `Skill("oh-my-claudecode:ralph", "--critic=critic <conteúdo de .omc/handoffs/v1-f<N>.md>")`, acrescentando: **terminar sem commit, sem push e sem PR**.
3. Grave em `.omc/handoffs/v1-f<N>-pendencias.md` as decisões abertas e os achados do architect/critic do ralph, por severidade (formato de `f2-hexlog-v1-pendencias.md`).
4. Entrevista item a item: um `AskUserQuestion` por turno, nunca a lista inteira. Grave cada decisão no mesmo arquivo, seção `## Decisões (AAAA-MM-DD)`.
5. Decisões que mudam código: ralph de novo, sem commit. Verde em `npm run typecheck && npm run lint && npm run format:check && npm test`.
6. Gate humano "commit, push e PR?". Com o sim: commits Conventional Commits (subject ≤ 80, sem corpo), push, PR pelo MCP `github-official` com a base da tabela, corpo em pt-BR, sem merge.
7. Próxima sessão: `/clear` e `/deliver-phase` (bloco 2).

## Bloco 2: Revisão

1. `Skill("review-pr", "--panel --normal #<n>")`: painel, `investigate-review-points` e `pr-verdict` em cadeia. O veredito sai como COMMENT (PR do próprio autor). Sem júri.
2. Depois que o `pr-verdict` postar: `hexlog-flow`, processo `omc-review`, target da tabela — `attachment` com o texto de `review*.md`, depois verdict `claim: review`, `result` = `request-changes` ou `approve` conforme o veredito, `data.attachment` = hash.
3. Próxima sessão: `/clear` e `/deliver-phase` (bloco 3).

## Bloco 3: Entrevista + ajuste

1. Entrevista item a item sobre os BLOCKING/URGENT/NORMAL do `open-items.md`: uma decisão por turno, explicando em uso antes das opções. O usuário pode rebaixar para MINIMAL ou descartar. MINIMAL não entra na entrevista; vai para a issue no bloco 4.
2. Grave em `open-items.md`, seção `## Decisões da entrevista item a item (AAAA-MM-DD)`, uma linha por ID: aplicado / rebaixado / descartado / risco aceito, com o porquê.
3. `Skill("oh-my-claudecode:ralph", "aplicar as decisões de <open-items.md>, sem commit")`. Desvio do decidido vira `deviation` pela `hexlog-flow` e linha no `open-items.md`.
4. Gate humano "commit e push?" → **um** commit `fix(<escopo>): apply review fixes to <o quê>` e push.
5. Comentário-resumo no PR (`add_issue_comment`): o que foi aplicado por ID, o que foi rebaixado e o sha. Repo pessoal: publica direto.
6. `hexlog-flow`: `attachment` com a seção de decisões; verdict `claim: review`, `result: approve`, `supersedes` o veredito do bloco 2, evidência "decisões aplicadas em <sha>"; `evaluate_gate` `review-approved`.
7. Siga para o bloco 4 na mesma sessão.

## Bloco 4: Fechamento

1. Revalide no head atual os `arquivo#símbolo` de cada MINIMAL (o #61 citou símbolos que mudaram depois do fix).
2. Uma issue por PR (`issue_write`), sem label, no esqueleto de #61/#63:
   - título `Follow-ups MINIMAL da revisão do PR #<n> (F<N> <tema>)`;
   - abertura com o head revisado e o sha dos ajustes;
   - seções temáticas com `- [ ] **M<k>** \`arquivo#símbolo\`: problema + correção`;
   - `## Rebaixados na entrevista` e, se houver, `## Decisão do autor` (opções e recomendada);
   - rodapé `Origem`: o PR e `.ignore/reviews/prs/PR<n>/review*.md`.

   Anote o número da issue no `open-items.md`.
3. Handoff em `.omc/handoffs/v1-f<próxima>.md`, no contrato do `/handoff` (o `/handoff` só o usuário dispara e grava no /tmp; esta skill escreve direto no repo):
   - bloco pronto para colar, no formato de `.omc/handoffs/v1-f0-ralph.md` (Antes de tudo, Execução, Pronto quando, Entrega), apontando a seção da fase no §4.3;
   - herança: decisões que afetam a fase seguinte, issues de MINIMAL abertas, base do PR;
   - seção `Suggested skills` (`deliver-phase`, `worktrunk`, `hexlog-flow`, `code-standards`);
   - cite artefatos por caminho ou URL, sem duplicar; sem dado sensível.
4. `hexlog-flow`: milestone `milestoneType: handoff`, target da fase, `trace` com o caminho do handoff e a URL da issue.
5. Wiki pela regra de fechamento do CLAUDE.md global, quando a fase revelou causa raiz ou armadilha.
6. Próxima sessão: `/clear` e `/deliver-phase` (bloco 1 da fase seguinte).

## Modo autônomo (`--autonomo`)

A maestro [deliver-v1](../deliver-v1/SKILL.md) abre esta sessão numa tab do Herdr (`claude --model opus --permission-mode auto`) e manda `/deliver-phase F<N> --autonomo`. Esta sessão é a **TeamLead** da fase. Decisões e porquês: [deliver-v1-autonomo.md](../../../.omc/specs/deliver-v1-autonomo.md).

O usuário autorizou na spec: nesta sessão não há humano. Nunca use `AskUserQuestion` nem termine mensagem com pergunta ou lista de opções (o hook `workflow-drift-guard` trava o Stop). "Sempre perguntar" e "entrevista item a item" do CLAUDE.md global cedem ao decisor do workflow. Merge, `git tag`, `node scripts/install.ts` e `test:budget` local continuam proibidos.

### Passo A: detectar e lançar

1. Passo 0 acima, com a fase do argumento, sem anunciar e esperar: só registre a evidência na sua mensagem.
2. Monte os `args` e lance `Workflow({ name: "deliver-phase", args })` (fallback: `scriptPath` `/home/gabriel/personal/hexlog/.claude/workflows/deliver-phase.js`). O usuário optou pelo workflow na spec; ele roda a fase inteira a partir do bloco detectado, com todo `agent()` em sonnet:

   | Fase | `slug` | `nextPhase` / `nextSlug` | `planSection` |
   |---|---|---|---|
   | F4 PR-5 | `f4-queries` | `F5` / `f5` | `F4. Serviços de escrita e de consulta` (só a "Entrega PR-5") |
   | F5 | `f5` | `F7` / `f7` | `F5. Adaptador MCP e bundle de prévia` |
   | F7 | `f7` | `F6` / `f6` | `F7. Arquivamento, instalador e deny` |
   | F6 | `f6` | `F8` / `f8` | `F6. Corte` |
   | F8 | `f8` | `F9` / `f9` | `F8. Documentação, ADRs e AGENTS` |

   Demais `args`: `phase` (ex.: `"F5"`), `branch`, `base` e `target` da tabela de fases, `repo` (`/home/gabriel/personal/hexlog`), `worktree` (caminho da branch no `wt list`; sem worktree, o caminho que o Worktrunk vai criar), `startBlock` (1 a 4), `startStep` (`inicio`, `pendencias`, `entrevista`, `ajuste`, `issue` ou `handoff`, pelo Passo 0; `pr` quando as pendências já estão decididas e aplicadas e só falta commit, push e PR), `prNumber` (se já existir) e `date` (hoje, `AAAA-MM-DD`).
3. Espere a notificação de conclusão sem polling. O turno que termina esperando o workflow fecha com a linha `AGUARDANDO-WORKFLOW <runId>`: é como a maestro distingue espera de travamento. Se o workflow falhar com "a TeamLead assume", conclua você os passos restantes do bloco no contrato deste arquivo, com as regras deste modo; se a falha for transitória (API, limite), relance com `resumeFromRunId`.

### Passo B: conferência própria

Depois do bloco 4, em Opus, sem subagente:

1. Suíte completa no head da worktree (`npm run typecheck && npm run lint && npm run format:check && npm test`).
2. Critérios de saída da fase (§4.3 "Saída" e os ACs da §5 que ela cita), um a um, com a evidência.
3. Leitura própria do diff contra a base, procurando BLOCKING e URGENT que o painel não pegou.
4. Coerência: a issue de MINIMAL cita `arquivo#símbolo` que existem no head; o handoff da próxima fase existe e herda as decisões; `chain` íntegra em `omc-exec`, `omc-review` e `omc-orchestrate`; gate `review-approved` passou.
5. Resto do workflow: registre em `omc-orchestrate` cada entrada de `unrecorded` (decisão aplicada sem registro) e decida você mesma cada item com `contingency: true` (adiado porque o decisor falhou), registrando com `decidedBy: team-lead`.

Achou BLOCKING ou URGENT: corrija você mesma, suíte verde, um commit `fix(<escopo>): address team lead check on <o quê>`, push e comentário no PR. Se a correção mudar algo citado, atualize a issue e o handoff. Cada correção vira `orchestrator-decision` (`gate: team-lead-check`, `decidedBy: team-lead`) em `omc-orchestrate`.

### Passo C: relatório para a maestro

Grave `.omc/state/deliver-v1/<slug>.json` com `phase`, `pr`, `issue`, `handoff`, `workflowRunId`, os `counts` e a lista `decisions` devolvidos pelo workflow, `teamLeadFixes` (commit e o que corrigiu) e `deviations`. A maestro só considera a fase entregue com esse arquivo. A última linha da mensagem final é `DELIVER-PHASE-DONE <slug>`.

## Exemplos

### Exemplo 1: fechar a F2 (estado de 2026-10-01)

Usuário: `/deliver-phase`

Ações: na `main`, a fase mais recente com PR é a F2 (#62). O ledger tem o #62, o `open-items.md` tem `## Decisões da entrevista item a item (2026-10-01) e execução`, o head tem 886ceff `fix(storage): apply review fixes ...`, a issue #63 existe e `.omc/handoffs/v1-f3.md` não existe → bloco 4, handoff. Escreve `.omc/handoffs/v1-f3.md` e registra o milestone `handoff` em `hex:target:v1-f3`.

Resultado: "F2 fechada. Próxima sessão: `/clear` e `/deliver-phase` (bloco 1 da F3)."

### Exemplo 2: revisar a F3

Usuário, em sessão nova: `/deliver-phase F3`

Ações: o PR de `feat/v1-adapters` existe e o ledger não o tem → bloco 2. Roda `review-pr --panel --normal #<n>`, para no gate do `pr-verdict`, posta com o aval do usuário e registra o verdict `review` no `omc-review`.

Resultado: "Revisão postada como COMMENT. Próxima sessão: `/clear` e `/deliver-phase` (bloco 3)."

## Armadilhas

| Situação | O que fazer |
|---|---|
| Ralph do bloco 1 abre PR sozinho | Reforce "sem commit/PR" no argumento; se abriu, siga para o bloco 2 e registre `deviation` |
| Revisão na mesma sessão da execução | Pare e mande `/clear`; auto-aprovar no mesmo contexto invalida o painel |
| Sessão aberta dentro da worktree da fase | A skill não carrega lá (não está commitada na cadeia); reabra na raiz |
| Worktree com sobras de outra sessão | Pare e pergunte antes de commitar arquivo que você não gerou. Com `--autonomo`: não pergunte nem commite o que não gerou; anote no relatório do Passo C |
| `review-pr` sem alvo pula PR do próprio autor | Passe sempre `#<n>` explícito |
| Handoff de pendências da F2 com nome antigo (`f2-hexlog-v1-pendencias.md`) | Aceite como equivalente de `v1-f2-pendencias.md` na detecção |
| `register` com chave fora do schema (ex.: `text` em milestone) | `INVALID_EVENT`: reenvie só com `milestoneType`, `target`, `trace` |
