# Plug no Spec Kit

Como o hexlog se liga a um repositório que usa o Spec Kit. Só a **camada C** está ativa: ela escreve a skill do projeto, o modelo e um bloco delimitado no `AGENTS.md` do destino, e funciona por conta própria, sem depender de disparo do Spec Kit.

## Camada C (sempre)

1. A skill do projeto (`.claude/skills/<projeto>-hexlog/SKILL.md`), cuja `description` nomeia os comandos das fases do Spec Kit (`/speckit-specify`, `/speckit-plan`, `/speckit-tasks`), porque o gatilho por descrição é probabilístico.
2. O **bloco no `AGENTS.md`** do destino, com texto e regras em `agents-block.template.md`. A alcançabilidade do bloco (`AGENTS.md` lido direto ou `CLAUDE.md` com import) está nos passos 9 e 10 do `SKILL.md` do setup. O que é próprio do Spec Kit:
   - O `specify init` (1.2.4) cria só os arquivos do Spec Kit: o `CLAUDE.md`, o `AGENTS.md` e a região gerenciada ficam por conta da extensão opt-in `agent-context`.
   - A região usa os marcadores `<!-- SPECKIT START -->` e `<!-- SPECKIT END -->`, configuráveis em `.specify/extensions/agent-context/agent-context-config.yml`, e é reescrita pelos hooks `after_specify` e `after_plan`.
   - Se a pasta da extensão existe, leia essa config para os marcadores e o arquivo de contexto reais e escreva o bloco do hexlog fora do par; como o bloco termina no próximo título ou comentário HTML, ele para antes da região do Spec Kit.
   - Com a configuração padrão a extensão cria um `CLAUDE.md` sem import e o bloco fica inerte: o passo 10 do setup avisa o dev.
3. O fechamento da unidade confere um registro por fase e, se faltar, avisa e oferece registro retroativo, sem alterar o modelo.

## Versões do Spec Kit provadas

B e A desativados: a tabela tem zero versões provadas.

| Versão | Evidência no hexlog | Fases que disparam |
|---|---|---|

Uma versão do Spec Kit fora desta tabela fica com a camada C. Uma sonda rodada pelo dono promove uma versão a B; a sonda feita no ambiente do dev fica fora da tabela.
