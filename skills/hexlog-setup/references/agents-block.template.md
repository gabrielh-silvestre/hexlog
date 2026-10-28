# Bloco da camada C no AGENTS.md

Fonte única do bloco: texto literal que o setup escreve no `AGENTS.md` do destino, em inglês, com até 8 linhas, e as regras de posição, comparação e reaplicação. O título `## hexlog` é fixo: a reaplicação procura esse título e compara o texto do bloco. Substitua `{{commands}}` pelos comandos das fases do modelo, separados por vírgula, e `{{skill_name}}` pelo nome da skill do projeto.

```markdown
## hexlog

After {{commands}}, you MUST use the skill `{{skill_name}}` to record the phase in hexlog and,
when the last phase ends, to check that the unit of work is complete.
If the hexlog tools are unavailable, continue without recording and tell the developer once.
```

Regras:

- O bloco vai no fim do `AGENTS.md`, fora de qualquer região que outra ferramenta gerencie.
- O bloco vai do título `## hexlog` até o próximo título (de qualquer nível), a próxima linha que abre comentário HTML (`<!--`, como o marcador de região do Spec Kit) ou o fim do arquivo, o que vier primeiro. A comparação e a escrita ficam dentro desse limite.
- Um `AGENTS.md` ausente é criado só com o bloco.
- Bloco ausente: o setup o recria sem perguntar. Bloco com o mesmo texto do template renderizado: o arquivo fica como está.
- Um título `## hexlog` com texto diferente do template pode ser de terceiros: o setup mostra o diff e **pergunta** antes de gravar. Só o bloco que o próprio setup escreveu (texto igual ao último renderizado) é restaurado sem perguntar.
- Limite documentado: o hexlog é por máquina (`<D>` local). Dois desenvolvedores na mesma unidade criam processos locais divergentes, e quem usa o fallback do bloco (sem o hexlog) segue sem registrar.
