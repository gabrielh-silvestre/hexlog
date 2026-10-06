# ADR 0010: Camada do hexlog sobre o OMC

**Status:** Aceito

**Data:** 2026-10-06

**Deciders:** Gabriel Baldino, depois de três pesquisas (docs oficiais do Claude Code, plugin OMC 5.6.2 instalado e harness local) e do veredito de um júri de três agentes

---

## Context

O hexlog passa a ser usado no próprio repositório num fluxo de execução autônoma guiado por diretrizes. O agente decide sozinho, toda escolha entre alternativas viáveis vira um registro `decisão` ancorado numa diretriz (ou numa `lacuna`, quando nenhuma cobre), e um gate segura a abertura do PR. O desenvolvimento em si é conduzido pelas skills do OMC (`deep-interview`, `plan`, `execute`, `review`, `verify`), e o caminho de cada trabalho é escolhido pelo dono: feature longa passa por entrevista e plano, ajuste pontual vai direto para a execução.

As regras de uso do hexlog precisam valer como uma camada por cima do OMC, na sessão principal e em todos os subagentes que ela lança, porque as decisões também nascem dentro deles (`planner`, `executor`, `architect`, `critic`). Duas restrições:

- O OMC vem do marketplace. Editar as skills ou os agentes dele não é opção: a edição some na atualização. O fluxo anterior, que editava as skills do OMC, foi abandonado por isso.
- Os agentes do OMC 5.6.2 são `agents/*.md` estáticos, sem `omitClaudeMd` nem allowlist `tools`, e nenhum mecanismo do OMC injeta regra de projeto em subagente.

O que a pesquisa estabeleceu sobre os canais disponíveis:

- O `CLAUDE.md` do projeto, com os imports `@`, chega aos subagentes não-fork, inclusive os de plugin. Isso está documentado e foi confirmado no harness local. As exceções são o `Explore` e o `Plan` nativos e agentes com `omitClaudeMd`.
- O hook `SubagentStart` com `additionalContext` alcança qualquer subagente, inclusive os de plugin, e reinjeta depois de compaction. O plugin ponytail já usa esse canal.
- Hooks `PreToolUse` de `settings.json` disparam dentro de subagentes.
- `SessionStart`, `UserPromptSubmit`, output styles e `--append-system-prompt` não alcançam subagentes.
- Subagentes herdam os MCP servers da sessão, então enxergam as tools `mcp__hexlog__*`.
- O context-mode e o OMC já reescrevem o input do tool `Agent` com `updatedInput` no `PreToolUse`.

## Decision

1. **Entrada fina.** Uma skill local de execução abre o trabalho (sincroniza as diretrizes, cria o processo do trabalho, registra o modo) e chama as skills do OMC no caminho escolhido. No fim, retoma o pré-PR: verificação, review, gate e abertura do PR. A skill não substitui nem edita o OMC.
2. **Regras de uso num doc importado pelo `CLAUDE.md`.** As regras de registro (quando uma escolha vira `decisão`, o que ela carrega, quando vira `lacuna`, o gate antes do PR) moram num único doc, importado com `@` no `CLAUDE.md` do projeto. É a fonte única dessas regras, para a sessão principal e para os subagentes.
3. **Ponteiro no `SubagentStart`.** Um hook `SubagentStart` em `.claude/settings.json` do projeto, com matcher vazio, injeta um `additionalContext` de cerca de três linhas que remete ao doc do item 2. O ponteiro não copia as regras, para não criar um segundo canal que diverge do doc.
4. **Bloqueio da abertura de PR.** Um hook `PreToolUse` em `.claude/settings.json` do projeto nega `create_pull_request` (GitHub MCP) e `gh pr create` (Bash) quando falta o marcador gravado pela skill de pré-PR, a não ser que o PR seja aberto em rascunho (`draft=true`). O hook não lê o log do hexlog, para não se acoplar ao formato em disco. Quando não consegue decidir, bloqueia, e a mensagem diz o que fazer: avaliar o gate e abrir em rascunho se houver lacuna aberta.
5. **Sem reescrita do prompt do `Agent`.** Nenhum hook do hexlog usa `updatedInput` no tool `Agent`. O context-mode e o OMC já reescrevem esse input, e um terceiro hook reescrevendo o mesmo input pode apagar o que os outros puseram sem erro visível.

## Consequences

- O bloqueio do item 4 é o único freio que não depende de o modelo obedecer. Ele pega um PR aberto por qualquer agente, inclusive um `executor` ou o `/pr` do OMC, que não passam pela skill de pré-PR.
- O ponteiro do item 3 cobre a diferença entre a regra chegar ao subagente e ser seguida dentro de um prompt longo. Esse ganho não foi medido, e o júri se dividiu (2 a 1) sobre ele. Critério para manter: rodar um `executor` do OMC numa tarefa com escolha real, com e sem o ponteiro, e comparar se a `decisão` foi registrada, sem colocar no prompt o token que o teste procura. Se não houver diferença, o ponteiro sai.
- Decisão não registrada não deixa rastro no log, então a auditoria por amostragem, que confere decisões registradas, não a detecta. Por isso o item 3 existe antes de uma falha observada.
- O gate em si não consegue exigir que toda `decisão` aponte para uma diretriz, porque as perguntas de gate só leem relações de entrada. O schema da `decisão` exige justificativa e fundamento. A pergunta de gate que exigiria a relação de saída está na issue #86.
- Tudo fica local ao repositório: o doc de regras, as skills e os dois hooks em `.claude/settings.json`. Nada edita o OMC. Atualizar o OMC não quebra a camada, salvo se ele passar a usar `omitClaudeMd` nos agentes, caso em que o item 3 continua alcançando os subagentes.
- Portar o fluxo para outro repositório pede as mesmas quatro peças: a skill de entrada, o doc importado no `CLAUDE.md` e os dois hooks.

## Emendas datadas

Um ADR aceito não é refeito: cada entrada abaixo diz o que mudou, por quê e quem decidiu.

- **2026-10-06: o item 4 passa a cobrir também `gh pr ready` com a checagem do marcador e `update_pull_request` com `draft: false`, sempre negado (decisão do dono, Gabriel Baldino).** O bloqueio da abertura de PR deixa de parar na criação: sem isso, um PR aberto em rascunho com lacuna aberta sairia do rascunho sem passar pelo pré-PR. `gh pr ready` passa com o marcador do pré-PR, regravado pela skill de resolução de lacunas quando o gate das lacunas passa; `update_pull_request` com `draft: false` nunca passa, porque o GitHub MCP não traz a branch e o hook não tem como conferir o marcador, e a mensagem manda usar `gh pr ready`. Limite conhecido: `gh pr ready` com número ou URL é negado, e `gh api` e push que cria PR seguem fora do alcance.
