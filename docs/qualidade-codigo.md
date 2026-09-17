# Qualidade de código e testes

Estudo do que dá para melhorar em qualidade/confiabilidade do hexlog no nível
de código e teste — TypeScript, ESLint, jest, property-based testing,
mutação. **Nada daqui está instalado.** Para plataformas de CI/CD (CodeQL,
Dependabot, npm audit, SonarQube Cloud, Codecov, knip, dependency-cruiser,
Semgrep), ver [`qualidade-ci.md`](./qualidade-ci.md) — não repetido aqui.

Fontes consultadas em **2026-09-17**. Versões e regras mudam; reconfira a
fonte antes de adotar qualquer item.

## Já coberto hoje (não é frente nova)

- **Testes de contrato/integração MCP via transporte em memória** — já é a
  base de quase toda spec: `test/helpers.ts` (`criarAmbiente()`) sobe o
  servidor `hexlog` real e um `Client` MCP ligados por `InMemoryTransport`,
  nunca mocka o servidor; `test/ferramentas-eventos.spec.ts` (a maior spec do
  repositório) testa as 10 tools reais. `test/stdio.e2e.spec.ts` complementa
  com e2e real via stdio contra o bundle `.mjs`. Não há lacuna aqui.
- **`npm ci` no CI** (`.github/workflows/ci.yml:19`) já falha se
  `package-lock.json` estiver fora de sincronia com `package.json` — não
  precisa de um step separado de verificação de lockfile.
- **fast-check** já cobre 5 arquivos: `test/cadeia.spec.ts`,
  `test/eventos.spec.ts`, `test/estado.property.spec.ts`,
  `test/pacote.spec.ts`, `test/fixtures/corpus.ts` (gerador de corpus).
- **`tsconfig.json:10`** já tem `"verbatimModuleSyntax": false` — decisão
  explícita (não omissão), não uma lacuna a preencher. Rever só se o build
  esbuild ou o transform CJS do ts-jest mudarem.

## Agora

Baixo custo, zero conta externa, todos tocam arquivos que o repo já tem
(`tsconfig.json`, `eslint.config.js`, `package.json`, `ci.yml`).

