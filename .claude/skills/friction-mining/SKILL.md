---
name: friction-mining
description: Mine Claude Code transcripts of a project over a date window for friction in real use of the hexlog MCP tools, producing a ranked report plus issue and comment drafts for the hexlog repo. Invoke explicitly. Not for harness-config mining (session-mining) nor hexlog log metrics (scripts/insights.ts).
disable-model-invocation: true
license: CC-BY-4.0
metadata:
  author: Gabriel Baldino
  version: 1.0.0
---

# friction-mining

Minera as sessões do Claude Code de um projeto-fonte numa janela de datas atrás de atrito no uso real das tools `mcp__hexlog__*` e transforma o que achar em relatório, issues e comentários no repo do hexlog. As decisões de método já estão fixadas (sinais, critério de confiança, harness separado); a rodada só escolhe janela e projeto-fonte.

```
skill (gate 1: janela + fonte) → Workflow friction-mining-run
  Extract (scripts/mine.py) → Analyze (lanes) → Consolidate → Write → Verify (≤2 voltas)
skill (gate 2: aprovar publicação) → labels → issues/comentários
```

Tudo antes do gate 2 é local e reversível; o relatório fica em `.ignore/reports/`, fora do git. Nada sai para o GitHub sem o ok do usuário no gate 2, e o que sai é byte a byte o rascunho aprovado.

## Passo 1 — Gate 1: janela e projeto-fonte

Pergunte com `AskUserQuestion`, uma pergunta por vez:

1. Projeto-fonte: liste `~/.claude/projects/` e ofereça os diretórios com atividade recente (ex.: `-home-gabriel-work`). `slug` = tudo depois de `-home-<user>-` (`work`, `personal-hexlog`).
2. Janela: `from` e `to` (inclusivos, `YYYY-MM-DD`). Recomende a semana útil anterior.

Esperado: `projectDir`, `slug`, `from`, `to` confirmados.

## Passo 2 — Preparar a rodada

1. Prior art: `mcp__github-official__list_issues` (owner `gabrielh-silvestre`, repo `hexlog`, state `OPEN`, fields `number,title`, `perPage: 100`). Monte uma linha `#N título; #M título; …`. Acrescente itens abertos citados como pendentes nos relatórios anteriores `.ignore/reports/*-mineracao-*.md` e nos versionados de antes em `docs/pesquisa/*-mineracao-*.md`.
2. Caminhos:
   - `out` = `<scratchpad>/friction-mining/<to>/mining`
   - `reportPath` = `<raiz do checkout principal>/.ignore/reports/<to>-mineracao-<slug>.md`
   - `draftsDir` = `<raiz do checkout principal>/.ignore/friction-mining/<to>`
   - `skillDir` = o "Base directory for this skill" desta invocação (caminho absoluto)

## Passo 3 — Rodar o workflow

Invoque `Workflow` com `name: "friction-mining-run"` e `args` como objeto JSON (não string):

```json
{ "projectDir": "...", "projectSlug": "...", "from": "...", "to": "...", "repoRoot": "<raiz do checkout principal>",
  "skillDir": "...", "out": "...", "reportPath": "...", "draftsDir": "...", "priorArt": "#6 ...; #7 ..." }
```

Esta skill é o opt-in do usuário para o Workflow. Não rode lanes à mão enquanto ele executa; espere a notificação de conclusão. Se voltar `error`, veja Troubleshooting.

## Passo 4 — Gate 2: aprovar a publicação

Leia o relatório e os rascunhos (`draftsDir`) e apresente em até 5 linhas:
- chamadas, achados por confiança (`counts.byConfidence`), `counts.issues` novas, `counts.comments`, `counts.reinforceOnly`, achados de harness;
- `skippedLanes`, `lostLanes` (lane perdida não gera `error`: o relatório foi escrito sem ela) e `residualProblems` do verifier (cada um com a correção sugerida; `verifyRan: false` = verificação não rodou).

