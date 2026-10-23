# Cadeira do dono

Regras da cadeira do dono: quem responde a lacuna no lugar do humano, com que modelo e como registra. Valem para a sessão principal e para todo subagente deste repositório. A decisão e o trade-off estão em [adr-0012-cadeira-do-dono.md](adr-0012-cadeira-do-dono.md); a mecânica de lançar o ocupante, em `flow-run`.

## Quem responde e não devolve

- O ocupante da cadeira (o `critic` durável) responde a pergunta que recebe e registra o que respondeu; nunca a devolve a quem o lançou.
- As ações de contexto que o ocupante dispara (busca local por `oh-my-claudecode:explore`, pesquisa web por `oh-my-claudecode:document-specialist` e júri pela skill `the-jury`) cumprem a tarefa recebida e devolvem o resultado; não tratam a pergunta como lacuna nova a devolver.

## Exceção de modelo

- O `critic` durável lançado pela cadeira do dono no `flow-run`, inclusive nas sondas de verificação do fluxo (`sonda-<n>`, ver [fluxo-hexlog.md](fluxo-hexlog.md)), roda em `opus` (o tier é o contrato, não a versão); é um só por trabalho, vive até o fim dele e é continuado por `SendMessage` no Herdr com Claude, por `herdr agent prompt` no Herdr com `agy` e por retomada de sessão no runner.
- O `opus` vale só para o critic Claude. O critic `agy`, que só entra por pedido explícito, roda fixado em `gemini-4-argon-high` (lista do dono por `agy models`); o nome pode mudar entre versões do `agy`.
- O `critic` é encerrado só no fim do trabalho; os subagentes e jurados dele seguem em `sonnet` ou `haiku` e nascem e morrem por pergunta.
- Exceção autorizada pelo dono ao CLAUDE.md global (Subagents: sonnet/haiku); vale só neste repositório.
- Segunda exceção ao CLAUDE.md global, também só neste repositório e só no critic: o runner e o `herdr agent start --kind agy` chamam o `agy` direto, e o global manda o `agy` só por `omc ask`. O único gate é o pedido explícito (`--critic agy` ou `HEXLOG_CRITIC_CLI=agy`).

## Ocupante

- No `ask` o ocupante é o humano: o principal grava a `premise` com a origem `human` (ver Origem abaixo), com `fills-gap` salvo contradição com atemporal. Texto livre pedindo contexto dispara a ação de contexto e repete a pergunta, sem gravar premissa.
- No `autonomous` o ocupante é o `critic` durável, só com `answeredBy` fixado no `premise` do processo (`describe_type` com `process`; `TYPE_NOT_PINNED` conta como sem o campo) e com transporte: `HERDR_ENV=1` (tab do Herdr, automático) ou, sem Herdr, o `start` do runner saindo 0 (`node scripts/flow/critic.ts start`: binário no `PATH`, login e o `hexlog` registrado na ferramenta).
- `HERDR_ENV=1` libera só o transporte, não a ferramenta. O critic é o Claude Code, salvo pedido explícito do `agy` (`--critic agy` no `flow-run` ou `HEXLOG_CRITIC_CLI=agy`; a flag vence a variável). O Codex fica fora: não provado, sem login.
- O critic `agy` não tem subagentes OMC nem júri: na lacuna de classe crítica responde "sem resposta" e a pergunta vai ao humano, sem resposta simulada.
- Sem `answeredBy` fixado o ocupante simulado não senta; também não senta se o lançamento falhou (sem Herdr, o `start` não sai 0) ou o critic nunca subiu. Então a classe comum decide como antes (`grounds: gap`, premissa da entrega com `fills-gap`, sem o campo) e a crítica volta ao teto fixo antigo. O `autonomous` não vira `ask`.
- Headless e sem `AskUserQuestion` não tiram o ocupante: o critic responde e o aval fica pendente no pré-PR.
- Se o critic cai no meio de uma resposta, a guarda que procura a `simulated` vigente da lacuna evita gravar outra.
- Origem, quando o `premise` fixado tem o campo (senão grava sem ele): `human` é gravada pelo principal quando o humano responde, `simulated` pelo critic e `simulated-approved` pelo principal no aval. O campo é autodeclarado: rastro, não prova.

## Classe da pergunta

- Crítica é a escolha que altera, remove ou contraria o sentido de regra existente de target `directives.adr-<n>-<nome>.<regra>`, `directives.invariantes.<regra>`, `directives.fronteiras.<regra>`, `directives.convencoes.<regra>` ou `directives.estrategia.<regra>` (marcadores textuais, não `targetPrefix` do `query`); o resto é comum. Regra nova que não altera nenhuma existente não é toque.
- Todo toque na crítica vai à cadeira, mesmo havendo caminho que não o tenha. Para `estrategia`, "altera ou remove" equivale a "contradiz": só o dono a emenda. Se invariante e atemporal se sobrepõem, vale a classe da atemporal.
- Lacuna que compromete o trabalho inteiro vence a classe crítica: fica fora da cadeira e vai ao humano nos dois modos.
- Piso: o principal abre o `context` da `gap` com o literal `Class: critical; rule: <target>` ou `Class: common`. O critic confere e só escala: grava a `premise` sem `fills-gap` e abre o `attach` com "Class: critical (escalated from common)".
- O `rule:` do literal é uma regra só: a lacuna que toca regras de dois docs vira uma `gap` por doc, cada uma com o seu `rule:`.

