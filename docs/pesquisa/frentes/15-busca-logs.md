## Frente 15: Busca nos logs (Fuse.js × MiniSearch × alternativas × nativo)

- Data: 2026-09-16. Pedido do usuário: busca nos logs para o agente, com Fuse.js como proposta inicial.
- Probe em `scratchpad/busca/` (`bench.cjs`, `out2.log` = execução final válida; `out.log` = 1ª rodada com teto de recall corrigido).
- Corpus sintético determinístico (seed 42): 10.000 eventos em pt-BR com acentos (~40% Marco, ~40% Veredito, ~20% custom), 200 alvos, 15 consultas com gabarito calculado por força bruta, independente dos motores.

### Candidatos
| lib | versão | licença | último release | downloads/sem | unpacked | instalado | bundle min/gzip | deps | ESM/CJS | tipos | jest |
|---|---|---|---|---|---|---|---|---|---|---|---|
| fuse.js | 7.5.0 | Apache-2.0 | 2026-08-09 | 9.809.589 | 407 KB | 452 K | 26,5 KB / 9,5 KB | 0 | dual | nativos | sim |
| **minisearch** | 7.2.0 | MIT | 2025-09-16 | 2.057.682 | 807 KB | 904 K | 17,7 KB / 5,9 KB | 0 | dual | nativos | sim |
| flexsearch | 0.8.212 | Apache-2.0 | 2025-09-06 | 933.362 | 2,28 MB | 3,1 M | 50,6 KB / 17,3 KB | 0 | dual | nativos | sim |
| @orama/orama | 3.1.18 | Apache-2.0 | 2026-07-27 | 1.042.703 | 2,14 MB | 3,7 M | 48,2 KB / 16,8 KB | 0 | dual | nativos | sim |
| lunr | 2.3.9 | MIT | 2023-07-10 (parado) | 5.387.584 | 953 KB | 1,2 M | 30,9 KB / 8,9 KB | 0 | só CJS | @types/lunr | sim |
| @leeoniya/ufuzzy | 1.0.19 | MIT | 2025-08-22 | 303.991 | 131 KB | 164 K | 8,9 KB / 4,2 KB | 0 | dual | nativos | sim |
| match-sorter | 8.3.0 | MIT | 2026-04-15 | 2.402.848 | 179 KB | 1,37 M (@babel/runtime) | 9,2 KB / 3,5 KB | 2 | dual | nativos | sim |

Todos fazem `require()` em `.cjs` puro (sem `moduleNameMapper`). Acento nativo (conferido no código instalado): Fuse `ignoreDiacritics`; Orama `replaceDiacritics` (sempre ligado); FlexSearch charset `normalize` (padrão); match-sorter via `remove-accents`. MiniSearch e lunr: exigem `processTerm`/pipeline custom (~3 linhas). uFuzzy e nativo: normalização manual.

### Qualidade (médias das 15 consultas)
| motor | P@10 | recall | ruído top 10 (soma) | ruído total (soma) | inexistente = 0? | determinismo (5×) |
|---|---|---|---|---|---|---|
| **minisearch** | **0,97** | 1,00 | 4 | 20.084 | sim | sim |
| lunr | 0,87 | 0,76 | 0 | 0 | sim | sim |
| ufuzzy | 0,87 | 0,93 | 9 | 905 | sim | sim |
| match-sorter | 0,85 | 1,00 | 23 | 11.668 | sim | sim |
| fuse.js | 0,84 | 1,00 | 24 | 16.232 | sim | sim |
| nativo | 0,79 | 0,93 | 22 | 714 | sim | sim |
| orama | 0,74 | 0,83 | 39 | 33.883 | sim | sim |

