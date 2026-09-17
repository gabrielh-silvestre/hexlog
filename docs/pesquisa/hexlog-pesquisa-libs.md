# Pesquisa de libs e padrões — hexlog

- Data: 2026-09-16
- Origem: fase dedicada de pesquisa do `/ralplan --deliberate` sobre a spec `deep-dive-vamos-criar-uma-aplicacao-propria.md` (mantida em `.omc/specs/`, fora do repo)
- Método: 11 frentes em paralelo (10 × `document-specialist`, 1 × `claude-code-guide`), versões e datas verificadas no npm/GitHub/documentação oficial no dia, probes isolados no scratchpad. A frente de isolamento teve uma segunda rodada e verificação direta do orquestrador na doc em markdown.
- Ambiente: Node v24.18.1, npm 11.16.0, Claude Code 2.1.273, Linux WSL2 (ext4 em `~/.local/share`), `bwrap`/`socat` ausentes.
- Status: promovido para o repo em 2026-09-16.

## Relatórios por frente

1. [Servidores MCP de log/auditoria existentes](frentes/01-mcp-existentes.md)
2. [API real do SDK v2 do MCP](frentes/02-sdk-v2.md)
3. [JSONL append-only com lock multi-processo](frentes/03-jsonl-lock.md)
4. [Hash chain e JSON canônico](frentes/04-hash-chain.md)
5. [JSON Schema → Zod](frentes/05-jsonschema-zod.md)
6. [Isolamento no Claude Code](frentes/06-isolamento-claude-code.md)
7. [Event sourcing em TypeScript](frentes/07-event-sourcing.md)
8. [Hook Bash e instalação idempotente](frentes/08-hook-instalacao.md)
9. [Stack de testes](frentes/09-testes.md)
10. [Utilitários pequenos](frentes/10-utilitarios.md)
11. [RFCs e especificações](frentes/11-rfcs-especificacoes.md)
12. [Alternativas enxutas ao lodash](frentes/12-alternativas-lodash.md) (pós-consenso, preferência do usuário)
13. [Logging estruturado enxuto](frentes/13-logging-estruturado.md) (pós-consenso; nativo mantido, LogTape como follow-up)
14. [Ecossistema do zod](frentes/14-ecossistema-zod.md) (pós-consenso; nenhuma lib adotada)
15. [Busca nos logs](frentes/15-busca-logs.md) (pós-consenso; MiniSearch 7.2.0 adotado)
16. [Effect: ganhos e custos](frentes/16-effect.md) (pós-consenso; não usar no MVP)
17. [Bundle e executável autocontido](frentes/17-bundle-executavel.md) (pós-consenso; esbuild 0.28.2 + cópia instalada)

## Decisão por componente

