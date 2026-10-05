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
| `README.md` | Documentação de uso, instalação, tools e formato dos dados |
| `.gitignore` | Arquivos ignorados |
| `.hexlog/` | Mapa do fluxo do OMC (`flow.md`) e os schemas dos cinco tipos custom de auditoria (`types/*.json`): fonte versionada dos tipos e do cálculo offline de `hashes.schemas`; o mapa e os schemas ainda descrevem o 0.x (`register_type`) e a F9 (passo 8) os regenera para `define_type` |

## Subdirectories
| Directory | Purpose |
|-----------|---------|
| `src/` | Servidor MCP, domínio puro, cadeia de hash, comandos, consultas, adaptadores de disco, tools e instalação (see `src/AGENTS.md`) |
| `hook/` | Hook PreToolUse que bloqueia acesso via Bash ao diretório de dados (see `hook/AGENTS.md`) |
| `scripts/` | Build esbuild, instalador e scripts read-only de insights, export e timeline (see `scripts/AGENTS.md`) |
| `test/` | Specs unit, property, MCP em memória, e2e stdio sobre o bundle real e pacote (see `test/AGENTS.md`) |
| `docs/` | ADR 0007 (domínio), 0008 (serviços) e 0009 (ferramental) e a pesquisa que fundamenta as decisões (see `docs/AGENTS.md`) |
| `skills/` | Três skills, cada uma instalada pelo instalador em `~/.claude/skills/<nome>/SKILL.md`: `hexlog` (bootstrap/diagnóstico), `hexlog-setup` (mapeia o fluxo de um repositório alvo em `.hexlog/flow.md`, roda uma vez) e `hexlog-flow` (registra e consulta registros e gates contra esse mapa) |

## For AI Agents

### Working In This Directory
- O log é estritamente append-only, gravado sob lock por processo (publicado por `rename`, com dono por pid, `bootId` e token, `src/adapters/fs/lock.ts`). Nunca crie código que edite ou remova linhas.
- A leitura e a escrita do log usam um único predicado (`isValidLine` em `src/shared/loader.ts`). Não duplique essa lógica. Ele devolve `LineCheck`: `valid` (elos e próximo esperado), `torn` (linha que nem é JSON) ou `rejected` com `reasons` (`invalid-line`, `diverging-seq`, `hash-mismatch`), conferidas por `isValidLink` (`src/domain/chain.ts`), que devolve `{ link }` ou `{ reasons }`.
- Toda tool passa por `execute()` em `src/mcp/kernel.ts`. `HexlogError` vira `{code, message, details}`, e qualquer outra exceção vira `INTERNAL`, sem stack na resposta.
- São exatamente 11 tools (`docs/adr-0009-ferramental.md`). Adicionar ou remover uma quebra testes do instalador e do e2e.
- Anexo é um blob imutável em `<projeto>/attachments/<sha256>`; o hash é o sha256 dos **bytes** UTF-8, não do JCS. `attachments` é nome reservado de processo. Nunca crie código que escreva por cima de um blob existente.
- A tool `attach` aceita `text` ou `path` de um arquivo `.md`/`.txt` dentro do `cwd` do servidor e fora de `<D>` (`docs/adr-0009-ferramental.md`); o `cwd` é o teto (sessão em `$HOME` alcança todo `.md`/`.txt`) e só essas extensões entram por não carregarem credencial (`.json`, `.log`, `.env` ficam fora). Não amplie esse alcance sem um ADR novo.
- `define_type`/`define_relation`/`define_gate` versionam em semver `major.minor` em `<nome>/<versão>.json`, nunca sobrescrevem e não deixam arquivo legado. Os dados 1.0 vivem em `<D>/.v1/`.
- Trocar uma lib ou uma decisão exige conferir antes `docs/adr-0007-dominio.md`, `docs/adr-0008-servicos.md`, `docs/adr-0009-ferramental.md` e `docs/pesquisa/hexlog-pesquisa-libs.md`; para decisão do 0.x, o ADR 0001 está só no git (`git show 87237c3:docs/adr-0001-hexlog-mvp.md`).
- A partir da 1.0, ADR não é refeito nem apagado, só recebe emenda (seção nova ou ADR seguinte). Na aprovação só o cabeçalho muda (Status passa a Aceito e Deciders inclui quem aprovou); depois de Aceito, o corpo só muda por emenda datada. A troca dos ADRs 0001, 0002, 0005 e 0006 pelos 0007 a 0009 foi a exceção única.
- `node scripts/install.ts` escreve em `~/.claude/settings.json`, `~/.claude.json` e `~/.local/lib/hexlog/`. Não rode sem pedido explícito. `--check` só verifica. Com dado 0.x em `<D>`, sem flag só lista e sai 2; `--archive-0x` arquiva em `<D>/archive/` e segue para a instalação (`src/archive.ts`; recusas e retomada no README, seção "Dado 0.x"). Só Linux: o arquivador e o lock dependem de `/proc`, hard link e `fsync` de diretório; macOS não foi testado.
- O instalador copia toda pasta de `skills/` (não uma fixa): uma skill nova só precisa da pasta em `skills/<nome>/SKILL.md` para ser instalada e conferida pelo `--check`.

