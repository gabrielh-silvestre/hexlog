# hook

**Parent context:** `../AGENTS.md`
**Generated:** 2026-09-17 · **Updated:** 2026-10-07

## Purpose
Um hook do Claude Code. `bash-guard.ts` (`PreToolUse` da tool `Bash`) impede
que um agente contorne as tools MCP do hexlog (`list`, `query`,
`verify_chain`, `read_attachment`, `evaluate_gate`, `describe_type`) lendo o diretório de dados por fora, com `cat`, `grep`, `jq` etc. Só
tokeniza o comando recebido; nunca executa nada.

## Key Files
| File | Description |
|---|---|
| `bash-guard.ts` | Lê `{tool_name, tool_input.command, cwd}` do stdin, tokeniza o comando com `shell-quote` e nega (exit 2) se algum token alcançar o diretório de dados (`dataDir`, de `src/directory.ts`), por igualdade, prefixo, glob (`*`, `?`, `[`, `{a,b}`, `**`) ou menção literal, que `decide` confere antes de tokenizar. Nega também o que não consegue decidir: token com glob que o shell expande (sem aspas e sem `\`) acima de `MAX_GLOB_TOKEN_LENGTH`, `MAX_BRACES` ou `MAX_BRACKETS`, comando cujos tokens com glob somam mais que `MAX_GLOB_TOTAL_LENGTH`, comando acima de `MAX_COMMAND_LENGTH` (1 MiB). Libera o comando que o `shell-quote` não parseia (`${}`) e o token cujo casamento lança. Falha aberto também para entrada que não é comando Bash: stdin vazio, JSON inválido, `tool_name` diferente de `Bash`, Node ausente ou hook morto pelo `timeout` de 10 s. A mensagem de negação é o literal de `denialMessage`, que lista as tools de leitura (6 das 12); a negação por custo usa `undecidableMessage`, que diz que o comando não cita `D` literalmente e foi negado só por um teto. Em comando composto (`&&`, `||`, `;`, `|`, `&`, `|&`) ambas acrescentam ` Matched: <segmento>` (até 200 caracteres, controle e formatação viram `?`) |

## Navigation Notes
- A lógica de decisão é pura (`decide`, sem I/O, não exportada) e separada da
  execução real (`run`, que lê stdin e seta `process.exitCode`).
- `import.meta.main` não sobrevive ao bundle do esbuild; a checagem
  `isExecutedDirectly()` compara `fs.realpathSync(process.argv[1])` com
  `fileURLToPath(import.meta.url)`, para o hook valer também quando chamado por symlink.
- Os tetos de glob (`MAX_GLOB_TOKEN_LENGTH`, `MAX_BRACES`, `MAX_BRACKETS`) valem só
  para o token que o shell expande: `maskQuoted` troca o texto entre aspas e escapado por `x` num
  segundo parse (`maskedTokensOf`, só quando algum token passa dos tetos) e `toCandidates` marca o
  `expandable` de cada token. As regras (o que faz o `maskQuoted` desistir, o orçamento total, o
  limite aceito) estão em `docs/directives/instalacao-e-hooks.md` (ver `## Diretrizes` abaixo).
- `decide` expande o `~` de cada token uma vez e `toCandidates` guarda o resultado em `expanded`:
  `skipsGlobMatch`, o orçamento e `classifyToken` medem esse mesmo valor. `skipsGlobMatch` pula o
  casamento do token só entre aspas acima dos tetos, que `literalPrefixReaches` confere pelo prefixo
  literal.
- O `shell-quote` só devolve `{op: 'glob'}` para `*` e `?`; `{` e `[` voltam como string, sem marca
  de aspas, por isso o segundo parse.
- `MAX_GLOB_TOTAL_LENGTH` e `MAX_COMMAND_LENGTH` existem para o hook não morrer no timeout, que libera
  o comando: sem eles, um `[`×4096 ou centenas de tokens abaixo do teto levam segundos.
- O `path.matchesGlob` expande o produto das chaves e das faixas, então a chave só expande até
  `MAX_BRACE_EXPANSION` (32) alternativas (`braceAlternatives`); acima disso, ou com faixa `..`, cada
  grupo vira `*` (`collapseBraceGroups`), e `.*` na abertura de um segmento oculto de `D`, que o `*`
  não casa.
- O `shell-quote` devolve `{comment}` com todo o resto da entrada a partir de um `#` fora de aspas
  (inclusive `a#b` e as linhas seguintes); `parseCommand` tokeniza esse trecho de novo, uma linha por
  vez e com o `#` trocado por espaço, para o `cat <glob>` depois do comentário ser conferido. A
  linha desse trecho que o `shell-quote` não parseia (`${}`) é liberada sozinha, sem levar as outras. Os tokens do trecho engolido contam nos tetos de custo e no
  orçamento de glob como os demais.
- Falso positivo aceito: token com glob sem aspas ou comando legítimo acima do teto é negado, e o glob
  que alcança `D` dentro de um comentário de verdade também.
- `test/bash-guard.spec.ts`: casos de negação e permissão contra o hook
  `.ts` real (I4), entrada inválida falha aberto (I7), tokens hostis negados
  (U1; o comando que o `shell-quote` não parseia passa), trecho citado na mensagem (#45), entrypoint por symlink (M2), e um
  describe `B1(b)` que builda o `.ts` de verdade com esbuild e roda o `.mjs`
  resultante (nega `cat <D>/x` com exit 2, permite `true` com exit 0, nega
  também por symlink e confere que o bundle não contém o shim `Dynamic require of`).
- Rodar com `npm test` (jest); o spec do hook roda fora do transform `ts-jest`.
- Prefixo literal decide antes de expandir glob: um segmento com `**` ou uma
  chave `{a/b,c}` com barra é truncado no prefixo, porque `path.matchesGlob`
  não expande `**` até a profundidade de `D`.
- `~` só é expandido no início do token ou logo após `=` (`--opt=~/x`); o
  `shell-quote` não expande til por conta própria (`TILDE_REGEX`).

## Dependencies
### Internal
- `../src/directory.ts` (`dataDir`)

### External
- `shell-quote` (parse dos tokens do comando)
- `es-toolkit` (`isNil`, `isString`, `sumBy`, `take`, `takeWhile`)
- `node:fs`, `node:os`, `node:path`, `node:url`

## Manual Notes

## Diretrizes

- [instalacao-e-hooks.md](../docs/directives/instalacao-e-hooks.md): build, instalação e atualização do hook, regras de falha aberta
- [qualidade-e-testes.md](../docs/directives/qualidade-e-testes.md): o hook é testado sempre por processo real
