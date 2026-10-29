# Context Map

O termo canônico de cada glossário é em pt-BR, com o identificador do código ou da tool ao lado; o termo que já venceu em inglês na prosa (como `target`) fica em inglês.

## Contexts

- [Produto](./CONTEXT.md): o log append-only de registros que o servidor MCP grava, encadeia e consulta
- [Fluxo de desenvolvimento](./.claude/CONTEXT.md): como o trabalho neste repositório é decidido e registrado no hexlog

## Relationships

- **Fluxo → Produto**: o fluxo é cliente do produto. Cada trabalho vira um processo do projeto `hexlog`, e diretriz, premissa, decisão, lacuna e achado são tipos de registro desse projeto
- **Cadeira do produto ≠ cadeira do fluxo**: "cadeira" e "ocupante" existem nos dois glossários com sentidos distintos. No [produto](./CONTEXT.md) a cadeira é o recurso opt-in do `hexlog-setup`, com resposta do ocupante e auditoria humana posterior; no [fluxo](./.claude/CONTEXT.md) é o papel do `critic` com aval prévio na classe crítica. O fluxo migra para a cadeira do produto num trabalho futuro ([ADR 0014](docs/directives/adr-0014-cadeira-do-dono-como-pacote-de-dados.md))
