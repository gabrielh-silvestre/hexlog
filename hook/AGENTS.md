<!-- Parent: ../AGENTS.md -->
<!-- Generated: 2026-09-17 | Updated: 2026-09-27 -->

# hook

## Purpose
Dois hooks do Claude Code. `bash-guard.ts` (`PreToolUse` da tool `Bash`)
impede que um agente contorne as tools MCP do hexlog (`list`, `state`,
`events`, `chain`) lendo o diretório de dados por fora, com `cat`, `grep`,
`jq` etc. Só tokeniza o comando recebido; nunca executa nada.
`flow-reminder.ts` (`PostToolUse` da tool `Skill`) lembra o agente de cruzar
via `hexlog-flow` quando a skill invocada está mapeada no `.hexlog/flow.md`
do repositório alvo.

## Key Files
| File | Description |
|---|---|
| `bash-guard.ts` | Lê `{tool_name, tool_input.command, cwd}` do stdin, tokeniza o comando com `shell-quote` e nega (exit 2) se algum token alcançar o diretório de dados (`dataDir`, de `src/directory.ts`), por igualdade, prefixo, glob (`*`, `?`, `[`, `{a,b}`, `**`) ou menção literal fora de qualquer token isolado (rede de segurança). Falha aberto: qualquer exceção interna, Node ausente ou stdin inválido cai em exit 0 (R-1) |
| `flow-reminder.ts` | Hook `PostToolUse` da tool `Skill`. Nunca bloqueia: lê `.hexlog/flow.md` do `cwd`, valida o frontmatter com `parseFlowMap` (`src/flow-map.ts`) e injeta um lembrete (`additionalContext`) quando a skill invocada está mapeada numa fase do `flow.md` com `hook: true`. Segundo modo (`--validate <path>`), usado pela `hexlog-setup`, só roda o parser e imprime os issues. Falha aberto igual a `bash-guard.ts` (R-1) |

## For AI Agents
### Working In This Directory
- `bash-guard.ts` é buildado pelo `esbuild` (`scripts/build.ts`, entrada
  `bash-guard` → `dist/bash-guard.mjs`) e é esse `.mjs`, não a working tree,
  que o `install.ts` copia para `~/.local/lib/hexlog/<versão>/` e registra em
  `~/.claude/settings.json` (`matcher: '^Bash$'`). Mudar este `.ts` só afeta
  sessões novas depois de rodar `node scripts/install.ts` de novo.
- A lógica de decisão é pura (`decide`, sem I/O) e separada da execução real
  (`run`, que lê stdin e seta `process.exitCode`), mas `decide` não é
  exportada: os testes sempre sobem um processo real (`spawnSync`) contra o
  `.ts` ou o `.mjs` empacotado, nunca chamam `decide` direto.
- `import.meta.main` não sobrevive ao bundle do esbuild; a checagem
  `isExecutedDirectly()` compara `process.argv[1]` com `fileURLToPath(import.meta.url)`.
- `flow-reminder.ts` é buildado pelo mesmo `scripts/build.ts` (entrada
  `flow-reminder` → `dist/flow-reminder.mjs`) e instalado por `install.ts`
  também numa cópia estável fora do diretório de versão
  (`~/.local/lib/hexlog/flow-reminder.mjs`), pra não exigir reapontar o
  `.claude/settings.json` do repositório alvo a cada upgrade. A cópia estável
  só é gravada depois que a troca atômica do diretório de versão dá certo.
- O `flow-reminder.mjs` não pode puxar `src/definitions.ts` (ajv,
  `canonicalize`): o hook roda a cada invocação de skill, e um teste de
  `flow-reminder.spec.ts` falha se esses módulos aparecerem no bundle.

### Testing Requirements
- `test/bash-guard.spec.ts`: casos de negação e permissão contra o hook
  `.ts` real (I4), entrada inválida/exceção interna falha aberto (I7), e um
  describe `B1(b)` que builda o `.ts` de verdade com esbuild e roda o `.mjs`
  resultante (nega `cat <D>/x` com exit 2, permite `true` com exit 0, e
  confere que o bundle não contém o shim `Dynamic require of`).
- `test/flow-reminder.spec.ts`: lembrete injetado para skill mapeada, silêncio
  para skill fora do mapa ou `flow.md` ausente/inválido, o modo `--validate`, e
  um build real que confere que o bundle não contém ajv/`canonicalize`.
- Rodar com `npm test` (jest); os dois specs sempre sobem um processo real de
  Node contra o `.ts`/`.mjs` (`spawnSync`), fora do transform `ts-jest`.

### Common Patterns
- Prefixo literal decide antes de expandir glob: um segmento com `**` ou uma
  chave `{a/b,c}` com barra é truncado no prefixo, porque `path.matchesGlob`
  não expande `**` até a profundidade de `D`.
- `~` só é expandido no início do token ou logo após `=` (`--opt=~/x`); o
  `shell-quote` não expande til por conta própria.

## Dependencies
### Internal
- `../src/directory.ts` (`dataDir`, só em `bash-guard.ts`)
- `../src/flow-map.ts` (`parseFlowMap`, `FlowMap`, só em `flow-reminder.ts`),
  que importa `../src/events.ts` (`Name`)

### External
- `shell-quote` (parse dos tokens do comando, só em `bash-guard.ts`)
- `yaml`, `zod` (parse e validação do `.hexlog/flow.md`, via `flow-map.ts`)
- `es-toolkit` (`isNil`, `isString`)
- `node:fs`, `node:os`, `node:path`, `node:url`

<!-- MANUAL: Any manually added notes below this line are preserved on regeneration -->
