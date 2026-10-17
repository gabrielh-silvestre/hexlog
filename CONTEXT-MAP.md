# Context Map

O termo canônico de cada glossário é em pt-BR, com o identificador do código ou da tool ao lado; o termo que já venceu em inglês na prosa (como `target`) fica em inglês.

## Contexts

- [Produto](./CONTEXT.md): o log append-only de registros que o servidor MCP grava, encadeia e consulta
- [Fluxo de desenvolvimento](./.claude/CONTEXT.md): como o trabalho neste repositório é decidido e registrado no hexlog

## Relationships

- **Fluxo → Produto**: o fluxo é cliente do produto. Cada trabalho vira um processo do projeto `hexlog`, e diretriz, premissa, decisão, lacuna, achado e verificação são tipos de registro desse projeto
