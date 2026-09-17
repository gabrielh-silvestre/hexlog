---
name: hexlog
description: "Use when the agent needs to bootstrap a new project in hexlog (register vocabulary/types/gates, create a process, register events, evaluate gates) or diagnose whether an already-installed hexlog server is healthy. Examples: \"configura o hexlog nesse projeto\", \"o hexlog está funcionando?\", \"registra esse marco no hexlog\", \"avalia esse gate\""
---

# hexlog

Servidor MCP para agentes registrarem seu próprio histórico de trabalho: marcos,
veredictos e gates, com log append-only. Esta skill cobre bootstrap de projeto e
diagnóstico de saúde — não a instalação; isso é do `README.md` do repo hexlog.

## Ordem obrigatória de bootstrap

| # | Tool | Motivo |
|---|---|---|
| 1 | `register_vocabulary` | Cria o diretório do projeto. Sem nenhuma chamada, `create_process` lança `VOCABULARY_MISSING` (`definitions.ts:237`, único lançador em todo o `src/`) |
| 2 | `register_type` / `register_gate` | Opcionais — mas, se usados, precisam vir **antes** do passo 3 |
| 3 | `create_process` | **Ponto sem volta**: congela um snapshot de types/vocabulary/gates lidos naquele instante (`definitions.ts:186-255`). Nada registrado depois vale para esse processo — não existe "atualizar"; recriar dá `PROCESS_ALREADY_EXISTS` |
| 4 | `register` / `evaluate_gate` | Dependem de `loadProcess`, que só existe a partir do passo 3 |

Chame `register_vocabulary` pelo menos uma vez, com qualquer `owner` — o que
destrava o passo 3 é existir um arquivo em `vocabulary/`, não o conteúdo dele.

## Armadilhas

| Situação | Resultado | Onde |
|---|---|---|
| `create_process` com `process` em `RESERVED_PROCESS_NAMES` (`schemas`, `vocabulary`, `gates`) | `RESERVED_NAME` | `definitions.ts:20` |
| `register_type` com `name` em `RESERVED_TYPE_NAMES` (`milestone`, `verdict`) | `RESERVED_NAME` | `definitions.ts:23` |
| `register_gate` com `name` em um dos 4 `BUILTIN_GATE_NAMES` (`no-orphans`, `no-conflicts`, `chain-intact`, `no-invalid-references`) | `RESERVED_NAME` | `definitions.ts:26-31` |
| Tipo custom usado em `register` fora do snapshot fixado do processo | `TYPE_NOT_PINNED` — não `TYPE_NOT_FIXED`, esse código não existe | `event-tools.ts:395` |
| `milestoneType` ou `decisions[].action` fora do vocabulário fixado (campos fechados) | `VOCABULARY_VIOLATED` | `event-tools.ts:508` |
| `result` de um Veredito fora do vocabulário fixado (campo aberto) | aviso `UNKNOWN_VOCABULARY`, não bloqueia — evento é gravado normalmente | `event-tools.ts:529` |
| `milestoneType: "gate"` ou chave `gate` num `register` fora de `evaluate_gate` | `RESERVED_FIELD` | `event-tools.ts:397-402` |

Notas adicionais:

- Vocabulário de owners diferentes **coexiste** — cada owner grava seu próprio
  `vocabulary/<owner>.json`. Reregistrar substitui só o arquivo do **mesmo**
  owner, nunca o de outro.
- Os 4 gates embutidos passam trivialmente (`passed: true`) num processo com
  zero eventos — ausência de contra-evidência, não prova de saúde do processo.

## Exemplo mínimo: do zero a um `register` e um `evaluate_gate` verdes

```
1. register_vocabulary({
     project: "myproj", owner: "core",
     milestoneType: ["setup"], result: ["ok"], action: ["approve"]
   })
   → { project: "myproj", owner: "core", hash: "<sha256>", replaced: false }

2. create_process({ project: "myproj", process: "onboarding" })
   → { project: "myproj", process: "onboarding", createdAt: "<iso>",
       hashes: {...}, types: [], owners: ["core"], gates: [] }

3. register({
     project: "myproj", process: "onboarding",
     id: "myproj:onboarding:milestone",
     agent: "setup-agent",
     data: { milestoneType: "setup", target: "hex:target:onboarding-1" }
   })
   → { event: { id: "myproj:onboarding:milestone:<uuid v7>", ... },
       deduplicated: false, warnings: [] }

4. evaluate_gate({
     project: "myproj", process: "onboarding",
     gate: "no-orphans", agent: "setup-agent",
     target: "hex:target:onboarding-1"
   })
   → { event: {...}, passed: true, evidence: [], totalEvidenceItems: 0 }
```

`id` no passo 3 é um **prefixo** `{project}:{process}:{type}`: o servidor gera
o uuid v7 e devolve o id completo no evento. Reenviar esse id completo com o
mesmo `type`/`agent`/`data` normalizados é retentativa idempotente
(`deduplicated: true`); conteúdo diferente é `CONFLICTING_ID`.

`no-orphans` no passo 4 é embutido e por isso não aceita `result` — o servidor
calcula a partir do Estado do processo. Só um gate **custom** (registrado via
`register_gate`) exige `result: {passed, evidence}` do agente.

## Diagnóstico de saúde

**A prova real de que o servidor está vivo é chamar `list` sem parâmetros.**
Ele responde os 4 gates embutidos (`builtinGates`) sem precisar de nenhum
projeto existente.

**`--check` não prova o servidor.** `node scripts/install.ts --check` valida
o hook por execução real e compara o sha256 do manifest — mas nunca conecta
ao MCP nem reconfere a contagem de tools. Essa garantia é herdada de
`verifyPreparedArtifact` (`installation.ts:74`), chamada dentro de `install()`
no momento da instalação (`installation.ts:239`), e não é reverificada depois.
Confundir os dois é o erro mais fácil de cometer: um `--check` verde não diz
nada sobre o servidor MCP responder.

### O que exige a mão do humano

| Ação | Motivo técnico |
|---|---|
| Descartar `~/.local/share/hexlog` | O hook PreToolUse nega qualquer Bash que alcance o diretório de dados — isolamento por desenho, não um obstáculo a contornar |
| Reiniciar a sessão do Claude Code | Cache de `tools/list` do protocolo MCP — fora do alcance de qualquer agente |
| Rodar `node scripts/install.ts` sem `--check` | Proibido por `AGENTS.md:33` sem pedido explícito — escreve em `~/.claude/settings.json`, `~/.claude.json` e `~/.local/lib/hexlog/` |

Reinstalar a mesma versão com conteúdo diferente **não bloqueia** — só avisa
"consider bumping the version".
