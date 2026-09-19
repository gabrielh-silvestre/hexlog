# ADR 0003: Gate de regra, votação às cegas, fases ordenadas, predecessores e dependência de veredito

**Status:** Aceito

**Data:** 2026-09-19

**Deciders:** Gabriel Henrique Silvestre Baldino; planejamento RALPLAN "wave de melhorias" (a partir de `.ignore/reports/wave-hexlog-poc-inferencia.md`)

---

## Context

Uso real do hexlog em projetos (rdsc, hextelemetry, weed-clicker) expôs 5
lacunas independentes: (1) gates custom só aceitam a opinião do agente, sem
jeito de o servidor calcular `passed` sozinho a partir do que já está no
log; (2) um Marco pode registrar `milestoneType` em qualquer ordem, sem
noção de fase; (3) nada modela "este alvo depende de outro terminar antes";
(4) `supersedes` já modela substituição de Veredito, mas não "este Veredito
se apoia em outro sem substituí-lo"; (5) uma rodada de votação entre agentes
não tem como ficar às cegas — qualquer voto anterior fica visível para quem
vota depois, viesando o resultado.

Duas restrições estruturais amarram toda solução:

- **Teto de exatamente 10 tools** (`src/installation.ts: TOOLS_COUNT = 10`,
  verificado em `test/stdio.e2e.spec.ts` e por `src/AGENTS.md`). Nenhuma
  tool nova.
- **Hash retroativo de `process.json`** (`verifyHashes`, ADR 0002): um
  campo novo dentro de um bloco já hasheado (`fixed.types`/
  `fixed.vocabulary`/`fixed.gates`) muda o JCS resultante e quebra todo
  `process.json` gravado antes da mudança. O precedente seguro já existia
  no código: `versions` (ADR 0002) fica fora de `hashes`, opcional, e um
  `process.json` legado sem ele carrega sem erro.

## Decision

Implementar as 5 mudanças estendendo tools existentes — nunca criando uma
tool nova — e, onde a configuração precisa sobreviver a `create_process`,
usando um bloco `fixed.*`/`hashes.*` novo e opcional, nunca um campo dentro
de um bloco já existente e já hasheado.

1. **Gate de regra.** `register_gate` aceita `rule?: RuleGateSpec`
   (`targetPattern`, `requireVigente`, `acceptedResults`, `minCount`).
   `evaluate_gate` despacha para `evaluateRule` (`src/gates.ts`), que conta
   os alvos de `state.active` batendo `targetPattern`/`acceptedResults` e o
   filtro de `requireVigente`, contra o piso `minCount` — em vez de aceitar
   `result` do agente. `result` informado num gate de regra falha com
   `INVALID_EVALUATION`, o mesmo código de um gate embutido no mesmo caso.
   Gate sem `rule` continua sendo gate de opinião, sem mudança de
   comportamento.

2. **Votação às cegas.** Tipo nativo `vote` (`target`, `round`,
   `votersExpected`, `position`, `confidence?`, `changed`, `flipReason?`).
   `votersExpected` é fixado pelo 1º voto da rodada (`target`+`round`); um
   voto seguinte com valor diferente falha com `VOTE_ROUND_MISMATCH`, sem
   gravar nada. Até a contagem de votos da rodada bater `votersExpected`, a
   leitura redige `position`/`confidence`/`changed`/`flipReason` (`null`,
   `redacted: true`) em `events`/`state`, e exclui o voto por completo do
   conjunto de candidatos de `events(search: ...)`. O N-ésimo voto revela
   todos de uma vez, recalculado a cada leitura — nada é reescrito no log.
   `state.voteRounds` expõe a contagem (`votesReceived`/`votersExpected`/
   `revealed`) sem conteúdo, para notar uma rodada emperrada.

3. **Fases ordenadas.** `register_vocabulary` aceita `transitions?:
   {from, to}[]` por `owner`, registrado (versionado) como uma 4ª categoria
   em `transitions/<owner>/<versão>.json`. `from: null` marca fase inicial.
   Uma vez que algum par declara um `to`, `register` de um Marco daquele
   `milestoneType` exige que a fase atual do alvo (`state.phases`, a
   `milestoneType` não-gate mais recente) seja um `from` aceito — senão
   `INVALID_TRANSITION`. `milestoneType` sem par declarado continua sem
   restrição. `process.json` ganha `fixed.transitions`/`hashes.transitions`,
   ambos opcionais.

4. **Predecessores.** Marco aceita `predecessors?: string[]` (alvos). O
   Marco mais recente daquele alvo que declarou o campo vence (`state.ts`).
   `state.blocked` lista alvos com ao menos um predecessor sem Veredito
   vigente; `state.released`, os alvos com todos os predecessores já
   vigentes (`active` ou `conflict`). Alvo sem `predecessors` não entra em
   nenhuma das duas listas.

