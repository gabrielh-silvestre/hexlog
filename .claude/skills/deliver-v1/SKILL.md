---
name: deliver-v1
description: Maestro of the autonomous hexlog v1 delivery — opens one Herdr tab per remaining phase (F4 PR-5, F5, F7, F6, F8), starts an Opus team lead session there with /deliver-phase --autonomo, waits event-driven, refuses blocked prompts, pushes a notification on state changes and publishes the final review artifact after F8. Use when the user runs /deliver-v1 in the Herdr tab they opened for it, or says "roda a v1 autônoma", "retoma a maestro". Not for one phase by hand (that is deliver-phase), not for F9/F10, merge or release.
license: CC-BY-4.0
metadata:
  author: Gabriel Baldino
  version: 1.0.0
---

# deliver-v1

Maestro da entrega autônoma da v1. Roda na tab do Herdr que o usuário abriu, na raiz `~/personal/hexlog`. Abre uma tab por fase, em sequência, e acompanha a TeamLead de cada uma até o fim da F8. Decisões e porquês: [deliver-v1-autonomo.md](../../../.omc/specs/deliver-v1-autonomo.md). Política do decisor: [politica-de-decisao.md](references/politica-de-decisao.md).

O usuário autorizou na spec: a execução nunca para para perguntar. Nada de `AskUserQuestion`, merge, tag, instalador ou F9/F10. A maestro não decide gate de conteúdo (é o decisor do workflow) e **nunca aprova** prompt de permissão de uma TeamLead.

## Pré-voo

Pare e diga o que falta (esta é a única parada, antes de começar) se:

- `test "$HERDR_ENV" = 1` falhar ou `herdr status` não mostrar o servidor rodando;
- `mcp__hexlog__list` (projeto `hexlog`, processo `omc-orchestrate`) não mostrar o processo com os tipos `orchestrator-decision` e `deviation` fixados (sem o tipo fixado, todo registro do workflow dá `TYPE_NOT_PINNED`);
- `.claude/workflows/deliver-phase.js` não existir.

Esta sessão roda em `--permission-mode auto` (o usuário a inicia assim); sem isso, cada `herdr`, `PushNotification` e o artifact pedem confirmação.

## Fila

`F4 PR-5` (`f4-queries`) → `F5` (`f5`) → `F7` (`f7`) → `F6` (`f6`) → `F8` (`f8`). Fase entregue = existe `.omc/state/deliver-v1/<slug>.json`. Comece pela primeira sem esse arquivo. Depois da F8, vá para o Fechamento.

## Por fase

