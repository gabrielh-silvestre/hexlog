# ADR 0004: O fluxo é do projeto, a auditoria é do hexlog

**Status:** Proposto

**Data:** 2026-09-20

**Deciders:** Gabriel Henrique Silvestre Baldino; discussão de agnosticismo
posterior à PR #4 (`feat/wave-melhorias`)

> **Nota (2026-09-28):** a PR #4 foi fechada sem merge. As cinco mecânicas
> que este ADR generaliza (e o ADR 0003 que as registrava) não estão na
> `main`.

## Context

O hexlog nasceu para auditar a fase pré-código — discovery e refinamento —
registrando as decisões que os agentes tomaram e as motivações que levaram
a cada uma. Essa é a motivação de origem, e ela não mudou.

Cada projeto, e cada pessoa, conduz essa fase de um jeito diferente. O fluxo
de refinamento do `hextelemetry` (architect e critic opinando às cegas, gate
só depois do verifier) não é o do `weed-clicker` (wave → task → pr, com
premissa refutada propagando para a task dependente), que não é o de um
processo de review de PR.

O servidor hoje tem dois tiers, e isso foi decisão explícita do deep-dive
inicial (2026-09-16): Marco e Veredito são nativos e trazem todas as regras
de Estado; tipo custom registrado via `register_type` é **inerte no Estado**.
A PR #4
acrescentou cinco mecânicas (gate de regra, voto às cegas, ordem de fases,
predecessores, `dependsOn`), todas presas a nomes de campo fixos do
vocabulário do próprio hexlog.

A consequência prática é que um projeto com fluxo próprio tem duas saídas
ruins: traduzir o fluxo dele para `milestone`/`verdict`/`vote`, ou registrar
um tipo custom e perder toda a projeção de Estado.

## Drivers

- O fluxo pré-código varia por pessoa e por projeto; a ferramenta tem que
  caber no fluxo, não o contrário.
- A auditabilidade não pode variar junto: cadeia, vigência e rastro de
  premissa são o produto.
- Um gate só é confiável se o critério não for escolhido ad hoc por quem
  está sendo julgado (aprendizado do achado B3 da PR #4).
- Teto de 10 tools, mantido.

## Decision

Separar **mecânica** (do hexlog) de **vocabulário** (do projeto).

| Universal — o hexlog garante | Do projeto — o hexlog não deve saber |
|---|---|
| append-only e cadeia de hash | os nomes dos eventos do fluxo |
| "X supera Y" → vigência, conflito, fork | quais eventos superam quais |
| "X depende de Y" → `toReview` | que fase vem depois de qual |
| rodada cega revelada em N | quem vota, e em que momento |
| termo fora do vocabulário é recusado | os termos em si |
| ordem declarada é obrigatória | a ordem declarada |

1. **Traits.** `register_type` aceita `traits`, um mapa de campo do schema
   do projeto para uma mecânica que o servidor já implementa. Catálogo
   fechado, um por mecânica existente: `supersede`, `dependency`,
   `predecessor`, `phase`, `blindRound`, `deadline`. Nenhuma mecânica nova.

2. **Predicados enumerados.** `register_type` aceita `predicates` para os
   pontos em que o servidor hoje tem opinião de produto embutida e que
   variam por fluxo. Começam dois, ambos com caso real: `resolved` (o que
   conta como predecessor cumprido — é o achado N6 da PR #4) e `reveal`
   (`onCount`, como hoje, ou `onDeadline`, para a rodada que emperra). É um
   enum, nunca uma expressão; um predicado novo entra por caso de uso, não
   por sintaxe.

3. **Fixação.** `traits` e `predicates` entram no snapshot de
   `create_process`, versionados e hasheados como vocabulário, gates e
   `transitions` já são
   ([ADR 0002](adr-0002-versionamento-definicoes.md)). A configuração do
   fluxo passa a ser parte do registro auditável: `list` mostra qual
   configuração aquele processo usa, e mudar a definição depois só vale
   para processos novos.

4. **Compatibilidade.** `milestone`, `verdict` e `vote` continuam existindo
   como traits implícitos. Todo log e todo `process.json` já gravado
   continuam válidos sem migração.

5. **Sem tool nova.** `register_type` ganha dois campos opcionais.

## Alternatives Considered

- **Manter o desenho atual e documentar a fronteira.** Insuficiente: o que
  trava o fluxo alheio não é a mecânica, é o nome do campo a que ela está
  soldada.
- **Motor declarativo de projeções (DSL).** Desnecessário e caro. A mecânica
  de auditoria é universal — não é ela que varia. Exigiria gramática,
  avaliador, versionamento da própria linguagem, e trocaria erros precisos
  (`INVALID_TRANSITION`, com as fases de origem aceitas) por diagnóstico
  genérico. Nenhum dos fluxos conhecidos pede isso.
- **Só os nomes, com predicados fechados no servidor.** Cobre a maior parte,
  mas deixa sem resposta o N6 e a rodada de voto que nunca revela, que são
  justamente detalhes de fluxo. Rejeitada por deixar de fora o que o usuário
  pediu explicitamente: alinhar a ferramenta na maior parte possível dos
  detalhes do fluxo pré-código.

## Consequences

- Tipo custom deixa de ser cidadão de segunda classe: o log passa a falar a
  língua do projeto sem perder projeção de Estado.
- `state.ts` e `event-tools.ts` passam a ler o nome do campo de um mapa em
  vez de literal. É indireção, não algoritmo novo — os testes existentes
  cobrem a mecânica, que não muda.
- A configuração de fluxo vira parte do que é auditado, e não um bypass da
  auditoria.
- Risco residual: alguém cria um processo novo com predicado frouxo. Já vale
  hoje para vocabulário e gate custom, e é por isso que a fixação por
  processo existe.
- O N6 deixa de ser achado em aberto e vira caso de uso do predicado
  `resolved`.
- O ADR 0003 não é revogado: as cinco mecânicas continuam, com o mesmo
  comportamento. O que muda é o acoplamento delas ao nome do campo.

## Follow-ups

- Levantar o plano de implementação: mapear todos os pontos de `state.ts` e
  `event-tools.ts` que hoje leem nome de campo literal, e a ordem das levas.
- Decidir se `reveal: "onDeadline"` entra na mesma leva dos traits ou depois.
- Reavaliar o limite (d) do ADR 0003 (recuperação do voto redigido pela
  pré-imagem do `prevHash`) quando `blindRound` virar trait genérico: a
  redação passa a valer para campos que o servidor não conhece de antemão.
