<!-- Generated: 2026-09-17 | Updated: 2026-10-05 -->

# hexlog

## Purpose
Servidor MCP stdio (TypeScript, Node ≥24.18.1) para agentes registrarem o próprio histórico de trabalho: registros tipados com relações e gates declarativos, sem termo de fluxo no código. Cada processo tem um log JSONL append-only com cadeia de hash sha256 + JCS. O servidor expõe exatamente 11 tools. Não há CLI nem daemon (só scripts read-only em `scripts/`): servidor MCP e hook de isolamento Bash são instalados no Claude Code como dois bundles esbuild em `~/.local/lib/hexlog/<versão>/`, junto com as skills de `skills/`. Os dados ficam em `$XDG_DATA_HOME/hexlog/.v1/` (fallback `~/.local/share/hexlog/.v1/`); dado 0.x em `<D>` é recusado com `LEGACY_DATA` até o instalador arquivá-lo.

## Key Files
| File | Description |
|------|-------------|
| `package.json` | Dependências fixadas, scripts (`test`, `test:budget`, `test:coverage`, `typecheck`, `lint`, `format`, `format:check`, `build`, `prepare`), `lint-staged` e config do jest (ts-jest em CJS) |
| `tsconfig.json` | Configuração do TypeScript |
| `eslint.config.js` | Config do ESLint (typescript-eslint com `stylisticTypeChecked`, `eslint-plugin-jest`, `eslint-plugin-n`); importa `boundaryBlocks` de `eslint.boundaries.js` |
| `eslint.boundaries.js` | Blocos `no-restricted-imports` que travam a direção de dependência entre camadas (`boundaryBlocks`); `eslint.boundaries.d.ts` só tipa o export |
| `.prettierrc`, `.prettierignore`, `.editorconfig` | Formatação (aspas simples, vírgula final, 100 colunas); `*.md` e `package-lock.json` ficam fora do Prettier |
| `.husky/pre-commit` | Roda `lint-staged` (`eslint --fix` e `prettier --write` nos `*.ts` do commit) |
| `.github/workflows/ci.yml` | CI: `typecheck`, `lint`, `format:check`, `test` e `test:budget` (Node 24.18.1) |
| `README.md` | Porta de entrada enxuta: o que é, instalação, exemplo mínimo, como funciona e índice de `docs/` (a referência de tools, dados, migração e instalação avançada mora em `docs/`) |
| `LICENSE` | Licença MIT |
| `.gitignore` | Arquivos ignorados |
| `.hexlog/` | Fonte versionada do `define_*` do fluxo guiado por diretrizes: 7 tipos (`types/*.json`, JSON Schema cru), 4 relações (`relations/*.json`, `{kind, from, to}`) e 2 gates (`gates/*.json`, `{questions}`), com o nome do arquivo como nome da definição; `test/flow-definitions.spec.ts` as ensaia em memória. O fluxo novo substitui o setup da F9 (passo 8): não há `.hexlog/flow.md`, o papel é de `docs/directives/fluxo-hexlog.md` e das skills locais |

## Subdirectories
| Directory | Purpose |
|-----------|---------|
| `src/` | Servidor MCP, domínio puro, cadeia de hash, comandos, consultas, adaptadores de disco, tools e instalação (see `src/AGENTS.md`) |
| `hook/` | Hook PreToolUse que bloqueia acesso via Bash ao diretório de dados (see `hook/AGENTS.md`) |
| `scripts/` | Build esbuild, instalador e scripts read-only de insights, export e timeline (see `scripts/AGENTS.md`) |
| `test/` | Specs unit, property, MCP em memória, e2e stdio sobre o bundle real e pacote (see `test/AGENTS.md`) |
| `docs/` | Guias, estudos de apoio, as diretrizes em `docs/directives/` (docs vivos de regras e ADRs 0007 a 0010) e a pesquisa que fundamenta as decisões (see `docs/AGENTS.md`) |
| `skills/` | As skills de `skills/`, cada uma instalada pelo instalador em `~/.claude/skills/<nome>/SKILL.md`: `hexlog` (bootstrap/diagnóstico), `hexlog-setup` (mapeia o fluxo de um repositório alvo em `.hexlog/flow.md`, roda uma vez) e `hexlog-flow` (registra e consulta registros e gates contra esse mapa) |

## Dependencies

### External
- `@modelcontextprotocol/server` 2.0.0: servidor MCP stdio
- `zod` 4: validação de eventos e entradas
- `ajv` + `ajv-formats`: validação de JSON Schema (`define_type`) e do `data` de cada registro
- `canonicalize`: JCS para o hash da cadeia
- `es-toolkit`: helpers usados em todo o `src/` e nos scripts
- `jsonc-parser`: edição preservando formatação de `~/.claude/settings.json` (instalação e guard)
- `minisearch`: busca textual no filtro `text` de `query`
- `safe-regex2`: detecção de regex catastrófico (ReDoS) em `pattern` e nas chaves de `patternProperties` de schema de tipo, usada no `checkSchema` (o bundle do servidor a embute; o hook não)
- `shell-quote`: tokenização de comandos no hook

### Dev (`devDependencies`)
- `esbuild`: build dos dois bundles
- `tar`: geração do `.tar` do arquivamento do dado 0.x (`src/archive.ts`, só pelo instalador, que roda do repositório)
- `jest` + `ts-jest`, `fast-check`, `@modelcontextprotocol/client` (cliente dos specs MCP e e2e): testes
- `typescript`, `eslint` (+ `typescript-eslint`, `eslint-plugin-jest`, `eslint-plugin-n`, `eslint-config-prettier`), `prettier`: tipos, lint e formatação
- `husky` + `lint-staged`: hook de pré-commit

<!-- MANUAL: Any manually added notes below this line are preserved on regeneration -->

## Diretrizes

Regras que valem para o repositório todo, importadas pelo `CLAUDE.md`:

- [convencoes.md](docs/directives/convencoes.md): idioma, núcleo e bordas, dependências, hash, escrita em disco, imports
- [fronteiras.md](docs/directives/fronteiras.md): camadas, direção de dependência, travas mecânicas e checklist de review
- [invariantes.md](docs/directives/invariantes.md): log append-only, cadeia, lock, tools, anexos e definições
- [qualidade-e-testes.md](docs/directives/qualidade-e-testes.md): comandos antes de concluir, orçamentos e convenções dos specs
- [documentacao.md](docs/directives/documentacao.md): ADR e doc vivo, como citar, `pesquisa/` congelado, famílias de ID
- [instalacao-e-hooks.md](docs/directives/instalacao-e-hooks.md): instalador, hook de isolamento e hooks do fluxo