1. **TeamLead viva?** `herdr agent get v1-<slug>`: se responder, pule para o passo 4 (retomada).
2. **Tab:** `herdr tab create --workspace "$HERDR_WORKSPACE_ID" --cwd /home/gabriel/personal/hexlog --label "v1 <fase>" --no-focus`; leia `.result.root_pane.pane_id`.
3. **TeamLead:** `herdr agent start v1-<slug> --kind claude --pane <pane> --timeout 300000 -- --model opus --permission-mode auto`. Se voltar `agent_not_ready`, leia a tela (`herdr agent read`): diálogo de confiança na pasta ou de login é com o usuário (push e espere, única exceção ao "nunca para", porque a sessão nem começou); outro diálogo segue o [Bloqueio](#bloqueio). Depois `herdr agent prompt v1-<slug> "/deliver-phase <fase> --autonomo"` (sem `--wait`).
4. **Espera, por evento:** Bash em background com `herdr agent wait v1-<slug> --until working --timeout 600000; herdr agent wait v1-<slug> --timeout 600000`. O teto de 10 min é o batimento da regra de monitoramento do CLAUDE.md global. Sem mensagem ao usuário em batimento sem mudança.
5. **Ao acordar**, nesta ordem:
   - `.omc/state/deliver-v1/<slug>.json` existe → passo 6;
   - `herdr agent get v1-<slug>` falha (agente sumiu) → TeamLead morta: volte ao passo 2 (o Passo 0 da `deliver-phase` retoma pelos artefatos) e mande push;
   - `agent_status` `blocked` → [Bloqueio](#bloqueio);
   - `agent_status` `working` → ela ainda trabalha (Passo B longo, correção): volte ao passo 4, sem prompt;
   - `herdr agent read v1-<slug> --source recent-unwrapped --lines 80` termina em `AGUARDANDO-WORKFLOW` → o workflow roda: volte ao passo 4;
   - termina em `DELIVER-PHASE-DONE` sem o arquivo → `herdr agent prompt v1-<slug> "Grave o relatório do Passo C em .omc/state/deliver-v1/<slug>.json."` e volte ao passo 4;
   - qualquer outro fim, com a TeamLead ociosa → `herdr agent prompt v1-<slug> "Continue o modo autônomo da fase do ponto em que parou (Passo 0 da deliver-phase)."` e volte ao passo 4.

   Teto: 5 retomadas por prompt ("continue" ou relatório) e 3 TeamLeads mortas na mesma fase. No teto, push (`v1 <fase>: TeamLead não avança após <n> retomadas`) e abra uma TeamLead nova pelo passo 2, que retoma pelos artefatos; o contador recomeça.
6. **Conferência externa:** leia o JSON e confira que o PR existe e está aberto, que o `open-items.md` tem `## Decisões da entrevista`, que a issue de MINIMAL existe e que o handoff `.omc/handoffs/v1-<próximo slug>.md` existe. Divergência entre o JSON e o estado real: `herdr agent prompt` pedindo a correção e volte ao passo 4.
7. **Push** (`PushNotification`, até 200 caracteres): `v1 <fase> fechada: PR #<n>, issue #<m>, <total> decisões (<pesquisa> pesquisa, <júri> júri, <contra> contra você)`. A tab fica aberta para inspeção. Siga para a próxima fase.

## Bloqueio

`blocked` é um prompt de permissão que o classificador do modo auto não aprovou, ou um diálogo de pergunta. A maestro **nunca** aprova: aprovar o que o classificador barrou desliga a proteção que o usuário escolheu.

1. `herdr agent read v1-<slug> --source recent-unwrapped --lines 60` e identifique a ação pedida.
2. `herdr agent send-keys v1-<slug> esc`.
3. Conte a recusa em `.omc/state/deliver-v1/blocked.json` (chave: fase + ação).
4. `herdr agent prompt v1-<slug> "A maestro recusou o pedido para <ação> (recusa <n> deste item). Siga por outro caminho e registre: deviation (trigger blocked-dependency, outcome.decidedBy orchestrator) e orchestrator-decision (gate blocked, decidedBy maestro). Na 3ª recusa do mesmo item, faça scope-cut e anote na issue de MINIMAL."`
5. Na 3ª recusa, push: `v1 <fase>: <ação> recusada 3x, item cortado (scope-cut)`. Volte ao passo 4.

## Fechamento

Depois da F8:

1. Junte os `.omc/state/deliver-v1/<slug>.json` da fila (o `blocked.json` tem outro formato e entra só como contagem de recusas) e os eventos `orchestrator-decision` de `omc-orchestrate` (`mcp__hexlog__events`, paginando até o fim), mais `mcp__hexlog__chain` de `omc-exec`, `omc-review` e `omc-orchestrate`.
2. Publique um artifact privado (carregue antes a skill `artifact-design`) com a fila de revisão, nesta ordem: decisões que contrariaram o usuário, confiança `baixa`, decididas por júri, com pesquisa. Cada linha traz fase, item, escolha, justificativa curta e o id do evento. Depois vêm, por fase, PR, issue, handoff e correções da TeamLead, e por fim a integridade da cadeia.
3. Push com o link: `v1 até a F8 entregue: <n> PRs empilhados para merge; revisão em <link>`.
4. Diga o que fica com o usuário: merge da pilha na `v1` em ordem, F10 e F9 (handoff `.omc/handoffs/v1-f9.md`).

## Armadilhas

| Situação | O que fazer |
|---|---|
| TeamLead ociosa esperando o workflow | É normal: ela fecha o turno com `AGUARDANDO-WORKFLOW`; só re-arme a espera |
| `herdr agent wait` sai por timeout | Batimento: rode o passo 5 de novo, sem mensagem |
| Hook bloqueia `sleep` | Espere com `herdr agent wait` em background, nunca com `sleep` |
| Nome de agente do Herdr | `[a-z][a-z0-9_-]{0,31}`: use `v1-<slug>` (ex.: `v1-f4-queries`) |
| Branch `feat!/v1-cutover` (F6) | Sempre entre aspas no shell; o `!` dispara expansão de histórico no zsh |
