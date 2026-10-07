# Qualidade de código e testes

Estudo do que dá para melhorar em qualidade/confiabilidade do hexlog no nível
de código e teste — TypeScript, ESLint, jest, property-based testing,
mutação. **O tier "Agora" já está instalado; o resto é estudo, nada instalado.** Para plataformas de CI/CD (CodeQL,
Dependabot, npm audit, SonarQube Cloud, Codecov, knip, dependency-cruiser,
Semgrep), ver [`qualidade-ci.md`](./qualidade-ci.md) — não repetido aqui.

Fontes consultadas em **2026-09-17**. Versões e regras mudam; reconfira a
fonte antes de adotar qualquer item.

## Já coberto hoje (não é frente nova)

- **Testes de contrato/integração MCP via transporte em memória** — já é a
  base das specs de `test/mcp/`: `test/mcp/environment.ts#createEnvironment`
  liga `compose` e `createServer` a um `Client` MCP por `InMemoryTransport`,
  nunca mocka o servidor; `test/mcp/tools.spec.ts` testa as 12 tools reais.
  `test/stdio.e2e.spec.ts` complementa com e2e real via stdio contra o bundle
  `.mjs`. Não há lacuna aqui.
- **`npm ci` no CI** (`.github/workflows/ci.yml`) já falha se
  `package-lock.json` estiver fora de sincronia com `package.json` — não
  precisa de um step separado de verificação de lockfile.
- **fast-check** já cobre a vigência de registros em
  `test/domain/vigency.property.spec.ts`, a busca em `test/adapters/search.spec.ts`
  e a paginação em `test/queries/pagination.spec.ts`; `test/package.spec.ts` só
  trava a versão fixada da dependência.
- **`tsconfig.json`** já tem `"verbatimModuleSyntax": false` — decisão
  explícita (não omissão), não uma lacuna a preencher. Rever só se o build
  esbuild ou o transform CJS do ts-jest mudarem.

## Agora

> **Instalada em 2026-09-28** (branch `chore/code-quality-agora`). Desvios do
> plano: `--ci` ficou de fora (o repo não tem snapshots);
> `consistent-type-definitions` padroniza em `type`; cobertura roda só via
> `npm run test:coverage`, sem `coverageThreshold`; `jest/expect-expect`
> reconhece `expectError` e `expectDeduplicated` como asserts.

Baixo custo, zero conta externa, todos tocam arquivos que o repo já tem
(`tsconfig.json`, `eslint.config.js`, `package.json`, `ci.yml`).

