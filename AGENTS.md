# hexlog

**Generated:** 2026-09-17 · **Updated:** 2026-10-17

## Purpose
Servidor MCP stdio (TypeScript, Node ^24.18.1) para agentes registrarem o próprio histórico de trabalho: registros tipados com relações e gates declarativos, sem termo de fluxo no código. Cada processo tem um log JSONL append-only com cadeia de hash sha256 + JCS. O servidor expõe exatamente 12 tools. Não há CLI nem daemon para o agente (só scripts em `scripts/`: os relatórios read-only, o `flow/reanchor.ts` e o `flow/sync-cli.ts`, os únicos que gravam no log e só com `--apply`, o `flow/critic.ts`, que o `flow-run` chama para o critic da cadeira do dono e só escreve em `os.tmpdir()` (a mailbox e o arquivo de regras do verbo `rules`), e o `release-notes-cli.ts`, que só o `release.yml` chama, sem `src/` e sem dado): servidor MCP e hook de isolamento Bash são instalados no Claude Code como dois bundles esbuild em `~/.local/lib/hexlog/<versão>/`, junto com as skills de `skills/`. Os dados ficam em `$XDG_DATA_HOME/hexlog/.v1/` (fallback `~/.local/share/hexlog/.v1/`); dado 0.x em `<D>` é recusado com `LEGACY_DATA` até o instalador arquivá-lo.

