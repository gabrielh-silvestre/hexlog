# ADR 0012: Cadeira do dono no fluxo do hexlog

**Status:** Aceito

**Data:** 2026-10-16

**Deciders:** Gabriel Baldino (desenho da cadeira e aprovação do plano), com o plano de consenso entre planner, architect e critic

---

## Context

No modo `autonomous` o agente decide as lacunas sozinho e a premissa que as fecha é texto dele ([ADR 0011](adr-0011-camada-estrategica.md), itens 3 e 9). O dono quer uma cadeira com ocupante simulado, independente do principal e durável no trabalho, e aval humano nos pontos críticos, sem tocar `src/`.

Quatro restrições a moldam:

- Nenhuma tool, tipo ou relação nova (`ferramentas-fixas`, `nucleo-sem-termo-de-fluxo`): só um campo opcional em tipo existente, dado em `.hexlog/`, skills, docs e testes.
- Definição é imutável e fixada por processo: o trabalho aberto antes do `define_type` não enxerga o campo.
- Os hooks e o aval são freio, não barreira (`hooks-sao-freios`).
- Só o dono muda premissa atemporal; o agente nunca edita [estrategia.md](estrategia.md).

As regras da cadeira moram no doc vivo `cadeira-do-dono.md`, importado pelo `CLAUDE.md`; este ADR registra a decisão e o trade-off, e o fluxo geral segue em [fluxo-hexlog.md](fluxo-hexlog.md).

## Decision

1. **Cadeira como papel.** A skill neutra `flow-owner-seat` descreve só o contrato; as regras ficam em `cadeira-do-dono.md`. O ocupante é o humano no `ask`; no `autonomous` é um `critic` em Opus, e só se o `premise` fixado do processo tem `answeredBy`. O critic nunca responde anonimamente.
2. **Campo de origem.** `premise.answeredBy` opcional (`human`, `simulated`, `simulated-approved`), autodeclarado, entra por `define_type` minor. A geração de diretrizes só vira `directives-N` em mudança `breaking` ou em campo obrigatório para o que o sync grava. Recusado: tipo novo e `answeredBy` obrigatório (emendado em 2026-10-16, ver Emendas datadas).
3. **Classe crítica.** É crítica a escolha que altera, remove ou contraria o sentido de regra existente de `directives.adr-`, `directives.invariantes.`, `directives.fronteiras.`, `directives.convencoes.` ou `directives.estrategia.`; o resto é comum. Todo toque vai à cadeira, mesmo havendo caminho limpo. Lacuna que compromete o trabalho inteiro fica fora e vai ao humano.
4. **Segundo gate.** Na classe crítica o critic grava a premissa `simulated` sem `fills-gap` e o agente executa sobre ela. O aval humano no pré-PR grava `simulated-approved`, com `fills-gap` e `derivesFrom` cru para a `simulated`, sem `supersedes` de premissa. É freio: gate `gaps` falhando e relatório acusando, não barreira.
5. **Backstop.** O `flow-report.ts` acusa `critical-gap` e `rests-on-simulated`. A classe vem de um literal em texto livre de `gap.context` (`Class: critical; rule: <target>`), freio declarado, com falso negativo admitido. A recusa depois de executar refaz o trabalho dependente e volta ao critic como dado.
6. **Atemporal.** A cadeira nunca faz `fills-gap` contra premissa atemporal: o critic só recomenda, a lacuna fica aberta, o PR em rascunho e o que depende dela trava até o dono decidir. Só o dono emenda [estrategia.md](estrategia.md).
7. **Exceção ao teto fixo.** Na classe crítica de ADR, invariantes, fronteiras e convenções, a escolha pode contrariar a regra citada se a regra for emendada no mesmo trabalho e a escolha tiver aval do humano no pré-PR. Para `estrategia` não há exceção.
8. **Quem registra.** O subagente que encontra lacuna ou ponto crítico que ninguém lhe entregou devolve ao principal, sem delegar registro. O critic registra a premissa; a `decision` do principal é adoção própria da resposta, com `rationale` citando o id da `simulated`.
9. **Critic durável.** Roda numa sessão Claude separada (tab Herdr no worktree, `claude --model opus`), um por trabalho, continuado por `SendMessage` entre sessões, sem teto de perguntas. Relê o hexlog a cada pergunta e este vale mais que a memória dele. Queda, contexto cheio ou silêncio o substituem. Sem Herdr não há ocupante.
10. **Emendas.** Este ADR emenda os itens 1, 3 (a 2ª condição), 5, 6, 8, 9 e 10 do ADR 0011 e o item 3 do [ADR 0010](adr-0010-camada-sobre-omc.md), como descrito na seção "Emendas aos ADRs 0010 e 0011". Os dois ADRs recebem só uma linha datada em "Emendas datadas".
11. **Ativação em trabalho seguinte.** O `define_type` de `premise` é ação do dono, depois do merge, em trabalho próprio. Até lá, e em processo aberto antes dele, vale a regra sem ocupante: classe comum decide como antes, e a crítica volta ao teto fixo.

