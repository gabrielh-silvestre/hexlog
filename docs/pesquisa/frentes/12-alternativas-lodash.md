## Frente 12: Alternativas enxutas ao lodash

- Data: 2026-09-16. Pedido do usuário, por preferência pessoal (a pergunta é "qual", não "precisa").
- Medição: `npm view`, GitHub API, `api.npmjs.org/downloads`, esbuild 0.25.5 + gzip, Node 24.18.1 + jest 30.5.1/ts-jest 29.4.12/TS 5.9.2. Probes em `scratchpad/lodash-like/` (`probe.mjs`, `inspect-exports.mjs`, `jest.config*.cjs`).
- Nota: lodash clássico saiu do congelamento (4.18.0/4.18.1 nesta semana, antes 4.17.21 desde 2021).

### Ranking por tamanho
Conjunto de 12 funções: `groupBy`, `keyBy`, `pick`, `omit`, `isEqual`, `cloneDeep`, `uniqBy`, `sortBy`, `chunk`, `debounce`, `merge` profundo, `get` por caminho.

| lib | versão | unpacked | instalado c/ deps | bundle 12 funções min/gzip | bundle pick+omit+groupBy min/gzip | cobertura |
|---|---|---|---|---|---|---|
| lodash | 4.18.1 | 1,41 MB | 4,9 MB | 73,9 KB / 26,9 KB (sem tree-shaking) | 73,8 KB / 26,9 KB | 12/12 |
| lodash-es | 4.18.1 | 634,6 KB | 2,7 MB | 30,7 KB / 11,5 KB | 25,1 KB / 9,3 KB | 12/12 |
| es-toolkit (core) | 1.52.0 | 4,23 MB | **18 MB** | 7,8 KB / 2,75 KB | **0,36 KB / 0,21 KB** | 11/12 |
| es-toolkit/compat | 1.52.0 | (mesmo) | (mesmo) | 20,9 KB / 6,9 KB | 12,9 KB / 4,3 KB | 12/12 |
| remeda | 2.50.0 | 2,83 MB | 4,7 MB | 5,8 KB / 2,25 KB | 0,81 KB / 0,43 KB | 11/12 |
| **radashi** | 12.9.4 | 459 KB | 472 KB | **3,19 KB / 1,42 KB** | 0,86 KB / 0,50 KB | 11/12 |
| radash (original) | 12.1.1 | 306 KB | 408 KB | 1,56 KB / 0,80 KB | 0,29 KB / 0,22 KB | 10/12 |
| rambda | 11.3.0 | 674 KB | 1,2 MB | 3,53 KB / 1,51 KB | 0,73 KB / 0,43 KB | 9/12 |
| ramda | 0.32.0 | 1,20 MB | 3,4 MB | 13,9 KB / 4,19 KB | 6,85 KB / 2,24 KB | 10/12 |
| moderndash | 4.0.2 | 359 KB | 384 KB (+ type-fest 1,1 MB, hotscript 500 KB só tipos) | 2,23 KB / 0,96 KB | 0,51 KB / 0,30 KB | 9/12 |
| @antfu/utils | 9.3.0 | 45 KB | 68 KB | 0,98 KB / 0,55 KB | 0,27 KB / 0,21 KB | 3/12 |
| underscore | 1.13.8 | 908 KB | 2,6 MB | 20,1 KB / 7,6 KB | 20,1 KB / 7,6 KB (sem tree-shaking) | 12/12* |
| just-* (11 pacotes) | vários | soma 75 KB | 440 KB | 4,54 KB / 1,71 KB | 0,66 KB / 0,36 KB | 11/12 |

`*` underscore: `clone`/`extend` são rasos.

### Cobertura de funções
| função | lodash/-es | es-toolkit | remeda | radashi/radash | rambda | ramda | moderndash | antfu | underscore | just |
|---|---|---|---|---|---|---|---|---|---|---|
| groupBy | ✓ | ✓ | ✓ | `group` | ✓ | ✓ | `group` | ✗ | ✓ | `just-group-by` |
| keyBy | ✓ | ✓ | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ | `indexBy` | ✗ |
| pick | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | `objectPick` | ✓ | `just-pick` |
| omit | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | `objectOmit` | ✓ | `just-omit` |
| isEqual | ✓ | ✓ | `isDeepEqual` | ✓ | `equals` | `equals` | ✓ | `isDeepEqual` | ✓ | `just-compare` |
| cloneDeep | ✓ | ✓ | `clone` | ✓ (radash ✗) | ✗ | `clone` | ✗ | ✗ | `clone` (raso) | `just-clone` |
| uniqBy | ✓ | ✓ | `uniqueBy` | `unique(fn)` | ✓ | ✓ | `unique(fn)` | `uniqueBy` | `uniq(fn)` | `just-unique` |
| sortBy | ✓ | ✓ / `orderBy` | ✓ | `sort(fn)` | ✓ | ✓ | `sort(fn)` | ✗ | ✓ | `just-sort-by` |
| chunk | ✓ | ✓ | ✓ | `cluster` | `splitEvery` | `splitEvery` | ✓ | ✗ | ✓ | `just-split` |
| debounce | ✓ | ✓ | ✓ | ✓ | ✗ | ✗ | ✓ | ✓ | ✓ | `just-debounce-it` |
| merge profundo | ✓ | ✓ | `mergeDeep` | ✓ | `mergeDeep` | `mergeDeepRight` | ✓ | `deepMerge` | `extend` (raso) | `just-extend` (flag) |
| get por caminho | ✓ | só `/compat` | `pathOr` | ✓ | `path` | `path`/`pathOr` | ✗ | ✗ | ✓ | `just-safe-get` |