## Key Files
| File | Description |
|------|-------------|
| `package.json` | Dependências em faixa `^X.Y.Z` (o lock fixa a resolvida), scripts (`test`, `test:budget`, `test:coverage`, `test:mutation`, `typecheck`, `lint`, `lint:md`, `spell`, `knip`, `format`, `format:check`, `build`, `prepare`) e config do jest (ts-jest em CJS) |
| `tsconfig.json` | Configuração do TypeScript |
| `stryker.config.json` | Config do Stryker (`npm run test:mutation`): roda só os specs unitários de `stryker.config.json#jest.config.testMatch` contra os arquivos de `mutate`, fora do CI e do husky; relatórios em `reports/mutation/` (ignorado pelo git) |
| `knip.json` | Config do `knip` (`npm run knip`): entradas explícitas (`src/server.ts`, `hook/bash-guard.ts`, `scripts/*.ts`, `.claude/hooks/*.ts`, `.claude/workflows/*.js` e os fixtures de `test/fixtures/` que rodam como processo filho), fixtures de `test/fixtures/boundaries/` fora da análise, `mkfifo` em `ignoreBinaries` e a duplicata `Name`/`alias` de `src/domain/ids.ts` em `ignoreIssues`; o `$schema` é local, em `node_modules/knip/schema.json` |
| `eslint.config.js` | Config do ESLint (typescript-eslint com `stylisticTypeChecked`, `eslint-plugin-jest`, `eslint-plugin-n`); importa `boundaryBlocks` de `eslint.boundaries.js` |
| `eslint.boundaries.js` | Blocos `no-restricted-imports` que travam a direção de dependência entre camadas (`boundaryBlocks`); `eslint.boundaries.d.ts` só tipa o export |
| `.prettierrc`, `.prettierignore`, `.editorconfig` | Formatação (aspas simples, vírgula final, 100 colunas); `*.md` e `package-lock.json` ficam fora do Prettier |
| `.husky/pre-commit` | Roda `lint-staged --concurrent false` (`lint-staged.config.ts`): as chaves `*.ts` e `*.md` rodam em série |
| `lint-staged.config.ts` | Config do `lint-staged`: nos `*.ts` em stage roda `eslint --fix`, `prettier --write`, `npm run typecheck` e os specs (o núcleo fixo `test/domain/`, `test/shared/`, `register.spec.ts` e `register-state.spec.ts`, mais o spec de mesmo nome em qualquer pasta de `test/`: `y.ts` casa `y.spec.ts` e `y.<x>.spec.ts`); nos `*.md`, `markdownlint-cli2`, `cspell`, `directives.spec.ts` e `skill-coherence.spec.ts` |
| `.markdownlint-cli2.jsonc`, `cspell.json` | Lint e ortografia dos `.md` (`npm run lint:md`, `npm run spell`): `docs/pesquisa/**` fora dos dois e o template de PR fora do lint, MD013 e as regras que outros `.md` também violam desligadas no repositório todo, as sete que só o `AGENTS.md` gerado e os ADRs violam desligadas só neles por `overrides`, dicionário pt-BR (`@cspell/dict-pt-br`), `words` do projeto e nome de arquivo `.md` fora da conferência |
| `.husky/pre-push` | No 1º push de uma branch (sha remoto zerado) roda `npm run test:coverage`; tag, remoção e pushes seguintes pulam |
| `.husky/commit-msg` | Roda o `commitlint` na mensagem do commit (`commitlint.config.js`) |
| `commitlint.config.js` | Config do `commitlint`: `config-conventional`, header até 80 caracteres, corpo vazio; `Merge` e `Revert` do Git passam pelos ignores padrão e o commit do Dependabot pelo rodapé `Signed-off-by: dependabot[bot]` |
| `.github/workflows/ci.yml` | CI: `npm audit signatures`, `typecheck`, `lint`, `knip`, `format:check`, `test:coverage` (piso de 90%) e `test:budget` (Node 24.18.1) |
| `.github/workflows/changelog-draft.yml` | Em PR para `main`, comenta o rascunho do `git-cliff` para o `CHANGELOG.md` |
| `.github/workflows/workflow-lint.yml` | Job `workflow-lint` em todo PR: se o diff toca `.github/`, roda actionlint (binário de versão fixa com sha256 conferido) e zizmor (`zizmor-action` pela tag); sem mudança em `.github/`, os steps de lint são pulados e o check reporta sucesso; o zizmor audita também `.github/dependabot.yml` |
| `.github/zizmor.yml` | Config do zizmor: `unpinned-uses` com política `ref-pin` para toda action, porque os workflows referenciam a action pela tag (major quando existe, tag exata quando não) e não pelo SHA do commit |
| `.github/workflows/changelog-line.yml` | Job `changelog-line` em PR para `develop`: commit `feat`, `fix`, `perf` ou `revert` (menos os escopos `flow` e `claude`) exige linha nova em `[Não lançado]` citando o `#N` do próprio PR; Dependabot pula o job, e `chore/back-merge-*` também, só quando `head.repo.full_name` é o próprio repositório (PR de fork com esse nome passa pelo job) |
| `.github/workflows/commitlint.yml` | Job `commitlint` em todo PR, qualquer base: confere as mensagens de `base.sha..head.sha` com `commitlint.config.js`; `chore/back-merge-*` pula o job só quando `head.repo.full_name` é o próprio repositório (PR de fork com esse nome passa pelo job) |
| `.github/workflows/docs.yml` | Job `docs` em todo PR, qualquer base: `npm run lint:md` e `npm run spell` sobre o repositório todo |
| `.github/workflows/dependency-review.yml` | Job `dependency-review` em todo PR: a `dependency-review-action` (tag exata `v5.0.0`, sem major publicada) falha em dependência nova com advisory `high` ou acima, sem filtro de licença |
| `.github/workflows/dependabot-auto-merge.yml` | Job `dependabot-auto-merge` em PR do `dependabot[bot]`: liga o auto-merge nos PRs de `npm` minor e patch; regra em `docs/directives/qualidade-e-testes.md`, pré-condição e risco aceito no cabeçalho do workflow |
| `.github/workflows/scorecard.yml` | Job `scorecard` do OpenSSF Scorecard, medidor e não gate, com SARIF na aba Security; limitações no cabeçalho do workflow |
| `.github/workflows/release.yml` | Job `release` no `push` em `main`: cria a tag `vX.Y.Z`, o GitHub Release e o PR de back-merge para `develop`; fluxo em `docs/directives/documentacao.md`, o resto no workflow |
| `.github/dependabot.yml` | Dependabot em `npm` e `github-actions`, version updates semanais em `develop`; regra em `docs/directives/qualidade-e-testes.md`, security updates e `ignore` no cabeçalho do arquivo |
| `.github/pull_request_template.md` | Template de PR só com os vínculos: `Closes #N`, linha do `CHANGELOG.md` em `[Não lançado]`, PR relacionado, versão ou tag |
| `SECURITY.md` | Política de segurança: só a versão mais recente recebe correção; o relato é privado, pelo formulário de reporte privado do GitHub (aba Security) |
| `CHANGELOG.md` | Mudanças visíveis por versão, no Keep a Changelog em pt-BR, desde a 1.0.0; `test/changelog.spec.ts` exige a seção da versão do `package.json` |
| `cliff.toml` | Config do `git-cliff`: mapeia os Conventional Commits para as seções do changelog e descarta os tipos internos; o cabeçalho avisa que o filtro dos commits é o mesmo de `changelog-line.yml` |
| `README.md` | Porta de entrada enxuta: o que é, instalação, exemplo mínimo, como funciona e índice de `docs/` (a referência de tools, dados, migração e instalação avançada mora em `docs/`) |
| `CLAUDE.md` | Importa este `AGENTS.md` e as diretrizes de `docs/directives/` para toda sessão e todo subagente |
| `CONTEXT-MAP.md` | Mapa dos glossários: liga o contexto do produto (`CONTEXT.md`) ao do fluxo de desenvolvimento (`.claude/CONTEXT.md`) e descreve a relação entre eles |
| `CONTEXT.md` | Glossário do produto: o log append-only de registros que o servidor MCP grava, encadeia e consulta; termo canônico em pt-BR com o identificador do código ou da tool ao lado |
| `LICENSE` | Licença MIT |
| `.gitignore` | Arquivos ignorados |
| `.claude/` | Config do Claude Code do projeto: `settings.json` com os hooks do fluxo, `hooks/` (só `flow-hooks.ts` e `flow-command.ts`, os hooks; `slug`, `sync-cli`, `mark`, `gate`, `report`, `reanchor` e `critic` vivem em `scripts/flow/`, que o Claude Code não dispara), as skills locais em `skills/` e `workflows/` (`friction-mining-run.js`) e `CONTEXT.md`, o glossário do fluxo de desenvolvimento. Fica fora do bundle do produto |
| `.hexlog/` | Fonte versionada do `define_*` do fluxo guiado por diretrizes: 8 tipos (`types/*.json`, JSON Schema cru), 6 relações (`relations/*.json`, `{kind, from, to}`) e 2 gates (`gates/*.json`, `{questions}`), com o nome do arquivo como nome da definição; `test/flow-definitions.spec.ts` as ensaia em memória. O fluxo deste repositório não mora num mapa: o papel é de `docs/directives/fluxo-hexlog.md` e das skills locais |

