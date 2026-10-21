# Qualidade e testes

## Antes de concluir

- Rode `npm run typecheck`, `npm run lint`, `npm run knip`, `npm run format:check`, `npm run lint:md` e `npm run spell` (o CI roda os seis: os quatro primeiros e mais `npm run test:coverage` e `npm run test:budget` no job `quality`, `lint:md` e `spell` no job `docs`).
- `npm run knip` falha com export, arquivo ou dependência morta. As entradas são declaradas em `knip.json`; falso positivo se resolve com entrada nova ou `ignoreDependencies` por nome com o motivo registrado, nunca com supressão geral. Fixture novo de `test/fixtures/` que roda como processo filho entra em `entry` por nome.
- Tipo que só aparece em assinatura exportada fica sem `export` até um consumidor importá-lo; reexportá-lo antes disso o `knip` acusa como export morto.
- A mensagem de commit segue Conventional Commits com header de até 80 caracteres e sem corpo (`commitlint.config.js`). O hook `.husky/commit-msg` barra a mensagem fora da regra e o job `commitlint` repete a conferência em todo PR, de `base.sha` a `head.sha`. Merge e revert do Git e o commit do Dependabot (rodapé `Signed-off-by: dependabot[bot]`, forjável: freio, não barreira) passam; só o PR `chore/back-merge-*` do próprio repositório pula o job: a isenção testa também `head.repo.full_name == github.repository`, então um PR de fork com esse nome de branch passa pelo job.
- `npm run lint:md` (markdownlint) e `npm run spell` (cspell, dicionário pt-BR) conferem todos os `.md`, menos `docs/pesquisa/**` (congelado) e `.github/pull_request_template.md` (o `lint:md` o ignora em `.markdownlint-cli2.jsonc`). O job `docs` os roda em todo PR. O MD013 (linha longa) e as regras que outros `.md` também violam por formato (MD032, MD034, MD038, MD060) ficam desligados em `.markdownlint-cli2.jsonc` no repositório todo; as que só o `AGENTS.md` gerado e os ADRs aceitos violam (MD005, MD007, MD022, MD029, MD033, MD056, MD058) ficam desligadas só neles, por `overrides` com o filtro `**/AGENTS.md` e `docs/directives/adr-*.md`. Palavra legítima que o cspell não conhece entra em `words` de `cspell.json`, nunca em supressão geral; grafia truncada ou sem acento (`dominio`, `supersed`) não é palavra legítima, então se cita em crase. Em código (crase), em destino de link e em nome de arquivo `.md` o cspell não confere.
- `npm run test:coverage` é o `npm test` com cobertura de `src/**/*.ts` e piso global de 90% em statements, branches, functions e lines (`package.json#jest.coverageThreshold`); o CI o roda no lugar de `npm test`, e abaixo do piso o job `quality` falha. O CI também roda `npm audit signatures` depois do `npm ci`, sem `continue-on-error`: registry fora do ar ou pacote sem assinatura reprova. O CI não roda `npm run build`.
- `npm test` roda tudo, exceto os specs de orçamento (`*.budget.spec.ts`), e termina em até 300 s (P5). `npx jest test/<arquivo>.spec.ts` (ou `npm test -- test/<arquivo>.spec.ts`) roda um spec.
- `npm ci` precisa ser completo (sem `--omit=dev`): `esbuild` e `@modelcontextprotocol/client` são devDependencies usadas pelo instalador e pelos testes. Node `>= 24.18.1` (`package.json#engines`).
- Não precisa de `npm run build` prévio: os specs que dependem de bundle constroem o artefato num processo filho. `npm run build` só cabe antes de PR que toque `scripts/build.ts` ou `scripts/install.ts`.
- Os testes lentos do `npm test` são TF1 (kill -9 no meio do lote), TF4 (dono do lock vivo pausado), P1 e o estresse 8x25 do lock.
- Sobra de execução interrompida (`kill -9` pula o `globalTeardown`): `find "${TMPDIR:-/tmp}" -maxdepth 1 -name 'hexlog-suite-*' -exec rm -rf {} +`.

