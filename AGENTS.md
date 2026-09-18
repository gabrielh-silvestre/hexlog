<!-- Generated: 2026-09-17 | Updated: 2026-09-17 -->

# hexlog

## Purpose
Servidor MCP stdio (TypeScript, Node ≥24.18.1) para agentes registrarem o próprio histórico de trabalho: decisões, marcos e veredictos. Cada processo tem um log JSONL append-only com cadeia de hash sha256 + JCS. O servidor expõe exatamente 10 tools. Não há CLI nem daemon: só o servidor MCP e um hook de isolamento Bash, instalados no Claude Code como bundle esbuild em `~/.local/lib/hexlog/<versão>/`. Os dados ficam em `$XDG_DATA_HOME/hexlog/` (fallback `~/.local/share/hexlog`).

## Key Files
| File | Description |
|------|-------------|
| `package.json` | Dependências fixadas, scripts `test`/`typecheck`/`build` e config do jest (ts-jest em CJS) |
| `tsconfig.json` | Configuração do TypeScript |
| `README.md` | Documentação de uso, instalação, tools e formato dos dados |
| `.gitignore` | Arquivos ignorados |

## Subdirectories
| Directory | Purpose |
|-----------|---------|
| `src/` | Servidor MCP, cadeia de hash, log, estado, tools e instalação (see `src/AGENTS.md`) |
| `hook/` | Hook PreToolUse que bloqueia acesso via Bash ao diretório de dados (see `hook/AGENTS.md`) |
| `scripts/` | Build esbuild e instalador (see `scripts/AGENTS.md`) |
| `test/` | Specs unit, property, MCP em memória, e2e stdio e pacote (see `test/AGENTS.md`) |
| `docs/` | ADR 0001/0002 e pesquisa que fundamenta as decisões (see `docs/AGENTS.md`) |

## For AI Agents

### Working In This Directory
- O log é estritamente append-only, gravado sob lock por diretório (`mkdirSync` exclusivo + token). Nunca crie código que edite ou remova linhas.
- A cadeia usa um único predicado (`isValidLink` em `src/chain.ts`) para escrita e verificação. Não duplique essa lógica.
- Toda tool passa por `execute()` em `src/mcp.ts`. `HexlogError` vira `{code, message, details}`, e qualquer outra exceção vira `INTERNAL`, sem stack na resposta.
- São exatamente 10 tools. Adicionar ou remover uma quebra testes do instalador e do e2e.
- `register_type`/`register_vocabulary`/`register_gate` versionam em semver `major.minor` em
  `<nome>/<versão>.json`, nunca sobrescrevem. O arquivo legado `<nome>.json` nunca é apagado,
  reescrito ou materializado — segue como fonte fixa da versão `1.0` para sempre.
- Trocar uma lib ou uma decisão exige conferir antes `docs/adr-0001-hexlog-mvp.md`,
  `docs/adr-0002-versionamento-definicoes.md` e `docs/pesquisa/hexlog-pesquisa-libs.md`.
- `node scripts/install.ts` escreve em `~/.claude/settings.json`, `~/.claude.json` e `~/.local/lib/hexlog/`. Não rode sem pedido explícito. `--check` só verifica.

### Testing Requirements
- `npm test` roda tudo. `npx jest test/<arquivo>.spec.ts` roda um spec.
- `npm run typecheck` antes de concluir.
- Não precisa de `npm run build` prévio: os specs que dependem de bundle constroem o artefato num processo filho.
- `test/search.budget.spec.ts` mede tempo (índice ≤500ms, busca ≤2000ms) e pode falhar em máquina lenta.

### Common Patterns
- Nomes de módulos, funções e códigos de erro em inglês; comentários e descrições de teste continuam em português (ver `CLAUDE.md`).
- Esquemas Zod para eventos e entradas de tools. O núcleo (chain, state, gates) é puro, e o I/O fica em `log.ts` e `definitions.ts`.
- IDs nos títulos de teste (M#, N#, S#, B#, I#, C#, Q#, R-#, U-#) remetem a critérios do ADR 0001.
- Versões de dependências fixadas sem `^`.

## Dependencies

### External
- `@modelcontextprotocol/server` 2.0.0: servidor MCP stdio
- `zod` 4: validação de eventos e entradas
- `canonicalize`: JCS para o hash da cadeia
- `minisearch`: busca textual em eventos
- `shell-quote`: tokenização de comandos no hook
- `esbuild`, `jest` + `ts-jest`, `fast-check`: build e testes

<!-- MANUAL: Any manually added notes below this line are preserved on regeneration -->
