# Formato do target

`target` é o endereço de um item de trabalho: `hex:target:<id>`, validado pelo
schema `Target` (`events.ts:27-30`) contra `/^hex:target:[^\s:]+$/` — o
prefixo `hex:target:` é fixo, só o `<id>` varia.

## `<id>` customizado por projeto

O `.hexlog/flow.md` pode restringir o formato do `<id>` via `targetIdPattern`
no frontmatter (ver `skills/hexlog-setup/references/flow-map-schema.md`) — por exemplo, um projeto que numera
tarefas como `PROJ-123` declara `targetIdPattern: 'PROJ-\d+'`. Quando o campo
está ausente, o default é o mesmo regex embutido em `Target`
(`[^\s:]+` — qualquer coisa sem espaço nem `:`).

Antes de montar um `target` novo (ao registrar o primeiro marco sobre um item de
trabalho), confira o `targetIdPattern` do flow map — um `<id>` fora do padrão
declarado não é validado pelo servidor (o servidor só valida contra o regex fixo
de `Target`), mas quebra a convenção que o projeto combinou, e passa a não bater
com o que outras fases esperam encontrar ao consultar esse mesmo `target`.

Ao reusar um `target` já existente (para registrar um segundo marco sobre o mesmo
item, ou pra consultar via `events`/`chain`/`state`), copie o id exatamente como
foi usado da primeira vez — não regenere a partir do `<id>` original.
