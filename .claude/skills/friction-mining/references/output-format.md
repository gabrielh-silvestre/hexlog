# Formato das saídas

## Relatório (`.ignore/reports/<to>-mineracao-<slug>.md`, pt-BR, só local)

Seções, nesta ordem:

1. `# Mineração das sessões do <projeto>: atrito no uso do hexlog (<from> a <to>)` + um parágrafo de escopo.
2. `## Resumo`: chamadas por tool, sessões, taxa de erro, onde está o atrito, quanto veio do harness.
3. `## Método`: script → analistas (listar as lanes que rodaram, fixas e de descoberta, as puladas e as perdidas com o sinal que ficou sem cobertura) → consolidação → verificação. Critério de confiança em uma linha.
4. `## Cobertura dos sinais`: tabela com os 5 sinais, definição e resultado na janela. Todo sinal com zero achados explica o porquê.
5. `## Achados do hexlog`: uma `###` por tool, em ordem `register`, `evaluate_gate`, `query`, `list`, outras. Dentro de cada tool, `####` por achado ordenado por confiança (high → medium → low). Título: `#### H-xx — <frase curta> · \`<confiança>\``. Corpo:
   - `- sinal: … · frequência: … · sessões-mãe: N (ids)`
   - `- citação: > <literal> (<sessão>, <ts>)`
   - `- causa: <arquivo:linha + 1 frase>`
   - `- melhoria: <1–2 frases>`
   - Achado que reforça issue aberta: acrescentar `- reforça: #N` e ir para comentário, não issue nova.
6. `## Harness do <projeto>`: tabela de atribuição por origem (somando o total de chamadas) e custo por execução das skills que mais chamam; depois `#### W-xx — <frase>` com `- confiança:`, citação, `arquivo:linha` e ajuste. Sem issue.
7. `## Prior art`: o que reforçou issues/itens existentes e o que não teve evidência nova.
8. `## Descartados`: uma linha por coisa olhada que não é atrito.

IDs `H-xx`/`W-xx` recomeçam em 01 a cada relatório. Links internos usam o slug do GitHub (minúsculas, sem pontuação, espaços viram `-`).

## Rascunhos (`.ignore/friction-mining/<to>/`)

Um arquivo por publicação; o conteúdo do arquivo é exatamente o que vai ao GitHub.

- `issue-H-xx.md`: primeira linha `title: <título>`, segunda `labels: confidence:<nível>`, linha em branco, corpo.
- `comment-<N>.md`: corpo do comentário na issue `#N`, com a evidência nova (frequência, sessões, citação). Achados que reforçam a mesma `#N` vão no mesmo arquivo, um parágrafo por H-xx.
- Achado `reinforce-only` (prior art sem issue) e achados W-xx não geram rascunho.

### Estilo dos corpos (o hook stop-slop barra o formulaico)

- Abrir com `Achado H-xx da mineração de sessões do <projeto> (<from> a <to>)`. O relatório fica só local: o corpo traz a evidência que sustenta o achado, sem link para ele.
- Narrativa direta com sujeito claro ("os agentes chamam…", "`src/x.ts` (`nomeDaFuncao`) faz…"). Nada de rótulos `Evidência:`/`Causa:`/`Proposta:` em sequência, nada de anúncio ("Este documento…"), nada de ressalva do tipo "leitura minha", "confiança média".
- Números com o impacto ao lado ("26 páginas, ~610k chars"), não soltos.
- No máximo uma citação em bloco, a mais forte.
- Proposta no fim, como frase afirmativa.