## Hooks locais

- `.husky/pre-commit` roda o `lint-staged` (`lint-staged.config.ts`). Com `.ts` em stage: `eslint --fix`, `prettier --write`, `npm run typecheck` e os specs: um núcleo fixo em todo commit (`test/domain/`, `test/shared/`, `test/commands/register.spec.ts` e `test/commands/register-state.spec.ts`, cerca de 5 s) e o spec de mesmo nome de cada arquivo, em qualquer pasta de `test/` (`src/x/y.ts` roda `test/**/y.spec.ts` e `test/**/y.property.spec.ts`, sem casar `y-<x>.spec.ts`; spec em stage roda a si mesmo). Com `.md` em stage: `markdownlint-cli2` e `cspell` sobre os arquivos em stage e, depois, `test/directives.spec.ts` e `test/skill-coherence.spec.ts`. O `tsc` confere o projeto inteiro, no estado do stash do `lint-staged`, e erro de tipo bloqueia o commit. O hook chama `lint-staged --concurrent false` (a opção só existe na linha de comando, não no arquivo de config): num commit com `.ts` e `.md`, as chaves `*.ts` e `*.md` rodam em série, para o spec de doc (que lê `src/**/*.ts`) não correr enquanto `eslint --fix` e `prettier --write` reescrevem arquivos e para dois `jest` não subirem juntos.
- `.husky/pre-push` roda `npm run test:coverage` só no 1º push de uma branch (`refs/heads/*` com sha remoto zerado). Push de tag, de remoção e os pushes seguintes pulam, e o CI cobre o resto. O 1º push leva de 3 a 5 minutos: o agente roda o `git push` com `timeout` de ao menos 600000 ms ou em background, porque o padrão do Bash é 120 s. Timeout de jest sob carga no 1º push: reexecute o push (depois de aliviar a máquina), nunca `--no-verify`.
- Limites conhecidos: o hook pega descuido, não burla (`--no-verify` e `HUSKY=0` o pulam); além do núcleo, só o spec de mesmo nome é rodado, então a mudança em helper ou fixture de `test/` não dispara outro spec; cerca de um terço dos `.ts` (23) tem spec de outro nome (`scripts/timeline.ts` e `timeline-cli.spec.ts`, `queries/query-service.ts` e `query.spec.ts`) e fica só com o núcleo no commit, até a nomenclatura da issue #227; a cobertura do 1º push vale para o estado do `HEAD`, não para o que vier depois.
- O `prepare` do `npm ci` aponta o `core.hooksPath` para `.husky/_`, que o Husky gera dentro do checkout: worktree nova sem `npm ci` fica sem hooks. No CI o `HUSKY: 0` desliga o `prepare`.

## Dependências e actions no CI

- Toda action dos workflows vem pela tag, sem o SHA do commit, por decisão do dono: a major quando a action publica uma, a tag exata quando não. O `zizmor` roda com a política `ref-pin` (`.github/zizmor.yml`) por isso, e com `collect: all` em `workflow-lint.yml`, então também audita `.github/dependabot.yml`.
- O Dependabot (`.github/dependabot.yml`) cobre `npm` e `github-actions`, semanal, com `cooldown` de 7 dias e minor e patch num PR por ecossistema. Major de `npm` nunca vem por ele (`ignore`): entra por PR manual. Major de `github-actions` vem por PR, com merge manual, porque as actions por tag major (`@v7`) só têm a próxima major como candidata.
- O auto-merge (`.github/workflows/dependabot-auto-merge.yml`) liga `gh pr merge --auto --merge` só no PR do Dependabot com base `develop` que é de `npm` e de minor ou patch. Major e `github-actions` ficam com merge manual. O merge espera os checks do ruleset, e a flag `allow_auto_merge` do repositório liga à parte.

## Orçamentos de tempo

