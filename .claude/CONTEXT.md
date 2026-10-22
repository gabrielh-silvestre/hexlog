# Fluxo de desenvolvimento

Como o trabalho neste repositório é decidido, justificado e registrado no hexlog, para que cada escolha possa ser auditada contra as regras e as premissas do produto. Os termos do log em si (processo, registro, vigente, marcador) estão no [glossário do produto](../CONTEXT.md).

## Language

### Trabalho

**Trabalho**:
Uma entrega deste repositório, feita numa branch e registrada num processo próprio do produto.
_Avoid_: tarefa, job, processo (para o trabalho)

**Dono**:
A pessoa que define o rumo do produto, valida as premissas atemporais e decide o que o agente não pode decidir sozinho.
_Avoid_: usuário, owner, humano

**Modo** (`ask`, `autonomous`):
Como o trabalho trata uma lacuna: parando para perguntar ao dono, ou decidindo e registrando a premissa sozinho.
_Avoid_: nível de autonomia

**Pré-PR**:
A etapa que fecha o trabalho: review, relatório das decisões, push, marcador e abertura do PR. Os comandos de checagem (tipos, lint, testes) ficam com o husky, o commitlint e o CI, não com o log.
_Avoid_: checklist final, fechamento

**Marcador do pré-PR**:
A prova, gravada por `scripts/flow/mark.ts` só quando os gates `pre-pr` e `gaps` do trabalho estão verdes, de que eles passaram num commit da branch; sem ela o PR só abre em rascunho. A árvore suja não importa.
_Avoid_: marcador (sozinho), selo, flag

### Regras

**Diretriz** (`directive`):
Uma regra atômica de trabalho, escrita num documento de `docs/directives/` e registrada no processo das diretrizes.
_Avoid_: norma, política, guideline

**Doc vivo**:
Documento de diretrizes que não é ADR e se edita como código.
_Avoid_: doc de regra, wiki

**Processo das diretrizes** (`directives-N`):
O processo que guarda as diretrizes e as premissas atemporais vigentes; ganha uma geração nova quando um tipo, nome de relação ou gate delas muda.
_Avoid_: processo de regras, base de diretrizes

**Reancoragem**:
Regravar as decisões vigentes para que apontem às diretrizes da geração nova do processo das diretrizes.
_Avoid_: migração de decisões, remapeamento

### Porquês

**Premissa** (`premise`):
O porquê de uma escolha, em linguagem de produto.
_Avoid_: hipótese, motivo, justificativa

**Premissa atemporal**:
Premissa do produto, escrita em `estrategia.md`, que só o dono muda.
_Avoid_: premissa estratégica, princípio

**Premissa da entrega**:
Premissa que vale só para um trabalho.
_Avoid_: premissa local, premissa do PR

**Objetivo**:
A primeira premissa da entrega: o resumo do que foi pedido.
_Avoid_: escopo, meta

**Sentinela** (`directives.estrategia.none`):
A premissa atemporal que declara que nenhuma outra se aplica.
_Avoid_: premissa vazia, nenhuma

### Escolhas

**Decisão** (`decision`):
Uma escolha entre alternativas viáveis que muda código, escopo ou processo.
_Avoid_: escolha mecânica, opção

**Fonte** (`evidence`):
A justificativa pesquisada que apoia uma decisão vigente.
_Avoid_: evidência, referência

**Confiança** (`confidence`):
O quanto a diretriz citada resolve a decisão diretamente: `low`, `medium` ou `high`.
_Avoid_: certeza, score

**Lacuna** (`gap`):
Uma escolha que nenhuma diretriz cobre por inteiro, ou que o trabalho emenda.
_Avoid_: gap (na prosa), dúvida, pendência

**Fechador**:
A diretriz ou a premissa da entrega que fecha uma lacuna.
_Avoid_: resolução, resposta

**Lacuna aberta**:
Lacuna sem fechador vigente; deixa o PR em rascunho.
_Avoid_: lacuna pendente

### Review

**Achado** (`finding`):
Um problema que a review apontou, com severidade e origem.
_Avoid_: issue, comentário, bug
