<!-- Generated: 2026-09-17 | Updated: 2026-09-17 -->

# hexlog

## Purpose
Servidor MCP stdio (TypeScript, Node ≥24.18.1) para agentes registrarem o próprio histórico de trabalho: registros tipados com relações e gates declarativos, sem termo de fluxo no código. Cada processo tem um log JSONL append-only com cadeia de hash sha256 + JCS. O servidor expõe exatamente 11 tools. Não há CLI nem daemon (só scripts read-only em `scripts/`): servidor MCP e hook de isolamento Bash são instalados no Claude Code como dois bundles esbuild em `~/.local/lib/hexlog/<versão>/`, junto com as skills de `skills/`. Os dados ficam em `$XDG_DATA_HOME/hexlog/.v1/` (fallback `~/.local/share/hexlog/.v1/`); dado 0.x em `<D>` é recusado com `LEGACY_DATA` até o instalador arquivá-lo.

## Key Files
| File | Description |
|------|-------------|
| `package.json` | Dependências fixadas, scripts `test`/`typecheck`/`build` e config do jest (ts-jest em CJS) |
| `tsconfig.json` | Configuração do TypeScript |
| `README.md` | Documentação de uso, instalação, tools e formato dos dados |
| `.gitignore` | Arquivos ignorados |
| `.hexlog/` | Mapa do fluxo do OMC (`flow.md`) e os schemas dos cinco tipos custom de auditoria (`types/*.json`, ADR 0006): fonte versionada dos `register_type` e do cálculo offline de `hashes.schemas` |

## Subdirectories
| Directory | Purpose |
|-----------|---------|
| `src/` | Servidor MCP, domínio puro, cadeia de hash, comandos, consultas, adaptadores de disco, tools e instalação (see `src/AGENTS.md`) |
| `hook/` | Hook PreToolUse que bloqueia acesso via Bash ao diretório de dados (see `hook/AGENTS.md`) |
| `scripts/` | Build esbuild, instalador e scripts read-only de insights, export e timeline (see `scripts/AGENTS.md`) |
| `test/` | Specs unit, property, MCP em memória, e2e stdio sobre o bundle real e pacote (see `test/AGENTS.md`) |
| `docs/` | ADR 0001/0002/0005/0006 e pesquisa que fundamenta as decisões (see `docs/AGENTS.md`) |
| `skills/` | Três skills, cada uma instalada pelo instalador em `~/.claude/skills/<nome>/SKILL.md`: `hexlog` (bootstrap/diagnóstico), `hexlog-setup` (mapeia o fluxo de um repositório alvo em `.hexlog/flow.md`, roda uma vez) e `hexlog-flow` (registra e consulta registros e gates contra esse mapa) |

## For AI Agents

### Working In This Directory
- O log é estritamente append-only, gravado sob lock por processo (`mkdir` exclusivo com dono por pid, `bootId` e token, `src/adapters/fs/lock.ts`). Nunca crie código que edite ou remova linhas.
- A leitura e a escrita do log usam um único predicado (`isValidLine` em `src/shared/loader.ts`). Não duplique essa lógica. Ele devolve `{ link }` ou `{ reasons }` (`invalid-line`, `diverging-seq`, `hash-mismatch`).
- Toda tool passa por `execute()` em `src/mcp/kernel.ts`. `HexlogError` vira `{code, message, details}`, e qualquer outra exceção vira `INTERNAL`, sem stack na resposta.
- São exatamente 11 tools (ADR 0009). Adicionar ou remover uma quebra testes do instalador e do e2e.
- Anexo é um blob imutável em `<projeto>/attachments/<sha256>`; o hash é o sha256 dos **bytes** UTF-8, não do JCS. `attachments` é nome reservado de processo. Nunca crie código que escreva por cima de um blob existente.
- A tool `attach` aceita `text` ou `path` de um arquivo `.md`/`.txt` dentro do `cwd` do servidor e fora de `<D>` (ADR 0009); não amplie esse alcance sem um ADR novo.
- `define_type`/`define_relation`/`define_gate` versionam em semver `major.minor` em `<nome>/<versão>.json`, nunca sobrescrevem e não deixam arquivo legado. Os dados 1.0 vivem em `<D>/.v1/`.
- Trocar uma lib ou uma decisão exige conferir antes `docs/adr-0001-hexlog-mvp.md`, `docs/adr-0002-versionamento-definicoes.md`, `docs/adr-0005-hexlog-setup-hexlog-flow.md`, `docs/adr-0006-anexos-tipos-timeline.md` e `docs/pesquisa/hexlog-pesquisa-libs.md`.
- `node scripts/install.ts` escreve em `~/.claude/settings.json`, `~/.claude.json` e `~/.local/lib/hexlog/`. Não rode sem pedido explícito. `--check` só verifica.
- O instalador copia toda pasta de `skills/` (não uma fixa): uma skill nova só precisa da pasta em `skills/<nome>/SKILL.md` para ser instalada e conferida pelo `--check`.