### Testing Requirements
- `npm test` roda tudo, exceto os specs de orçamento (`*.budget.spec.ts`). `npx jest test/<arquivo>.spec.ts` roda um spec.
- `npm run test:budget` roda os specs de orçamento em série (`--runInBand`): `test/adapters/load.budget.spec.ts`, `test/queries/query.budget.spec.ts` e `test/queries/project.budget.spec.ts` (mais `test/adapters/search.budget.spec.ts` e `test/adapters/lock.budget.spec.ts`). O CI roda esse script depois de `npm test`.
- `npm run typecheck`, `npm run lint` e `npm run format:check` antes de concluir (o CI roda os três, mais `npm test` e `npm run test:budget`).
- Não precisa de `npm run build` prévio: os specs que dependem de bundle constroem o artefato num processo filho.
- Os testes lentos do `npm test` são TF1 (kill -9 no meio do lote), TF4 (dono do lock vivo pausado), P1 e o estresse 8x25 do lock; `npm test` termina em até 300 s (P5). Os specs de orçamento medem tempo e podem falhar em máquina lenta; por isso só rodam em `npm run test:budget`.

### Common Patterns
- Nomes de módulos, funções e códigos de erro em inglês; comentários e descrições de teste continuam em português (ver `CLAUDE.md`).
- Esquemas Zod para registros e entradas de tools. O núcleo (`src/domain/`, `src/shared/`) é puro, e o I/O fica em `src/adapters/`.
- IDs nos títulos de teste (M#, N#, S#, B#, I#, C#, Q#, R-#, U-#) remetem a critérios de aceite das duas famílias de IDs descritas em `docs/AGENTS.md#Common Patterns` (0.x no ADR 0001 removido, 1.0 no plano em `.omc/`), não aos ADRs 0007 a 0009.
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
- `safe-regex2`: detecção de regex catastrófico (ReDoS) em `pattern` e nas chaves de `patternProperties` de schema de tipo, usada no `checkSchema` (o bundle do servidor a embute; o hook não)
- `shell-quote`: tokenização de comandos no hook

### Dev (`devDependencies`)
- `esbuild`: build dos dois bundles
- `tar`: geração do `.tar` do arquivamento do dado 0.x (`src/archive.ts`, só pelo instalador, que roda do repositório)
- `jest` + `ts-jest`, `fast-check`, `@modelcontextprotocol/client` (cliente dos specs MCP e e2e): testes
- `typescript`, `eslint` (+ `typescript-eslint`, `eslint-plugin-jest`, `eslint-plugin-n`, `eslint-config-prettier`), `prettier`: tipos, lint e formatação
- `husky` + `lint-staged`: hook de pré-commit

<!-- MANUAL: Any manually added notes below this line are preserved on regeneration -->

## Fronteiras

Mapa de camadas (`src/`): `domain/` (puro) e `shared/` (carregador do log) na base; `ports.ts` declara as portas; `commands/` (escrita) e `queries/` (leitura) são serviços sobre as portas; `adapters/` implementa as portas (disco, validador, busca); `mcp/` expõe os serviços como tools; `compose.ts` é a única raiz de composição. Ficam fora do mapa os arquivos de raiz: `errors.ts` (importado por todas as camadas), `directory.ts`, `version.ts`, `server.ts` e `installation.ts`, `archive.ts` e `guard.ts`, que só o instalador usa. O porquê das decisões da frente de serviços está em `docs/adr-0008-servicos.md`.

Direção permitida de dependência:
- `domain/` não importa `shared/`, `commands/`, `queries/`, `mcp/` nem `adapters/`, nem builtin do Node (salvo `crypto`) nem lib de infraestrutura. Exceção: importa `src/errors.ts` (`HexlogError` em `domain/definitions.ts` e `domain/chain.ts`), e `errors.ts` importa de volta só os tipos `Name` e `RecordId` (ciclo só de tipo). `eslint.boundaries.js` não proíbe `errors.ts` nem `ports.ts` dentro de `domain/`, então essa parte é convenção.
- Quem importa `shared/`: `commands/` e `queries/` (`latest.ts`, `loader.ts`, `pages.ts`, `logger.ts`), `compose.ts` (`loader.ts`, `logger.ts`) e `server.ts` (`logger.ts`); `mcp/` e `adapters/` só importam `shared/logger.ts`.
- `shared/`, `commands/` e `queries/` dependem de `domain/` e das portas, nunca de `adapters/`; `commands/` e `queries/` não se importam.
- `adapters/` só implementa portas: não importa `commands/`, `queries/` nem `mcp/` (`eslint.boundaries.js#adaptersBlock`); builtins do Node e libs de infraestrutura são o que ele existe para usar.
- `mcp/` chama só serviços: não importa `adapters/`, builtin do Node nem `compose.ts`; `mcp/kernel.ts` também não importa `mcp/tools/`.
- Só `server.ts`, os scripts e os testes importam `compose.ts`. Scripts de leitura passam por `compose.ts#composeReader` (só o lado de leitura, sem serviço de escrita: "script de leitura não grava" é garantia de tipo) e não importam `adapters/` nem `mcp/` (`scripts/install.ts` e `scripts/build.ts` ficam de fora).
- Travas mecânicas: `eslint.boundaries.js#scriptsBlock` e os demais blocos de `boundaryBlocks`, `NO_DYNAMIC_IMPORT` (import dinâmico barrado nas camadas com bloco: `domain/`, `shared/`, `ports.ts`, `commands/`, `queries/`, `mcp/` e `scripts/**` menos `install.ts` e `build.ts`, porque contornaria as travas de import) e `test/boundaries.spec.ts`.
- Fora dos blocos (`adapters/`, `hook/` e os arquivos de raiz de `src/`, exceto `ports.ts`) o lint não barra `import()`; a convenção é não usá-lo, e hoje nenhum arquivo usa.

Checklist de review:
- Serviço recebendo caminho de configuração (`dataDir`, `cwd`): quem conhece caminho é o adaptador, e o serviço recebe a porta.
- Regra de negócio em adaptador: a regra mora em `domain/` ou no serviço.
- Tipo de domínio com cara de formato em disco: o formato em disco fica em `adapters/fs/data-format.ts`.
- Caso de uso chamando outro via tool: serviço chama serviço ou função pura, nunca uma tool.
- Arquivo de serviço perto do `max-lines` (800): divida antes de bater no teto.
- Serviço de escrita gravando em mais de uma porta: a escrita de um `register` é um lote numa só linha de um só processo.
- `queries/` chamando gravação de qualquer porta: leitura só usa os `*Reader`.
- `timeline` somando o projeto contra o teto de 64 MiB por processo (`MAX_LOG_BYTES`): o script lê numa chamada só e o teto vale por processo, não pelo projeto.

Toda violação é achado URGENT.

## Fluxo hexlog

O fluxo do OMC deste repositório (fases, processos, gates) está em
`.hexlog/flow.md`. Para registrar marcos e vereditos, use a skill `hexlog-flow`.
