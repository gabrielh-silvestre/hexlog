# Plug no Spec Kit

Como o hexlog se liga a um repositório que usa o Spec Kit. Só a **camada C** está
ativa: ela escreve a skill do projeto, o modelo e um bloco delimitado no `AGENTS.md` do
destino, e nunca depende de disparo do Spec Kit.

## Camada C (sempre)

1. A skill do projeto (`.claude/skills/<projeto>-hexlog/SKILL.md`), cuja `description`
   nomeia os comandos das fases do Spec Kit (`/speckit-specify`, `/speckit-plan`,
   `/speckit-tasks`), porque o gatilho por descrição é probabilístico.
2. O **bloco no `AGENTS.md`** do destino, copiado de `agents-block.template.md`: ponteiro
   imperativo de até 8 linhas, com o título fixo `## hexlog`, dizendo que, depois dos
   comandos das fases, se usa a skill do projeto.
   Sem `CLAUDE.md`, o Claude Code lê o `AGENTS.md` direto (v2.1.277 ou mais nova; fonte
   oficial: https://code.claude.com/docs/en/memory, seção AGENTS.md). Com um `CLAUDE.md`
   que não importa o `AGENTS.md` (`@AGENTS.md`), o bloco não é alcançado; o setup só mexe
   no `CLAUDE.md` com opt-in do dev e, quando mexe, escreve no fim do arquivo, **fora de
   qualquer região que o Spec Kit gerencia**. A mesma regra vale para o `AGENTS.md`.
   O `specify init` (1.2.4) não cria `CLAUDE.md` nem `AGENTS.md` nem região gerenciada. A
   região vem da extensão opt-in `agent-context`, com os marcadores `<!-- SPECKIT START -->`
   e `<!-- SPECKIT END -->`, configuráveis em
   `.specify/extensions/agent-context/agent-context-config.yml`, e é reescrita pelos hooks
   `after_specify` e `after_plan`. Se a pasta da extensão existe, leia essa config para os
   marcadores e o arquivo de contexto reais e escreva o bloco do hexlog fora do par; o bloco
   termina no próximo título ou comentário HTML (regras em `agents-block.template.md`), então
   nunca avança sobre a região do Spec Kit. Com a configuração padrão a extensão cria um
   `CLAUDE.md` sem import e o bloco fica inerte: o passo 10 do setup avisa o dev.
3. O fechamento da unidade confere um registro por fase e, se faltar, avisa e oferece
   registro retroativo, sem alterar o modelo.

A reaplicação do setup confere o bloco, o recria se faltar e pergunta (com diff) antes de
tocar um `## hexlog` com texto diferente.

## Versões do Spec Kit provadas

B e A desativados: nenhuma versão provada.

| Versão | Evidência no hexlog | Fases que disparam |
|---|---|---|

Uma versão do Spec Kit fora desta tabela fica só com a camada C. Só uma sonda rodada
pelo dono promove uma versão a B; sonda feita no ambiente do dev não alimenta a tabela.
