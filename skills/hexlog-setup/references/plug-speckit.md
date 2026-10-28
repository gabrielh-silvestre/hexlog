# Plug no Spec Kit

Como o hexlog se liga a um repositório que usa o Spec Kit. Só a **camada C** está
ativa: ela só escreve arquivos do próprio hexlog e nunca depende de disparo do Spec Kit.

## Camada C (sempre)

1. A skill do projeto (`.claude/skills/<projeto>-hexlog/SKILL.md`), cuja `description`
   nomeia os comandos das fases do Spec Kit (`/speckit-specify`, `/speckit-plan`,
   `/speckit-tasks`), porque o gatilho por descrição é probabilístico.
2. O **bloco no `AGENTS.md`** do destino: ponteiro imperativo de até 8 linhas, com
   título fixo, dizendo que, depois dos comandos das fases, se usa a skill do projeto.
   O `AGENTS.md` é lido pelo Claude Code por import do `CLAUDE.md`; o setup só mexe no
   `CLAUDE.md` com opt-in do dev e, quando mexe, escreve no fim do arquivo, **fora de
   qualquer região que o Spec Kit gerencia** (marcadores observados no aceite). A mesma
   regra vale para o `AGENTS.md`.
3. O fechamento da unidade confere um registro por fase e, se faltar, avisa e oferece
   registro retroativo, sem alterar o modelo.

A reaplicação do setup confere o bloco e o restaura se faltar.

## Versões do Spec Kit provadas

B e A desativados: nenhuma versão provada.

| Versão | Evidência no hexlog | Fases que disparam |
|---|---|---|

Uma versão do Spec Kit fora desta tabela fica só com a camada C. Só uma sonda rodada
pelo dono promove uma versão a B; sonda feita no ambiente do dev não alimenta a tabela.