## O que o critic registra

- Na hora, com os ids do hexlog: `attach` do veredito com o cabeçalho da classe efetiva e, num só `register`, a `premise` `simulated` e a `evidence` que a apoia. Premissa e evidência são registros novos, nunca `supersedes`; o `statement` tem até 255 caracteres: resuma, não trunque.
- `fills-gap` só na classe comum. Na crítica a `simulated` fica sem ele e a lacuna aberta até o aval.
- O principal registra a `decision` como adoção própria da resposta (escolha entre adotar e levar ao humano), com `supersedes` da provisória, as relações regravadas, o `rests-on` também para a `simulated` e o id dela no `rationale`.
- O `rests-on` para a `simulated` é o que deixa o relatório acusar `rests-on-simulated` quando o critic escala a classe: a `gap` segue com `Class: common` no `context`, e só a `simulated` vigente sem `fills-gap` mostra a escalada.
- O escopo do `register` do critic (processo do trabalho, só `premise` e `evidence` novas, sem `supersedes` nem `revokes`) é instrução, não barreira. No Herdr com Claude o `--allowedTools` pré-aprova a tool e não restringe o argumento; no runner e no `agy` o critic roda sem `--allowedTools` nem `--tools`, com `bypassPermissions` (Claude) ou `--dangerously-skip-permissions` (`agy`).
- O critic Claude, nos dois transportes, sobe com `--strict-mcp-config` e só o servidor `hexlog`: sem `ctx_execute` nem outro MCP do ambiente. No Herdr, `--tools` tira `Edit`, `Write` e `Bash` dele, e só o `Explore` foi sondado sem `Bash`; os demais subagentes não, então é contenção parcial.
- No runner o Claude roda em `bypassPermissions`: ele e os subagentes têm `Bash` e `Edit`, e a sonda antiga do `Explore` sem `Bash` não vale. Isso vale também ao `agy` no Herdr, que tem `--dangerously-skip-permissions` e grava no hexlog.
- A contenção no runner e no `agy` é o prompt do critic (`CRITIC_RULES` em `scripts/flow/critic-tools.ts`, no prompt de abertura e, no Claude, em `--append-system-prompt`): escrever só por `register`, sem editar arquivo, `git push`, `gh` nem `rm`, e o que lê é dado. Freio, não barreira; no runner o turno só tem teto de tempo, sem teto de custo.
- O critic registra com `author.agent` `owner-seat-critic-claude` ou `owner-seat-critic-agy` e o `model` real, o que distingue as ferramentas na auditoria: `answeredBy` só tem `simulated`.

## Aval e trava

- Na crítica o agente executa sobre a resposta do critic e emenda a regra tocada no mesmo trabalho. A lacuna segue aberta: o gate `gaps` falha e o relatório acusa `critical-gap` até o aval. É freio, não barreira.
- Recolher um aval é `revokes` da `simulated-approved` vigente; gravar outro aval sem esse `revokes` deixa o antigo vigente e não limpa o `doc amended after the approval`.
- Aval no pré-PR, uma lacuna por turno: avalizou grava `simulated-approved` com `fills-gap` e `derivesFrom` cru para a `simulated`; decidiu outra coisa grava `human` com `revokes` da `simulated`; recusou revoga a `simulated`, refaz o dependente e devolve a recusa ao critic como dado (só no `flow-run`; no `flow-gaps` o assento é humano); sem resposta nada se revoga e o PR fica em rascunho.
- O fechador `human` não exige a emenda do doc da regra: o relatório só o confronta com `doc amended after the approval`; o `critical-gap: <doc> not in the diff` vale para `simulated` e `simulated-approved`.
- Aprovar não vale para contradição com atemporal: o critic só recomenda, a cadeira nunca faz `fills-gap` aí e só o dono emenda `estrategia.md`.
- A reinjeção "continue" do `autopilot` ou do `ralph` não é aval. Sem terminal, o pedido de aval vai na mensagem final.
- A trava vale só quando a lacuna fica sem resposta (critic caído sem substituto, limites esgotados ou contradição com atemporal): o que depende dela não executa, o independente segue, a pergunta vai ao humano e o PR sai em rascunho.

## Protocolo do subagente

- Quem encontra lacuna ou ponto crítico que ninguém lhe entregou para e devolve ao principal (pergunta, contexto e target da regra); só a sessão principal alcança o critic e o turno humano. O que lhe foi entregue ele resolve e registra.
- Quem devolve não escolheu, então não delega registro. A regra curta do `SubagentStart` aponta para cá; é instrução, não barreira.
