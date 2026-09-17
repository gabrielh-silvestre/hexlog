## Frente: Hook PreToolUse em TypeScript (detecção de caminho) e instalação idempotente

### 1. Parsers de shell (probe com env `{HOME, XDG_DATA_HOME}` simulado)
| Caso | shell-quote 1.10.0 | sh-syntax 0.6.0 (mvdan-sh WASM) | regex/normalize |
|---|---|---|---|
| `cat ~/.local/share/hexlog/p/x.jsonl` | pega | pega | pega |
| `cat "$HOME/.local/share/hexlog/..."` | pega (expande `$HOME` com env explícito) | pega (caminhar AST) | pega se conhecer `$HOME` |
| `jq . ${XDG_DATA_HOME}/hexlog/...` | pega | pega | pega se conhecer a var |
| `cd ~/.local/share && cat hexlog/p/x.jsonl` | **escapa** | **escapa** | **escapa** (ninguém rastreia `cd`) |
| `find ~ -name '*.jsonl'` | passa (correto) | passa | passa |
| `grep -r foo ~/.local/share/` | passa (sem "hexlog") | passa | passa |
| `cat ~/.local/share/hex""log/x` | **pega** (word-joining) | pega | **escapa** |
| heredoc com o caminho no corpo | pega (por acidente; tokeniza `<<` mal) | pega | pega |
| `cat $(echo ~/.local/share/hexlog)` | pega (literal vira token) | pega | pega |
| `ls ~/.local/share` | passa, sem falso positivo | passa | passa |

- Custo: shell-quote ~instantâneo (JS puro, 0 deps); sh-syntax ~68 ms/processo (import ESM do wrapper; parse warm 3,3 ms; WASM 734 KB). tree-sitter-bash exige compilação nativa — não testado.
- Limitação comum aceita: `cd <pai> && <relativo>`. Documentar como conhecida.

### 2. Referência local (Go, só leitura)
`own-harness/internal/hook/worktreeguard/parser.go`: tokenizer manual (~250 linhas, 0 libs) — state machine de aspas/escapes, segmentos por `;`, `\n`, `|`, `&&`, `||`, `&` (sem confundir `2>&1`), marca `invalid` em `(`, `)`, `{`, `}`, backtick. Caminha prefixos (`env`/`command`, `VAR=x`), basename do executável, opções globais do git, switch por subcomando. Testes: `corpus.go` gera ~644 casos por produto cartesiano + casos nomeados; `golden_test.go` compara com oracle **congelado** em `testdata/oracle_verdicts.json` e falha se o corpus mudar de tamanho. `run.go` falha aberto (JSON inválido ou `command` ausente → allow). **Espelhar no TS: corpus gerado + oracle JSON congelado.**

### 3. Node 24 executando `.ts`
- nodejs.org/api/typescript.html: type stripping **Stable** desde v24.12.0; sem warning desde v24.3.0; ligado por padrão desde v23.6.0.
- Probe: `enum` e parameter properties → `ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX`; interfaces/tipos OK. Node não lê `tsconfig.json`; `erasableSyntaxOnly` serve só no `tsc --noEmit`. Imports com extensão explícita.
- Latência (10 execuções): `.js` mediana ~38,5 ms; `.ts` ~75 ms (+~35 ms por comando Bash).

### 4. Instalação idempotente em settings.json
- `~/.claude/settings.json` é JSON estrito válido (271 linhas; `//` só dentro de strings).
- `jsonc-parser` `modify()+applyEdits()`: diff de **2 linhas**, formatação preservada.
- `JSON.parse+stringify(…,2)`: diff de **13 linhas** (reescreve e desescapa `<`/`>`).
- Escrita atômica: `writeFileSync(tmp)` + `renameSync` no mesmo diretório (ext4). Backup `.bak` antes. Modo `--check` só verifica.

### Candidatos
| Candidato | Versão / release | Licença | Manutenção | ESM/TS/Node 24 | Deps | Encaixe | Veredito |
|---|---|---|---|---|---|---|---|
| **shell-quote** | 1.10.0 / 2026-07-10 | MIT | ljharb, ativo | CJS, ok | 0 | tokeniza + remove aspas + word-joining + expande `$VAR` | **Adotar** |
| bash-parser | 0.5.0 / 2022-06-13 | MIT | parado | datado | ~20 | overkill | Descartar |
| @ericcornelissen/bash-parser | 0.5.3 / 2025-05-29 | MIT | fork | idem | ~16 | idem | Descartar |
| sh-syntax | 0.6.0 / 2026-07-08 | MIT | ativo | ESM, WASM 734 KB | 0 | parser completo | Escalonamento futuro |
| tree-sitter-bash / web-tree-sitter | 0.25.1 / 0.27.0 | MIT | ativos | nativo (node-gyp) | node-addon-api | sem ganho | Descartar |
| **jsonc-parser** | 3.3.1 / 2026-07-16 | MIT | microsoft (VS Code) | CJS/ESM | 0 | diff cirúrgico | **Adotar** |
| comment-json | 5.0.0 / 2026-04-12 | MIT | mantido | CJS | esprima, array-timsort | mais pesado | Descartar |
| write-file-atomic | 8.0.0 / 2026-09-09 | ISC | npm | CJS | signal-exit | trata Windows | Nativo cobre |

### Decisão recomendada
- **Parser do hook:** Adotar `shell-quote`.
- **Runtime do hook:** `.ts` direto no Node 24 (sem build); `erasableSyntaxOnly` no tsconfig para o type-check.
- **Edição do settings.json:** Adotar `jsonc-parser`; checar existência antes de `modify()` (idempotência).
- **Escrita atômica:** Nativo (tmp + rename) + backup + `--check`.

### Riscos e armadilhas
- `cd` não rastreado — limitação documentada.
- shell-quote só expande `$VAR` com env passado; `~` não é expandido → trocar `~/` por `os.homedir()` antes de comparar.
- +35 ms por comando Bash com `.ts`.
- settings.json mistura tipos de hook (`command`, `prompt`); a entrada do hexlog precisa de chave de identidade (ex.: caminho absoluto do script do hook).

### Evidência
- `node --help | grep strip`; probes `enum-test.ts`, `paramprops-test.ts`, `plain-test.ts`.
- Latências `.js`: 38,41,40,35,41,39,38,36,38,41; `.ts`: 71,79,74,76,70,70,73,80,84,82.
- `npm view shell-quote` → 1.10.0, 2026-07-10, MIT, sem deps. `npm view jsonc-parser` → 3.3.1, 2026-07-16, MIT. `npm view bash-parser time.modified` → 2022-06-13.
- Probes em `scratchpad/hook-instalacao/`.

### Perguntas em aberto
Nenhuma.