Ramda/rambda não têm `debounce` por design (funções puras).

### Encaixe na toolchain (sem config extra)
| lib | ESM/CJS | tipos nativos | sideEffects | deps | `node arq.ts` | jest + ts-jest | mapper? |
|---|---|---|---|---|---|---|---|
| lodash | CJS, sem `exports` | ✗ (@types/lodash) | — | 0 | import nomeado **falha** (`SyntaxError`); só default | ✓ | não |
| lodash-es | ESM puro, sem `require` | ✗ | — | 0 | ✓ | **✗** `Must use import to load ES Module` | **mapper não basta**: precisa também `transform`/`transformIgnorePatterns` |
| es-toolkit | dual | ✓ | `false` | 0 | ✓ | ✓ | não |
| remeda | dual | ✓ | `false` | 0 | ✓ | ✓ | não |
| radashi / radash | dual | ✓ | `false` | 0 | ✓ | ✓ | não |
| rambda / ramda | dual | rambda ✓ / ramda ✗ | `false` | 0 | ✓ | ✓ | não |
| moderndash | dual | ✓ | `false` | 2 (só tipos) | ✓ | ✓ | não |
| @antfu/utils | ESM, `exports.require: false` | ✓ | `false` | 0 | ✓ | **✗** | mapper + transform |
| underscore | dual (UMD) | ✗ | — | 0 | ✓ | ✓ | não |
| just-* | dual por pacote | ✓ | — | 0 | ✓ | ✓ | não |

Correção ao padrão do `canonicalize`: o `moduleNameMapper` isolado só funciona quando o arquivo apontado já é CJS-compatível. Para lodash-es e @antfu/utils (ESM real), é preciso mapper + transform.

### Manutenção e qualidade
| lib | último commit | stars | issues | downloads/sem | licença | API |
|---|---|---|---|---|---|---|
| lodash | 2026-09-11 | 61.278 | 105 | 120.067.588 | MIT | data-first |
| lodash-es | (mesmo repo) | — | — | 34.458.948 | MIT | data-first |
| es-toolkit | 2026-09-16 | 11.341 | 52 | 36.874.781 | MIT | data-first; claim do autor "2-3x mais rápido, até 97% menor" |
| remeda | 2026-09-16 | 5.428 | 15 | 8.015.005 | MIT | data-last/pipe |
| radashi | 2026-09-14 | 962 | 55 | 105.271 | MIT | data-first; fork comunitário do radash |
| radash | **2025-06-18** (parado) | 4.836 | 129 | 1.460.675 | MIT | data-first |
| rambda | 2026-09-14 | 1.757 | 0 | 1.780.906 | MIT | data-last/pipe |
| ramda | 2026-09-16 | 24.049 | 142 | 9.571.125 | MIT | data-last/pipe |
| moderndash | 2026-03-17 | 366 | 14 | 24.974 | MIT | data-first |
| @antfu/utils | 2025-10-06 | 877 | 7 | 2.282.882 | MIT | mista |
| underscore | 2026-09-16 | 27.320 | 53 | 21.013.546 | MIT | data-first |
| just | **2023-05-06** (parado) | 6.200 | 61 | ~29 mil/pacote | MIT | 1 pacote por função |

Nenhum benchmark independente verificado; claims de performance são dos próprios autores.

### Equivalentes nativos no Node 24
| função | nativo |
|---|---|
| cloneDeep | `structuredClone()` (funções/undefined diferem do lodash) |
| isEqual | `util.isDeepStrictEqual()` |
| groupBy | `Object.groupBy()` / `Map.groupBy()` |
| sortBy | `Array.prototype.toSorted()` (sem seletor) |
| uniqBy | `Set` só para unique simples |
| pick, omit, chunk, debounce, merge, get, keyBy | sem nativo |

### Recomendação (tamanho > encaixe > manutenção)
1. **es-toolkit `1.52.0`**: menor bundle no subconjunto mínimo (0,36 KB / 0,21 KB), dual sem mapper, muito ativo. Contras: 18 MB em disco; `get`/`keyBy` só via `es-toolkit/compat`.
2. **radashi `12.9.4`**: menor instalado (472 KB), bundle das 12 em 3,19 KB / 1,42 KB, dual sem mapper, ativo. Contras: sem `keyBy`; nomes divergem do lodash (`group`, `cluster`, `sort`); 105 mil downloads/semana.
3. **lodash-es `4.18.1`**: 12/12 com API idêntica ao lodash. Contras: bundle maior (25–30 KB), sem tipos nativos, exige mapper + transform no jest.

### Riscos e armadilhas
- radash original abandonado → se família radash, usar `radashi`.
- just parado há 3,3 anos; 11 pacotes separados.
- @antfu/utils cobre só 3/12.
- ramda sem tipos nativos; rambda/ramda sem `debounce`.
- `import { pick } from 'lodash'` quebra em runtime no Node ESM.
