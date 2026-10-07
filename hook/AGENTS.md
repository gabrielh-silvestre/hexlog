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
| `bash-guard.ts` | Lê `{tool_name, tool_input.command, cwd}` do stdin, tokeniza o comando com `shell-quote` e nega (exit 2) se algum token alcançar o diretório de dados (`dataDir`, de `src/directory.ts`), por igualdade, prefixo, glob (`*`, `?`, `[`, `{a,b}`, `**`) ou menção literal fora de qualquer token isolado (rede de segurança). Falha aberto: qualquer exceção interna, Node ausente ou stdin inválido cai em exit 0 (R-1). A mensagem de negação é o literal de `denialMessage` e lista as tools de leitura (6 das 12) |

## Navigation Notes
- A lógica de decisão é pura (`decide`, sem I/O, não exportada) e separada da
  execução real (`run`, que lê stdin e seta `process.exitCode`).
- `import.meta.main` não sobrevive ao bundle do esbuild; a checagem
  `isExecutedDirectly()` compara `process.argv[1]` com `fileURLToPath(import.meta.url)`.
- `test/bash-guard.spec.ts`: casos de negação e permissão contra o hook
  `.ts` real (I4), entrada inválida/exceção interna falha aberto (I7), e um
  describe `B1(b)` que builda o `.ts` de verdade com esbuild e roda o `.mjs`
  resultante (nega `cat <D>/x` com exit 2, permite `true` com exit 0, e
  confere que o bundle não contém o shim `Dynamic require of`).
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