| Componente | Decisão | Pacote / abordagem | Motivo curto | Frente |
|---|---|---|---|---|
| Servidor MCP completo | Construir | — | Nenhum servidor existente cobre hash chain + schemas custom + multi-processo + isolamento | 1 |
| Framework MCP | Adotar | `@modelcontextprotocol/server@2.0.0` (exato) | GA 2026-07-27; `registerTool` com Zod; stdio via `@modelcontextprotocol/server/stdio` | 2 |
| Cliente MCP (testes) | Adotar (dev) | `@modelcontextprotocol/client@2.0.0` | `InMemoryTransport.createLinkedPair()` + `StdioClientTransport` | 2, 9 |
| Validação | Adotar | `zod@4.6.5` (exato) | Satisfaz `^4.2.0` do SDK, cópia única | 2, 5 |
| Lock multi-processo | Nativo | `fs.mkdirSync` + token + `mtime` (padrão POC) | Libs só dão mutex; proper-lockfile com race aberta; probe 4 processos íntegro | 3 |
| Store JSONL + dedupe + seq | Construir | reaproveitar desenho de `appendEvento` da POC | Nenhuma lib cobre ler+dedupe+prevHash+append numa seção crítica | 3, 7 |
| Hash | Nativo | `node:crypto` sha256 sobre `prevHash + canonical(payload)` | ~10 linhas; libs Merkle resolvem outro problema | 4 |
| Canonicalização JSON | Adotar | `canonicalize@5.0.0` (RFC 8785, exato) | 0 deps; falha em NaN/Infinity/BigInt; função da POC perde `Date` | 4, 11 |
| JSON Schema → Zod | Nativo do Zod | `z.fromJSONSchema` | 12/12 casos no probe; rejeita `$ref` externo nativamente | 5 |
| Validade do schema registrado | Adotar | `ajv@8.20.0` (`ajv/dist/2020`, strict) + `ajv-formats@3.0.1` | `fromJSONSchema` aceita keyword com typo, `required` malformado e raiz não-objeto | 5 |
| Projeção do Estado | Padrão sem lib | Decider: `evolve` puro + `reduce` | Libs de ES impõem agregado/comando e backend externo | 7 |
| Deny de leitura/escrita | Adotar (nativo CC) | `permissions.deny`: `Read(//<dados>/**)`, `Edit(//<dados>/**)` | Cobre Read/Grep/Glob/Edit/Write e `cat <arquivo>`; forma `//` obrigatória | 6 |
| Hook PreToolUse Bash | Construir | TS + `shell-quote@1.10.0` | Pega `$HOME`, `${XDG_DATA_HOME}`, `hex""log`; 0 deps | 6, 8 |
| Runtime do hook | Nativo | `.ts`/`.mts` direto no Node 24 (type stripping estável) | Sem build; +~35 ms por comando Bash; substituído pelo bundle esbuild instalado, U-7/U-8, ver ADR | 8, 9 |
| Instalação em settings.json | Adotar | `jsonc-parser@3.3.1` + tmp/rename nativo + backup + `--check` | Diff cirúrgico de 2 linhas vs 13 do stringify | 8 |
| Diretório de dados | Nativo | 3 linhas XDG (ignorar valor vazio ou relativo) | `env-paths` adiciona `-nodejs`; só Linux | 10 |
| UUID do id | Adotar | `uuid@14.0.2` (`v7`) | Node 24 não gera v7 nativo; RFC 9562 ordenável; substituído por `crypto.randomUUIDv7()` nativo, ver ADR | 10, 11 |
| Erro estruturado | Nativo do Zod | `error.issues` → `details[]` com `path` em JSON Pointer | treeify/flatten/prettify e `zod-validation-error` desnecessários | 10, 11 |
| Datas | Nativo | ISO-8601 UTC `Z`; comparação lexicográfica | `Temporal` indisponível no Node 24 | 10 |
| Runner de teste | Adotar | `jest@30.5.1` + `ts-jest@29.4.12` (CJS, sem `--experimental-vm-modules`) | Probe verde com SDK v2 + zod + fast-check | 9 |
| Property-based | Adotar | `fast-check@4.10.1` puro + `--show-seed` | `@fast-check/jest` é só açúcar | 9 |
| Teste multi-processo | Construir (portar POC) | `fork` + barreiras IPC; filho via `ts.transpileModule` ou `.mts` | `.ts` com `import` falha sob `type: commonjs` | 9 |
| Smoke E2E MCP | Adotar pontual | `npx @modelcontextprotocol/inspector@2.7.0 --cli` | "Stdio has no in-process shortcut" | 9 |
| Utilitários de coleção/objeto | Adotar (preferência do usuário) | `es-toolkit@1.52.0` (+ `es-toolkit/compat` para `get`) | Menor bundle tree-shaken no uso mínimo (0,36 KB); dual sem mapper no jest; 37M downloads/semana | 12 |
| Sandbox nativo CC | Adiado (follow-up) | `sandbox.filesystem.denyRead` | Exige sudo (bwrap+socat) e muda todas as sessões | 6 |

## Decisões do usuário nesta fase (2026-09-16)

| Tema | Decisão |
|---|---|
| Id do evento | Formato `{project}:{process}:{type}:{uuid}`. O agente sempre envia o prefixo `{project}:{process}:{type}` em `register`; o servidor gera o UUIDv7, grava e devolve o id completo. Retentativa com o id completo devolvido resulta em 1 linha (N2). Resposta perdida → retentativa com prefixo duplica (aceito). Continuam 10 tools. |
| `{entidade}` no id | É o tipo do evento: `milestone`, `verdict` ou nome de tipo custom fixado no processo. |
| Sandbox nativo | Não agora. Gaps aceitos: `cd` + caminho relativo, `grep -r` no diretório pai, `node -e`/`python`. |
| Registro de deny + hook | User settings (`~/.claude/settings.json`) via script idempotente + checagem de guard ausente (spec I5). |
| Canonicalização | Lib `canonicalize` (RFC 8785), versão exata. |

## Achados que mudam ou detalham a spec

