# Checagens da coleta

Lido no Passo 1. Cada checagem veio de um erro ou achado real do piloto (PRs #31 e #32 do hexlog, 2026-09-28).

## Prompt do subagente de coleta

Copie, trocando `<n>` e `<repo>`:

```
Somente leitura. Repositório <repo>, PR #<n>. Levante e devolva numa mensagem de conclusão com o resumo (máx. ~50 linhas):

1. PR: título, estado (draft/aberto/mergeado), head sha, data de criação, corpo. Lista de commits da branch com data/hora (`git log --format='%h %ad %s' --date=format:'%m-%d %H:%M' origin/<base>..origin/<branch>`).
2. Issues citadas no corpo (closes) e nos commits: título e, no corpo de cada uma, a fonte da evidência (relatório, achado H-xx, sessão).
3. Plano local: arquivos em .omc/plans/ ligados ao PR (branch, issues, tema); iterações (snapshots) com horário; veredito de cada review de Architect/Critic; trechos "Perguntas abertas ao usuário" e decisões marcadas como recomendação do Planner.
4. Wiki: páginas em .omc/wiki/ que citam o PR, a branch ou as issues; a de decisão principal.
5. Review: .ignore/reviews/prs/PR<n>/open-items.md, se existir.
6. Worktree: `wt list` para achar a worktree da branch; `git status --short` nela.
7. Relatórios de origem (docs/pesquisa/** ou branch de docs) citados pelas issues.

Aplique as checagens C1–C6 de .claude/skills/debug-vibecoding/references/checks.md e liste as que falharam, cada uma com a evidência.
```

## Checagens

| # | Checagem | Como | Se falhar |
|---|---|---|---|
| C1 | Corpo do PR está atual | commits e `closes` do corpo × commits da branch e issues citadas nos commits; horário de criação do PR × último commit e última iteração do plano | pendência "corpo desatualizado" |
| C2 | Worktree limpa | `git status --short` na worktree da branch | avisar antes de qualquer decisão que mude código; mostrar o que o WIP corrige |
| C3 | Decisões passaram pelo usuário | no plano, "Perguntas abertas ao usuário: nenhuma" ou decisões rotuladas como recomendação do Planner | item próprio no mapa: listar essas decisões |
| C4 | Issue fechada por inteiro | pedido da issue × o que o commit implementa (escopo reduzido, parte adiada) | pendência "resíduo" antes do merge fechar a issue |
| C5 | Ganho chega ao uso | a mudança é automática (default) ou opt-in (parâmetro novo)? quem consome (skills, scripts, outro repo)? | opt-in com consumidor fora do repo vira pendência "relatório no consumidor" |
| C6 | Porquê registrado | a decisão tem justificativa no ADR, plano, wiki ou issue? | marcar como inferido no cenário |

## Fontes por nível

| Nível | Melhor fonte | Fraca em |
|---|---|---|
| Produto | issues (evidência de uso real), relatórios de mineração, wiki de decisão | commits |
| Decisão | plano (princípios, opções rejeitadas), ADR, reviews de consenso | corpo do PR (envelhece) |
| Código | commit, `arquivo:linha`, diff | porquê |
| Bruto | transcripts `~/.claude/projects/<projeto>/*.jsonl` (caro; só sob demanda) | custo |
