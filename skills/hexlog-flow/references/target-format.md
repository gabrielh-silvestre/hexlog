# Formato do target

`target` é o endereço de um item de trabalho: um rótulo `a.b.c`, validado pelo schema `Target` (`domain/ids.ts#Target`). Cada segmento casa `[a-z0-9][a-z0-9-]{0,62}` (minúsculo, dígito e hífen, começando por letra ou dígito, até 63 caracteres), os segmentos se separam por `.`, e o rótulo inteiro tem até 200 caracteres, sem `.` no fim. Maiúscula, `_`, `:` e espaço são recusados com `INVALID_INPUT` (por exemplo, `v1-f6.revisao` é válido e `hex:target:v1-f6` é recusado). Carregue este arquivo ao montar um `target` novo.

## Subárvore e `targetPrefix`

O `.` é o separador de subárvore (`plano.iteracao-2`), e o filtro `targetPrefix` da `query` e dos seletores de gate respeita essa fronteira (`domain/gate.ts#matchesTargetPrefix`): `a.b` casa `a.b` e `a.b.c`, e deixa `a.bc` de fora. Por isso a raiz do target costuma ser o slug do item de trabalho (do plano, da spec, do team), e as partes dele ficam abaixo (`<slug>.revisao`). Assim uma consulta por `targetPrefix` = o slug traz o item inteiro, e o `target` do `evaluate_gate` é herdado pelos seletores que omitem `targetPrefix`.

## `targetPattern` customizado por projeto

O modelo do projeto pode restringir o formato do target via `targetPattern` (ver [`../../hexlog-setup/references/model-schema.md`](../../hexlog-setup/references/model-schema.md)): uma regex sobre o **rótulo inteiro**, mais estreita que a sintaxe acima. Por exemplo, um projeto que numera tarefas como `proj-123` e as divide em partes declara `targetPattern: 'proj-[0-9]+(\.[a-z0-9-]+)*'`. Com o campo ausente, vale só a sintaxe do `Target`.

Ao registrar o primeiro registro sobre um item de trabalho, confira o `targetPattern` do modelo do projeto antes de montar o `target` novo. O servidor valida só a sintaxe do `Target`: um rótulo fora do padrão do projeto é aceito, mas quebra a convenção combinada e deixa de bater com o que outras fases esperam achar ao consultar esse mesmo target.

Ao reusar um `target` já existente (para registrar um segundo registro sobre o mesmo item, ou para consultar), copie o rótulo exatamente como foi usado da primeira vez, em vez de regenerá-lo a partir do slug original.
