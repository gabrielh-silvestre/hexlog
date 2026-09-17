<!-- Parent: ../AGENTS.md -->
<!-- Generated: 2026-09-17 | Updated: 2026-09-17 -->

# hook

## Purpose
Hook `PreToolUse` da tool `Bash` do Claude Code. Impede que um agente
contorne as tools MCP do hexlog (`listar`, `estado`, `eventos`, `cadeia`)
lendo o diretório de dados por fora, com `cat`, `grep`, `jq` etc. Só
tokeniza o comando recebido; nunca executa nada.

## Key Files
| File | Description |
|---|---|
| `guarda-bash.ts` | Lê `{tool_name, tool_input.command, cwd}` do stdin, tokeniza o comando com `shell-quote` e nega (exit 2) se algum token alcançar o diretório de dados (`dirDados`, de `src/diretorio.ts`), por igualdade, prefixo, glob (`*`, `?`, `[`, `{a,b}`, `**`) ou menção literal fora de qualquer token isolado (rede de segurança). Falha aberto: qualquer exceção interna, Node ausente ou stdin inválido cai em exit 0 (R-1) |

## For AI Agents
### Working In This Directory
- `guarda-bash.ts` é buildado pelo `esbuild` (`scripts/build.ts`, entrada
  `guarda-bash` → `dist/guarda-bash.mjs`) e é esse `.mjs`, não a working tree,
  que o `instalar.ts` copia para `~/.local/lib/hexlog/<versão>/` e registra em
  `~/.claude/settings.json` (`matcher: '^Bash$'`). Mudar este `.ts` só afeta
  sessões novas depois de rodar `node scripts/instalar.ts` de novo.
- A lógica de decisão é pura (`decidir`, sem I/O) e separada da execução real
  (`rodar`, que lê stdin e seta `process.exitCode`) — teste contra `decidir`,
  nunca subindo um processo, quando possível.
- `import.meta.main` não sobrevive ao bundle do esbuild; a checagem
  `executadoDiretamente()` compara `process.argv[1]` com `fileURLToPath(import.meta.url)`.

### Testing Requirements
- `test/guarda-bash.spec.ts`: casos de negação e permissão contra `decidir`
  (I4), entrada inválida/exceção interna falha aberto (I7), e um describe
  `B1(b)` que builda o `.ts` de verdade com esbuild e roda o `.mjs` resultante
  (nega `cat <D>/x` com exit 2, permite `true` com exit 0, e confere que o
  bundle não contém o shim `Dynamic require of`).
- Rodar com `npm test` (jest, testa o `.ts` fonte direto via ts-jest).

### Common Patterns
- Prefixo literal decide antes de expandir glob: um segmento com `**` ou uma
  chave `{a/b,c}` com barra é truncado no prefixo, porque `path.matchesGlob`
  não expande `**` até a profundidade de `D`.
- `~` só é expandido no início do token ou logo após `=` (`--opt=~/x`); o
  `shell-quote` não expande til por conta própria.

## Dependencies
### Internal
- `../src/diretorio.ts` (`dirDados`)

### External
- `shell-quote` (parse dos tokens do comando)
- `es-toolkit` (`isNil`, `isString`)
- `node:fs`, `node:os`, `node:path`, `node:url`

<!-- MANUAL: Any manually added notes below this line are preserved on regeneration -->