| Item | Esforço | Valor | Fonte |
|---|---|---|---|
| `noUncheckedIndexedAccess` + `noImplicitOverride` no tsconfig | ~20–40 min | Undefined explícito em acesso a índice; as classes do repo (`HexlogError`, `ArchiveError`) ficam protegidas contra override silencioso | [tsconfig noUncheckedIndexedAccess](https://www.typescriptlang.org/tsconfig/#noUncheckedIndexedAccess), [noImplicitOverride](https://www.typescriptlang.org/tsconfig/#noImplicitOverride) |
| `tseslint.configs.stylisticTypeChecked` | ~15 min | Regras de estilo type-aware, maioria autofixável por `eslint --fix` | [typescript-eslint shared configs](https://typescript-eslint.io/users/configs/) |
| `eslint-plugin-n` (`flat/recommended-module`) | ~15–20 min | Barra API deprecada/não suportada no piso de Node declarado em `engines` (`package.json`, `engines.node`) | [eslint-plugin-n README](https://github.com/eslint-community/eslint-plugin-n) |
| `eslint-plugin-jest` (`flat/recommended`, escopado a `test/**`) | ~10 min | Pega `no-conditional-expect`, `no-disabled-tests`, `valid-expect` numa suíte com specs de até 1.646 linhas (`test/guard.spec.ts`) | [eslint-plugin-jest README](https://github.com/jest-community/eslint-plugin-jest) |
| jest hardening (`test:coverage` local sem gate e `--errorOnDeprecated`; `--ci` ficou de fora) | ~10 min | Visibilidade de cobertura sem travar PR; erro cedo em API deprecada | [jest configuration](https://jestjs.io/docs/configuration), [jest CLI](https://jestjs.io/docs/cli) |

### `noUncheckedIndexedAccess` + `noImplicitOverride`

```json
{
  "compilerOptions": {
    "noUncheckedIndexedAccess": true,
    "noImplicitOverride": true
  }
}
```

`noImplicitOverride` tem custo ~zero: o repo só tem duas classes,
`HexlogError extends Error` (`src/errors.ts`) e `ArchiveError extends Error`
(`src/archive.ts`), sem nenhum método sobrescrito — habilitar não quebra nada
hoje, só passa a exigir `override` se algum dia surgir uma segunda camada de
herança.

`noUncheckedIndexedAccess` já está ligada. O acesso a índice de chave livre que
sobra no código de produção é `env.XDG_DATA_HOME` em `src/directory.ts`
(`dataDir`).

### `stylisticTypeChecked`

```js
// eslint.config.js
tseslint.configs.recommendedTypeChecked,
tseslint.configs.stylisticTypeChecked,
```

O `eslint.config.js` usa `recommendedTypeChecked` e `stylisticTypeChecked`
juntos, como a própria documentação do typescript-eslint recomenda.

### `eslint-plugin-n`

```js
import n from 'eslint-plugin-n';
// ...
n.configs['flat/recommended-module'], // package.json tem "type": "module"
```

O plugin está instalado em 18.4.0 (`package.json`), junto do ESLint 10.10.0.

### `eslint-plugin-jest`

```js
{
  files: ['test/**/*.ts'],
  ...jest.configs['flat/recommended'],
  rules: {
    ...jest.configs['flat/recommended'].rules,
    'jest/expect-expect': [
      'error',
      { assertFunctionNames: ['expect', 'expectError', 'expectDeduplicated'] },
    ],
  },
},
```

### jest hardening

```jsonc
// package.json > scripts
"test:coverage": "jest --coverage", // informativo, sem coverageThreshold
"test": "jest --errorOnDeprecated",
```

O `ci.yml` roda `npm test` sem `--ci`, porque o repo não tem snapshots.
`eslint.config.js` (`ignores`) já ignora `coverage/**`, a pasta de saída do
`test:coverage`.

## Depois

Valor real, mas custo maior (triagem de regras, calibração, ou infra nova).
Um item por PR, quando a base crescer ou o tempo sobrar.

| Item | Esforço | Valor | Trade-off | Fonte |
|---|---|---|---|---|
| `tseslint.configs.strictTypeChecked` | ~60–90 min | Pega promise não tratada, condição sempre verdadeira, `any` implícito residual | Gera muitos avisos na 1ª rodada; foi Non-Goal explícito da tarefa de CI mais recente (`git log`: `2a7d97e ci: add github actions quality workflow`) — reavaliar depois do `stylisticTypeChecked` assentar | [typescript-eslint shared configs](https://typescript-eslint.io/users/configs/) |
| `eslint-plugin-unicorn` (`unicorn/recommended`) | ~45–90 min | 300+ regras, cobre filename-case (já bate com o padrão kebab-case do repo), array/string idioms | Muito opinativo, precisa triagem de exceções; exige ESLint ≥10.4 (ok, tem 10.10.0) e flat config + ESM (ok) | [eslint-plugin-unicorn README](https://github.com/sindresorhus/eslint-plugin-unicorn) |
| StrykerJS + `@stryker-mutator/jest-runner`, escopado a `src/domain/chain.ts` e `src/domain/relations.ts`, modo incremental | ~45–60 min setup | Mede se os testes da cadeia de hash e das regras de relação e vigência (núcleo do domínio) realmente matam mutantes, não só cobrem linha | Rodada de mutação é lenta; `incremental: true` amortiza rodadas seguintes | [Stryker intro](https://stryker-mutator.io/docs/stryker-js/introduction/), [jest runner](https://stryker-mutator.io/docs/stryker-js/jest-runner/), [incremental](https://stryker-mutator.io/docs/stryker-js/configuration/#incremental-boolean) |
| Expandir fast-check para `src/domain/gate.ts` (`evaluateGate`) | ~30–45 min | Vigência, busca e paginação já têm property test (`test/domain/vigency.property.spec.ts`, `test/adapters/search.spec.ts`, `test/queries/pagination.spec.ts`); gates só têm exemplo fixo (`test/domain/gate.spec.ts`) | fast-check é agnóstico de test runner, plugável direto no jest já usado | [fast-check getting started](https://fast-check.dev/docs/introduction/getting-started/) |
| commitlint + hook `commit-msg` no husky já instalado | ~15–20 min | Passa a verificar automaticamente o padrão Conventional Commits que os commits recentes já seguem (`5121859 chore:`, `fdbf24f fix:`, `2a7d97e ci:`) | Mais um gate no fluxo de commit; hoje o padrão é só convenção (skill `commit-message`) | [commitlint local setup](https://commitlint.js.org/#/guides-local-setup) |

## Nunca

Linhas `Depois` (Stryker) e `Nunca` revalidadas em 2026-10-03 contra a árvore 1.0: os arquivos citados existem, `exactOptionalPropertyTypes` foi remedido em 2026-10-04 (abaixo) e `publint`/`arethetypeswrong` seguem irrelevantes porque o pacote é `private`, instalado como bundle, e os ADRs 0007 a 0009 não preveem publicação em registry.

| Item | Motivo | Fonte |
|---|---|---|
| `exactOptionalPropertyTypes` | Atrito medido em 2026-10-04 na árvore 1.0 (`npx tsc --noEmit --exactOptionalPropertyTypes`): ligar a flag dá 20 erros de tipo em 13 arquivos, 9 deles nas tools MCP (`src/mcp/tools/`, campos opcionais Zod repassados aos serviços); o resto fica em `src/adapters/search.ts`, `src/archive.ts`, `src/commands/process.ts`, `src/domain/gate.ts`, `src/queries/query-service.ts`, `scripts/insights.ts` e em três specs (`test/`); `src/domain/chain.ts` (`hashLink`, `omit`) não quebra. Custo de migração maior que o valor no tamanho atual do projeto | [tsconfig exactOptionalPropertyTypes](https://www.typescriptlang.org/tsconfig/#exactOptionalPropertyTypes) |
| `noPropertyAccessFromIndexSignature` | Ganho é só estilístico (obriga colchete em vez de ponto em index signature); único uso real hoje é `env.XDG_DATA_HOME` em `src/directory.ts` (`dataDir`) | [tsconfig noPropertyAccessFromIndexSignature](https://www.typescriptlang.org/tsconfig/#noPropertyAccessFromIndexSignature) |
| Matriz de versões de Node no CI | `ci.yml` (`node-version`) fixa Node exatamente em `24.18.1` (`package.json` (`engines.node`) só declara o piso `>=24.18.1`); `src/node-types.d.ts` documenta que o código depende de uma API de `node:crypto` (`randomUUIDv7`) ainda não coberta por `@types/node` 24.8.1 — testar contra versão mais antiga falharia de propósito | — (evidência local, `src/node-types.d.ts`) |
| `type-coverage` | Mede % de código tipado vs. `any`, mas `strict: true` (`tsconfig.json` (`strict`)) + `recommendedTypeChecked` (`eslint.config.js`) já cobrem a mesma preocupação de forma mais acionável — erro no arquivo exato, não um número agregado num projeto pequeno | [type-coverage no npm](https://www.npmjs.com/package/type-coverage) |
| `publint` / `arethetypeswrong` | Checam resolução de `exports`/tipos para quem instala via npm; hexlog é `"private": true` (`package.json` (`private`)) e nunca é publicado num registry — é instalado como bundle esbuild versionado em `~/.local/lib/hexlog/<versão>/` (`scripts/install.ts`). Irrelevante enquanto isso não mudar | — (evidência local, `package.json` (`private`), `scripts/install.ts`) |

## Ordem sugerida

1. Instalado: `noUncheckedIndexedAccess` + `noImplicitOverride` no `tsconfig.json`.
2. Instalado: `stylisticTypeChecked` + `eslint-plugin-n` + `eslint-plugin-jest`.
3. Instalado, sem `--ci`: jest hardening (`test:coverage` local, `--errorOnDeprecated`).
4. Reavaliar `strictTypeChecked`, `eslint-plugin-unicorn`, Stryker e o resto da camada **Depois** quando a base de código crescer.
