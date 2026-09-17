<!-- Parent: ../AGENTS.md -->
<!-- Generated: 2026-09-17 | Updated: 2026-09-17 -->

# scripts

## Purpose
Entrypoints reais de build e instalação do hexlog. Ligam as funções puras de
`src/guard.ts` e `src/installation.ts` a I/O de verdade: `esbuild`, `fs`,
`child_process` e o cliente MCP.

## Key Files
| File | Description |
|---|---|
| `build.ts` | Builda com `esbuild` os dois entrypoints (`server`: `src/server.ts`, `bash-guard`: `hook/bash-guard.ts`) para ESM `node24`, bundled, extensão `.mjs`. Sempre resolve a partir da raiz do repo (`import.meta.dirname`), nunca do cwd, pra garantir os mesmos bytes independente de quem chama. Exporta `build()` (usado por `install.ts` com `write: false` para pegar os bytes em memória) e `hasDynamicRequire()` (detecta o shim de `require` dinâmico que o esbuild injeta para dependência CJS não embutida) |
| `install.ts` | Instalador/verificador versionado. `node scripts/install.ts` builda os bundles, verifica o artefato preparado antes de trocar qualquer coisa (hook nega `D`/permite o resto; servidor sobe e anuncia as 10 tools), copia para `~/.local/lib/hexlog/<versão>/` com troca atômica, grava `manifest.json` (sha256, commit, `dirty`), registra as 4 regras de deny + o hook `PreToolUse` em `~/.claude/settings.json` (backup em `settings.json.bak-hexlog`) e o servidor MCP via `claude mcp add`/`remove`. `node scripts/install.ts --check` só verifica, sem tocar em nada |

## For AI Agents
### Working In This Directory
- A lógica de negócio dos dois scripts vive em `src/guard.ts`
  (`expectedRules`, `applyGuard`, `verifyGuard`, `hookProbes`,
  `sha256`) e `src/installation.ts` (`installArtifact`, `registerGuard`,
  `needsMcpRegistration`, `verifyInstallation`) — esses módulos são puros e
  testáveis, sem chamar `esbuild`/`claude`/`fs` de verdade. `install.ts` é só
  a fiação: injeta `runRealHook`, `countTools` (sobe o servidor num
  `HOME` descartável e conta `tools.length`) e `registerMcp` (`claude mcp
  remove`+`add`, substituível por `HEXLOG_REGISTER_MCP=<script>` nos testes).
- Mudar `hook/bash-guard.ts` ou `src/server.ts` na working tree não afeta
  nenhuma sessão em andamento nem nova até rodar `node scripts/install.ts`
  de novo: sessões sempre executam a cópia versionada em
  `~/.local/lib/hexlog/<versão>/`.
- Instalação é idempotente pelos bytes instalados (compara sha256 do build
  atual contra o instalado) e trata concorrência entre dois instaladores
  rodando ao mesmo tempo via troca atômica (`renameSync`) com fallback em
  `ENOTEMPTY`/`EEXIST`/`ENOENT`.

### Testing Requirements
- `npm test` (jest) roda tudo, incluindo:
  - `test/toolchain.spec.ts`: builda os dois entrypoints com o `esbuild` real
    e confere que nenhum bundle contém o shim `Dynamic require of`, e que o
    hook empacotado (`hook-probe.mjs`) sai com o código esperado.
  - `test/package.spec.ts` (N11): `dependencies`/`devDependencies` do
    `package.json` batem exatamente com o manifesto do projeto (sem
    `^`/`~`/faixas), `engines.node` é `>=24.18.1`.
  - `test/guard.spec.ts` (describes B2/B3): chama `installArtifact` e
    `verifyInstallation` direto, com `HOME` temporário — nunca o `HOME`
    real.
- `npm run typecheck` (`tsc --noEmit`) e `npm run build` (`node
  scripts/build.ts`, equivalente ao passo 1 do instalador) também cabem
  aqui antes de qualquer PR que toque nestes dois arquivos.

### Common Patterns
- `import.meta.main`/`import.meta.dirname` são usados nos dois scripts para
  o modo executável direto — incompatíveis com o transform CJS do ts-jest,
  por isso `src/installation.ts` duplica `hasDynamicRequire` em vez de
  importar de `build.ts`.
- Toda execução externa (`runHook`, `verifyServer`, `clock`, `log`)
  é passada por parâmetro para as funções de `src/`, nunca chamada direto —
  é isso que torna `installArtifact`/`verifyInstallation` testáveis sem
  processo real.

## Dependencies
### Internal
- `build.ts`: nenhuma (só resolve caminhos da raiz do repo)
- `install.ts`: `./build.ts`, `../src/directory.ts`, `../src/guard.ts`, `../src/installation.ts`

### External
- `esbuild`
- `@modelcontextprotocol/client` (`Client`, `StdioClientTransport`; devDependency)
- `node:fs`, `node:os`, `node:path`, `node:child_process`

<!-- MANUAL: Any manually added notes below this line are preserved on regeneration -->