### Testing Requirements
- `npm test` roda tudo, exceto os specs de orçamento (`*.budget.spec.ts`). `npx jest test/<arquivo>.spec.ts` roda um spec.
- `npm run test:budget` roda os specs de orçamento em série (`--runInBand`): `test/adapters/load.budget.spec.ts`, `test/queries/query.budget.spec.ts` e `test/queries/project.budget.spec.ts` (mais `test/adapters/search.budget.spec.ts` e `test/adapters/lock.budget.spec.ts`). O CI roda esse script depois de `npm test`.
- `npm run typecheck` antes de concluir.
- Não precisa de `npm run build` prévio: os specs que dependem de bundle constroem o artefato num processo filho.
- Os testes lentos do `npm test` são TF1 (kill -9 no meio do lote), TF4 (dono do lock vivo pausado), P1 e o estresse 8x25 do lock; `npm test` termina em até 300 s (P5). Os specs de orçamento medem tempo e podem falhar em máquina lenta; por isso só rodam em `npm run test:budget`.

### Common Patterns
- Nomes de módulos, funções e códigos de erro em inglês; comentários e descrições de teste continuam em português (ver `CLAUDE.md`).
- Esquemas Zod para registros e entradas de tools. O núcleo (`src/domain/`, `src/shared/`) é puro, e o I/O fica em `src/adapters/`.
- IDs nos títulos de teste (M#, N#, S#, B#, I#, C#, Q#, R-#, U-#) remetem a critérios do ADR 0001.
- Versões de dependências fixadas sem `^`.
- Documentação (`.md`) e comentários citam arquivo + símbolo, nunca número de linha; `test/skill-coherence.spec.ts` trava a regra nos `.md`. Nas skills o formato é `caminho/arquivo.ts#símbolo`, com o caminho relativo a `src/` (ex.: `mcp/kernel.ts#execute`), conferido contra `src/`.

## Dependencies

### External
- `@modelcontextprotocol/server` 2.0.0: servidor MCP stdio
- `zod` 4: validação de eventos e entradas
- `ajv` + `ajv-formats`: validação de JSON Schema (`define_type`) e do `data` de cada registro
- `canonicalize`: JCS para o hash da cadeia
- `es-toolkit`: helpers usados em todo o `src/` e nos scripts
- `jsonc-parser`: edição preservando formatação de `~/.claude/settings.json` (instalação e guard)
- `minisearch`: busca textual no filtro `text` de `query`
- `safe-regex2`: detecção de regex catastrófico (ReDoS) em `pattern` de schema de tipo, usada no `checkSchema` (o bundle do servidor a embute; o hook não)
- `shell-quote`: tokenização de comandos no hook
- `tar`: geração do `.tar` do arquivamento do dado 0.x (`src/archive.ts`, só pelo instalador)
- `esbuild`, `jest` + `ts-jest`, `fast-check`: build e testes

<!-- MANUAL: Any manually added notes below this line are preserved on regeneration -->

## Fluxo hexlog

O fluxo do OMC deste repositório (fases, processos, gates) está em
`.hexlog/flow.md`. Para registrar marcos e vereditos, use a skill `hexlog-flow`.