5. **Dependência de veredito.** Veredito aceita `dependsOn?: string[]`
   (mesmo tipo/teto de `supersedes`, ids de Veredito). Não supera nada:
   diferente de `supersedes`, uma referência em `dependsOn` não remove o
   Veredito referenciado de `active`. Alimenta `invalidReferences` (mesma
   checagem de `supersedes`) e o BFS de `state.toReview` — superar a
   premissa de um `dependsOn` também enfileira o alvo do Veredito
   dependente para revisão.

## Drivers

- Teto de 10 tools (`src/installation.ts`).
- Imutabilidade retroativa de `process.json` via `verifyHashes` (ADR 0002).
- Genericidade validada contra hextelemetry e weed-clicker, não só rdsc — as
  5 mudanças precisavam fazer sentido fora do projeto que motivou o pedido.

## Alternatives Considered

- **Tool dedicada por mudança.** Reabriria o teto de 10; nenhuma das 5
  mudanças exigiu uma tool nova de fato. Reabrir o teto fica reservado a
  uma necessidade futura que não caiba em tool existente — decisão do
  usuário, não deste ADR.
- **Vocabulário/transições dentro do `VocabSchema` existente.** Corrompe o
  hash de `process.json` legado (campo novo num bloco `fixed.*` já
  hasheado).
- **Camadas/ordenação topológica completa para dependência entre unidades.**
  Rejeitada pelo próprio usuário antes deste plano, na revisão de
  generalidade de 2026-09-19 — reduzida a `predecessors`/`dependsOn`.
- **Predicado de "liberado" configurável por projeto.** Rejeitada por
  escopo: reabriria a redução já decidida do item anterior.

## Consequences

- `event-tools.ts` cresce em responsabilidade: o dispatch por `type` ganha
  um 3º ramo nativo (`vote`), espalhado em 5 pontos reais
  (`RESERVED_TYPE_NAMES`, `dataSchema`, a checagem `TYPE_NOT_PINNED`,
  `comparableData`, `applyVocabulary`), não numa constante só. Um 4º tipo
  nativo futuro justificaria extrair para uma tabela `Record<type,
  Handler>` — não faz sentido para 3.
- `definitions.ts` ganha uma 4ª categoria versionada (`transitions`) e
  `RESERVED_PROCESS_NAMES` ganha uma 4ª entrada.
- Documentação (`src/AGENTS.md`, `README.md`, skill `hexlog`) atualizada
  junto com o código, não depois.

**Limites conhecidos, documentados em vez de resolvidos:**

- **(a) Confidencialidade em tempo de consulta, não em repouso.** A rodada
  às cegas redige `events`/`state`/busca, mas o conteúdo do voto está em
  texto claro em `events.jsonl` desde o `append`. `scripts/insights.ts`, que
  lê o log direto para o script de insights, enxerga votos de rodada aberta
  sem passar pela redação — é código first-party instalado com o próprio
  hexlog, não um agente arbitrário, mas deve ser citado para quem estender
  esse script no futuro. Confidencialidade em repouso ficou fora de escopo:
  nenhuma das 5 decisões pediu isso.
- **(b) `until` antigo pode ocultar voto já revelado.** `events(until: ...)`
  congela um prefixo do arquivo para paginação estável (ADR 0001); um `until`
  de antes da rodada bater `votersExpected` mostra o voto redigido mesmo que
  a rodada já tenha revelado depois. Intencional — a paginação nunca revela
  cedo — mas quem espera "revelado agora, revelado sempre nessa página"
  precisa saber que não é esse o contrato.
- **(c) Teto de 10 tools mantido.** As 5 mudanças cabem nas 10 tools
  existentes; qualquer necessidade futura que não caiba é decisão de
  reabrir o teto, não deste ADR.

**Assimetria deliberada entre os três canais de leitura de voto:**
`events(search: ...)` omite a linha inteira de rodada aberta (nem aparece,
nem redigida — só assim elimina o oráculo de confirmação por termo de
busca); `events`/`state` em modo cru mostram um stub redigido (a linha
aparece, para não haver buraco na paginação nem contagem estranha, só o
conteúdo vira `null`); `state.voteRounds` expõe a contagem sem conteúdo. Os
três tratam a mesma rodada aberta de formas diferentes por desenho, não por
inconsistência — cada canal resolve um problema de leitura distinto.

## Follow-ups

- Itens 2, 3, 4, 5 e 8 do relatório original (`.ignore/reports/`), fora
  desta wave: espelho local, documento desatualizado, vocabulário de
  júri/milestoneType como registro simples, reserva de numeração, e a
  auditoria via verifier.
- Predicado de "liberado" configurável por projeto, se o predicado fixo da
  mudança 4 (resolvido = `active`/`conflict`) se mostrar insuficiente em uso
  real.
- Hash isolado do bloco `versions` (cogitado no ADR 0002, ainda não feito).
