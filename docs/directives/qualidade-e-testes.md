# Qualidade e testes

## Antes de concluir

- Rode `npm run typecheck`, `npm run lint` e `npm run format:check` (o CI roda os três, mais `npm test` e `npm run test:budget`).
- `npm test` roda tudo, exceto os specs de orçamento (`*.budget.spec.ts`), e termina em até 300 s (P5). `npx jest test/<arquivo>.spec.ts` (ou `npm test -- test/<arquivo>.spec.ts`) roda um spec.
- `npm ci` precisa ser completo (sem `--omit=dev`): `esbuild` e `@modelcontextprotocol/client` são devDependencies usadas pelo instalador e pelos testes. Node `>= 24.18.1` (`package.json#engines`).
- Não precisa de `npm run build` prévio: os specs que dependem de bundle constroem o artefato num processo filho. `npm run build` só cabe antes de PR que toque `scripts/build.ts` ou `scripts/install.ts`.
- Os testes lentos do `npm test` são TF1 (kill -9 no meio do lote), TF4 (dono do lock vivo pausado), P1 e o estresse 8x25 do lock.
- Sobra de execução interrompida (`kill -9` pula o `globalTeardown`): `find "${TMPDIR:-/tmp}" -maxdepth 1 -name 'hexlog-suite-*' -exec rm -rf {} +`.

## Orçamentos de tempo

- `npm run test:budget` roda os specs de orçamento em série (`jest --runInBand`): `adapters/load.budget.spec.ts`, `adapters/search.budget.spec.ts`, `adapters/lock.budget.spec.ts`, `queries/query.budget.spec.ts` e `queries/project.budget.spec.ts`. O CI o roda depois de `npm test` ([ADR 0009](adr-0009-ferramental.md), item 4).
- Eles medem tempo e podem falhar em máquina lenta, por isso só rodam nesse script. `adapters/load.budget.spec.ts` compara o mínimo das medições, não a mediana.

## Convenções dos specs

- Spec que chama tools passa por `mcp/environment.ts#createEnvironment()` (servidor real sobre `compose` e `InMemoryTransport`) e nunca mocka o servidor MCP.
- Ao testar uma tool que recusa entrada, use `expectError()` de `mcp/environment.ts` antes de reimplementar a asserção de erro estruturado.
- Diretório temporário só por `helpers.ts#createTempDir`, dentro de hook ou teste, nunca na coleta do `describe`: a coleta roda até com `-t`, e o `afterAll` de `cleanup.ts` não roda num arquivo sem teste selecionado, então o diretório vazaria. A trava de lint só barra `mkdtempSync`.
- Teste que sobe bundle, processo filho ou carga declara o próprio timeout como último argumento do `it` (de 15_000 a 240_000 ms), porque o padrão do jest é 5000 ms e não há `testTimeout` global.
- Property-based tests (`fast-check`, `fc.assert`/`fc.property`) cobrem as invariantes de hash e de vigência: `domain/chain.spec.ts` e `domain/vigency.property.spec.ts`.
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
