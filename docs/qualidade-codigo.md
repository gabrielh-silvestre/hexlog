# Qualidade de código e testes

Estudo do que dá para melhorar em qualidade/confiabilidade do hexlog no nível
de código e teste — TypeScript, ESLint, jest, property-based testing,
mutação. **O tier "Agora" e o Stryker (só nos unitários) já estão instalados; o resto é estudo, nada instalado.** Para plataformas de CI/CD (CodeQL,
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

> **Instalada em 2026-09-28.** Desvios do
> plano: `--ci` ficou de fora (o repo não tem snapshots);
> `consistent-type-definitions` padroniza em `type`; cobertura roda só via
> `npm run test:coverage`, sem `coverageThreshold`; `jest/expect-expect`
> reconhece `expectError` e `expectDeduplicated` como asserts.
>
> **Atualizado em 2026-10-21:** o `ci.yml` roda `npm run test:coverage` (com
> `--errorOnDeprecated`) no lugar de `npm test`, com piso global de 90%
> (`package.json#jest.coverageThreshold`), e o `knip` está instalado
> (`knip.json`, `npm run knip` no CI). Os trechos abaixo sobre cobertura
> informativa e sobre o `ci.yml` rodar `npm test` descrevem o estado de
> 2026-09-28.

Baixo custo, zero conta externa, todos tocam arquivos que o repo já tem
(`tsconfig.json`, `eslint.config.js`, `package.json`, `ci.yml`).

| Item | Esforço | Valor | Fonte |
|---|---|---|---|
| `noUncheckedIndexedAccess` + `noImplicitOverride` no tsconfig | ~20–40 min | Undefined explícito em acesso a índice; as classes do repo (`HexlogError`, `ArchiveError`) ficam protegidas contra override silencioso | [tsconfig noUncheckedIndexedAccess](https://www.typescriptlang.org/tsconfig/#noUncheckedIndexedAccess), [noImplicitOverride](https://www.typescriptlang.org/tsconfig/#noImplicitOverride) |
| `tseslint.configs.stylisticTypeChecked` | ~15 min | Regras de estilo type-aware, maioria autofixável por `eslint --fix` | [typescript-eslint shared configs](https://typescript-eslint.io/users/configs/) |
| `eslint-plugin-n` (`flat/recommended-module`) | ~15–20 min | Barra API deprecada/não suportada no piso de Node declarado em `engines` (`package.json`, `engines.node`) | [eslint-plugin-n README](https://github.com/eslint-community/eslint-plugin-n) |
| `eslint-plugin-jest` (`flat/recommended`, escopado a `test/**`) | ~10 min | Pega `no-conditional-expect`, `no-disabled-tests`, `valid-expect` numa suíte com specs grandes | [eslint-plugin-jest README](https://github.com/jest-community/eslint-plugin-jest) |
| jest hardening (`test:coverage` e `--errorOnDeprecated`; `--ci` ficou de fora; o piso de 90 veio depois) | ~10 min | Visibilidade de cobertura sem travar PR; erro cedo em API deprecada | [jest configuration](https://jestjs.io/docs/configuration), [jest CLI](https://jestjs.io/docs/cli) |

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
"test:coverage": "jest --coverage", // estado de 2026-09-28: informativo; hoje tem piso de 90
"test": "jest --errorOnDeprecated",
```

O `ci.yml` rodava `npm test` sem `--ci`, porque o repo não tem snapshots; hoje roda
`npm run test:coverage`, também sem `--ci`.
`eslint.config.js` (`ignores`) já ignora `coverage/**`, a pasta de saída do
`test:coverage`.

## Mutação (Stryker)

> **Instalado em 2026-10-17**, só nos specs unitários: `@stryker-mutator/core`,
> `jest-runner` e `typescript-checker` em `^10.0.0`.

A rodada é manual, por `npm run test:mutation`, fora do CI e do husky. Os specs
e os arquivos de `src/` do escopo ficam em `stryker.config.json`
(`jest.config.testMatch` e `mutate`), e o relatório sai em `reports/mutation/`,
ignorado pelo git. O Stryker roda o jest sem `globalSetup`, sem `globalTeardown`
e sem `--findRelatedTests`.

Três opções têm motivo próprio. `disableBail: true` guarda o `killedBy` completo de
cada mutante, que a remoção de teste com prova exige, sem custo, porque o jest já
roda sem `--bail` dentro do Stryker. `ignoreStatic` fica desligado de propósito: o
mutante estático mata de verdade, ao preço de rodar a suíte inteira para cada um.
O `typescript-checker` fica no padrão `prioritizePerformanceOverAccuracy: true`,
por tempo: o score absoluto é aproximado, e a comparação entre rodadas vale porque a
config é a mesma. Mudar qualquer uma das três pede rodada-base nova.

Limites da medição. O escopo são os 18 arquivos de `mutate`, e `mutate` e `testMatch` são
mantidos à mão: arquivo novo no escopo entra nos dois. `hook/bash-guard.ts`, `src/guard.ts` e
`src/installation.ts` ficam fora porque seus specs sobem processo filho ou o bundle
([qualidade-e-testes.md](directives/qualidade-e-testes.md), seção "Bundle e processo filho", que
nomeia só `bash-guard`, `stdio.e2e` e `guard`; `test/installation.spec.ts` também sobe os bundles e
processos filhos reais), e a rodada só roda os specs unitários. `thresholds.break` fica no padrão `null`: a rodada é uma
medição pontual e não reprova, e o piso de 80% por arquivo é conferido à mão no relatório.

## Depois

Valor real, mas custo maior (triagem de regras, calibração, ou infra nova).
Um item por PR, quando a base crescer ou o tempo sobrar.

| Item | Esforço | Valor | Trade-off | Fonte |
|---|---|---|---|---|
| `tseslint.configs.strictTypeChecked` | ~60–90 min | Pega promise não tratada, condição sempre verdadeira, `any` implícito residual | Gera muitos avisos na 1ª rodada; foi Non-Goal explícito da tarefa de CI mais recente (`git log`: `2a7d97e ci: add github actions quality workflow`) — reavaliar depois do `stylisticTypeChecked` assentar | [typescript-eslint shared configs](https://typescript-eslint.io/users/configs/) |
| `eslint-plugin-unicorn` (`unicorn/recommended`) | ~45–90 min | 300+ regras, cobre filename-case (já bate com o padrão kebab-case do repo), array/string idioms | Muito opinativo, precisa triagem de exceções; exige ESLint ≥10.4 (ok, tem 10.10.0) e flat config + ESM (ok) | [eslint-plugin-unicorn README](https://github.com/sindresorhus/eslint-plugin-unicorn) |
| Expandir fast-check para `src/domain/gate.ts` (`evaluateGate`) | ~30–45 min | Vigência, busca e paginação já têm property test (`test/domain/vigency.property.spec.ts`, `test/adapters/search.spec.ts`, `test/queries/pagination.spec.ts`); gates só têm exemplo fixo (`test/domain/gate.spec.ts`) | fast-check é agnóstico de test runner, plugável direto no jest já usado | [fast-check getting started](https://fast-check.dev/docs/introduction/getting-started/) |
| commitlint + hook `commit-msg` no husky já instalado | ~15–20 min | Passa a verificar automaticamente o padrão Conventional Commits que os commits recentes já seguem (`5121859 chore:`, `fdbf24f fix:`, `2a7d97e ci:`) | Mais um gate no fluxo de commit; hoje o padrão é só convenção (skill `commit-message`) | [commitlint local setup](https://commitlint.js.org/#/guides-local-setup) |

## Nunca

Linhas `Nunca` revalidadas em 2026-10-03 contra a árvore 1.0: os arquivos citados existem, `exactOptionalPropertyTypes` foi remedido em 2026-10-04 (abaixo) e `publint`/`arethetypeswrong` seguem irrelevantes porque o pacote é `private`, instalado como bundle, e os ADRs 0007 a 0009 não preveem publicação em registry.

| Item | Motivo | Fonte |
|---|---|---|
| `exactOptionalPropertyTypes` | Atrito medido em 2026-10-04 na árvore 1.0 (`npx tsc --noEmit --exactOptionalPropertyTypes`): ligar a flag dá 20 erros de tipo em 13 arquivos, 9 deles nas tools MCP (`src/mcp/tools/`, campos opcionais Zod repassados aos serviços); o resto fica em `src/adapters/search.ts`, `src/archive.ts`, `src/commands/process.ts`, `src/domain/gate.ts`, `src/queries/query-service.ts`, `scripts/insights.ts` e em três specs (`test/`); `src/domain/chain.ts` (`hashLink`, `omit`) não quebra. Custo de migração maior que o valor no tamanho atual do projeto | [tsconfig exactOptionalPropertyTypes](https://www.typescriptlang.org/tsconfig/#exactOptionalPropertyTypes) |
| `noPropertyAccessFromIndexSignature` | Ganho é só estilístico (obriga colchete em vez de ponto em index signature); único uso real hoje é `env.XDG_DATA_HOME` em `src/directory.ts` (`dataDir`) | [tsconfig noPropertyAccessFromIndexSignature](https://www.typescriptlang.org/tsconfig/#noPropertyAccessFromIndexSignature) |
| Matriz de versões de Node no CI | `ci.yml` (`node-version`) fixa Node exatamente em `24.18.1` (`package.json` (`engines.node`) declara a faixa `^24.18.1`, que cobre só a série 24.x e deixa de fora o Node 25 e o 26); o `engines` (`^24.18.1`) fixa o piso e o teto; o código usa `randomUUIDv7` de `node:crypto` (disponível desde o Node 24.16.0, estável só a partir do 26.1.0) | — (evidência local, `package.json` (`engines.node`)) |
| `type-coverage` | Mede % de código tipado vs. `any`, mas `strict: true` (`tsconfig.json` (`strict`)) + `recommendedTypeChecked` (`eslint.config.js`) já cobrem a mesma preocupação de forma mais acionável — erro no arquivo exato, não um número agregado num projeto pequeno | [type-coverage no npm](https://www.npmjs.com/package/type-coverage) |
| `publint` / `arethetypeswrong` | Checam resolução de `exports`/tipos para quem instala via npm; hexlog é `"private": true` (`package.json` (`private`)) e nunca é publicado num registry — é instalado como bundle esbuild versionado em `~/.local/lib/hexlog/<versão>/` (`scripts/install.ts`). Irrelevante enquanto isso não mudar | — (evidência local, `package.json` (`private`), `scripts/install.ts`) |

## Ordem sugerida

1. Instalado: `noUncheckedIndexedAccess` + `noImplicitOverride` no `tsconfig.json`.
2. Instalado: `stylisticTypeChecked` + `eslint-plugin-n` + `eslint-plugin-jest`.
3. Instalado, sem `--ci`: jest hardening (`test:coverage` com piso de 90 no CI, `--errorOnDeprecated`).
4. Instalado: Stryker só nos unitários (`npm run test:mutation`, rodada manual).
5. Reavaliar `strictTypeChecked`, `eslint-plugin-unicorn` e o resto da camada **Depois** quando a base de código crescer.
