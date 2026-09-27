# Mineração das sessões do `personal-auth`: atrito no uso do hexlog (2026-09-14 a 2026-09-20)

Levantamento das sessões do Claude Code no projeto `personal-auth` (`~/personal/personal-auth`) entre 2026-09-14 e 2026-09-20, olhando o uso real das tools `mcp__hexlog__*` a partir do log gravado pelo servidor hexlog que esse projeto consome.

## Resumo

- 40 chamadas em 3 sessões-mãe: `register` 17, `list` 10, `state` 3, `create_process` 3, `register_gate` 2, `register_vocabulary` 2, `events` 2, `evaluate_gate` 1.
- 5 erros na janela (12,5% das 40 chamadas; 4 em `register`, 1 em `list`), todos corrigidos por retry ou por virada de tool na mesma sessão.
- O atrito concentra em `register`: a description não mostra a forma real de `count`/`decisions[]` (H-01), e força reconstruir manualmente `project:process:type` no `id` apesar dos dois já chegarem como parâmetros próprios (H-02, reforça #8). Secundariamente, `state` reenvia o histórico de avisos inteiro sem corte incremental (H-03) e `list` confunde `type` reservado (`verdict`/`milestone`) com custom type registrável (H-04).
- Do harness: 22 das 40 chamadas (55%, 69% dos bytes) saem de `continuation:clear` — nenhuma skill ativa, nenhum gatilho do turno — e concentram 4 dos 5 erros da janela; é o agente operando o hexlog de memória/via CLAUDE.md do projeto-fonte, fora do fluxo guiado por skill. Duas ambiguidades do CLAUDE.md do `personal-auth` custaram uma rodada dupla de registro (W-01) e um processo órfão (W-03). Detalhe em [Harness do personal-auth](#harness-do-personal-auth).

## Método

1. O script separa as 40 chamadas hexlog da janela em buckets por sinal (`bucket:*`, com contagem de sessões-mãe em `bucket_parents:*`) e traz o prior art da rodada (#6–#21, P6–P9, e os rascunhos da rodada `personal-hextelemetry`: H-01, H-02, H-03, H-07, H-09, H-10, publicados depois desta rodada como #28, #23, #24, #25, #26, #27) para não ser re-reportado.
2. Sete lanes leram um bucket cada: register-gate, state-cost, events-orientation, events-cost, list-misc, user, harness. Nenhuma lane foi pulada e nenhuma ficou perdida nesta rodada (`lost: []`, `skipped: []`) — os 5 sinais tiveram lane cobrindo o bucket correspondente, com o sinal (d) lido por composição/redundância de payload em vez de tamanho bruto (nenhuma resposta passou de 10k chars nesta janela — ver Cobertura dos sinais).
3. Consolidação: dedup contra o prior art, aplicação do critério de confiança, `harnessRaw` fechando a tabela de atribuição por origem.
4. Verificação: contagens de cada achado batem com `occurrences`/`parent_sessions` dos buckets de origem antes de fechar o relatório.

**Confiança:** `high` = 3 ou mais sessões-mãe distintas e causa localizada em `arquivo:linha`; `medium` = 2 sessões, ou 3+ com causa só inferida; `low` = 1 sessão-mãe.

## Cobertura dos sinais

| Sinal | Definição | Resultado na janela |
|---|---|---|
| (a) erro | `is_error` ou objeto top-level com `code`+`message` | 5 chamadas em 2 sessões-mãe (dd3c0a8d, 2d998a65): 4 em `register` (count/note em dd3c0a8d + decisions[] em 2d998a65 → H-01; `origin`/`trace` ausentes ao registrar um Verdict em 2d998a65 → H-01; TYPE_NOT_PINNED em 2d998a65 → W-02), 1 em `list` (INVALID_INPUT → H-04) |
| (b) retry | mesma tool rechamada em até 3 chamadas depois de (a), com args diferentes | embutido nos mesmos episódios de (a): H-01 corrigido no retry em ~2,7s; W-02 corrigido em ~3,3s; a falha de `list` (H-04) não teve retry direto de `list` — o agente foi para `state()` 0,5s depois |
| (c) orientação | leitura repetida sobre o mesmo processo/target sem escrita depois | 2 candidatas (`c_orient_list` 1, `c_orient_state` 1), ambas descartadas — `c_orient_list` é a mesma chamada de `a_error_list` por adjacência posicional, `c_orient_state` não configura leitura repetida real; `events-orientation` não teve nenhuma candidata (só 2 chamadas de `events` na janela inteira, ver Descartados) |
| (d) custo | resposta acima de 10k chars **e** redundante | 0 respostas passaram do limiar bruto de 10k chars; os 2 achados marcados (d) usam a leitura por composição que o briefing pede em vez do limiar bruto — H-02: reconstrução manual do `id` em 17/17 chamadas de `register` (100%); H-03: 50,4% do payload da 2ª chamada de `state` é aviso já lido 10min antes |
| (e) correção do usuário | mensagem real do usuário corrigindo o agente ou reclamando do hexlog | 4 mensagens em 3 sessões-mãe; 1 virou achado (W-03: nome de `process` por escopo, não versão); as outras 3 são pedido neutro de kickoff ou decisão de escopo pré-execução (ver Descartados) |

## Achados do hexlog

### `register`

#### H-01 — Milestone.count e decisions[] rejeitados por shape errado, description nunca mostra o formato real · `medium`
- sinal: (a)+(b) · frequência: 3 ocorrências (1 INVALID_EVENT com 2 causas simultâneas em dd3c0a8d — `count` esperado `{field,value}` recebido `number`, chave extra `note` rejeitada por `strictObject`; 1 ocorrência análoga em 2d998a65 com `decisions[]` em shape errado — string em vez de `{action,...}`; 1 ocorrência em 2d998a65 às 22:24:07Z com `origin`/`trace` ausentes ao registrar um Verdict — a description trata os dois como aceitos sem marcar como obrigatórios, ao contrário do `trace` opcional do Milestone) · sessões-mãe: 2 (dd3c0a8d, 2d998a65)
- citação: > {"code":"INVALID_EVENT","message":"event data failed validation","details":[{"path":"/data/count","code":"invalid_type","message":"Invalid input: expected object, received number"},{"path":"/data","code":"unrecognized_keys","message":"Unrecognized key: \"note\""}]} (dd3c0a8d-808e-4cad-883d-74f251bf7226, 2026-09-19T19:33:19.220Z)
- causa: `src/events.ts:56` define `count: z.strictObject({field: Label, value: z.number()}).optional()`; a única pista visível ao agente é a descrição solta em `src/event-tools.ts:73` ("Milestone accepts ... count, ..."), sem citar o shape `{field,value}` nem que chaves extras são rejeitadas. `decisions[].action` é vocabulário fechado (`event-tools.ts:523-530`) e também não tem shape descrito; `skills/hexlog/SKILL.md` (linhas 65-96) nunca usa o campo `count` no Milestone de exemplo; `VerdictData` (`src/events.ts:66-75`) exige `origin` e `trace` como `Text` obrigatório, e a description (`event-tools.ts:73-76`) não distingue isso do `trace` opcional do Milestone.
- melhoria: a description de `register` passa a documentar inline `count:{field,value}` e `decisions[]:[{action:<vocabulário fechado>,...}]`, do mesmo jeito que já documenta `target`; o exemplo mínimo do SKILL.md ganha um Milestone com `count` preenchido e cita que chaves extras (como `note`) são sempre rejeitadas.
- reforça: #28 (H-01 de `personal-hextelemetry`)

#### H-02 — register obriga reconstruir manualmente project:process:type no id, apesar dos dois já virem como parâmetros próprios · `medium`
- sinal: (d) · frequência: 17/17 chamadas de `register` na janela (100%) reconstroem `id` como `{project}:{process}:{type}`, retipando dois valores que já chegam como parâmetros separados da mesma chamada · sessões-mãe: 2 (dd3c0a8d, 2d998a65)
- citação: > {"project": "personal-auth", "process": "release-hextelemetry", "id": "personal-auth:release-hextelemetry:milestone", "agent": "main", "data": {"milestoneType": "release-opened", "target": "hex:target:release-hextelemetry"}} (2d998a65-e856-4e21-9078-5b3bb726a62e, 2026-09-20T22:00:50.941Z)
- causa: `src/event-tools.ts:69-71` — `id` só aceita o prefixo completo `{project}:{process}:{type}` (ou id completo com uuid); não há como passar `type` isolado mesmo com `project`/`process` já declarados nos parâmetros do `register`.
- melhoria: `register` passa a aceitar `type` como parâmetro próprio (como `list` já faz) e monta o prefixo do `id` no servidor a partir de `project`+`process`+`type` já recebidos separadamente.
- reforça: #8

### `state`

#### H-03 — state reenvia o histórico completo de warnings sem corte incremental, agente lê como "piorando" · `low`
- sinal: (d) · frequência: 2ª chamada = 50,4% do payload (1725/3422 bytes) é a seção `warnings`; 5 dos 10 avisos são bit-a-bit idênticos aos 5 devolvidos pela 1ª chamada 10min antes; resposta cresceu 1271→3409 bytes (+168%) em 2 chamadas na mesma sessão só pelo reenvio do que já tinha sido lido · sessões-mãe: 1 (2d998a65)
- citação: > Piorou: agora são 10 avisos, e o `adopt` também não é o valor certo. Procuro o vocabulário `core` 1.1 no código do hexlog, sem registrar mais nada. (2d998a65-e856-4e21-9078-5b3bb726a62e, 2026-09-20T22:34:31.277Z)
- causa: `src/state.ts:297-317` (`collectWarnings`) percorre o log inteiro (deduplicated) a cada chamada de `state`; não há `since`/`ifLogThroughAtLeast` para pedir só o delta desde o último `logThrough` já lido.
- melhoria: mesmo pedido de #25 (H-07 de `personal-hextelemetry`) — `state` passa a aceitar `since`/`ifLogThroughAtLeast` para devolver só avisos (e demais seções) novos desde o corte informado, em vez de reprojetar o histórico inteiro a cada chamada.
- reforça: #25 (H-07 de `personal-hextelemetry`)

### `list`

#### H-04 — list com type=verdict/milestone sem process confunde kind embutido do protocolo com custom type registrável · `low`
- sinal: (a) · frequência: 1 chamada, 1 sessão-mãe; o `INVALID_INPUT` consumiu o turno e o agente abandonou a busca pelo vocabulário, indo direto para `state()` sem o que queria · sessões-mãe: 1 (2d998a65)
- citação: > O hexlog avisou que `adopt` também está fora do vocabulário, então o palpite anterior estava errado. Antes de registrar mais qualquer coisa, descubro os valores aceitos. (2d998a65-e856-4e21-9078-5b3bb726a62e, 2026-09-20T22:34:26.072Z)
- causa: `src/definition-tools.ts:266-268` (guarda `requires_process`) e `:311-314` (`TYPE_NOT_FOUND`) — nenhum dos dois avisa que `verdict`/`milestone` são kinds embutidos do protocolo, não custom types registráveis via `register_type`/fixáveis por processo.
- melhoria: quando `type ∈ {milestone, verdict}`, `list` passa a devolver mensagem distinta apontando para `list({project,process}).vocabulary` (Milestone) ou para os campos fixos do Verdict, em vez do genérico "type requires process"/"not fixed in process".
- reforça: #27 (H-10 de `personal-hextelemetry`)

## Harness do `personal-auth`

Tabela de atribuição por origem das 40 chamadas (`calls.jsonl`, 3 sessões-mãe, 33.242 bytes totais — nenhuma chamada tem `session != parent`, ou seja 0% desta janela foi disparada por subagente; toda a carga é da sessão principal):

| Origem | Chamadas | Sessões-mãe | Bytes totais | Bytes/chamada (média) | Erros |
|---|---|---|---|---|---|
| `skill:hexlog` | 9 | 1 (dd3c0a8d, bootstrap 19/09) | 4.940 | 549 | 1 (INVALID_EVENT, count/note → H-01) |
| `skill:grilling` | 4 | 1 (8167c221) | 3.409 | 852 | 0 |
| `continuation:oh-my-claudecode:omc-reference` | 2 | 1 (8167c221, mesma sessão, após grilling terminar) | 389 | 195 | 0 |
| `continuation:clear` (sem gatilho/skill ativa) | 22 | 1 (2d998a65) | 22.946 | 1.043 | 4 (TYPE_NOT_PINNED → W-02; 2× INVALID_EVENT (decisions[] em shape errado; `origin`/`trace` ausentes no Verdict) → H-01; INVALID_INPUT → H-04) |
| `user-asked` | 3 | 1 (2d998a65, mesma sessão) | 1.558 | 519 | 0 |

`continuation:clear` — nenhuma skill carregada, nenhum gatilho explícito do usuário naquele turno — é 55% das chamadas e 69% dos bytes desta janela, e concentra 4 dos 5 erros. Não é custo de nenhuma skill do projeto-fonte: é o agente operando o hexlog de memória/via CLAUDE.md do projeto, fora do fluxo guiado por skill. As duas skills que de fato chamam hexlog aqui (`hexlog`, `grilling`) são baratas (549B e 852B/chamada) e quase sem erro — `hexlog` erra 1/9 (H-01), `grilling` não erra.

#### W-01 — CLAUDE.md do personal-auth confunde Verdict.result com decisions[].action, e o warning de vocabulário não lista os termos aceitos
- confiança: `low` · 1 sessão-mãe (2d998a65)
- reforça: #23 (H-02 de `personal-hextelemetry`)
- 5 Verdicts registrados com `result:"alta"` (5 avisos, ~4.861B) e re-registrados minutos depois com `result:"adopt"` (mais 5 avisos, ~5.727B) — 10 chamadas `register`/~10.588B de conteúdo duplicado para as mesmas 5 claims, em ~10min (22:24–22:34); mais ~3.770B de `list`+`events` gastos noutro projeto só para descobrir o formato de Verdict antes de tentar de novo.
- citação: > Registrei 5 Verdicts em `release-hextelemetry`: chain ok, 0 orphans, 5 avisos. Usei `result: "alta"` em vez de `adopt`. Isso não bloqueia os gates. (2d998a65-e856-4e21-9078-5b3bb726a62e, 2026-09-20T22:24:57.956Z)
- causa: harness — `personal-auth/CLAUDE.md:127` (commit f26bb4b) diz "a Verdict with adopt/reject/defer for a design decision" — essa é a vocabulária fechada de `decisions[].action` (`event-tools.ts:545`), não a de `Verdict.result` (campo aberto, `event-tools.ts:567`; vocabulário real registrado em `register_vocabulary` no dia anterior é `confirmed`/`refuted`/`inconclusive`/`outdated`). Hexlog — `src/event-tools.ts:559-570` (`unknownResultWarning`) monta `details:{field,value}` sem `allowed`; a função irmã `ensureVocabulary` (linha 553) já calcula `allowed: allowedTerms(vocabulary, field)` para o mesmo Vocabulary e não é reaproveitada aqui, por isso o warning nunca corrige o agente de cara.
- ajuste: harness — reescrever `CLAUDE.md:127` do `personal-auth` separando as duas vocabulárias com um exemplo de cada (`Verdict.result` vs `decisions[].action`). Hexlog — incluir `allowed: allowedTerms(vocabulary, 'result')` em `unknownResultWarning`, para o aviso não-bloqueante devolver de cara os termos aceitos.

#### W-02 — segmento de tipo do id confundido com milestoneType (TYPE_NOT_PINNED), e CLAUDE.md não diz que o id sempre termina em :milestone/:verdict
- confiança: `low` · 1 sessão-mãe (2d998a65)
- reforça: #8
- 1 `TYPE_NOT_PINNED` corrigido no retry seguinte (3,3s depois), trocando o segmento final do `id` de "release-opened" para "milestone" e movendo o mesmo valor para `data.milestoneType`; única abertura de processo desta janela (1/1 bateu na confusão).
- citação: > Branch e worktree `release/0.0.2` criados. Agora abro o process no hexlog. (2d998a65-e856-4e21-9078-5b3bb726a62e, 2026-09-20T21:54:23.292Z)
- causa: hexlog — `src/event-tools.ts:420-422` — o segmento de tipo do `id` só aceita `milestone`, `verdict` ou um custom type já fixado; o agente usou o valor semântico do evento ("release-opened") nesse segmento. Harness — `personal-auth/CLAUDE.md:124` (commit f26bb4b) lista valores de `milestoneType` na mesma célula que dispara o `create_process`, sem nunca dizer que o `id` termina sempre em `:milestone` (ou `:verdict`/tipo custom).
- ajuste: hexlog — já coberto por #8 (aceitar `type` como parâmetro próprio e montar o prefixo do `id` no servidor). Harness — renomear a coluna do `CLAUDE.md:122` para "milestoneType" e anotar que o `id` sempre termina em `:milestone` ou `:verdict`.

#### W-03 — create_process é imutável e a skill não orienta nomear process por escopo em fluxos de release, agente recria o processo do zero e deixa um órfão
- confiança: `low` · 1 sessão-mãe (2d998a65)
- 1 processo órfão (`release-0-0-2`, criado 21:54:23Z, nunca mais referenciado) + recriação completa em `release-hextelemetry` (`create_process` + register milestone) ~6min depois (22:00:48Z/22:00:50Z); sem delete/rename disponível, o próprio agente registra que "o process release-0-0-2 permanece no hexlog".
- citação: > 2; se a doc disser o contrario ajuste, vamos definir o release com um nome no hexlog "release hextelemetry", não pela versão a versão será descoberta depois só dependendo da ordem de entrega (2d998a65-e856-4e21-9078-5b3bb726a62e, 2026-09-20T22:00:10.454Z)
- causa: `skills/hexlog/SKILL.md:18` documenta que `create_process` fixa um snapshot e "não existe atualizar", mas não orienta como escolher o nome de `process` para fluxos de release cuja versão só se decide na entrega; o agente default para nome versionado (`release-0-0-2`) e teve que descartá-lo ao ser corrigido pelo usuário.
- ajuste: acrescentar nota na skill — nomear `process` de release pelo escopo/feature entregue, não pela versão ainda não fechada (a versão pode entrar depois como decision/evidence de um milestone); evita processo órfão dado que `create_process` é imutável e sem rename.

## Prior art

- #28 (H-01 de `personal-hextelemetry`) ganha evidência de produção com H-01 deste relatório: mesma causa de documentação (`count`/`decisions[]` sem shape na description), agora em `personal-auth`, 2 sessões-mãe distintas.
- #8 ganha evidência de produção com H-02 e W-02: 17/17 chamadas de `register` reconstroem manualmente `id` a partir de `project`+`process`+`type` já recebidos separados (H-02), e a mesma limitação gerou 1 `TYPE_NOT_PINNED` ao abrir processo (W-02).
- #23 (H-02 de `personal-hextelemetry`) ganha evidência de produção com W-01: além do agente confundir o vocabulário fechado de `decisions[].action`, o CLAUDE.md do `personal-auth` mistura essa vocabulária com a de `Verdict.result` (campo aberto), gerando 5 Verdicts registrados em duplicado.
- #25 (H-07 de `personal-hextelemetry`) ganha evidência de produção com H-03: `state` reenviando o histórico de warnings inteiro sem corte incremental, agora com o agente lendo a piora como regressão.
- #27 (H-10 de `personal-hextelemetry`) ganha evidência de produção com H-04: `list` com `type` reservado (`verdict`) sem `process` devolve o mesmo `INVALID_INPUT` genérico, sem apontar o caminho certo (`vocabulary`/campos fixos do Verdict).
- #6, #7, #9, #10, #11, #12, #13, #14, #15, #16, #17, #18, #19, #20, #21, P6, P7, P8, P9, e #24/#26 (H-03/H-09 de `personal-hextelemetry`) sem evidência nova nesta janela.

## Descartados

- `evaluate_gate`: só 1 chamada em toda a janela (gate embutido "chain-intact", sucesso) — sem repetição possível, sem atrito.
- Tamanho de payload de `register`: 300–1250 chars, nunca >10k — não configura sinal (d) por tamanho bruto; a composição (id reconstruído manualmente) já é o achado H-02, sem evidência de custo adicional de tamanho.
- `state`: escopo tinha só 3 chamadas na janela (1 sessão-mãe com sinal real — H-03 —, 1 leitura vazia de `skill:grilling` sem atrito); nenhuma resposta passou de 10k chars; description do tool bate com a implementação (`SECTION_ITEMS_CAP`, `attachVerdictData`) — sem gap description-vs-código. As 2 respostas observadas não trazem `targets`/`totals.targets` (presentes incondicionalmente no código atual desde commit 4ef7370) — indício de servidor rodando versão mais antiga que main, não reportado como achado de código por falta de confirmação da versão realmente servida.
- `events-orientation`: só 2 chamadas de `events` em toda a janela (população total, não amostra; nenhum bucket dedicado existe), ambas leitura-antes-de-escrever legítima e single-shot (sem paginação, enumeração de targets irmãos, polling ou releitura); o padrão de fundo (aprender o shape de Milestone/Verdict lendo um evento existente) já está coberto pelo prior art #28/#23/#24 (H-01/H-02/H-03 de `personal-hextelemetry`) (`personal-hextelemetry`).
- `events-cost`: mesmas 2 chamadas de `events` (985 e 1610 chars), nenhuma >10k, sem `persisted:true`, sem bucket `d_cost` em `stats.json`; ambos os payloads foram citados/usados explicitamente pelo agente depois, sem metadado morto que pese custo.
- `list-misc`: `c_orient_list` (1 item) é a mesma chamada de `a_error_list` (adjacência posicional, não uma segunda ocorrência real) — já contabilizada em H-04, não em dobro; a sequência `list()`→`list(project)`→`list(project,process)` em 3 sessões é orientação instruída pelo próprio SKILL.md (linha 109: "a prova real de que o servidor está vivo é chamar list sem parâmetros"), não a description do tool sugerindo pré-requisito — insuficiente para reforçar #21; `register_gate` (`local-gate`, `decisions-justified`) foi registrado mas nenhum `evaluate_gate` na janela os exercita ainda (setup adiantado, não atrito); `create_process` e `register_vocabulary` tiveram seus resultados efetivamente consumidos (`TYPE_NOT_PINNED` e `VOCABULARY_VIOLATED` confirmam o snapshot sendo checado); P9 (prefixo `hex:target:`) usado corretamente em toda a janela, sem evidência nova de atrito.
- `user`: das 4 mensagens do bucket `e_user` (3 sessões-mãe), só 1 virou achado (W-03, `create_process`/naming); as outras 3 são pedidos neutros de kickoff ou decisão de escopo do próprio usuário durante um design Q&A, não correção de erro nem reclamação do hexlog; varredura extra ao redor dos 2 erros autocorrigidos em 2d998a65 (`TYPE_NOT_PINNED`, `INVALID_EVENT`) não achou intervenção adicional do usuário fora do `e_user`.
- Padrão descartado por ser legítimo: as 13 chamadas `skill:hexlog`+`skill:grilling` abrem sempre com `list()` sem args → `list(project)` → `list(project,process)`, 3 leituras de especificidade crescente. Bate com `SKILL.md:109` ("a prova real de que o servidor está vivo é chamar list sem parâmetros") e cada sequência é seguida de escrita real (`register_vocabulary`/`register_gate`/`create_process`) ou é diagnóstico pré-grill — não conta como atrito (c) nem custo (d): tamanhos entre 152B e 1398B, nenhum passa de 10k.
- A chamada `list({project,type:"verdict"})` às 22:34:26 que falha com `INVALID_INPUT` ("type requires process") já é a evidência de H-04 — não abre achado duplicado na lane de harness.
- Harness (tabela de atribuição, 40 chamadas/3 sessões-mãe/33.242B): 0% da janela foi disparada por subagente; `continuation:clear` (sem skill ativa) concentra 55% das chamadas, 69% dos bytes e 4 dos 5 erros — não é custo de nenhuma skill do projeto, é o agente operando de memória fora do fluxo guiado por skill; `skill:hexlog`/`skill:grilling` são baratas e quase sem erro (`hexlog` erra 1/9, já em H-01; `grilling` não erra).
