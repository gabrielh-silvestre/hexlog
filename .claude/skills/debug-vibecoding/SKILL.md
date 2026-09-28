---
name: debug-vibecoding
description: Walk the user through the decisions behind vibecoded work in one or more GitHub PRs, from product motivation down to code, one decision per turn: collect the PR body, commits, closed issues, local plans, wiki, reviews and worktree state; flag stale PR bodies, decisions the planner took without asking the user and partially closed issues; close each PR with pending items (issue, PR body, execution) and a resumable session file in .ignore/debug/. Use when the user says "debug do vibecoding", "debug do trabalho do PR 31", or runs /debug-vibecoding followed by PR numbers. Not for code review or bug hunting (review-pr, code-review), nor for posting a verdict (pr-verdict).
license: CC-BY-4.0
metadata:
  author: Gabriel Baldino
  version: 1.0.0
---

# debug-vibecoding

Conduz o usuário do porquê de produto até o código de um trabalho que ele direcionou mas não escreveu. O usuário decide; você levanta os fatos, apresenta cada decisão como cenário de uso e registra o que ele aceitou, questionou ou deixou pendente.

Regras que valem do início ao fim:

- **Uma pergunta por turno.** Cada turno fecha com uma pergunta `❓ **Qn - título**`, opções A/B/C curtas, `➡️` com a sua recomendação e o motivo, e `**Próximo passo:**`. Nunca agrupe decisões.
- **Cenário antes de opção.** Toda decisão abre com: ação que disparou a situação → o que acontece sem o ajuste → o que acontece com o PR. Só depois as opções. Se o usuário pedir "mais alto nível", reescreva no cenário, sem jargão de código.
- **Mapas e cenários em bloco de código**, prosa curta fora dele.
- **Porquê inferido é marcado como inferido.** Se o registro diz o quê e não diz o porquê, escreva "inferência minha" e ofereça buscar no transcript.
- **Achado errado se corrige na hora**, dizendo o que estava errado. Pergunta do usuário sobre o que foi dito é respondida antes de repetir a pergunta pendente.

## Passo 1: Coleta

Entrada: um ou mais números de PR. Com vários, percorra um PR por vez, na ordem que o usuário escolher.

1. Se `.ignore/debug/PR<n>.md` existir na raiz da worktree principal (ver [references/session-file.md](references/session-file.md)), leia e retome (Passo 6). Se o head do PR mudou desde o arquivo, avise antes de retomar.
2. Leia [references/checks.md](references/checks.md) e dispare **um** subagente `explore` (sonnet) com o prompt de coleta de lá, pedindo mensagem de conclusão com o resumo. Não leia plano, diff nem transcript inteiro no contexto principal.
3. Enquanto a coleta roda, não pergunte nada que dependa dela.

Resultado esperado: tabela de fontes do PR e a lista de checagens que falharam (corpo desatualizado, worktree suja, decisão do planner sem o usuário, issue fechada pela metade, consumidor externo).

## Passo 2: Contexto

Um bloco curto: origem do trabalho (qual evidência ou pedido motivou), temas agrupados com as issues, decisão de produto central, o que ficou de fora, estado do PR (draft, review pendente, WIP). Se forem vários PRs, um bloco por PR e a pergunta de por qual começar.

## Passo 3: Mapa

Liste as decisões `D1..Dn`: produto primeiro, processo por último. Inclua as checagens que falharam como itens próprios. Recomende por onde começar; se o usuário pedir ordem, siga a ordem até fechar.

## Passo 4: Uma decisão por turno

Para cada decisão, no formato de cenário, com a fonte citada (arquivo ou link). Opções padrão:

- **Aceitar**: registra e segue.
- **Questionar**: investigue o ponto (subagente se for busca ampla) e volte com o fato; a decisão pode virar pendência.
- **Descer ao código**: mostre o trecho que implementa a decisão (commit, `arquivo:linha`, hunk do diff) ainda no formato de cenário; o objetivo é ver a decisão no código, não revisá-lo.

Se o usuário decidir mudar algo (remover opção, reverter escopo), confira dependências antes de executar: o que mais usa aquilo, o que está sem commit na worktree. Mostre o que sobrevive e o que cai, e pergunte o formato da execução.

## Passo 5: Pendências no fim do PR

Liste as pendências abertas e pergunte quando resolver (agora, no fim do lote, só registrar). Destinos:

| Pendência | Destino |
|---|---|
| Corpo do PR desatualizado | reescrever o corpo a partir dos commits e do plano, com verificação rodada no head |
| Resíduo de issue fechada pela metade, trabalho adiado | issue nova com cenário, causa e opções sem decisão |
| Mudança de código decidida | `executor` (sonnet) na worktree do PR, um commit, sem push salvo pedido |
| Ajuste em outro repositório | relatório no repositório consumidor, com `arquivo:linha`, evidência e dependência |

Projeto pessoal publica issue e corpo de PR direto. Repositório de trabalho (`~/work`) passa por rascunho local e aprovação antes de publicar.

## Passo 6: Arquivo de sessão

Mantenha `.ignore/debug/PR<n>.md` no formato de [references/session-file.md](references/session-file.md). Atualize a cada decisão fechada e a cada pendência resolvida, para a sessão poder cair sem perder estado. Ao retomar, siga da primeira decisão ainda aberta.

Quando o usuário corrigir o jeito de conduzir (formato, nível, ordem), registre na seção "Ajustes na skill" do arquivo de sessão. Esses ajustes alimentam a próxima versão desta skill.

## Exemplos

**Um PR:** "debug do trabalho do PR 31" → coleta → contexto (mineração → 14 issues, contrato quebrado por padrão) → mapa D1..D6 → D1 em cenário → usuário aceita → ... → pendências: corpo do PR desatualizado e resíduo da #25 → usuário escolhe "agora" → corpo reescrito e issue aberta → arquivo de sessão fechado.

**Vários PRs:** `/debug-vibecoding 31 32` → contexto dos dois → usuário escolhe o 31 → ciclo completo → pendências do 31 → mesmo ciclo no 32.

**Questionar muda o código:** no PR 32 o usuário decide remover o hook → conferir quem usa o hook (validador, instalador, specs) e o que está sem commit → mostrar o que sobrevive e o que cai → usuário escolhe um commit só → executor.

## Troubleshooting

- **Corpo do PR contradiz o plano:** compare horários (criação do PR × commits × iterações do plano); em geral o corpo foi escrito antes das últimas levas.
- **`git switch` falha na branch do PR:** ela está em outra worktree; ache com `wt list` e rode tudo lá.
- **Porquê não aparece em lugar nenhum:** marque como inferido e ofereça buscar no transcript da sessão da data do commit.
