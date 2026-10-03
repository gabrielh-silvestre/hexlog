# Regras de cruzamento

Três regras, decididas no grilling do mapa de fluxo. Nenhuma delas precisa de tool
nova — todas são combinações de `register`, `query`, `evaluate_gate` e
`verify_chain`, guiadas pela leitura do `.hexlog/flow.md`.

## 1. Mesma fase — conflito ou superado

Dois registros da mesma fase (mesmo `process`, já que fase e processo são 1:1)
podem entrar em conflito: uma decisão nova invalida ou refina uma anterior sobre o
mesmo alvo. Registre o novo com relação `supersedes` apontando para o `id` que ele
substitui (o novo é do **mesmo tipo** do antigo) ou `revokes`, para anular sem
sucessor. O substituído deixa de ser vigente; a `query` só o devolve com
`includeNonCurrent: true`.

O servidor recusa a bifurcação **na escrita**: `supersedes` ou `revokes` sobre um
registro que já não é vigente dá `FORK_REJECTED`, com `details[0].current` = a
versão atual da linhagem (ou nulo, se foi revogada). Não existe gate de
"bifurcação" nem como "cancelar" um registro já gravado: o log é append-only, e
anular é um `revokes`. Para seguir a linhagem, `query` com `includeNonCurrent:
true` e `relatedTo` = o `id`; cada registro traz `in` e `out`.

Substituir e revogar só valem **dentro do processo** (`cross-process-currency`).

## 2. Entre fases — leitura com o alcance certo

Cruzar informação entre fases diferentes não é uma tool especial: é uma leitura
que enxerga mais de um processo.

- Para ler **uma** fase, `query` com o `process` dela (o flow map traduz "fase X"
  para o nome do processo) — nunca o `process` da fase corrente por padrão.
- Para ler **várias** de uma vez, `query` com `scope: "project"`: lê e verifica todos
  os processos do projeto, e `in`, `out.current` e `needsReview` passam a ver as
  relações entre processos. O alcance padrão (`process`) não vê relação vinda de
  outro processo e **não avisa**.
- Para **ligar** um registro a outro de outra fase, use qualquer relação menos
  `supersedes` e `revokes`: `supports`, `contradicts`, `answers`, `derivesFrom`,
  `complements`, `reopens` aceitam o `id` de outro processo. `supports` exige que o
  destino seja **vigente**; para citar um registro histórico, `derivesFrom` ou
  `complements`.

Exemplo: a fase de revisão quer saber se a de planejamento já decidiu algo sobre um
alvo. Chame `query({project, process: <processo da fase de planejamento>,
targetPrefix})`, ou `scope: "project"` com o mesmo `targetPrefix`. Um gate cuja
evidência vem de outra fase declara `scope: "project"` na pergunta.

## 3. Lacunas — gate por fase

Uma lacuna é um critério que o processo não prova sozinho: sem gate, nada barra um
plano sem aprovação ou um desvio sem resposta. Se uma fase do flow map declara um
gate (`gate` no frontmatter), essa é a forma combinada de fechar a lacuna: o gate é
definido por `define_gate` (feito pela `hexlog-setup`, não por esta skill) como uma
lista de perguntas sobre os registros **vigentes**, e se avalia com `evaluate_gate`
informando o nome em `gate`. A evidência vem do servidor, nunca do agente.

| Pergunta (`kind`) | Passa quando |
|---|---|
| `approved` (`of`, `by?`) | há ao menos um registro vigente em `of`, todos têm um `supports` de um registro vigente (que case `by`) e nenhum `contradicts` vigente |
| `occurred` (`select`, `min?`) | há ao menos `min` (padrão 1) registros vigentes em `select` |
| `no_pending` (`pending`, `resolvedBy`) | todo registro vigente em `pending` tem uma relação de entrada vigente do `kind` dado (e de um tipo em `from`, se dado) |
| `no_open_contradiction` (`of?`) | nenhum registro vigente em `of` tem `contradicts` vigente de entrada |

Um seletor é `{ type?, targetPrefix?, where? }`, com `where` = igualdade em campos
de primeiro nível de `data`, só valor escalar. Uma comparação ("revisão ≥ 2") se
modela com um campo booleano do tipo (`where: { isRevision: true }`), nunca com
operador. Recusado e pendente se distinguem pela evidência: há `contradictions`
versus apoio ausente (`unsupported`).

Sem gate declarado para a fase, não invente um cruzamento — a lacuna fica sem
prova formal, e isso é uma decisão aceita, não um bug.