Pergunte com `AskUserQuestion`: publicar tudo / revisar item a item / parar. Em "item a item", uma pergunta por rascunho, esperando a resposta antes da próxima. Resíduo do verifier que o usuário aceitar corrigir: aplique no arquivo e mostre o trecho antes de seguir.

## Passo 5 — Publicar (só depois do ok)

Ordem fixa; cada passo usa o conteúdo do arquivo aprovado, sem reescrever:

1. Labels `confidence:high|medium|low`: `mcp__github-official__get_label`; se faltar, `gh label create <nome> --color <0e8a16|fbca04|c5def5> -R gabrielh-silvestre/hexlog` (o MCP não cria label).
2. Cada `issue-H-xx.md`: `mcp__github-official__issue_write` (`method: create`), título e label das duas primeiras linhas, corpo = resto do arquivo. Anote `H-xx → #N`.
3. Cada `comment-<N>.md`: `mcp__github-official__add_issue_comment` na issue `#N`.
4. Confira com `gh issue list -R gabrielh-silvestre/hexlog --state open --json number,title,labels` que cada issue saiu com a label certa.

Se o hook stop-slop barrar um corpo: reescreva o rascunho seguindo a mensagem do hook e `references/output-format.md`, mostre texto antigo → novo, peça ok para aquele item e só então publique.

## Passo 6 — Fechar

- Relate: caminho do relatório, lista `H-xx → #N` agrupada por confiança, comentários feitos, o que ficou de fora.
- `wiki_add` só se a rodada revelou armadilha nova de método ou mudou uma decisão (título carrega o fato).

## Referências (carregue quando indicado)

- `references/briefing.md`: briefing que cada lane lê. Abra só para ajustar lanes ou investigar um resultado estranho.
- `references/output-format.md`: formato do relatório e dos rascunhos. Abra no gate 2 e ao reescrever um corpo barrado.
- `scripts/mine.py`: extração determinística. Rode à mão só para depurar (`--help`).
- `.claude/workflows/friction-mining-run.js`: lanes, schema, cálculo de confiança e loop do verifier.
- `docs/friction-mining.md`: arquitetura e guia para portar a outra tool MCP.

## Exemplos

**Rodada semanal.** Usuário: "/friction-mining". Gate 1 → `-home-gabriel-work`, `2026-09-28` a `2026-10-02`. Workflow roda as lanes, acha 5 achados (2 reforçam #14 e #10). Gate 2 → "publicar tudo". Resultado: relatório em `.ignore/reports/`, 3 issues novas, 2 comentários em #14 e #10.

**Outro projeto-fonte.** Usuário: "/friction-mining nas sessões do hexlog mesmo, última semana". Gate 1 → `-home-gabriel-personal-hexlog`, slug `personal-hexlog`. `list`, `verify_chain`, `create_process` e os `define_*` sem chamadas: lane `list-misc` pulada; uma tool nova do hexlog com bucket `d_cost_<tool>` vira lane de descoberta.

## Troubleshooting

- **Workflow volta `error`** (`ERROR:` do mine.py, `no hexlog calls in window` ou `missing args`): rode `python3 <skillDir>/scripts/mine.py --project-dir … --from … --to … --out …` à mão; causa comum é `projectDir` errado ou janela sem transcripts (`stats.json` sem chaves `calls:*`). `missing args` = o workflow foi chamado sem esta skill.
- **`lostLanes` não vazio**: um analista morreu. Relance com `Workflow({ name: "friction-mining-run", args, resumeFromRunId })` e os mesmos `args`; os agentes que já terminaram voltam do cache.
- **Resposta `persisted` sem arquivo**: o Claude Code já apagou o arquivo salvo. O tamanho vem do aviso; o conteúdo não. A lane deve dizer isso em vez de estimar.
- **Taxa de erro muito acima do esperado**: provável classificação de erro por regex no texto do `tool_result`. Só o JSON estruturado vale (ver `references/briefing.md`).
- **`gh label create` falha por permissão**: pare e peça ao usuário; não publique issue sem label.