## Subdirectories
| Directory | Purpose |
|-----------|---------|
| `src/` | Servidor MCP, domínio puro, cadeia de hash, comandos, consultas, adaptadores de disco, tools e instalação; os `AGENTS.md` das subpastas estão listados em `src/AGENTS.md` (see `src/AGENTS.md`) |
| `hook/` | Hook PreToolUse que bloqueia acesso via Bash ao diretório de dados (see `hook/AGENTS.md`) |
| `scripts/` | Build esbuild, instalador e scripts read-only de insights, export e timeline; `release-notes.ts` e `release-notes-cli.ts` só usam builtins do Node e leem apenas o `CHANGELOG.md`, porque o `release.yml` os roda sem `npm ci` (see `scripts/AGENTS.md`) |
| `test/` | Specs unit, property, MCP em memória, e2e stdio sobre o bundle real e pacote (see `test/AGENTS.md`) |
| `docs/` | Guias, estudos de apoio, as diretrizes em `docs/directives/` (docs vivos de regras e ADRs 0007 a 0012) e a pesquisa que fundamenta as decisões (see `docs/AGENTS.md`) |
| `skills/` | As skills de `skills/`, cada uma instalada pelo instalador em `~/.claude/skills/<nome>/SKILL.md`: `hexlog` (bootstrap/diagnóstico), `hexlog-setup` (configura um repositório de destino: gera a skill do projeto e o modelo declarativo) e `hexlog-flow` (mecânica de registro, consulta e ciclo de vida da unidade, com projeto, processo e gate vindos da skill do projeto) (see `skills/AGENTS.md`) |

