# Mineração das sessões do `hextelemetry`: atrito no uso do hexlog (2026-09-14 a 2026-09-20)

Levantamento das sessões do Claude Code no projeto `hextelemetry` (`~/personal/hextelemetry`) entre 2026-09-14 e 2026-09-20, olhando o uso real das tools `mcp__hexlog__*` a partir do log gravado pelo servidor hexlog que esse projeto consome.

## Resumo

- 306 chamadas em 6 sessões-mãe: `register` 125, `events` 84, `state` 36, `list` 27, `evaluate_gate` 16, `register_gate` 13, `create_process` 3, `register_vocabulary` 2.
- 12 erros na janela (10 em `register`, 2 em `list`), todos corrigidos por retry na mesma sessão.
- O atrito de forma concentra em `register`: a description não diz a forma de `count`/`decisions` (H-01), nem que `action` é vocabulário fechado (H-02), nem que `source` é string única diferente de `evidence` (H-03).
- `evaluate_gate` continua um gate por chamada (H-04, reforça #9); `events` continua sem lote de targets (H-09) e o cap de 24k chars trunca sem dizer o motivo, e cortar só `prevHash` recupera pouco (H-08, reforça #16); `state` promete `targets` mas o servidor MCP rodava build travado na janela inteira (H-06, reforça #18) e não tem "mudou desde X" (H-07).
- Do harness: 49 chamadas (16%) somam 63,3% de todos os bytes trocados — releitura do mesmo processo entre sessões-irmãs sem cache (W-01) — e um episódio de registro tardio do ralplan, corrigido só depois da pergunta do usuário (W-02). Detalhe em [Harness do hextelemetry](#harness-do-hextelemetry).

## Método

1. O script separa as 306 chamadas hexlog da janela em buckets por sinal (`bucket:*`, com contagem de sessões-mãe em `bucket_parents:*`) e traz o prior art da rodada (#6–#21, P6–P9) para não ser re-reportado.
2. Sete lanes leram um bucket cada: register-gate, state-cost, events-orientation, events-cost, list-misc, user, harness. Nenhuma lane foi pulada e nenhuma ficou perdida nesta rodada (`lost: []`, `skipped: []`) — os 5 sinais tiveram lane cobrindo o bucket correspondente.
3. Consolidação: dedup contra o prior art, aplicação do critério de confiança, harnessRaw fechando a tabela de atribuição por origem e o custo por execução das skills.
4. Verificação: contagens de cada achado batem com `occurrences`/`parent_sessions` dos buckets de origem antes de fechar o relatório.

**Confiança:** `high` = 3 ou mais sessões-mãe distintas e causa localizada em `arquivo:linha`; `medium` = 2 sessões, ou 3+ com causa só inferida; `low` = 1 sessão-mãe.

## Cobertura dos sinais

| Sinal | Definição | Resultado na janela |
|---|---|---|
| (a) erro | `is_error` ou objeto top-level com `code`+`message` | 12: 10 em `register` (H-01 3×, H-02 2×, H-03 5×), 2 em `list` (H-10, 1 sessão-mãe) |
| (b) retry | mesma tool rechamada em até 3 chamadas depois de (a), com args diferentes | embutido nos mesmos episódios de (a): todo erro de `register`/`list` acima foi seguido de retry corrigido na mesma sessão |
| (c) orientação | leitura repetida sobre o mesmo processo/target sem escrita depois | 25 candidatas (`c_orient_events` 21, `c_orient_list` 2, `c_orient_state` 2); virou achado só em `events` (H-09, bursts de targets irmãos); `list`/`state` descartados como fluxo esperado (ver Descartados) |
| (d) custo | resposta acima de 10k chars **e** redundante | heurística estreita do script achou só 2 (`d_cost_events` 1, `d_cost_state` 1); recontagem pelo limiar bruto >10k (`d_big`, 49 = 35 `events` + 14 `state`) sustenta H-04, H-06, H-07, H-08 e a lane de harness (W-01) |
| (e) correção do usuário | mensagem real do usuário corrigindo o agente ou reclamando do hexlog | 6 candidatas em 3 sessões-mãe; 1 correção real (W-02: "tu não ta anotando nada do plan no hexlog?"), as demais são pedido neutro ou decisão de escopo pré-execução (ver Descartados) |

## Achados do hexlog

### `register`

#### H-01 — Milestone.count e decisions[] sem a forma documentada na description · `high`
- sinal: (a)+(b) · frequência: 3 falhas `INVALID_EVENT` em 3 sessões-mãe distintas · sessões-mãe: 3 (81840bd1, b671aee6, 3c8ebf3e)
- citação: > Vou registrar isso agora, começando pelo marco da iteração 1 para descobrir o formato de `decisions`. (81840bd1-247c-476a-8d6a-17a169709dd5, 2026-09-18T22:15:22.344Z)
- causa: `src/events.ts:53-64` exige `count: {field,value}` e `decisions[].{item,action,text}`, mas `src/event-tools.ts:73-74` só lista os nomes dos campos, sem forma alguma.
- melhoria: em `event-tools.ts:73-74`, documentar a forma de `count` e de cada item de `decisions[]`, para eliminar a rodada de tentativa-e-erro.

#### H-02 — decisions[].action fora do vocabulário fixo, agente chuta verbo plausível sem checar list antes · `medium`
- sinal: (a)+(b) · frequência: 2 `VOCABULARY_VIOLATED` (`note`, `create`) · sessões-mãe: 2 (81840bd1, c63af885)
- citação: > decisions.action 'note' is outside the fixed vocabulary (agent-ashikamaru-planner-revisao-plano-v0-it4-84baa2f2bd4d788d, 2026-09-18T22:17:37.771Z)
- causa: `src/event-tools.ts:535-557` já calcula `owners`/`allowed` no detail de `VOCABULARY_VIOLATED` desde 5a27728, mas o texto capturado não trazia essa lista — indício de servidor MCP desatualizado; a description (`event-tools.ts:69-77`) também nunca menciona que `action` é vocabulário fechado por projeto.
- melhoria: confirmar que o servidor hexlog em execução correspondia ao código atual; citar na description que `action` é vocabulário fechado e apontar `list` como forma de descobrir os valores antes de `register`.

#### H-03 — Verdict.source tratado como array por espelhar evidence · `low`
- sinal: (a)+(b) · frequência: 5 `INVALID_EVENT` consecutivas em 10s, corrigidas só na 6ª tentativa · sessões-mãe: 1 (81840bd1)
- citação: > {"code":"INVALID_EVENT","message":"event data failed validation","details":[{"path":"/data/source","code":"invalid_type","message":"Invalid input: expected string, received array"},{"path":"/data/origin",...} (81840bd1-247c-476a-8d6a-17a169709dd5, 2026-09-18T21:22:31.039Z)
- causa: `src/events.ts:66-75` define `VerdictData.source` como string única enquanto `evidence` (linha 70) aceita string ou array; a description (`event-tools.ts:75`) só lista os nomes dos campos, sem tipo/obrigatoriedade — o agente generaliza a flexibilidade de `evidence` para `source` e não sabe que `origin`+`trace` são obrigatórios.
- melhoria: em `event-tools.ts:75`, documentar que `source` é string única (diferente de `evidence`) e que `origin`+`trace` são obrigatórios em Verdict.

### `evaluate_gate`

#### H-04 — pipeline de release avalia um gate por chamada, nunca em lote no mesmo milestone · `high`
- sinal: (d) · frequência: 16 chamadas na janela, 100% uma-gate-por-chamada · sessões-mãe: 4 (3c8ebf3e, 81840bd1, c63af885, 008ea4f7)
- reforça: #9
- citação: > {"project": "hextelemetry", "process": "v0-1-run", "gate": "post-commit-install", "agent": "orchestrator", "target": "hex:target:plan-v0-1", "result": {"passed": true, "evidence": [...]}} (c63af885-8b7e-4550-9484-605c05441a6d, 2026-09-19T20:23:34.686Z)
- causa: `src/event-tools.ts:99-144` aceita exatamente 1 gate por chamada (`inputSchema.gate: Name`, singular); não há forma de submeter vários gates do mesmo milestone numa chamada.
- melhoria: reforça #9 com evidência de produção — aceitar lista de `{gate, result}` por chamada para o mesmo target/milestone.

### `state`

#### H-06 — targets prometido sempre presente nunca aparece nas respostas grandes: servidor MCP rodava build travado antes do commit que adicionou o campo · `high`
- sinal: (d) · frequência: 14 respostas > 10k chars na janela, nenhuma com `targets`/`totals.targets` · sessões-mãe: 4 (3c8ebf3e, 008ea4f7, 81840bd1, c63af885)
- reforça: #18
- citação: > {"logThrough":{"id":"hextelemetry:v0-1-run:milestone:01a0bb48-71cd-7db7-aac7-041c3a661eaf","seq":40,...},"totals":{"active":25,"conflicts":0,"orphans":0,"toReview":6,"invalidReferences":0,"warnings":0},"active":[... (agent-araven-critic-gate-v0-1-3a25fcfbce659cb2, 2026-09-19T20:08:57.782Z)
- causa: `src/event-tools.ts:711-712` (resolveState) inclui `targets`/`totals.targets` incondicionalmente desde o commit 5a27728 (18/09, já mesclado antes da janela); o formato observado em toda a janela é byte-a-byte o formato anterior a esse commit — evidência de que o servidor MCP do `hextelemetry` rodava build travado antes de 5a27728/4ef7370 apesar dos commits já existirem no git.
- melhoria: não é bug no código atual. Reforça #18 (expor versão/commit do servidor em `list`, o que destravaria diagnosticar exatamente este caso) e é relacionado a P6 (installer garantir rebuild/restart do processo MCP após atualizar o hexlog no projeto consumidor).

#### H-07 — sem parâmetro de "mudou desde X": leitores paralelos/sequenciais pagam o payload cheio de novo por conteúdo quase idêntico · `medium`
- sinal: (d) · frequência: 2 pares de leituras quase idênticas (1 par byte-a-byte igual, 4s de intervalo; 1 par com 92% dos itens repetidos, 9min de intervalo) · sessões-mãe: 2 (3c8ebf3e, c63af885)
- citação: > Investigação SOMENTE LEITURA (não edite arquivos, não registre no hexlog). Repo: /home/gabriel/personal/hextelemetry. Hexlog projeto `hextelemetry`, processo `v0-run` (80 eventos, seq 0-79; carregue via ToolSearch "select:mcp__hexlog__events,mcp__hexlog__state,mcp__hexlog__list"). (agent-ahelena-tracer-auditoria-premissas-b3684af543ceb2ad, 2026-09-19T18:35:00.950Z)
- causa: `src/event-tools.ts:161-165` (inputSchema de `state`) só tem `project`, `process`, `sections`, `withData` — não há `since`/`ifLogThroughAtLeast` para o chamador evitar reler a projeção inteira quando nada mudou.
- melhoria: aceitar um `since`/`ifLogThroughAtLeast` opcional em `state`, devolvendo `{unchanged:true, logThrough}` sem repetir as listas quando o log não avançou.

### `events`

#### H-08 — cap de 24k chars trunca a página ignorando o limit pedido; cortar só prevHash recupera pouco porque data domina o payload · `high`
- sinal: (c)+(d) · frequência: 19 chamadas em 2 sessões-mãe com cursor/tamanho de resposta idênticos independente do `limit` pedido; 71% das 35 respostas do bucket a <4k do cap · sessões-mãe: 4 (3c8ebf3e, 008ea4f7, 81840bd1, c63af885)
- reforça: #16
- citação: > Hexlog projeto `hextelemetry`, processo `v0-run` (80 eventos, seq 0-79): leia todos (since=0/40, limit=40, until=80). (agent-abenson-critic-melhorias-proxima-run-4c4566157dfb3b1c, 2026-09-19T18:30:10.623Z)
- causa: `src/mcp.ts:41` (`PAGE_CHARS_CAP=24_000`), aplicado em `event-tools.ts` (raw:885, search:962), corta a página por tamanho de caractere antes do corte por `limit`, sem sinalizar qual dos dois motivos parou a página; numa página no cap (11 eventos, 24.644 chars), `data` é 82% do payload e `prevHash` isolado só 3% (64 chars/evento).
- melhoria: expor no output de `events` o motivo real da parada (limit vs cap de chars); estender a projeção de campos do #16 para também cobrir `data` (não só `prevHash`), já que `data` é ~82% do payload.

#### H-09 — sem lista de targets/seqs: cada item conhecido custa 1 chamada isolada, em bursts de 2 a 6 chamadas idênticas em estrutura · `high`
- sinal: (c) · frequência: 5 bursts em 3 sessões-mãe, 16 chamadas · sessões-mãe: 3 (c63af885, 3c8ebf3e, 81840bd1)
- citação: > US-004 feito. Agora US-005: ler os 6 eventos herdados do `v0-run`. (c63af885-8b7e-4550-9484-605c05441a6d, 2026-09-19T19:49:21.364Z)
- causa: `src/event-tools.ts:257` (`target: Target.optional()`) só aceita um valor único; não existe parâmetro `targets`/`seqs` para lote.
- melhoria: aceitar `targets: Target[]` (ou `seqs: number[]`) opcional em `events` (modo raw), devolvendo todos os itens pedidos numa única resposta — colapsa os bursts observados (2 a 6 chamadas) em 1.

### `list`

#### H-10 — filtro type nunca resolve nomes reservados (verdict/milestone) e o erro sugere tentar outro processo · `low`
- sinal: (a) · frequência: 2 chamadas em sequência (INVALID_INPUT → TYPE_NOT_FOUND) · sessões-mãe: 1 (3c8ebf3e)
- citação: > {"code":"TYPE_NOT_FOUND","message":"type 'verdict' is not fixed in process 'v0-run'","details":[]} (agent-ahelena-tracer-auditoria-premissas-b3684af543ceb2ad, 2026-09-19T18:36:10.631Z)
- causa: `src/definition-tools.ts:266-269` exige `process` junto com `type`, e `:311-313` devolve `TYPE_NOT_FOUND` genérico; `verdict` e `milestone` estão em `RESERVED_TYPE_NAMES` (`skills/hexlog/SKILL.md:29`) e por isso nunca aparecerão em `fixed.types` de processo nenhum — a mensagem implica que bastaria achar o processo certo, quando essa busca é impossível para nomes reservados.
- melhoria: quando `type` for um `RESERVED_TYPE_NAME`, devolver mensagem distinta ("verdict é tipo embutido do domínio, não um type customizado fixável") em vez do `TYPE_NOT_FOUND` genérico.

## Harness do hextelemetry

Tabela de atribuição por origem das 306 chamadas (`origin` em `calls.jsonl`):

| categoria | chamadas | % | chars totais | média/chamada |
|---|---|---|---|---|
| subagent-prompt (subagente com instrução no prompt) | 147 | 48% | 1.143.065 | 7.776 |
| skill (skill do turno, `skill:*`) | 115 | 38% | 266.412 | 2.317 |
| continuation (continuação de skill anterior, `continuation:*`) | 28 | 9% | 43.397 | 1.550 |
| user-asked (sem gatilho de skill) | 16 | 5% | 16.381 | 1.024 |

Custo por execução, por skill nomeada (`skill:*`/`continuation:*`, ordenado por custo médio):

| skill | chamadas | parents | média chars |
|---|---|---|---|
| skill:code-standards | 30 | 2 | 5.158 |
| continuation:ralph | 15 | 1 | 1.686 |
| continuation:ai-slop-cleaner | 7 | 1 | 1.663 |
| skill:ralph | 1 | 1 | 1.479 |
| skill:hexlog | 41 | 3 | 1.392 |
| skill:ralplan | 41 | 2 | 1.272 |
| continuation:ralplan | 3 | 1 | 1.102 |
| continuation:ultragoal | 3 | 1 | 1.054 |
| skill:ultragoal | 2 | 1 | 484 |

Nenhuma skill nomeada chega perto do custo de `subagent-prompt` (média 7.776, 5x `code-standards`): o maior custo por execução não vem de uma skill do catálogo, vem de subagentes instruídos inline pelo próprio orquestrador (padrão "Lane 1/2/3" de auditoria, sem arquivo de skill) — reportado como W-01 porque a causa não está numa skill específica. `skill:code-standards` aparecer como origin de chamadas hexlog é artefato de coocorrência: `CLAUDE-omc.md` manda invocar `code-standards` antes de escrever código, e a mesma resposta do executor também registra no hexlog por causa de `hextelemetry/CLAUDE.md:27-30` — não é a skill `code-standards` chamando o hexlog.

#### W-01 — orquestrador e subagentes-irmãos relêem o log inteiro do mesmo processo sem cache, pagando payload byte-a-byte idêntico — 63% dos bytes da janela
- confiança: `high` · 4 sessões-mãe (3c8ebf3e, 008ea4f7, 81840bd1, c63af885)
- reforça: #10, #11, #14, #16
- 49 de 306 chamadas (16%) somam 929.370 de 1.469.255 chars totais (63,3%); `subagent-prompt` concentra 147/306 chamadas (48%) mas 1.143.065 chars (78%), média 7.776/chamada. Confirmação byte-a-byte: 5 fetches idênticos em 2 sessões-mãe — 3× 23.521 chars e 2× 23.064 chars, mesmo conteúdo apesar do `limit` diferir entre chamadas.
- citação: > Hexlog projeto `hextelemetry`, processo `v0-run` (80 eventos, seq 0-79; carregue via ToolSearch "select:mcp__hexlog__events,mcp__hexlog__state,mcp__hexlog__list"). (agent-ahelena-tracer-auditoria-premissas-b3684af543ceb2ad, 2026-09-19T18:35:00.950Z)
- `hextelemetry/CLAUDE.md:27-30` e `:43` mandam checagem full-history repetida por subagente/iteração ("o orquestrador E cada subagente registram... Todo prompt de subagente inclui essa instrução"; "Orquestrador confere hexlog_events por target antes de disparar a próxima"), reproduzido ad hoc pelo orquestrador ao abrir lanes paralelas de auditoria que re-instruem cada subagente a carregar o processo inteiro. Do lado do servidor, falta de filtro por target/projeção de campos (#10, #11, #14, #16) e ausência de cache por (project,process,mode,since,until,limit,filters) fazem cada leitura repetida custar caro mesmo depois de ajustar o harness.
- ajuste: harness — em `hextelemetry/CLAUDE.md`, trocar a checagem full-events por target pela confiança no recibo que `register` já devolve (#6), reservando `events`/`state` para verificação pontual; ao abrir lanes paralelas sobre o mesmo processo, buscar o contexto uma vez e colar no prompt de cada lane em vez de repetir a instrução de tool-call. Hexlog — cache de curta duração (TTL ~60s, LRU pequeno) em `events`/`state` keyed por (project,process,mode,since,until,limit,filters), e implementar #10/#11/#14/#16 para baratear cada leitura restante.

#### W-02 — ralplan registrou só Verdicts de pesquisa e 2 decisões; plano/reviews de 3 iterações ficaram fora do hexlog até o usuário perguntar
- confiança: `low` · 1 sessão-mãe (81840bd1)
- até 21:37 o orquestrador tinha registrado 30 Verdicts da pesquisa inicial + 2 decisões da iteração 3, deixando de fora o rascunho do plano e as revisões architect/critic das 3 iterações do ralplan. Só depois da pergunta do usuário (22:15:14) o agente registrou em lote 9 eventos novos (seq 33-41) entre 22:15:22 e 22:15:57 (~35s), incluindo 1 tentativa com `INVALID_EVENT` antes de acertar o formato.
- citação: > tu não ta anotando nada do plan no hexlog? (81840bd1-247c-476a-8d6a-17a169709dd5, 2026-09-18T22:15:14.268Z)
- `hextelemetry/CLAUDE.md:31` ("Cada iteração do ralplan vai para o hexlog assim que acontece") não existia quando as 3 iterações do ralplan rodaram — essa linha só foi escrita como reação direta a esta reclamação. Sem a regra explícita, o orquestrador default para registrar em lote/no fim.
- ajuste: ao fazer bootstrap de hexlog+ralplan num projeto novo, escrever a regra "cada iteração do ralplan entra no hexlog assim que acontece" no CLAUDE.md do projeto antes de disparar as iterações — não depois que o usuário notar a lacuna. Candidato a checklist do skill de bootstrap do hexlog, específico da integração hexlog+ralplan, não do skill genérico ralplan.

## Prior art

- #9 ganha evidência de produção com H-04 (16 chamadas, 4 sessões-mãe, 100% um gate por chamada na janela).
- #18 ganha evidência de produção com H-06 (14 respostas grandes sem `targets`; causa: servidor MCP com build travado antes do commit que adicionou o campo).
- #16 ganha evidência de produção com H-08 (cap de chars ignora o `limit` pedido; `prevHash` isolado é só ~3% do payload no cap — cortar só ele não resolve).
- P8 ganha evidência de produção com H-11 — `register_gate` usa `name`, `evaluate_gate` usa `gate` para o mesmo conceito: 13 chamadas `register_gate` + 16 `evaluate_gate` em 5 sessões-mãe (3c8ebf3e, 81840bd1, b671aee6, c63af885, 008ea4f7), sem erro na janela só porque os agentes memorizaram a diferença.
- P9 confirmado sem atrito com H-05 — 16/16 chamadas `evaluate_gate` da janela usam target com o prefixo `hex:target:`, validado por regex em `src/events.ts:27-30`, sem variação nem erro de formato observado; item de formato confirmado, sem atrito adicional a corrigir.
- #10, #11 e #14 ganham evidência de produção com W-01 (harness): 49 chamadas (16%) somam 63,3% dos bytes trocados na janela, releitura do mesmo processo entre sessões-irmãs sem cache.
- #6, #7, #8, #12, #13, #15, #17, #19, #20, #21, P6, P7 sem evidência nova nesta janela.

## Descartados

- Rajadas de `evaluate_gate` sobre a mesma unidade: 16 chamadas na janela, 0 erros — reruns legítimos após correção, não atrito.
- Tamanho da resposta de `register`: máximo 5.274 chars, mediana 1.062 chars em 125 chamadas — nenhuma atinge o limiar de 10k do sinal (d).
- `register_gate` isolado: 13 chamadas, 0 erros.
- `c_orient_state` (2 itens): 1 é armadilha de adjacência posicional (o `before` capturado é sobre um plano do assistente, não sobre a tool `state`); nenhuma chamada `state` teve `persisted:true`; sem evidência de corte silencioso em `active`/`warnings` nas 14 respostas >10k.
- `c_orient_list` (2 chamadas): padrão `list()`→`list({project})` ensinado pela própria skill hexlog no bootstrap de leitura por agentes tracer read-only — fluxo esperado, não atrito.
- `register_vocabulary` (2 chamadas): bootstraps sequenciais de processos distintos (v1 abandonado, depois v0-run), sem `CONCURRENT_DIVERGENT_WRITE` — normal.
- `create_process` (3 chamadas): sem erro/warning.
- `a_error_list` (2 ocorrências, 1 sessão-mãe): confiança baixa, não elevada por outra sessão na janela.
- 5 das 6 mensagens do bucket `e_user` (3 sessões-mãe): pedido neutro de lançar subagentes de pesquisa via hexlog (3c8ebf3e); respostas a perguntas de entrevista do ralplan definindo uso do hexlog no processo, decisões de escopo pré-execução (81840bd1, 2 mensagens); primeiro prompt pedindo bootstrap do hexlog, ainda não em uso (b671aee6); diretiva de acompanhamento da mesma correção já reportada em W-02 ('a partir de agora você e os subagentes devem registrar no hexlog', 81840bd1, 22:16:11) — nenhuma é correção/reclamação nova.
- Decomposição do log `v0-run` em 4 fatias disjuntas (datena/williambonner/casagrande/neto, since 0-20/20-40/40-60/60-80): paralelização legítima sem sobreposição, não é releitura. Chamadas `events` com `search` isoladas ou target único sem repetição imediata: uso normal.
- 4 chamadas `search` de um único agente (86% de ids já vistos) reforçariam #15, mas com só 1 sessão-mãe e sem raciocínio explícito entre chamadas — não formalizado, fica para quem revisar #15 com mais amostras.
- `register` do planner com `INVALID_EVENT` + retry 6s depois (81840bd1, 22:15:22-28): já reportado em H-01, não duplicado aqui.
- `skill:code-standards` como origin de chamadas hexlog: artefato de coocorrência (CLAUDE-omc.md manda invocar code-standards antes de código; a mesma resposta também registra no hexlog por `hextelemetry/CLAUDE.md:27-30`), não é a skill code-standards chamando o hexlog.
- `d_cost_events`/`d_cost_state` (1 ocorrência cada, heurística estreita do script): subestimam o custo real por medirem só "grande E redundante"; usado o limiar bruto (>10k, bucket `d_big`, 49 ocorrências) para não repetir a subcontagem.