- `npm run test:budget` roda os specs de orçamento em série (`jest --runInBand`): `adapters/load.budget.spec.ts`, `adapters/search.budget.spec.ts`, `adapters/lock.budget.spec.ts`, `queries/query.budget.spec.ts`, `queries/project.budget.spec.ts` e `domain/inheritance.budget.spec.ts`. O CI o roda depois de `npm run test:coverage` ([ADR 0009](adr-0009-ferramental.md), item 4).
- Eles medem tempo e podem falhar em máquina lenta, por isso só rodam nesse script. `adapters/load.budget.spec.ts` compara o mínimo das medições, não a mediana.

## Convenções dos specs

- Spec que chama tools passa por `mcp/environment.ts#createEnvironment()` (servidor real sobre `compose` e `InMemoryTransport`) e nunca mocka o servidor MCP.
- Ao testar uma tool que recusa entrada, use `expectError()` de `mcp/environment.ts` antes de reimplementar a asserção de erro estruturado.
- Diretório temporário só por `helpers.ts#createTempDir`, dentro de hook ou teste, nunca na coleta do `describe`: a coleta roda até com `-t`, e o `afterAll` de `cleanup.ts` não roda num arquivo sem teste selecionado, então o diretório vazaria. A trava de lint só barra `mkdtempSync`.
- O `globalSetup` (`test/global-setup.ts`) apaga as variáveis locais do Git (`GIT_DIR`, `GIT_INDEX_FILE` etc.), que um hook disparado de worktree vinculada exporta: nenhum spec depende de `GIT_*` herdado, e todo `git` de spec roda com `cwd` num repositório temporário.
- Teste que sobe bundle, processo filho ou carga declara o próprio timeout como último argumento do `it` (de 15_000 a 240_000 ms), porque o padrão do jest é 5000 ms e não há `testTimeout` global.
- Property-based tests (`fast-check`, `fc.assert`/`fc.property`) cobrem as invariantes de vigência (`domain/vigency.property.spec.ts`), do `expectedHead` do `verify_chain` (`shared/loader.property.spec.ts`), da busca (`adapters/search.spec.ts`) e da paginação (`queries/pagination.spec.ts`).
- Os IDs nos títulos de teste (`M#`, `N#`, `S#`, `B#`, `I#`, `C#`, `Q#`, `R-#`, `U-#`) são rótulos das famílias descritas em [documentacao.md](documentacao.md), não dos ADRs 0007 a 0010.

## Bundle e processo filho

- Spec que precisa do artefato empacotado (`bash-guard`, `stdio.e2e`, `guard`) constrói o bundle sozinha no teste ou no `beforeAll`, por `fixtures/build-entry.ts` em processo filho. `stdio.e2e.spec.ts` é o único jeito de testar o artefato que as sessões executam.
- Spec de artefato nunca importa `scripts/build.ts` no jest: `import.meta.dirname` e `import.meta.main` não existem sob o transform CJS do ts-jest.
- O hook `hook/bash-guard.ts` é testado sempre por processo real (`spawnSync`) contra o `.ts` ou o `.mjs` empacotado; `decide` não é exportada.
- Spec que roda `scripts/install.ts` (inclusive `--check`) usa sempre `HOME` temporário, nunca o `HOME` real.

## Fixtures

- Todo arquivo de `test/fixtures/`, exceto `records-corpus.ts`, `chain-line.ts`, `fixture-args.ts`, `boundaries/`, `domains/` e `legacy-0x/`, roda como processo filho (`spawn`/`spawnSync`) e nunca é importado pelo jest.
- `argv` e `env` de cada probe são o contrato com quem o spawna (nos filhos de lock e de kill -9, um só argumento JSON tipado em `fixtures/fixture-args.ts`). Mudar a assinatura de um fixture atualiza a chamada em `test/*.spec.ts` no mesmo commit.
- `records-corpus.ts` é a única fonte de dados de volume: o spec que precisa de muitos registros chama `writeRecordsCorpus()` em vez de montá-los um a um.