| Item | Esforço | Valor | Fonte |
|---|---|---|---|
| `noUncheckedIndexedAccess` + `noImplicitOverride` no tsconfig | ~20–40 min | Undefined explícito em acesso a índice; única classe do repo protegida contra override silencioso | [tsconfig noUncheckedIndexedAccess](https://www.typescriptlang.org/tsconfig/#noUncheckedIndexedAccess), [noImplicitOverride](https://www.typescriptlang.org/tsconfig/#noImplicitOverride) |
| `tseslint.configs.stylisticTypeChecked` | ~15 min | Regras de estilo type-aware, maioria autofixável por `eslint --fix` | [typescript-eslint shared configs](https://typescript-eslint.io/users/configs/) |
| `eslint-plugin-n` (`flat/recommended-module`) | ~15–20 min | Barra API deprecada/não suportada na versão de Node fixada (`package.json:7`, `ci.yml:18`) | [eslint-plugin-n README](https://github.com/eslint-community/eslint-plugin-n) |
| `eslint-plugin-jest` (`flat/recommended`, escopado a `test/**`) | ~10 min | Pega `no-conditional-expect`, `no-disabled-tests`, `valid-expect` numa suíte com specs de até 967 linhas (`test/guarda.spec.ts`) | [eslint-plugin-jest README](https://github.com/jest-community/eslint-plugin-jest) |
| jest hardening (`collectCoverage` local sem gate, `--errorOnDeprecated`, `--ci` no CI) | ~10 min | Visibilidade de cobertura sem travar PR; erro cedo em API deprecada; snapshot novo falha em vez de gravar sozinho no CI | [jest configuration](https://jestjs.io/docs/configuration), [jest CLI](https://jestjs.io/docs/cli) |

### `noUncheckedIndexedAccess` + `noImplicitOverride`

```json
{
  "compilerOptions": {
    "noUncheckedIndexedAccess": true,
    "noImplicitOverride": true
  }
}
```

`noImplicitOverride` tem custo ~zero: o repo só tem uma classe,
`ErroHexlog extends Error` (`src/erros.ts:37`), sem nenhum método
sobrescrito — habilitar não quebra nada hoje, só passa a exigir `override`
se algum dia surgir uma segunda camada de herança.

`noUncheckedIndexedAccess` tem impacto real a medir: os pontos mais prováveis
de gerar erro novo são os vários `Record<string, ...>` de chave livre —
`src/eventos.ts:102,119,120,131,145` e `src/definicoes.ts:45,47,56,68,119,239,338`
— e `env.XDG_DATA_HOME` em `src/diretorio.ts:12`. Rode `npm run typecheck`
depois de ligar a flag para ver a lista real antes de decidir se corrige ou
reverte.

### `stylisticTypeChecked`

```js
// eslint.config.js
tseslint.configs.recommendedTypeChecked,
tseslint.configs.stylisticTypeChecked,
```

Hoje o `eslint.config.js:18` usa só `recommendedTypeChecked`. A própria
documentação do typescript-eslint recomenda começar com
`recommended-type-checked` + `stylistic-type-checked` juntos.

### `eslint-plugin-n`

```js
import n from 'eslint-plugin-n';
// ...
n.configs['flat/recommended-module'], // package.json tem "type": "module"
```

Confirme o range de `peerDependencies` do plugin contra ESLint 10.10.0
(`package.json:58`) antes de instalar — não verificado nesta pesquisa.

### `eslint-plugin-jest`

```js
{
  files: ['test/**/*.spec.ts'],
  ...jest.configs['flat/recommended'],
},
```

### jest hardening

```jsonc
// package.json > scripts
"test:coverage": "jest --coverage", // informativo, sem coverageThreshold
"test": "jest --errorOnDeprecated",
```

```yaml
# ci.yml
- run: npm test -- --ci
```

`eslint.config.js:10` já ignora `coverage/**` — a pasta de saída já é
esperada, só falta gerar o relatório.

## Depois

Valor real, mas custo maior (triagem de regras, calibração, ou infra nova).
Um item por PR, quando a base crescer ou o tempo sobrar.

| Item | Esforço | Valor | Trade-off | Fonte |
|---|---|---|---|---|
| `tseslint.configs.strictTypeChecked` | ~60–90 min | Pega promise não tratada, condição sempre verdadeira, `any` implícito residual | Gera muitos avisos na 1ª rodada; foi Non-Goal explícito da tarefa de CI mais recente (`git log`: `2a7d97e ci: add github actions quality workflow`) — reavaliar depois do `stylisticTypeChecked` assentar | [typescript-eslint shared configs](https://typescript-eslint.io/users/configs/) |
| `eslint-plugin-unicorn` (`unicorn/recommended`) | ~45–90 min | 300+ regras, cobre filename-case (já bate com o padrão kebab-case do repo), array/string idioms | Muito opinativo, precisa triagem de exceções; exige ESLint ≥10.4 (ok, tem 10.10.0) e flat config + ESM (ok) | [eslint-plugin-unicorn README](https://github.com/sindresorhus/eslint-plugin-unicorn) |
| StrykerJS + `@stryker-mutator/jest-runner`, escopado a `src/cadeia.ts` e `src/estado.ts`, modo incremental | ~45–60 min setup | Mede se os testes da cadeia de hash e da projeção de Estado (núcleo do domínio) realmente matam mutantes, não só cobrem linha | Rodada de mutação é lenta; `incremental: true` amortiza rodadas seguintes | [Stryker intro](https://stryker-mutator.io/docs/stryker-js/introduction/), [jest runner](https://stryker-mutator.io/docs/stryker-js/jest-runner/), [incremental](https://stryker-mutator.io/docs/stryker-js/configuration/#incremental-boolean) |
| Expandir fast-check para `src/busca.ts` (`buscar`) e `src/gates.ts` (`avaliarEmbutido`) | ~30–45 min por módulo | Hoje só `cadeia`/`eventos`/`estado` têm property test; busca e gates só têm exemplo fixo (`test/busca.spec.ts`, `test/gates.spec.ts`) | fast-check é agnóstico de test runner, plugável direto no jest já usado | [fast-check getting started](https://fast-check.dev/docs/introduction/getting-started/) |
| commitlint + hook `commit-msg` no husky já instalado | ~15–20 min | Passa a verificar automaticamente o padrão Conventional Commits que os commits recentes já seguem (`5121859 chore:`, `fdbf24f fix:`, `2a7d97e ci:`) | Mais um gate no fluxo de commit; hoje o padrão é só convenção (skill `commit-message`) | [commitlint local setup](https://commitlint.js.org/#/guides-local-setup) |

## Nunca

| Item | Motivo | Fonte |
|---|---|---|
| `exactOptionalPropertyTypes` | Atrito real com o uso pesado de `es-toolkit` `omit`/`pick` sobre tipos com campo opcional Zod — `src/cadeia.ts:30`, `src/definicoes.ts:240`, `src/estado.ts:265`, `src/ferramentas-eventos.ts:578`. Custo de migração maior que o valor no tamanho atual do projeto | [tsconfig exactOptionalPropertyTypes](https://www.typescriptlang.org/tsconfig/#exactOptionalPropertyTypes) |
| `noPropertyAccessFromIndexSignature` | Ganho é só estilístico (obriga colchete em vez de ponto em index signature); único uso real hoje é `env.XDG_DATA_HOME` em `src/diretorio.ts:12` | [tsconfig noPropertyAccessFromIndexSignature](https://www.typescriptlang.org/tsconfig/#noPropertyAccessFromIndexSignature) |
| Matriz de versões de Node no CI | `package.json:7` e `ci.yml:18` fixam Node exatamente em `24.18.1`; `src/tipos-node.d.ts` documenta que o código depende de uma API de `node:crypto` (`randomUUIDv7`) ainda não coberta por `@types/node` 24.8.1 — testar contra versão mais antiga falharia de propósito | — (evidência local, `src/tipos-node.d.ts`) |
| `type-coverage` | Mede % de código tipado vs. `any`, mas `strict: true` (`tsconfig.json:11`) + `recommendedTypeChecked` (`eslint.config.js:18`) já cobrem a mesma preocupação de forma mais acionável — erro no arquivo exato, não um número agregado num projeto pequeno | [type-coverage no npm](https://www.npmjs.com/package/type-coverage) |
| `publint` / `arethetypeswrong` | Checam resolução de `exports`/tipos para quem instala via npm; hexlog é `"private": true` (`package.json:3`) e nunca é publicado num registry — é instalado como bundle esbuild versionado em `~/.local/lib/hexlog/<versão>/` (ADR 0001). Irrelevante enquanto isso não mudar | — (evidência local, `package.json:3`, ADR 0001) |

## Ordem sugerida

1. `noUncheckedIndexedAccess` + `noImplicitOverride` no `tsconfig.json` — maior valor imediato, zero conta externa.
2. `stylisticTypeChecked` + `eslint-plugin-n` + `eslint-plugin-jest` no mesmo PR, já que os três só tocam `eslint.config.js`.
3. jest hardening (`collectCoverage` local, `--ci`, `--errorOnDeprecated`).
4. Reavaliar `strictTypeChecked`, `eslint-plugin-unicorn`, Stryker e o resto da camada **Depois** quando a base de código crescer.
