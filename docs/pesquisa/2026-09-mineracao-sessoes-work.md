# Mineração das sessões do `~/work`: atrito no uso do hexlog (2026-09-21 a 25)

Levantamento das sessões do Claude Code no projeto `~/work` entre 2026-09-21 e 2026-09-25 (timestamp das mensagens), olhando só o uso real das tools `mcp__hexlog__*`. Cada achado traz citação literal do transcript, frequência, sessões-mãe distintas, sinal, causa (`arquivo:linha`) e melhoria proposta.

## Resumo

- 91 sessões com hexlog (principais + subagentes, subagente contado pela sessão-mãe), **1782 chamadas**: `register` 976, `events` 516, `evaluate_gate` 213, `state` 43, `list` 30, `create_process` 2, `chain` 2.
- O servidor quase não falha: **2 erros em 1782 chamadas (0,11%)**, os dois com retry bem-sucedido.
- O atrito real é de **custo e forma das respostas**. `events` passa de 10k chars em 152 de 516 respostas (2,90M chars, p50 22,5k). `state` passa de 10k em 21 de 43 e chega a 78.972 chars. `register` devolve o evento inteiro em 976 chamadas (1,24M chars).
- Falta **filtro por subárvore de `target`** em `events` e `state`, e o agente compensa enumerando alvo a alvo ou paginando o log inteiro.
- Metade do volume (50,6%) vem de skills do `~/work` executadas no turno; outros 16,6% vêm de subagentes com instrução hexlog no prompt. Esses achados estão na seção [Harness do `~/work`](#harness-do-work), sem issue.

## Método

1. Um script extrai as chamadas hexlog da janela, deduplica mensagens por `uuid` (513 repetidas entre arquivos de subagentes fork) e separa os sinais em buckets. Erro é classificado pelo JSON estruturado do `tool_result`, nunca por regex: os códigos de erro de domínio do cliente aparecem no payload de `events` e inflavam a contagem em ~13x.
2. Sete analistas leram um bucket cada (register/gate, custo de `state`, orientação em `events`, custo de `events`, list/chain/create_process, correções do usuário, atribuição ao harness), reextraindo dos transcripts quando o bucket subcontava.
3. Consolidação: fusão de achados sobrepostos, aplicação do critério de confiança, checagem contra P6–P9 e contra issues abertas (nenhuma aberta).

**Confiança:** `high` = 3 ou mais sessões-mãe distintas e causa localizada no código; `medium` = 2 sessões ou causa inferida; `low` = 1 ocorrência.

## Cobertura dos sinais

| Sinal | Definição | Resultado na janela |
|---|---|---|
| (a) erro | `is_error` ou objeto top-level com `code`+`message` | 2 (`LOCK_TIMEOUT`, `id` ausente no `register`) |
| (b) retry | mesma tool rechamada em até 3 chamadas após (a), com args diferentes | 2, ambos bem-sucedidos |
| (c) orientação | `events`/`state`/`list` repetido sobre o mesmo processo/target sem escrita depois | 131 marcados pelo script; após leitura: paginação completa, enumeração de alvos irmãos, `search` longo; ~42 eram subagentes read-only por desenho |
| (d) custo | resposta > 10k chars **e** redundante | script marcou 15; recontagem por payload: 49 respostas de `events` com ≥15% de metadado não usado, 21 de `state` > 10k (8 desviadas para arquivo pelo Claude Code) |
| (e) correção do usuário | mensagem de usuário sobre hexlog, sem carga de skill, lembretes e mensagens inter-agente | 21 candidatas, **0 correções reais**; 3 pedidos para gravar o que o agente deixou pendente (harness) |

Limitação do script: ele não lia respostas que o Claude Code desviou para arquivo (`exceeds maximum allowed tokens. Output has been saved to …`). Os analistas de `state` e `events` reextraíram esses casos dos transcripts.

## Achados do hexlog

### `register`

#### H-01 — `register` devolve o evento inteiro · `high`
- sinal: (d) · frequência: 976 chamadas, 1,24M chars (1,27k por resposta) · sessões-mãe: 36 (ex.: 5843f502, a7d30041, 86468dd1)
- citação: > Frente wiki gravada (1 de 4): a tech doc não traz cenário para nenhum dos quatro casos. Aguardo código, tasks locais e planejamento. (5843f502, 2026-09-24T18:15:30)
- causa: `src/event-tools.ts:85` (output schema com `event: EventLine`) e `src/event-tools.ts:451` devolvem o evento gravado completo, com `data` e `prevHash`, que o agente acabou de enviar.
- melhoria: `register` devolver só `{seq, id, prevHash, deduplicated, warnings}`, com eco completo opcional por flag.

#### H-02 — `LOCK_TIMEOUT` menor que o limiar de lock órfão · `low`
- sinais: (a)+(b) · frequência: 1 em 976 · sessões-mãe: 1 (af794273), num minuto com 43 escritas de 7 sessões top-level no mesmo processo
- citação: > Ponto 75 (planejamento) falhou por lock do hexlog. Regravando. (af794273, 2026-09-25T14:32:43)
- causa: `src/log.ts:20` (`LOCK_TIMEOUT_MS = 5_000`) é menor que `src/log.ts:22` (`LOCK_ORPHAN_MS = 10_000`). O dono do lock ficou ~7,3s preso (seq 998→999, stall de I/O no WSL2 inferido), e quem esperava desistiu antes de a limpeza de órfão poder agir. O retry com o mesmo prefixo passou 5,4s depois, sem duplicata.
- melhoria: `LOCK_TIMEOUT_MS ≥ LOCK_ORPHAN_MS` (ex.: 15s), ou `details` do erro dizendo que nada foi gravado e que repetir com o mesmo prefixo de id é seguro.

#### H-03 — `id` obrigatório repete `project`/`process` · `low`
- sinais: (a)+(b) · frequência: 1 · sessões-mãe: 1 (09f6e6b5), primeiro `register` da sessão
- citação: > Input validation error: Invalid arguments for tool register: id: Invalid input: expected string, received undefined (09f6e6b5, 2026-09-24T16:57:17)
- causa: `src/event-tools.ts:81` exige `id`, cujo prefixo `{project}:{process}:{type}` repete dois campos que já vêm na chamada. Retry com `id` passou 9,4s depois.
- melhoria: aceitar `type` e o servidor montar o prefixo; `id` fica para o retry idempotente com id completo.

### `evaluate_gate`

#### H-04 — um gate por chamada, um milestone por gate · `high`
- sinal: (d) · frequência: 213 chamadas em 61 rajadas; 41 rajadas com 4–5 gates; 178 de 180 builtins passaram · sessões-mãe: 28
- citação: > Os 4 gates passaram. Falta atualizar os ids no script auxiliar e confirmar que o panorama não mudou. (86468dd1, 2026-09-24T18:34:09)
- causa: `src/event-tools.ts:92` em diante avalia um gate e grava um milestone por chamada. Os milestones de gate já são 18% das linhas e 14% dos bytes do log da wave. O volume é contrato do harness (ver [W-02](#w-02--gates-builtin-a-cada-passada)).
- melhoria: `evaluate_gate` aceitar `gates: [...]`, com uma chamada e um milestone. Na janela, ~120 das ~160 chamadas de builtin sairiam, junto com 3 de cada 4 linhas de gate no log.

### `state`

#### H-05 — `active` corta em 100 pela ordem de 1ª aparição e não tem filtro por target · `high`
- sinais: (d) + contorno · frequência: 17 chamadas com `totals.active` > 100 (120 a 546 vigentes, 100 devolvidos) · sessões-mãe: 11 (3e5445b3, 7e9f7f06, 88d3ac08, 9b8b471a, dd053dce, dec5c8a1, ea4e94ca, e2459340, 25e04555, 279b4a8d, d3bf7794)
- citação: > o `state()` devolve no máximo 100 dos 454 vereditos vigentes, e o ponto 54 ficou de fora. Montei os vigentes a partir dos `events` do alvo `comentarios.ponto-54` (9b8b471a, 2026-09-25T14:34)
- outra: > state.active do MCP corta em 100 itens e não alcança os pontos (dd053dce, 2026-09-24T13:26)
- causa: `src/event-tools.ts:701` faz `slice(0, SECTION_ITEMS_CAP)` sobre a lista em ordem de 1ª aparição (`src/state.ts:32`), então ficam os 100 alvos mais antigos. O `inputSchema` (`src/event-tools.ts:162-166`) não tem filtro por target. Complementa o P4 (`withData` + `targets`), que já está implementado.
- melhoria: `state` aceitar `targetPrefix` (ou `targets: string[]`) aplicado antes do cap em `active`, `conflicts` e `targets`. O pedido de `comentarios.ponto-54` cairia de ~30k para ~300 chars, sem lista incompleta.

#### H-06 — `withData` promete teto de 24k, mas a resposta chega a 51–79k · `high`
- sinal: (d) · frequência: 5 de 5 chamadas com `withData: true` acima do limite do Claude Code (51,4k–79k) · sessões-mãe: 5 (88d3ac08, e2459340, 25e04555, 279b4a8d, ea4e94ca)
- citação: > Error: result (78,972 characters) exceeds maximum allowed tokens. Output has been saved to /home/gabriel/.claude/projects/-home-gabriel-work/e2459340-… (e2459340, 2026-09-25T20:30)
- causa: `attachVerdictData` (`src/event-tools.ts:733-749`) só conta o orçamento sobre `active`. Depois de estourar (`:747`), ainda emite os 85 itens restantes marcados `truncated` (~24k a mais), e `targets`, `toReview` e `warnings` ficam fora da conta. A description (`src/event-tools.ts:158-160`) promete o teto de 24.000 chars.
- melhoria: ao estourar, cortar a lista e devolver `truncated: true` + cursor, contando a resposta inteira contra `PAGE_CHARS_CAP`. Isso leva de ~51,9k para até 24k por chamada, sem desvio para arquivo.

#### H-07 — `warnings` repete `kind: extension` a cada evento, e ninguém usa · `high`
- sinal: (d) · frequência: 9 chamadas com warnings no payload, 100% `extension`, `totals.warnings` até 279 · sessões-mãe: 7 (97b1119a, a7d30041, dec5c8a1, 3e5445b3, ea4e94ca, e2459340, d3bf7794)
- citação: > {"event":"rdsc:wave-auth-integration-ab-2:milestone:…","field":"milestoneType","value":"gate-contratos","kind":"extension","owner":"refino-card-wave"} (repetido 13–20x por resposta, ea4e94ca, 2026-09-23T14:38)
- causa: `src/state.ts:284-285` classifica valor declarado por um owner de vocabulário como `extension`, e `collectWarnings` (`src/state.ts:300-304`) emite um warning por evento. Uso legítimo do vocabulário vira ruído linear no tamanho do log. Nenhum texto do assistente cita esses warnings.
- melhoria: tirar `extension` da lista por padrão (contagem em `totals`) ou agrupar por `(field, value, owner, kind)` com `count` e um evento de exemplo. Medido: 17,5k → 664 chars numa resposta de 92 itens.

#### H-08 — `targets` sempre vem, fora do filtro `sections` · `high`
- sinal: (d) · frequência: 43 de 43 chamadas, +3,1–3,4k chars quando há ≥100 alvos · sessões-mãe: 24
- citação: > "targets":["hex:target:comentarios.ponto-1","hex:target:comentarios.ponto-10","hex:target:comentarios.ponto-11",… (88d3ac08, 2026-09-25T14:34, pedido com `sections: ["active","conflicts","forks"]`)
- causa: `src/event-tools.ts:714-715` emite `targets` sem olhar `sections`, como a description declara (`src/event-tools.ts:157`). O custo é medido; que o agente não usa a lista é inferido (nenhuma citação depois).
- melhoria: tratar `targets` como seção comum, filtrável por `sections` e pelo `targetPrefix` de H-05.

### `events`

#### H-09 — falta filtro por subárvore de `target` · `high`
- sinal: (c) · frequência: 134 chamadas em rajadas de ≥4 alvos irmãos (`comentarios.ponto-N`, `task-N.divergencia-N`, `task-5.dod-N`), mais 10 consultas ao alvo pai que voltaram vazias · sessões-mãe: 6 nas rajadas (d1389d79, dd65c5b7, ea4e94ca, 25e04555, 3e5445b3, d3bf7794), 3 nos vazios (25e04555, 279b4a8d, dd053dce)
- citação: > `state()` corta em 100 itens e a wave tem ~790 eventos, então busco os vereditos por `target` de cada ponto (1 a 9). (d1389d79, 2026-09-24T18:05)
- causa: `matchesTarget` (`src/search.ts:112-113`) compara por igualdade exata. Skills do `~/work` já prescrevem um curinga que não existe (`task-<m>.divergencia-*`); nenhuma das 297 chamadas com `target` usou `*`.
- melhoria: `target` casar a subárvore (`hex:target:task-2.*` ou campo `targetPrefix`) na fronteira de `.`. Em 25e04555, 8 consultas vazias + 34 buscas virariam 1 chamada; em d3bf7794, 23 viram 1.

#### H-10 — `search` longo cai em OR e enche a página de ruído · `high`
- sinais: (c)+(d) · frequência: 33 de 70 buscas do bucket caíram em OR (5–18 eventos, ~20k chars) contra 1–3 eventos e ~2k em AND; 68 de 121 buscas da janela têm ≥5 termos · sessões-mãe: 7 (25e04555, 3e5445b3, ea4e94ca, f5c2898f, 279b4a8d, d3bf7794, 1255bb0c)
- citação: > Afirmações a procurar (use mcp__hexlog__events com `search` e filtro `type: "verdict"`, e confira se o veredito é vigente, isto é, nenhum outro o cita em supersedes; ignore targets comentarios.ponto-*) (25e04555, 2026-09-25T16:18:43). Na sequência: 34 buscas de 5–15 termos em 3 minutos, ~370k chars.
- causa: `src/search.ts:158-159` refaz a busca em OR quando o AND não acha nada e há ≥2 termos, sem mínimo de termos casados; a página enche até o teto de 24k.
- melhoria: exigir mínimo de termos casados no OR (ex.: ⌈n/2⌉) ou devolver `matchedTerms` por hit e cortar abaixo de um limiar; avisar na description que consulta longa degrada para OR.

#### H-11 — `prevHash`, `agent`, `seq` e prefixo do id em todo evento, sem uso · `high`
- sinal: (d) · frequência: 152 respostas > 10k; em 80 delas o agente não cita nenhum evento nas 12 ações seguintes · sessões-mãe: 25 (ex.: d3bf7794, 25e04555, 3e5445b3, ea4e94ca, 279b4a8d, 5843f502)
- citação: > Grave o array JSON (cada evento com os campos id, type, data exatamente como vieram (97b1119a, prompt a subagente, 2026-09-22T22:41Z)
- causa: `src/event-tools.ts:878-891` (modo raw) e `:951-968` (modo search) emitem o `EventLine` inteiro (`src/events.ts:42-50`), e o teto de página conta o evento completo (`src/mcp.ts:41`, `src/event-tools.ts:884`). Das 104 respostas com `nextCursor`, 79 pararam no teto de chars e só 25 no `limit`. Integridade já é papel de `chain`.
- melhoria: omitir `prevHash` por padrão (`withHash: true` para quem quiser) e aceitar `fields` (ex.: `["id","type","data"]`). Simulado: −6,7% só sem `prevHash`; −17,2% (2,90M → 2,40M) sem `prevHash`/`agent`/`seq`/prefixo e com a compactação de H-12, com menos páginas.

#### H-12 — filtro por `target` traz milestones de gate que dominam a página · `high`
- sinal: (d) · frequência: 36 respostas > 10k com `target`; 41% dos chars são milestones de gate (316 gates contra 149 verdicts); em 17, gates são ≥50% dos eventos · sessões-mãe: 12 (25e04555, 456c1abd, 5843f502, 6ccee2cc, 86468dd1, 9cfe6a21, af794273, b78f8e7b, d3bf7794, d9082142, ea4e94ca, fcee33e9)
- citação: > events {"target": "hex:target:comentarios", "limit": 200} → 34 eventos, 21 deles gates (456c1abd, 2026-09-25T14:26:28Z)
- causa: `src/search.ts:112-114` casa `data.target` sem olhar o tipo, e todo `evaluate_gate` grava um milestone com o mesmo target. `src/gates.ts:85` copia o `criteria` inteiro e o `evaluatedThrough` completo (6 textos de criteria distintos repetidos em 581 gates). Os filtros são só de igualdade (`src/search.ts:101-110`).
- melhoria: filtro de exclusão (`excludeMilestoneType: ["gate"]`, ou gates fora por padrão quando há `target`) e gate builtin sem `criteria` e com `evaluatedThrough` reduzido a `seq`. −40,7% no modo target com a exclusão.

#### H-13 — sem export read-only, o log sai paginado pelo MCP e é redigitado · `high`
- sinal: (d) · frequência: 263 chamadas de export, 2,86M chars, 71 episódios (3,1 páginas em média), 40 varreduras completas sem filtro; em d3bf7794, 26 páginas seguidas (~610k chars); um subagente fez 52 páginas (831k chars) e 27 `Write` reemitindo ~655k · sessões-mãe: 30 (ex.: 97b1119a, d3bf7794, 3e5445b3, dd65c5b7, ea4e94ca)
- citação: > Os dados do hexlog só saem pelas ferramentas MCP (o hook bloqueou a leitura direta do arquivo). Vou gravar a saída do servidor no scratchpad para rodar a projeção da tabela. (97b1119a, 2026-09-22T22:21:41)
- outra: > ARMADILHA CONHECIDA: NÃO pagine o log inteiro com mcp__hexlog__events sem filtro, nem chame mcp__hexlog__state. O processo tem ~860 eventos e cada página é limitada a 24 mil caracteres (~15 eventos): a paginação completa leva mais de uma hora. Um agente anterior travou exatamente nisso. (d3bf7794, prompt do lead, 2026-09-24T19:34:52)
- causa: o guard nega leitura direta de `events.jsonl` (`src/guard.ts:52`, `docs/adr-0001-hexlog-mvp.md:231`), então a única via é paginar a 24k (`src/mcp.ts:41`) e transcrever. A transcrição à mão já gerou um alarme falso de "id duplicado" (25e04555, 2026-09-25T14:56; o log em disco está íntegro). Os scripts do harness que consomem o export estão em [W-01](#w-01--export-paginado-e-transcrito-para-scripts-de-projeção).
- melhoria: comando read-only no hexlog, no molde de `scripts/insights.ts` (ex.: `hexlog export <projeto>/<processo> --fields id,type,data`), escrevendo em stdout para ir direto no pipe do script consumidor.

#### H-14 — `events` não marca o Verdict já superado · `low`
- sinal: (c) (o `no-forks` reprovado não é erro (a): a resposta vem sem `code`) · frequência: 1 · sessões-mãe: 1 (ea4e94ca); o agente afirmou dois vigentes, o `register` abriu um fork, o `no-forks` acusou e a correção custou 1 `register` + 9 `evaluate_gate`
- citação: > o cenário 3 do card 5 nunca teve dois vereditos vigentes. A seq 284 já tinha sido superada pela 294, que fica em outro target (`task-5.descartado-nivel4-2`). A consulta filtrada por target não mostra esse tipo de substituição. (ea4e94ca, 2026-09-23T15:38:51)
- causa: inferida; não há `supersededBy` na resposta de `events` (`src/event-tools.ts`, `src/search.ts`). O gate funcionou como rede de segurança.
- melhoria: cada Verdict devolvido por `events` indicar se está superado e por qual id, mesmo quando o sucessor está em outro target.

### `list`

#### H-15 — a description de `list` a faz parecer porta de entrada obrigatória · `medium`
- sinal: (c) · frequência: 30 `list` (15 `{}`, 10 `{project}`, 5 `{project,process}`), 7 pares `{}` → `{project}` com o projeto já conhecido · sessões-mãe: 4 (279b4a8d, f5c2898f, 3e5445b3, ea4e94ca)
- citação: > Consultando o hexlog (projeto `rdsc`) atrás de decisões sobre a origem do `companyId` e o log do nó. (f5c2898f, 2026-09-24T13:18:06), seguido de `list {}` e `list {project: "rdsc"}`
- causa: inferida; a description (`src/definition-tools.ts:58-59`) apresenta `list` sem parâmetros como ponto de partida, e a skill hexlog, que orientaria o caminho, foi carregada em 0 de 13 subagentes. ~560 chars de `builtinGates` se repetem a cada resposta.
- melhoria: description de `list` dizer que é para descoberta e não é pré-requisito de leitura; com project/process conhecidos, ir direto a `state`/`events`.

#### H-16 — a versão do servidor em execução não aparece em nenhuma resposta · `low`
- sinal: (c) · frequência: 3 `list {}` numa sessão · sessões-mãe: 1 (d70df502)
- citação: > binário antigo. O `list` continua mostrando 4 gates. Sem reconectar, o smoke em `rdsc-smoke` (US-005) testaria o servidor velho.  Próximo passo: rode `/mcp`, reconecte o `hexlog` e me avise. (d70df502, ~2026-09-22T20:04)
- causa: `src/version.ts:2` só aparece no handshake (`src/mcp.ts:127`), que o agente não vê; ele detectou o binário velho contando builtins.
- melhoria: `list {}` devolver `server: {version, commit ou startedAt}` e `install --check` imprimir o commit instalado.

## Harness do `~/work`

Achados cuja causa está em skills, rules ou prompts do `~/work`. Não viram issue no hexlog.

**Atribuição das 1782 chamadas** (skill vale só no turno e zera a cada mensagem real do usuário; subagente herda a diretiva do prompt de spawn):

| Origem | Chamadas | % |
|---|---|---|
| skill do `~/work` no turno (`valida-comentarios-card` 415, `refino-card-wave` 308, `registra-estado-wave` 168, `plano-execucao-tdd` 11) | 902 | 50,6% |
| continuação de skill do turno anterior (usuário respondeu "sim"/"segue") | 441 | 24,7% |
| subagente com hexlog no prompt (170 de prompt improvisado, sem skill) | 295 | 16,6% |
| sem gatilho identificável | 66 | 3,7% |
| subagente sem gatilho no prompt (`writer.tpl`) | 37 | 2,1% |
| usuário pediu hexlog direto | 41 | 2,3% |

`~/.claude/skills/hexlog/SKILL.md` e `~/work/CLAUDE.md` geraram 0 chamadas na janela. Custo médio por execução: `valida-comentarios-card` 27,2 chamadas / 114k chars; `refino-card-wave` 46,5 / 94k; `registra-estado-wave` 20,4 / 47k.

#### W-01 — export paginado e transcrito para scripts de projeção
- confiança: `high` · 30 sessões-mãe
- citação: > Paginando o hexlog, que é lento demais (37 divergências espalhadas em 600 eventos). (dd65c5b7, 2026-09-23T14:34:52Z)
- `registra-estado-wave/SKILL.md:43`, `references/estado.md:9-13` e `:83`, `valida-comentarios-card/SKILL.md:83` e `refino-card-wave/SKILL.md:228-229` mandam puxar `state`+`events` pelo MCP e regravar em arquivo para `agent_docs/bin/projeta-estado.mjs` e `matriz-convergencia.mjs`. Os bytes passam duas vezes pelo contexto. `refino-card-wave/SKILL.md:229` nem passa `limit`, então vem a página default de 50, incompleta sem aviso.
- ajuste: trocar MCP→Write pelo pipe do export de [H-13](#h-13--sem-export-read-only-o-log-sai-paginado-pelo-mcp-e-é-redigitado--high); até lá, `limit: 200` no refino e os scripts falharem quando `totals.active > active.length`.

#### W-02 — gates builtin a cada passada
- confiança: `high`
- `registra-estado-wave/SKILL.md:47` e `:59-68` põem os 4 builtins como critério de pronto de toda passada, embora `references/log.md:85` reconheça que o hexlog já barra conflito e fork na escrita. 180 chamadas, 132k chars, 53 rodadas, 178 de 180 passaram, 28 sessões.
- citação: > Gravando no hexlog, conforme a `registra-estado-wave`: um marco `formato-alterado` por card, sem `decisions`, porque nenhuma decisão foi tomada. Depois vêm os gates e a reprojeção do ESTADO. (5b030cf7, 2026-09-23T14:25:54)
- ajuste: builtins só no fechamento da unidade, junto com os custom. Lado hexlog em [H-04](#h-04--um-gate-por-chamada-um-milestone-por-gate--high).

#### W-03 — `search` para achar o veredito a superar
- confiança: `high`
- `registra-estado-wave/SKILL.md:35` exige `supersedes`, mas `references/log.md:89` não diz como achar o vigente de uma afirmação; o agente cai no `search` ([H-10](#h-10--search-longo-cai-em-or-e-enche-a-página-de-ruído--high)). 121 chamadas, 1,26M chars, 20 sessões.
- citação: > Registrando no hexlog o cancelamento da 1524 e as 4 postagens. Antes, vou localizar os vereditos que o cancelamento derruba (fronteira 10, assunto 2). (279b4a8d, 2026-09-23T18:36:03)
- ajuste: `log.md:89` mandar usar `state({withData: true})` ou `events` por target exato antes de qualquer `search`.

#### W-04 — curinga de target prescrito que o servidor não tem
- confiança: `high` · frequência: 0 de 297 chamadas com target usaram `*`; 6 sessões-mãe (d1389d79, dd65c5b7, ea4e94ca, 25e04555, 3e5445b3, d3bf7794)
- citação: > `state()` corta em 100 itens e a wave tem ~790 eventos, então busco os vereditos por `target` de cada ponto (1 a 9). (d1389d79, 2026-09-24T18:05)
- `executa-plano-tdd/SKILL.md:133` ("filtro `target: task-<m>.divergencia-*`") e `valida-comentarios-card/SKILL.md:43` ("filtro por `target: task-<m>.*`") descrevem um filtro inexistente; os agentes enumeram alvo a alvo. Resolve junto com [H-09](#h-09--falta-filtro-por-subárvore-de-target--high).

#### W-05 — subagentes read-only relendo o hexlog por prompt improvisado
- confiança: `medium`
- Fan-out de revisores e críticos sem skill que o governe: cada subagente refaz o export e as buscas. 170 chamadas / 1,44M chars, mais 37 / 273k via `writer.tpl`; 5 sessões (3e5445b3, ea4e94ca, 25e04555, 279b4a8d, d70df502).
- citação: > Exporte do hexlog os vereditos vigentes dos pontos 1 a 23 da wave auth-integration-ab-2. Use mcp__hexlog__events (25e04555, 2026-09-25)
- ajuste: rule em `~/work/.claude/rules`: em fan-out que lê a wave, o lead exporta uma vez e passa o path; subagente não chama o hexlog. O mesmo vale para a sonda `list {}` de [H-15](#h-15--a-description-de-list-a-faz-parecer-porta-de-entrada-obrigatória--medium): o template de despacho deve dizer que project/process já existem.

#### W-06 — agente adia a gravação e pede permissão
- confiança: `medium` · 5 sessões (25e04555, 5b030cf7, 60037b49, ea4e94ca, 3e5445b3) com o padrão; em 3 o usuário precisou mandar gravar o que o agente deixou pendente.
- citação: > Três fatos que o hexlog ainda não registra: 1. As 8 respostas postadas no Jira hoje. [...] Quer que eu grave o primeiro no hexlog? (60037b49, 2026-09-25T17:33)
- `registra-estado-wave/SKILL.md:27` já admite ("O fato mais esquecido é o último"), mas nada autoriza gravar sem perguntar, o que contradiz "ao vivo, nunca em lote" (`refino-card-wave/SKILL.md:106`, `:221`).
- ajuste: autorização durável na skill ("gravar fato de wave não pede aprovação; grave logo depois do Edit").

#### W-07 — frentes gravam o mesmo `claim` no mesmo target e o `no-conflicts` falha
- confiança: `medium`
- 1 falha corrigida com 12 `register` de `supersedes` (86468dd1); o workaround (`claim` prefixado pela frente) aparece em 5 sessões, 74 claims.
- citação: > {"target": "hex:target:comentarios.ponto-11", "claim": "O card troca connectors.itemKey de label (tech doc §3.3) para id sem documentar o desvio", "candidates": [… (86468dd1, 2026-09-24T18:32:37)
- `registra-estado-wave/references/log.md:30` põe a frente só no `trace`, que fica fora da chave de conflito `(target, claim)` (`src/state.ts:136`). O workaround vive só na wiki do `~/work`.
- ajuste: levar a regra para `valida-comentarios-card/SKILL.md` e `log.md:30`. O hexlog não precisa mudar.

#### W-08 — sessões paralelas com faixa de numeração definida à mão
- confiança: `low`
- 1 coordenador (25e04555) despachou 8 sessões com faixas de pontos coladas no prompt.
- citação: > Numeração: use só os pontos 34 a 43, em ordem, começando no 34. [...] Não grave task-fechada: quem fecha é a sessão principal. (456c1abd, 2026-09-25T14:26)
- A regra "a numeração de ponto N nunca reinicia" e `projeta-estado.mjs --proximo` (`registra-estado-wave/SKILL.md:45`) disputam o mesmo número em paralelo; o lock do hexlog funcionou.
- ajuste: seção "rodada paralela" na `valida-comentarios-card` com reserva de faixa como passo formal.

## Prior art

- P1–P5 (feedback rdsc de 2026-09-18) estão implementados; H-05, H-06 e H-08 complementam o P4 (`state.withData` + `targets`) sem repeti-lo.
- P6–P9 seguem abertos e **não tiveram evidência nova**: todas as 213 chamadas de `evaluate_gate` usam `gate`, nenhuma `name` (P8); os 1486 targets da janela têm prefixo `hex:target:`, sem espaço nem `:` no corpo e sem erro de target (P9); installer e gate custom não apareceram (P6, P7).

## Descartados

- `create_process` (2 chamadas, sem `STALE_DEFINITIONS`) e `chain` (2, resultado usado): sem atrito.
- `list {project, process}` antes de registrar: conferência legítima do vocabulário congelado.
- Leituras de janela de `seq` e filtros únicos em `events`: leitura pontual, até ~16k.
- Verdicts superados em `events` (24% dos chars): necessários para a projeção; ficam como candidato a filtro opcional.
- Gates custom (33 chamadas, 115k chars): custo justificado.
- Hesitação sobre formato de id/tipo antes de `register`/`evaluate_gate`: 0 casos reais em 1189.