## Emendas aos ADRs 0010 e 0011

Itens do ADR 0011 emendados, cada um com o que muda:

- **Item 1 (camada de premissas):** `premise` ganha `answeredBy` opcional, campo novo em tipo existente; as atemporais seguem sem ele.
- **Item 3 (premissa que fecha lacuna), a 2ª condição ("nem diretriz técnica"):** na classe crítica a premissa pode contrariar a regra tocada se ela for emendada no mesmo trabalho, com aval humano no pré-PR. A 1ª condição (premissa atemporal) não muda.
- **Item 5 (teto técnico e contradição):** o teto técnico tem a mesma exceção na classe crítica; a contradição com atemporal passa a travar o que depende da lacuna, e o PR continua em rascunho.
- **Item 6 (evidência):** a `evidence` também apoia a premissa `simulated`, com o veredito do critic em anexo.
- **Item 8 (conferência pela auditoria):** a auditoria separa as premissas por `answeredBy`.
- **Item 9 (limite do gate `gaps`):** `answeredBy` e o backstop do relatório dão peso mecânico parcial ao gate no que o texto não alcança.
- **Item 10 (vale nos dois modos):** no `autonomous` quem decide a lacuna é o ocupante simulado e, na classe crítica, o aval do humano no pré-PR; no `ask` o ocupante segue sendo o humano.

Itens do ADR 0011 conferidos e não tocados: 2 (a `decision` continua ligando a premissa por `rests-on`), 4 (o gate `gaps` continua com a mesma pergunta), 7 (objetivo da entrega) e 11 (nenhuma geração nova de diretrizes).

Item 3 do ADR 0010 (ponteiro no `SubagentStart`): o hook passa de ponteiro a ponteiro mais regra curta. Quem encontra lacuna ou ponto crítico que ninguém lhe entregou devolve a quem o lançou; o critic e as ações de contexto dele ficam de fora e respondem. É instrução, não barreira, e o ponteiro continua sem copiar as regras.

## Alternatives considered

- **Regra em `fluxo-hexlog.md`:** o doc já passa de metade do teto de linhas e a regra estouraria o limite por bullet. **Seleção repetida nas duas skills:** duas cópias divergem sem trava. **Skill fina de seleção:** a seleção cabe numa frase e a skill competiria no roteador.
- **Origem por convenção de target, tipo `consultation` ou `answeredBy` obrigatório:** a convenção viola `validacao-por-esquema`, o tipo é irreversível e fora de escopo, e o campo obrigatório pede nova geração de diretrizes e reancoragem de cerca de cem arestas.
- **`simulated-approved` por `supersedes`:** contraria o item 3 do ADR 0011 e deixa a `evidence` apoiando registro não vigente. **Gate `owner-approval` ou hook `PreToolUse`:** o aval é um turno de `AskUserQuestion` que o hook não enxerga, e a pergunta nova é decisão de contrato.
- **Aval antes de executar, com trava:** rejeitado pelo dono por latência e atrito; o aval virou freio do pré-PR, ao custo de retrabalho na recusa.
- **Critic como subagente do `Agent`:** rejeitado pela Sonda 1. Com `name` ele vira teammate e o roster plano o impede de lançar subagente com `name`; sem `name`, o hook de nomes barra o tipo OMC.
- **Critic novo por pergunta:** mantém a independência, mas contraria o requisito do dono; é só a degradação quando o durável cai.
- **Ponteiro puro no `SubagentStart`, sem emenda do ADR 0010:** rejeitado pelo dono, que quer a regra curta no próprio hook.
- **Operações irreversíveis do dono no mesmo trabalho:** o `define_type` ficaria antes da review, e um commit depois dele invalidaria a verificação e o marcador.

## Consequences

- O `autonomous` ganha um ocupante independente do principal, com o hexlog como âncora, e o humano avaliza só o que é crítico. O servidor e as 12 tools não mudam.
- O aval é freio do pré-PR, não barreira: o `mark` não consulta gate nem relatório, então nada impede um agente de gravá-lo com o `gaps` vermelho. O agente executa antes do aval e a recusa custa retrabalho.
- A classe vem de um literal em texto livre; divergência entre o literal e o doc é achado de review. Doc crítico modificado sem lacuna não é motivo do relatório, e a review é a defesa.
- `author`, `answeredBy` e `human` são autodeclarados: rastro, não prova. `human` no log só vale com a conferência, no turno do `AskUserQuestion`, de que o humano respondeu. Processos abertos antes do `define_type` não enxergam o campo.
- Opus de longa duração: custo e deriva mitigados pela releitura do hexlog e pela substituição. A exceção de Opus mora no doc do repositório, não no `CLAUDE.md` global. O critic depende de Herdr; sem ele a cadeira não senta.
- Cada pergunta crítica deixa duas premissas (`simulated` e `simulated-approved`); sondas e rodadas deixam ruído revogado no log. É um doc vivo a mais no sync.
- O dono emendou duas premissas atemporais na branch do trabalho (`dois-modos-de-uso` e `camada-fina-sobre-o-omc`).
- Follow-ups:
  - Gate `owner-approval`, se o desvio aparecer na auditoria.
  - Campo `class` em `gap.json`, se o literal divergir do doc.
  - Comentários no PR e "se não trava, segue" (2ª entrega).
  - Prova real do freio do aval por uso, além do ensaio.
  - Nova geração de diretrizes, se o dono preferir a versão com `answeredBy` obrigatório.

