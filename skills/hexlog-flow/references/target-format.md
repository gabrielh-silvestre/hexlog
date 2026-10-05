# Formato do target

`target` é o endereço de um item de trabalho: um rótulo `a.b.c`, validado pelo
schema `Target` (`domain/ids.ts#Target`). Cada segmento casa
`[a-z0-9][a-z0-9-]{0,62}` — minúsculo, dígito e hífen, começando por letra ou
dígito, até 63 caracteres —, os segmentos se separam por `.`, o rótulo inteiro tem
até 200 caracteres e não termina em `.`. Maiúscula, `_`, `:` e espaço são recusados
com `INVALID_INPUT`. O prefixo `hex:target:` do 0.x não existe mais: escreva
`v1-f6.revisao`, não `hex:target:v1-f6`.

## Subárvore e `targetPrefix`

O `.` é o separador de subárvore (`plano.iteracao-2`), e o filtro `targetPrefix` da
`query` e dos seletores de gate respeita essa fronteira
(`domain/gate.ts#matchesTargetPrefix`): `a.b` casa `a.b` e `a.b.c`, e **não** casa
`a.bc`. Por isso a raiz do target costuma ser o slug do item de trabalho (do plano,
da spec, do team), e as partes dele ficam abaixo (`<slug>.revisao`). Assim uma
consulta por `targetPrefix` = o slug traz o item inteiro, e o `target` do
`evaluate_gate` é herdado pelos seletores que não trazem `targetPrefix`.

## `targetIdPattern` customizado por projeto

O `.hexlog/flow.md` pode restringir o formato do target via `targetIdPattern` no
frontmatter (ver [`../../hexlog-setup/references/flow-map-schema.md`](../../hexlog-setup/references/flow-map-schema.md)): uma regex
sobre o **rótulo inteiro**, mais estreita que a sintaxe acima — por exemplo, um
projeto que numera tarefas como `proj-123` e as divide em partes declara
`targetIdPattern: 'proj-[0-9]+(\.[a-z0-9-]+)*'`. Quando o campo está ausente, vale só a
sintaxe do `Target`.

Antes de montar um `target` novo (ao registrar o primeiro registro sobre um item de
trabalho), confira o `targetIdPattern` do flow map. O servidor só valida a sintaxe
do `Target`: um rótulo fora do padrão do projeto é aceito, mas quebra a convenção
combinada e deixa de bater com o que outras fases esperam achar ao consultar esse
mesmo alvo.

Ao reusar um `target` já existente (para registrar um segundo registro sobre o mesmo
item, ou para consultar), copie o rótulo exatamente como foi usado da primeira vez
— não o regenere a partir do slug original.