1. **Sintaxe do deny:** `Read(/home/...)` com uma barra é relativo ao arquivo de settings e fica silenciosamente ineficaz. Usar `//<caminho absoluto resolvido>/**` (doc permissions).
2. **Alcance do deny de Read:** cobre Grep/Glob (best-effort) e comandos Bash que nomeiam o arquivo (`cat <arquivo>`); também bloqueia Edit/Write no mesmo caminho. Não cobre `grep -r` no pai nem subprocessos. Hook continua necessário para `$XDG_DATA_HOME`, `$HOME` e variações.
3. **Hook falha aberto:** exit code diferente de 0/2 é erro não-bloqueante. Negar com exit 0 + JSON `permissionDecision: "deny"` (ou exit 2 + motivo); erro inesperado do hook deixa passar.
4. **Plugin não carrega permissions:** `settings.json` de plugin só aceita `agent` e `subagentStatusLine`. Managed settings (`/etc/claude-code/managed-settings.d/`) sobreviveriam ao harness, mas exigem sudo — descartado pelo usuário.
5. **Schema registrado precisa gate Ajv:** sem ele, `register_type` aceita schema com keyword digitada errada que não valida nada.
6. **`outputSchema` × erro:** o SDK pula a validação de `outputSchema` quando `isError: true` → `{code, message, details[]}` em `structuredContent` é seguro.
7. **stdout do servidor:** o transporte stdio v2 ignora silenciosamente linhas não-JSON → log só em stderr, com teste.
8. **Limite de saída do Claude Code:** `MAX_MCP_OUTPUT_TOKENS` default 25000 → `events` precisa paginação.
9. **Datas:** `z.iso.datetime()` padrão aceita só `Z`; `format: date-time` via `fromJSONSchema` aceita offset. Normalizar timestamps gravados para UTC `Z` para manter a comparação lexicográfica de prazos.
10. **Bug da POC:** `poc/src/hash.ts:10-23` hasheia `Date` como `{}`. Não portar.
11. **Toolchain:** `jest --experimental-vm-modules` da POC é desnecessário. Hook/filhos `.ts` com `import` exigem `"type": "module"` ou `.mts` — decidir no passo 0 com probe.
12. **Spec MCP corrente:** 2026-07-28. Annotations `readOnlyHint`/`idempotentHint` nas tools de leitura.

## Ideias de RFC/spec anotadas como follow-up (fora do MVP)

- Checkpoint periódico da cadeia no formato C2SP `tlog-checkpoint`/`signed-note`.
- Campo `prova` no molde Statement do in-toto (`subject`, `predicateType`, `predicate`).
- Nomes de proveniência do Veredito alinhados a W3C PROV (`wasDerivedFrom`, `wasAssociatedWith`).
- Recursos MCP com `notifications/resources/updated` para `state`/`events`.
- Sandbox nativo do Claude Code (`sandbox.filesystem.denyRead`, `allowUnsandboxedCommands: false`).
- Sidecar de índice/tail quando o reread O(n) por append passar de ~10k linhas (medido: ~18 ms/append com 4 escritores e fsync).

## Frentes pós-consenso (12–17)

| Frente | Decisão | Link |
|---|---|---|
| 12. Alternativas enxutas ao lodash | U-1: `es-toolkit@1.52.0` (core; `compat` só para `get`/`isEmpty`) | [frentes/12-alternativas-lodash.md](frentes/12-alternativas-lodash.md) |
| 13. Logging estruturado enxuto | U-4: logger nativo; LogTape 2.3.5 fica como follow-up | [frentes/13-logging-estruturado.md](frentes/13-logging-estruturado.md) |
| 14. Ecossistema do zod | U-3: nenhuma lib do ecossistema do zod adotada | [frentes/14-ecossistema-zod.md](frentes/14-ecossistema-zod.md) |
| 15. Busca nos logs | U-6: MiniSearch 7.2.0 estendendo `events`, sem tool nova | [frentes/15-busca-logs.md](frentes/15-busca-logs.md) |
| 16. Effect: ganhos e custos | U-5: Effect fora do MVP; reavaliar se o hexlog virar daemon/HTTP | [frentes/16-effect.md](frentes/16-effect.md) |
| 17. Bundle e executável autocontido | U-7/U-8: `esbuild@0.28.2`, um arquivo por entrada; cópia instalada em `~/.local/lib/hexlog/<versão>/` | [frentes/17-bundle-executavel.md](frentes/17-bundle-executavel.md) |
