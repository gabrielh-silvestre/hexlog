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
| `bash-guard.ts` | Lê `{tool_name, tool_input.command, cwd}` do stdin, tokeniza o comando com `shell-quote` e nega (exit 2) se algum token alcançar o diretório de dados (`dataDir`, de `src/directory.ts`), por igualdade, prefixo, glob (`*`, `?`, `[`, `{a,b}`, `**`) ou menção literal, que `decide` confere antes de tokenizar. Nega também o que não consegue decidir: token com glob acima de `MAX_GLOB_TOKEN_LENGTH`, `MAX_BRACES` ou `MAX_BRACKETS`, comando cujos tokens com glob somam mais que `MAX_GLOB_TOTAL_LENGTH`, token cujo casamento lança e comando que o `shell-quote` não parseia (`${}`). Falha aberto só para entrada que não é comando Bash: stdin vazio, JSON inválido, `tool_name` diferente de `Bash` ou Node ausente (R-1). A mensagem de negação é o literal de `denialMessage`, que lista as tools de leitura (6 das 12); a negação por comando indecidível usa `undecidableMessage`, sem citar `D`. Em comando composto (`&&`, `||`, `;`, `|`, `&`, `|&`) ambas acrescentam ` Matched: <segmento>` (até 200 caracteres, controle vira `?`) |

## Navigation Notes
- A lógica de decisão é pura (`decide`, sem I/O, não exportada) e separada da
  execução real (`run`, que lê stdin e seta `process.exitCode`).
- `import.meta.main` não sobrevive ao bundle do esbuild; a checagem
  `isExecutedDirectly()` compara `fs.realpathSync(process.argv[1])` com
  `fileURLToPath(import.meta.url)`, para o hook valer também quando chamado por symlink.
- Os tetos de glob (`MAX_GLOB_TOKEN_LENGTH`, `MAX_BRACES`, `MAX_BRACKETS`) valem só
  para token com caractere de glob, e `MAX_GLOB_TOTAL_LENGTH` limita a soma desses tokens no
  comando: sem eles, um `[`×4096 ou centenas de tokens abaixo do teto levam segundos e o hook
  morre no timeout, liberando o comando. Antes do casamento, cada grupo de chave vira `*`
  (`collapseBraceGroups`), porque o `path.matchesGlob` expande o produto das chaves e das faixas.
  Falso positivo aceito: token ou comando legítimo acima do teto é negado.
- `test/bash-guard.spec.ts`: casos de negação e permissão contra o hook
  `.ts` real (I4), entrada inválida falha aberto (I7), tokens hostis negados
  (U1), trecho citado na mensagem (#45), entrypoint por symlink (M2), e um
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
- `es-toolkit` (`isNil`, `isString`, `take`, `takeWhile`)
- `node:fs`, `node:os`, `node:path`, `node:url`

## Manual Notes

## Diretrizes

- [instalacao-e-hooks.md](../docs/directives/instalacao-e-hooks.md): build, instalação e atualização do hook, regras de falha aberta
- [qualidade-e-testes.md](../docs/directives/qualidade-e-testes.md): o hook é testado sempre por processo real
