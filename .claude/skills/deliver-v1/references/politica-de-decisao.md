# Política de decisão do decisor autônomo

Regras que o decisor do [workflow deliver-phase](../../../workflows/deliver-phase.js) usa como precedente nos gates de conteúdo. Saíram da mineração das 11 sessões de `deliver-phase` (2026-10-01 e 2026-10-02: 66 decisões, 9 divergências da recomendação do agente) e são **hipóteses**: a amostra é pequena e algumas divergências não tiveram justificativa dita. Spec: [deliver-v1-autonomo.md](../../../../.omc/specs/deliver-v1-autonomo.md).

## Como usar

1. Fonte explícita vence regra inferida. Antes de aplicar uma regra, procure decisão registrada sobre o mesmo ponto, nesta ordem (a mais nova vence): seções `## Decisões` dos `.omc/handoffs/v1-*-pendencias.md`, `## Decisões da entrevista item a item` dos `.ignore/reviews/prs/PR*/open-items.md`, registros `orchestrator-decision` anteriores em `omc-orchestrate`, plano `.omc/plans/ralplan-hexlog-1-0.md` (§9, §14, D-xx, "decisão do usuário"), ADRs em `docs/`, wiki (`.omc/wiki/`).
2. Cite no registro cada regra usada (`policyRules`, ex.: `["R4","R12"]`) e cada precedente (`precedents`).
3. Regra de confiança `media` sustenta decisão só com confiança `media` no máximo, o que dispara pesquisa.
4. Gere alternativas além das opções recebidas. Nos casos difíceis, o usuário inventou a saída (rotação de log, ISP, lib testada, dedupe com aviso de truncamento) em vez de escolher uma das oferecidas.

## Regras

| ID | Confiança | Regra | Evidência |
|---|---|---|---|
| R1 | alta | Gates de processo seguem a regra fixa: painel sempre; commit, push e PR com suíte verde; veredito `approve` via COMMENT com 0 BLOCKING e 0 URGENT abertos, `request changes` via COMMENT com URGENT aberto | 11 de 11 gates de processo; #64, #66 (request changes), #68 (approve) |
| R2 | alta | FIX local e barato (aplicar, acrescentar teste, emendar o plano) é aceito | NORMAL pós-painel seguiu a recomendação em 16 de 17 |
| R3 | alta | Achado só de documentação não vira gate: aplica e registra | memória `documentacao-aplicar-sem-perguntar`; #68 N8, #64 N6, #66 N7 |
| R4 | alta | Modelo de ameaça: o hexlog é ferramenta exclusiva de agentes de IA, sem humano malicioso. Depois de uma defesa razoável, o risco **residual** é aceito, documentado (ADR 0009) e vira follow-up, em vez de endurecer a custo alto | `eca149f6@14:36` ("ferramenta de uso exclusivo para agentes de IA", `$ref`); `359b89fd@17:40` (ReDoS residual após `safe-regex2` + `maxLength`) |
| R5 | média | Lacuna entre fases é aceitável: o projeto não é usado até a v1 inteira existir | `8016bc59@20:53` ("o projeto não será usado até ter toda a v1 entregue") |
| R6 | média | Camadas: validação de entrada na tool MCP (F5), serviço enxuto, sem validar duas vezes; reaproveitar o domínio (zod) em vez de duplicar regra | `eca149f6@15:18` (tetos do `register` na camada MCP); #68 N3; `64761236@12:15` |
| R7 | alta | Erro e retorno para agente são explícitos e dão contexto (caminho `/schema`, versões existentes, aviso de truncamento, próximo passo na mensagem) | 2 das 9 divergências trocaram "manter" por mais contexto (`8016bc59@21:02`, `8016bc59@21:23`) |
| R8 | alta | Disponibilidade do hexlog acima de pureza estrita: recusar na escrita em vez de gravar o que quebra o registro | `8016bc59@20:49` ("não podemos ficar sem o hexlog disponível durante a execução") |
| R9 | alta | Orçamento de desempenho (`test:budget`) só no CI, nunca local, mesmo que o handoff peça; medição isolada por spec | `8016bc59@20:28`, `738f7d5e@20:26`; memória `test-budget-so-no-ci` |
| R10 | média | Preferir solução testada e princípio conhecido (lib madura, ISP, DRY pelo domínio) a código caseiro | `eca149f6@13:11` (`safe-regex2`, "lib que já foi testada em campo"); `738f7d5e@21:05` (ISP) |
| R11 | média | Plano é emendado, não contornado: linha do plano que contradiz a realidade vira emenda explícita | N1 do plano, SL4 frio, N2/P3 |
| R12 | alta | Todo adiamento tem registro durável e diz onde o item reaparece (issue de MINIMAL, handoff da fase seguinte, checklist da F8, ADR) | todos os adiamentos das fases F3–F4 |
| R13 | alta | Decisão já tomada não é rediscutida: reuse a justificativa registrada | ReDoS debatido em 3 sessões (`64761236@23:04`, `eca149f6@13:01`, `359b89fd@17:24`) |
| R14 | alta | Justificativa concreta e com consequência: a dependência real (ex.: "`queries/` não importa `commands/` e o PR-5 precisa do tipo"), nunca "boa prática" solta | `359b89fd@17:45`, `738f7d5e@21:07` |
| R15 | alta | Texto que um humano vai ler (ledger, issue, PR) é curto, explica em termos de uso e lista itens em bullets com descrição | memórias `debate-explicar-em-usabilidade`, `listas-em-bullets-com-descricao` |
| R16 | média | Entre duas opções equivalentes, a mais rigorosa e auditável | `d84b7036`: 4 de 10 divergências, todas para o lado mais completo |

## Assinatura dos casos difíceis

Onde o usuário divergiu, um destes critérios decidiu. Confira-os antes de seguir a recomendação do executor ou do painel:

- **Modelo de uso decide contra endurecer** (R4, R5): "só agentes", "um agente por vez", "v1 sem uso ainda".
- **Clareza para o agente decide contra manter** (R7).
- **Fronteira de camada ou de fase decide o lugar** (R6): serviço, ponte MCP ou F5.
- **A saída certa não estava nas opções** (R10): lib testada, princípio SOLID, rotação de log, truncamento com aviso.
