# friction-mining: como funciona e como portar

A `friction-mining` minera os transcripts do Claude Code de um projeto-fonte numa janela de datas atrás de atrito no uso real de uma tool MCP (hoje, o hexlog). Ela entrega um relatório ranqueado mais rascunhos de issue e comentário, e só publica depois do ok humano. Nasceu da primeira rodada manual (relatório `docs/pesquisa/2026-09-mineracao-sessoes-work.md` do PR #5, issues #6–#21) e congela as decisões de método daquela rodada.

## Peças

| Peça | Caminho | Papel |
|---|---|---|
| Skill | `.claude/skills/friction-mining/SKILL.md` | Conduz a rodada: gate 1 (janela e fonte), preparação (branch via `wt`, prior art), dispara o workflow, gate 2 (aprovar publicação), publicação. Só invocação explícita (`disable-model-invocation: true`). |
| Script | `.claude/skills/friction-mining/scripts/mine.py` | Extração determinística: lê os `.jsonl`, deduplica, classifica e separa os sinais em buckets. Sem dependências além da stdlib do Python. |
| Workflow | `.claude/workflows/friction-mining-run.js` | Fan-out: roda o script por um agente, abre as lanes de análise em paralelo, consolida, calcula confiança, escreve relatório e rascunhos, verifica e corrige (até 2 voltas). |
| Briefing | `.claude/skills/friction-mining/references/briefing.md` | O que cada lane lê antes de começar: material, sinais, armadilhas, critério de confiança, formato de retorno. |
| Formato | `.claude/skills/friction-mining/references/output-format.md` | Estrutura do relatório e dos rascunhos, e o estilo que passa no hook stop-slop. |

O workflow não tem acesso a filesystem nem a Node; tudo que toca disco (rodar o script, escrever relatório) acontece dentro de um `agent()`. Ele também não pausa, por isso os gates humanos ficam na skill: um antes e um depois do workflow.

## Contratos

**Entrada do script:** `--project-dir` (diretório em `~/.claude/projects/`), `--from`/`--to` (inclusivos, no fuso de `--tz-offset`, padrão `-03:00`; o `ts` do transcript é UTC e o script converte a janela), `--out`.

**Saída do script (`--out`):**
- `calls.jsonl`: uma linha por chamada da tool na janela, com `session`, `parent` (sessão-mãe), `ts`, `tool`, `args`, `size`, `origin`, `is_error`, `code`, `persisted`, `warn_kinds`, `before`.
- Buckets `a_error_<tool>`, `c_orient_<tool>`, `d_cost_<tool>`, `e_user` (`.jsonl`).
- `stats.json`: `calls:<tool>`, `bucket:<nome>`, `bucket_parents:<nome>`, `c_orient:*`, `d_big:<tool>`, `origin:*`, `dup_uuid_skipped`.

**Args do workflow:** `projectDir`, `projectSlug`, `from`, `to`, `repoRoot`, `skillDir`, `out`, `reportPath`, `draftsDir`, `priorArt`.

**Retorno do workflow:** `report`, `drafts`, `counts` (chamadas, achados por confiança, issues, comentários, reforços sem issue, harness), `lanes`, `skippedLanes`, `lostLanes`, `verifyRan`, `residualProblems`. Chamado sem os args obrigatórios, devolve `error` sem rodar nada.

**Achado (schema das lanes):** `title`, `tool`, `signal`, `harness`, `reinforces`, `occurrences`, `parent_sessions`, `metrics`, `quote`, `quote_session`, `quote_ts`, `cause`, `cause_located`, `improvement`. A confiança não vem da lane: o workflow calcula a partir de `parent_sessions` e `cause_located`, para que o critério seja o mesmo em toda rodada.

## Decisões de método congeladas

- Evidência é só uso real da tool. Os sinais são erro, retry, orientação, custo (resposta > 10k chars **e** redundante) e correção do usuário.
- Confiança: `high` = 3+ sessões-mãe e causa em `arquivo:linha`; `medium` = 2 sessões-mãe, ou 3+ com causa inferida; `low` = 1.
- Achado cuja causa é o harness do projeto-fonte vai para seção separada, sem issue.
- Achado que bate com issue aberta vira comentário nela; item de prior art sem issue só reforça no relatório.
- Relatório agrupado por tool e, dentro dela, por confiança.
- Lanes fixas por tool (puladas quando a tool não teve chamada), lanes de descoberta para bucket sem dono e uma lane de harness sempre, em lotes de no máximo 12 agentes.
- Subagentes em `sonnet` (constante `MODEL` no workflow), pela regra global do usuário.

## Armadilhas que o método já trata

- **Regex em `tool_result` superestima erro ~13x**: códigos de domínio gravados no payload e `"warnings":[]` vazio parecem erro. O script classifica só pelo JSON estruturado.
- **Resposta grande some do parse**: acima do limite do Claude Code, o transcript guarda só `Error: result (N characters) exceeds maximum allowed tokens. Output has been saved to <arquivo>`. O script lê o tamanho do aviso e o conteúdo do arquivo, se ainda existir, e marca `persisted`.
- **Subagente fork duplica mensagens**: dedupe por `uuid`.
- **Atribuição inflada**: "última skill invocada" sem reset atribui chamadas a skills que só passaram pelo fluxo. O script zera a skill do turno a cada mensagem real do usuário e separa continuação, subagente e pedido direto.
- **`role=user` não é só o usuário**: carga de skill, lembretes do harness e mensagens entre agentes chegam como `user`; o script filtra antes do sinal (e).
- **Hook stop-slop barra corpo formulaico**: rótulos `Evidência/Causa/Proposta` em sequência e ressalvas ("leitura minha") são rejeitados. O formato de rascunho já evita.

## Como portar para outra tool MCP

1. **Script** (`mine.py`): troque `TOOL_PREFIX` (ex.: `mcp__outro__`), `READS` (tools de leitura) e `WRITES` (tools de escrita). O resto é genérico. Se a tool devolver erro em outro formato, ajuste o bloco que preenche `c['code']`.
2. **Workflow** (`friction-mining-run.js`): reescreva `FIXED` com as lanes da nova tool (uma por grupo de tools, com `tools`, `match` de bucket e `focus`), ajuste `TOOL_ORDER` e, se quiser outro modelo, `MODEL`. As lanes `user` e `harness` são genéricas.
3. **Briefing**: troque a menção a `mcp__hexlog__*`, o caminho do código do servidor e os exemplos das armadilhas.
4. **Formato**: troque o título do relatório e o owner/repo dos links.
5. **Skill**: troque owner/repo das chamadas GitHub, o prefixo da branch e a description.
6. Rode uma janela já conhecida e compare `stats.json` com números que você sabe de antemão antes de confiar nas lanes.

Fora do Claude Code (sem Workflow), o formato equivalente é: rodar o script, disparar um agente por lane com o briefing, consolidar, e aplicar o mesmo critério de confiança em código.