## Dependencies

### External
- `@modelcontextprotocol/server` 2: servidor MCP stdio
- `zod` 4: validação de eventos e entradas
- `ajv` + `ajv-formats`: validação de JSON Schema (`define_type`) e do `data` de cada registro
- `canonicalize`: JCS para o hash da cadeia
- `es-toolkit`: helpers usados em todo o `src/` e nos scripts
- `jsonc-parser`: edição preservando formatação de `~/.claude/settings.json` (instalação e guard)
- `minisearch`: busca textual no filtro `text` de `query`
- `shell-quote`: tokenização de comandos no hook

### Dev (`devDependencies`)
- `esbuild`: build dos dois bundles
- `tar`: geração do `.tar` do arquivamento do dado 0.x (`src/archive.ts`, só pelo instalador, que roda do repositório)
- `jest` + `ts-jest`, `fast-check`, `@modelcontextprotocol/client` (cliente dos specs MCP e e2e): testes
- `@stryker-mutator/core` + `@stryker-mutator/jest-runner` + `@stryker-mutator/typescript-checker`: teste de mutação dos unitários (`stryker.config.json`)
- `typescript`, `eslint` (+ `typescript-eslint`, `eslint-plugin-jest`, `eslint-plugin-n`, `eslint-config-prettier`), `prettier`: tipos, lint e formatação
- `husky` + `lint-staged`: hooks de pré-commit e pré-push
- `@commitlint/cli` + `@commitlint/config-conventional`: mensagem de commit no hook `commit-msg` e no CI (`commitlint.config.js`)
- `markdownlint-cli2`, `cspell` + `@cspell/dict-pt-br`: lint e ortografia dos `.md` (`.markdownlint-cli2.jsonc`, `cspell.json`)
- `git-cliff`: rascunho do `CHANGELOG.md` (`cliff.toml`)
- `knip`: código, arquivo e dependência mortos (`knip.json`)

## Manual Notes

## Diretrizes

Regras que valem para o repositório todo, importadas pelo `CLAUDE.md`:

- [fluxo-hexlog.md](docs/directives/fluxo-hexlog.md): processos e targets, premissas, `decision`, lacunas, verificação e gates do PR
- [convencoes.md](docs/directives/convencoes.md): idioma, núcleo e bordas, dependências, hash, escrita em disco, imports
- [fronteiras.md](docs/directives/fronteiras.md): camadas, direção de dependência, travas mecânicas e checklist de review
- [invariantes.md](docs/directives/invariantes.md): log append-only, cadeia, lock, tools, anexos e definições
- [qualidade-e-testes.md](docs/directives/qualidade-e-testes.md): comandos antes de concluir, hooks locais, dependências e actions no CI, orçamentos e convenções dos specs
- [documentacao.md](docs/directives/documentacao.md): ADR e doc vivo, changelog (gate `changelog-line` e release), como citar, `pesquisa/` congelado, famílias de ID
- [instalacao-e-hooks.md](docs/directives/instalacao-e-hooks.md): instalador, hook de isolamento e hooks do fluxo
- [estrategia.md](docs/directives/estrategia.md): premissas atemporais do produto, validadas pelo dono; cada decisão deve se apoiar em pelo menos uma, ou declarar que nenhuma se aplica
- [cadeira-do-dono.md](docs/directives/cadeira-do-dono.md): quem responde a lacuna no lugar do humano, com que modelo e como registra
