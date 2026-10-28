# Bloco da camada C no AGENTS.md

Texto literal que o setup escreve no `AGENTS.md` do destino, em inglês, com até 8 linhas.
O título `## hexlog` é fixo: a reaplicação procura esse título, compara o texto até o
próximo título e restaura o bloco se ele faltar ou divergir. Substitua `{{commands}}` pelos
comandos das fases do modelo, separados por vírgula, e `{{skill_name}}` pelo nome da skill
do projeto.

```markdown
## hexlog

After {{commands}}, you MUST use the skill `{{skill_name}}` to record the phase in hexlog and,
when the last phase ends, to check that the unit of work is complete.
```

Regras:

- O bloco vai no fim do `AGENTS.md`, fora de qualquer região que outra ferramenta gerencie.
- Um `AGENTS.md` ausente é criado só com o bloco.
- Um título `## hexlog` com texto diferente do template é restaurado ao texto do template, e o
  setup avisa o dev da diferença.