- Erro de digitação ("atenticação"): resolvido só por fuse, minisearch, orama, ufuzzy, match-sorter. lunr, nativo e flexsearch (tokenizer `forward`) falham.
- AND de duas palavras: minisearch, flexsearch e lunr limpos; fuse (0,4) e match-sorter (0) com ruído; orama falhou `cache+invalidação` por falta de `components.tokenizer.language: 'portuguese'` no probe (com a opção, passa) → números da Orama subestimados nesse ponto.
- **Id exato** (`hex:alvo:login` com variantes `login-1..6` no corpus): P@10 baixo em quase todos (0–0,6), porque o tokenizer quebra em `:`. Minisearch foi o melhor (1 / 0,6), mas nenhum acerta 100%. **Conclusão de design:** `alvo`/id exato deve ser filtro estruturado por igualdade, nunca busca textual.

### Desempenho (10k docs)
| motor | build (ms, mediana de 5) | consulta (ms, mediana de 100) | heap (MB) |
|---|---|---|---|
| match-sorter | 1,0 | 21,2 | +1,04 |
| nativo | 8,9 | 0,89 | +1,56 |
| ufuzzy | 9,1 | 5,5 | +1,36 |
| fuse.js | 14,1 | **121,4** | +2,52 |
| orama | 146,7 | 19,7 | +16,17 |
| **minisearch** | 137,8 | **0,98** | +8,37 |
| flexsearch | 248,4 | 0,002 (cache interno ligado, não confiável) | +23,26 |
| lunr | 405,3 | 2,1 | +39,74 |

Fuse.js varre tudo (Bitap sem índice invertido): ~121 ms por consulta em 10k linhas.

### Design proposto pelo agente (com correções do orquestrador)
Estender `in` de `eventos` com campos opcionais, sem nova tool (M1 continua com 10):
- `busca?: string` (min 1) → índice de texto.
- `alvo?: Alvo` → filtro estruturado por igualdade, fora do índice.
- `marcoTipo?: string`, `resultado?: string` → filtros por igualdade. **Correção:** o agente propôs enums fixos (`inicio|checkpoint|fim`, `confirmado|refutado|parcial`), mas o vocabulário é por projeto e fixado no processo; devem ser strings validadas contra o vocabulário fixado.
- Intervalo de tempo: o agente propôs só `ate` (timestamp). **Correção:** `desde` já existe e é índice físico de linha (não `seq` nem data); intervalo temporal precisa de par próprio (ex.: `apos`/`antes` em `Instante`), a definir no plano.
- `out`: `relevancia?: number` por linha quando `busca` presente; ordenação por relevância no modo busca, com `proximoCursor` sobre o conjunto ranqueado (semântica diferente do modo cru, documentar); sem `busca`, comportamento atual intocado. Teto de 24k caracteres igual.
- Índice construído por chamada (~140 ms para 10k), sem cache entre chamadas → sem problema de invalidação com N processos MCP gravando; cache em memória por processo com invalidação por contagem de linhas fica como evolução (YAGNI).
- Escopo: só o `processo` pedido; busca em todos os processos do projeto seria N× o custo medido (não medido) → melhor como tool nova no futuro.

### Recomendação
**MiniSearch 7.2.0**, não Fuse.js:
1. Melhor P@10 médio (0,97 × 0,84), recall igual (1,00).
2. ~124× mais rápido por consulta (0,98 ms × 121,4 ms em 10k linhas).
3. 0 deps, 17,7 KB / 5,9 KB gzip, dual, roda no `.ts` do Node 24 e no jest CJS sem mapper.
4. AND nativo (`combineWith: 'AND'`).
5. Determinístico.
Fora: acento exige `processTerm` de ~3 linhas (testado); `alvo`/id exato sempre filtro estruturado. Alerta: sem release há 1 ano (API estável, 2M+ downloads/semana).

### Riscos e armadilhas
- 1ª rodada tinha `limit=1000` mascarando recall (gabarito de "autenticação" = 1.530 docs); corrigido para `limit=N`.
- Orama exige `language: 'portuguese'`.
- FlexSearch cacheia consultas por padrão.
- Ids quase idênticos colidem em qualquer motor de texto.
- Corpus sintético; validar com dados reais.
