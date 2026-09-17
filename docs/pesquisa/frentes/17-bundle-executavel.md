## Frente 17: Bundle e executável autocontido

- Data: 2026-09-16. Pedido do usuário: "ferramentas tipo o webpack para gerar um executável js autocontido". Cobertas as duas leituras: (A) bundle em arquivo `.js` único; (B) binário com runtime embutido.
- Probes em `scratchpad/bundler/` (`probe/` e `harness/`): mini servidor MCP e mini hook com as deps reais em versões exatas; artefatos validados fora do projeto, sem `node_modules`, via `@modelcontextprotocol/client@2.0.0` (`Client` + `StdioClientTransport`). Node v24.18.1, Bun 1.3.14; Deno ausente.

### (A) Bundle em arquivo único
| ferramenta | versão | manutenção | TS direto | saída | servidor bytes / gzip | build ms | start servidor ms | start hook ms | resultado |
|---|---|---|---|---|---|---|---|---|---|
| **esbuild** | 0.28.2 (MIT, 2026-08-08, ~204M dl/sem) | ativa | sim | ESM/CJS | 1.671.246 / 295.398 | 65 / 8 (hook) | 223 | **41** | **Funcionou sem quebras, zero config** (embute deps por padrão) |
| tsdown (rolldown 1.2.9) | 0.23.0 (MIT, 2026-09-03, ~3,9M dl/sem) | ativa; sucessor do tsup | sim | ESM/CJS | 1.157.434 / 251.651 | 537 / 41 | 159 | 37 | Funcionou **só com config**: por padrão deixa `dependencies` externas; precisou `deps: { alwaysBundle: [/.*/] }` (glob `"*"` não cobre escopo; nomes exatos deixaram `zod` externo) |
| Rollup + rollup-plugin-esbuild + node-resolve/commonjs/json | 4.63.3 (MIT, 2026-09-14, ~91M dl/sem) | ativa | via plugin | ESM | 1.322.203 / 289.752 | ~4.500 | 159 | 39 | Funcionou com warnings não fatais (`@__PURE__` do zod, ciclos em zod/es-toolkit compat) |
| @vercel/ncc | 0.45.0 (MIT, 2026-08-13, ~695k dl/sem) | esporádica | sim (ts-loader) | ESM/CJS | — | — | — | — | **Falhou:** com `typescript@7.0.2` o ts-loader quebra (`TypeError: fileExists`); com TS 5.7.3 o type-check falha no `.d.ts` do Ajv; com `--transpile-only`, o resolver rejeita `canonicalize` (`"." is not exported under the conditions ["require","node","production"]`) |
| tsup | 8.5.1 (MIT) | README: "not actively maintained anymore, use tsdown instead" | sim | — | — | — | — | — | Não probado (descontinuado) |

webpack 5.111.0 e Parcel 2.16.4 descartados: setup pesado, voltados a web, sem ganho sobre esbuild/Rollup para servidor Node.

### (B) Binário autocontido
| ferramenta | versão | runtime | status | tamanho servidor / hook | build ms | start servidor ms | start hook ms | resultado |
|---|---|---|---|---|---|---|---|---|
| Node SEA | Node 24.18.1 (`--experimental-sea-config` + postject 1.0.0-alpha.6) | Node real | Stability 1.1 (doc v24.21.0); `--build-sea` **não existe** na 24.18.1 | 119,6 MB / 118,0 MB | ~5.000 / ~4.000 | 172 | 36 | Funcionou; fluxo manual de 3 passos (blob → copiar `node` → postject) |
| **@yao-pkg/pkg** | 6.22.0 (fork mantido; `vercel/pkg` arquivado em 2024-01-03) | Node real (`node24-linux-x64`) | ativo | **72,7 MB / 70,2 MB** | 4.335 (1ª vez baixa a base) / 835 | **130** | 52 | Funcionou sem quebras; menor binário e start mais rápido |
| Bun compile | Bun 1.3.14 | **Bun** (não Node) | estável | 91,7 MB / 90,2 MB | 456 / 233 | 194 | 37 | Funcionou nos pontos testados (`node:fs`, `randomUUIDv7`, `path.matchesGlob`); validação pontual, sem `linkSync`/`writeSync`+`fsync` |
| nexe | 5.0.0-beta.4 | Node | beta, ~4.884 dl/sem | — | — | — | — | Não probado |
| deno compile | — | Deno | — | — | — | — | — | Não probado (Deno ausente) |

### Referência sem build
| variante | start servidor (mediana 10×) | RSS | start hook (mediana 20×) |
|---|---|---|---|
| `node src/server.ts` (type stripping) | 407 ms | ~106,9 MB | 79 ms |
| `node dist-ref/server.js` (tsc, sem bundle) | 401 ms | ~93,8 MB | 41 ms |

### Recomendação do agente
- **(A) esbuild 0.28.2:** build de 65 ms, zero config para app standalone, sem quebras com Ajv 2020 (`new Function`), `canonicalize` ESM-only e `es-toolkit/compat`. Servidor sobe em 223 ms × 401–407 ms sem build; hook em 41 ms × 79 ms.
- **(B) nenhum:** Node já está garantido no ambiente (Claude Code roda em Node); 70–120 MB para remover uma dependência que já existe. Se necessário, `@yao-pkg/pkg` 6.22.0.
- (A) vale mais que continuar sem build, por resolver o risco "rodar da working tree" com custo desprezível. Decisão do usuário.

### Impacto no plano (se adotar A)
- Passo 0: etapa de build (`esbuild … --bundle --platform=node --target=node24`).
- `esbuild` em devDependencies; scripts `build` (e talvez `build:watch`).
- Jest **não muda**: continua testando o `.ts` fonte.
- Instalador: hook e servidor MCP apontam para o artefato, não para `src/`.
- Release por tag SemVer ganha artefato para anexar.
- Revisita a decisão R-2 (rodar da working tree) e o princípio "sem build".
- Nota do orquestrador: se o artefato ficar em `dist/` dentro da working tree, um `npm run build` com código quebrado ainda derruba o guard de todas as sessões; o isolamento real exige o instalador copiar o artefato para um diretório estável fora da working tree (e fora do diretório de dados protegido pelo deny).

### Riscos e armadilhas
- tsdown/rolldown: deps externas por padrão; só quebra em runtime fora do `node_modules`.
- @vercel/ncc: incompatível com TS 7; resolver não segue `exports` de pacotes ESM-only.
- Node SEA: fluxo manual, Stability 1.1, ~119 MB.
- `vercel/pkg` arquivado: só `@yao-pkg/pkg`.
- tsup descontinuado.
- Bun/Deno: runtime diferente; validação não exaustiva.
- Ajv `new Function` sobrevive a bundle e minificação; problema só de tipos.
