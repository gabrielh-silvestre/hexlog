# Regras de cruzamento

Três regras de cruzamento, mais a herança de relações pela linhagem. Todas são combinações de `register`, `query`, `evaluate_gate` e `verify_chain`, guiadas pelo modelo do projeto (tipos de fase, unidade e gate), que vem da skill do projeto: nenhuma pede tool nova. Carregue este arquivo ao decidir se um registro substitui outro, ao cruzar fases ou unidades, ao transformar uma lacuna do processo em pergunta de gate ou ao ler relações de um registro superado em processo com herança. Os códigos de erro de relação e o alcance da leitura (`scope`) estão no `SKILL.md`, seções "Regras de relação que o servidor impõe" e "Alcance da leitura".

## 1. Mesma unidade: conflito ou superado

Dois registros da mesma unidade (mesmo `process`: as fases de uma unidade são tipos e targets do mesmo processo) podem entrar em conflito: uma decisão nova invalida ou refina uma anterior sobre o mesmo target. Registre o novo com relação `supersedes` apontando para o `id` que ele substitui (o novo é do **mesmo tipo** do antigo) ou `revokes`, para anular sem sucessor. O substituído deixa de ser vigente; a `query` só o devolve com `includeNonCurrent: true`.

O servidor recusa a bifurcação **na escrita** (`FORK_REJECTED`, quando `supersedes` ou `revokes` aponta para um registro que já deixou de ser vigente). O log é append-only, então a bifurcação não vira pergunta de gate e um registro gravado só se anula por `revokes`. Para seguir a linhagem, `query` com `includeNonCurrent: true` e `relatedTo` = o `id`. O `relatedTo` devolve só os vizinhos diretos, por qualquer relação, de entrada ou de saída, sem o próprio `id`; com `relations: "full"`, cada registro traz `in` e `out`, e a cadeia se percorre por eles, um salto por vez.

Substituir e revogar valem **dentro do processo** (`cross-process-currency`), e o `supersedes` pede o **mesmo target** (`target-mismatch`): para mudar um fato de target, grave um registro só no target certo, com `revokes` e `derivesFrom` para o antigo.

### Herança de relações pela linhagem

O processo **criado depois** da herança nasce com ela (`create_process` devolve `lineageInheritance: true`); o anterior segue com a cascata manual (regravar `supports`, `answers` e `derivesFrom` na versão nova). Em processo com herança, superar uma unidade dispensa regravar as relações só para carregá-las: a leitura as estende à versão atual, sem gravar nada.

- `supports` recebido pela versão antiga vale para a atual (o destino sobe). O apoio de uma revisão **superada** morre com ela.
- `answers`, `derivesFrom`, `complements` e `reopens` gravados na versão antiga valem para a atual (a origem sobe); o destino fica como foi gravado.
- `contradicts`, `supersedes` e `revokes` ficam na versão onde foram gravados.
- Leia com `relations: "full"`: `inheritedIn` e `inheritedOut` (em `counts`, os mapas `inheritedInCounts` e `inheritedOutCounts`) trazem cada relação herdada com `origin` (`from`, `to`), a aresta gravada de onde ela vem. O `in`/`out` direto lista só as gravadas, e `needsReview` ignora o `supports` herdado.
- **Cortar:** grave um `contradicts` entre a linhagem de uma ponta e a da outra (qualquer direção). Ele tira a herança desse par, volta o `needsReview` e conta como contradição de verdade para `approved` e `no_open_contradiction`. Só o `contradicts` vigente corta: superar ou revogar o registro que o grava religa a herança.
- No gate, a pergunta `approved` ou `no_pending` conta o herdado só com `inherit: true`, e o que conta apenas por herança vem em `evidence.inherited`. O gate sem a opção avalia como antes.

## 2. Entre fases e entre unidades: leitura com o alcance certo

As fases de uma unidade vivem no mesmo processo, então cruzar fases da **mesma unidade** é uma `query` comum do `process` dela, filtrada por `type` ou `targetPrefix`. Cruzar **unidades** diferentes pede uma leitura que enxergue mais de um processo, e ela dispensa tool especial.

- Para ler **uma** fase da mesma unidade, `query` com o `process` da unidade e o `type` (ou o `targetPrefix`) da fase.
- Para ler **várias** unidades de uma vez, `query` com `scope: "project"`: lê e verifica todos os processos do projeto, e as relações entre processos passam a aparecer (o alcance padrão as deixa invisíveis, sem aviso; ver "Alcance da leitura" no `SKILL.md`).
- Para **ligar** um registro a outro de outra unidade, use qualquer relação exceto `supersedes` e `revokes`: `supports`, `contradicts`, `answers`, `derivesFrom`, `complements`, `reopens` aceitam o `id` de outro processo. `supports` pede destino **vigente**; para citar um registro histórico, `derivesFrom` ou `complements`.

Exemplo: a fase de revisão quer saber se a de planejamento da mesma unidade já decidiu algo sobre um target. Chame `query({project, process: <processo da unidade>, type: <tipo de planejamento>, targetPrefix})`. Para uma decisão de outra unidade, use `scope: "project"` com o mesmo `targetPrefix`. Um gate cuja evidência vem de outra unidade declara `scope: "project"` na pergunta.

## 3. Lacunas: gate da unidade

Uma lacuna é um critério que o processo não prova sozinho: sem gate, nada barra um plano sem aprovação ou um desvio sem resposta. Se o modelo do projeto declara um gate, essa é a forma combinada de fechar a lacuna: o gate é definido por `define_gate` (feito pela `hexlog-setup`, fora desta skill) como uma lista de perguntas sobre os registros **vigentes**, e se avalia com `evaluate_gate` informando o nome em `gate`. A evidência vem do servidor.

| Pergunta (`kind`) | Passa quando |
|---|---|
| `approved` (`of`, `by?`) | há ao menos um registro vigente em `of`, todos têm um `supports` de um registro vigente (que case `by`) e nenhum `contradicts` vigente |
| `occurred` (`select`, `min?`) | há ao menos `min` (padrão 1) registros vigentes em `select` |
| `no_pending` (`pending`, `resolvedBy`) | todo registro vigente em `pending` tem uma relação de entrada vigente do `kind` dado (e de um tipo em `from`, se dado) |
| `no_open_contradiction` (`of?`) | todo registro vigente em `of` está livre de `contradicts` vigente de entrada |

Um seletor é `{ type?, targetPrefix?, where? }`, com `where` = igualdade em campos de primeiro nível de `data`, só valor escalar. Uma comparação ("revisão ≥ 2") se modela com um campo booleano do tipo (`where: { isRevision: true }`), sem operador. Recusado e pendente se distinguem pela evidência: `contradictions` aponta recusa, `unsupported` aponta apoio ausente. Os modos da evidência (`failing`, `counts`, `full`) estão na seção "Leitura enxuta" do `SKILL.md`. Para contar também o apoio ou a resolução herdados da versão superada, `approved` e `no_pending` aceitam `inherit: true` (ver a herança acima).

Sem gate declarado no modelo, a lacuna fica sem prova formal, e isso é uma decisão aceita, sem cruzamento inventado.