## Emendas datadas

Um ADR aceito não é refeito: cada entrada abaixo diz o que mudou e por quê. Vêm de achados da review do PR #172, aplicados por autorização do dono, Gabriel Baldino.

- **2026-10-16: o item 2 troca o critério de nova geração de diretrizes.** A geração só vira `directives-N` quando o sync passa a gravar algo que a vigente não fixou (tipo, relação ou gate novo, ou campo novo em tipo existente) ou quando a mudança é `breaking`; o campo opcional que o sync não grava, como `answeredBy`, passa só por `define_type`. O critério "campo obrigatório para o que o sync grava" não cobria o tipo, a relação ou o gate novo, que o processo vigente recusaria (`TYPE_NOT_PINNED`, `unknown-relation-name`), nem o campo opcional que o schema fixado rejeita com `additionalProperties: false`. [fluxo-hexlog.md](fluxo-hexlog.md) traz o mesmo critério.
- **2026-10-16: o item 3 ganha o porquê da lista da classe crítica.** `directives.adr-` guarda decisão aceita e imutável; `invariantes` e `fronteiras` guardam o que o código garante e a direção entre as camadas; `convencoes` entra por escolha do dono na entrevista do plano, ciente de que é tocada com frequência e de que o volume de perguntas e o custo sobem; `estrategia` só o dono emenda. A lista não muda.
- **2026-10-16: `fluxo-hexlog`, `cadeira-do-dono` e `instalacao-e-hooks` ficam fora da classe crítica.** Escolha do dono: esses docs seguem o regime comum de [fluxo-hexlog.md](fluxo-hexlog.md), em que a emenda da própria regra citada no mesmo trabalho fecha como lacuna comum, sem aval humano por lacuna; a cobertura é a review humana do PR. Consequência aceita: as regras do gate, do `mark` e da própria cadeira ficam no regime mais frouxo do fluxo. Alternativa rejeitada: ampliar a lista a esses três docs, o que traria a cadeira obrigatória e o aval no pré-PR para a emenda deles.
- **2026-10-16: o item 8 acrescenta o `rests-on` para a `simulated`.** A `decision` de adoção liga `rests-on` à `simulated` além de citar o id no `rationale`. Sem a relação, o relatório não acusa `rests-on-simulated` quando o critic escala a classe, porque a `gap` segue com `Class: common` no `context` e as relações regravadas mantêm só o `rests-on` que a provisória tinha.
- **2026-10-16: o item 9 declara o que não foi sondado.** Substituir o critic por silêncio ou por `context: tight` não foi sondado com o lançamento final e pode descartar uma resposta em andamento. Nas Consequences, "sondas" são as verificações do fluxo contra uma pergunta simulada, gravadas em `<slug>.premise.sonda-<n>` e `<slug>.evidence.sonda-<n>`; o texto das desta entrega está no anexo de `feat-owner-seat.evidence.sondas` (hash `a3db31b2c40848f209c9f07918dfd958fa9000c87cf37a9f3934ea04f6e3b931`), rastro no log e não destino versionado. Não houve target `rodada-*`.
- **2026-10-16: as lacunas críticas desta entrega fecharam por aprovação do plano, não por aval por lacuna.** As lacunas críticas do ADR 0010 (item 3) e do ADR 0011 (itens 1, 3, 5, 6, 8, 9 e 10) fecharam pela aprovação do plano pelo dono e pelo aceite deste ADR, sem ocupante simulado nem aval de pré-PR por lacuna, porque nenhum processo fixa `answeredBy` antes do `define_type` (item 11). O precedente não vale para os trabalhos seguintes.
- **2026-10-17: o `define_type` de `premise` 1.1 foi gravado na Fase B (#177), dentro desta branch e antes do merge.** O item 11 ("depois do merge, em trabalho próprio") deixa de valer, e a previsão da alternativa rejeitada "Operações irreversíveis do dono no mesmo trabalho" se cumpriu: a `verification` e o marcador foram invalidados e refeitos. Só processo criado depois do 1.1 fixa `answeredBy`; os anteriores, `feat-owner-seat` incluído, seguem sem o campo. A dispensa do aval por lacuna da emenda de 2026-10-16 valia no fechamento das lacunas, quando nenhum processo fixava o campo; o precedente segue sem valer adiante. Trade-off aceito: a definição é irreversível, então rejeitar ou reabrir este PR deixa `premise` 1.1 no projeto sem `.hexlog/types/premise.json` na develop. O item 7.0 do plano (sessão nova a partir da develop mergeada) não foi executado.
