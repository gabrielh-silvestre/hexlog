# Briefing comum dos analistas

Leia inteiro antes de abrir qualquer bucket. Tarefa READ-ONLY: não edite arquivos do repo, não chame tools `mcp__hexlog__*`, não publique nada. Responda em pt-BR.

## Onde está o material

- `{out}/calls.jsonl`: todas as chamadas da janela, uma por linha (`session`, `parent` = sessão-mãe, `ts`, `tool`, `args`, `size`, `origin`, `is_error`, `code`, `persisted`, `warn_kinds`, `before` = texto do assistente antes da chamada).
- `{out}/<bucket>.jsonl`: sinais já separados pelo script. `{out}/stats.json`: contagens.
- Transcripts brutos para contexto: `{projectDir}/<parent>.jsonl` e `{projectDir}/<parent>/subagents/<session>.jsonl`. Nunca carregue um transcript inteiro; use python ou jq e imprima só trechos.
- Código do hexlog: `src/`, `skills/hexlog/SKILL.md`, `docs/` na raiz do repo.

## Sinais

| Sinal | Definição |
|---|---|
| (a) erro | `is_error` ou objeto top-level com `code`+`message` |
| (b) retry | mesma tool rechamada em até 3 chamadas depois de (a), com args diferentes |
| (c) orientação | leitura repetida sobre o mesmo processo/target sem escrita depois |
| (d) custo | resposta acima de 10k chars **e** redundante (metadado não usado, warning repetido, conteúdo já lido, desviada para arquivo) |
| (e) correção do usuário | mensagem real do usuário corrigindo o agente ou reclamando do hexlog |

## Armadilhas de método (já custaram uma rodada)

- Regex sobre o texto do `tool_result` conta como erro os códigos de domínio que o cliente grava no payload (ex.: `AGENT_BUILDER_DISPATCH_FAILED`) e o `"warnings":[]` vazio de todo sucesso. Classifique erro só pelo JSON estruturado.
- Resposta acima do limite do Claude Code vira `Error: result (N characters) exceeds maximum allowed tokens. Output has been saved to <arquivo>`. O script já trata (`persisted: true`); se você reextrair, trate também.
- O bucket `c_orient_*` usa adjacência posicional: toda chamada sem `target` conta como repetida. Confira se o par compartilha processo/target antes de chamar de atrito, e descarte subagentes read-only por desenho ("não registre no hexlog").
- `role=user` inclui carga de skill, mensagens entre agentes e o 1º prompt de subagente; `e_user` já filtra, mas confira. Ela só pega mensagens que citam "hexlog": correções sem a palavra ("não, registra como milestone") aparecem perto das chamadas, no transcript.
- Heurística de redundância do script subconta custo: meça a composição do payload (quanto é metadado que o agente não cita depois) antes de concluir que não há custo.

## Critério de confiança (o workflow recalcula; informe os insumos certos)

- `high`: 3 ou mais sessões-mãe distintas e causa localizada em `arquivo:linha`.
- `medium`: 2 sessões-mãe, ou 3+ com causa só inferida.
- `low`: 1 sessão-mãe.

Conte **sessões-mãe** (`parent`), não arquivos de subagente.

## Prior art

Não re-reporte o que já está em `{priorArt}`. Se achar evidência nova de um item listado ali, devolva o achado com `reinforces` = identificador do item (ex.: `#14`, `P7`).

## Causa no harness

Se a causa for skill, rule ou prompt do projeto-fonte (e não o servidor hexlog), marque `harness: true` e cite `arquivo:linha` no projeto-fonte ou em `~/.claude`. Se o ajuste pedir também mudança no hexlog, descreva as duas pontas.

## O que devolver

Um item por achado, no schema pedido. `quote` é trecho literal do transcript, até 300 chars, com `quote_session` e `quote_ts`. Em `discarded`, diga em uma linha o que olhou e por que não é atrito. Se o escopo não tiver atrito real, devolva `findings: []` e explique com números em `discarded`.
