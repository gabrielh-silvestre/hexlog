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
| 1 | `register_vocabulary` | Cria o diretório do projeto. Sem nenhuma chamada, `create_process` lança `VOCABULARY_MISSING` (`definitions.ts:577`, único lançador em todo o `src/`) |
| 2 | `register_type` / `register_gate` | Opcionais — mas, se usados, precisam vir **antes** do passo 3 |
| 3 | `create_process` | Congela um snapshot de types/vocabulary/gates lidos naquele instante, mais a versão vigente de cada um em `versions` (`definitions.ts:450-498`). Nada registrado depois vale para esse processo — não existe "atualizar". **Idempotente**: chamar de novo com o mesmo `process` devolve o processo existente com `existed: true` em vez de erro — hashes iguais ao fixado, sem aviso; hashes diferentes (algo foi registrado no projeto depois da fixação), aviso `STALE_DEFINITIONS` com o que mudou |
| 4 | `register` / `evaluate_gate` | Dependem de `loadProcess`, que só existe a partir do passo 3 |

Chame `register_vocabulary` pelo menos uma vez, com qualquer `owner` — o que
destrava o passo 3 é existir um arquivo em `vocabulary/`, não o conteúdo dele.

## Armadilhas

| Situação | Resultado | Onde |
|---|---|---|
| `create_process` com `process` em `RESERVED_PROCESS_NAMES` (`schemas`, `vocabulary`, `gates`) | `RESERVED_NAME` | `definitions.ts:21` |
| `register_type` com `name` em `RESERVED_TYPE_NAMES` (`milestone`, `verdict`) | `RESERVED_NAME` | `definitions.ts:24` |
| `register_gate` com `name` em um dos 5 `BUILTIN_GATE_NAMES` (`no-orphans`, `no-conflicts`, `chain-intact`, `no-invalid-references`, `no-forks`) | `RESERVED_NAME` | `definitions.ts:27-33` |
| `register_type`/`register_vocabulary`/`register_gate` com mudança que quebra e sem `breaking: true` | `BREAKING_CHANGE` | `definitions.ts` (`decideVersion`) |
| Tipo custom usado em `register` fora do snapshot fixado do processo | `TYPE_NOT_PINNED` — não `TYPE_NOT_FIXED`, esse código não existe | `event-tools.ts:421` |
| `milestoneType` ou `decisions[].action` fora do vocabulário fixado (campos fechados) | `VOCABULARY_VIOLATED`, com `owners`/`allowed` em `details[0]` (donos fixados e termos aceitos do campo) | `event-tools.ts:545` |
| `result` de um Veredito fora do vocabulário fixado (campo aberto) | aviso `UNKNOWN_VOCABULARY`, não bloqueia — evento é gravado normalmente | `event-tools.ts:567` |
| `milestoneType: "gate"` ou chave `gate` num `register` fora de `evaluate_gate` | `RESERVED_FIELD` | `event-tools.ts:423-428` |

Notas adicionais:

- Vocabulário de owners diferentes **coexiste** — cada owner grava sua própria
  linha de versões em `vocabulary/<owner>/`. Reregistrar o mesmo owner cria uma
  versão nova (`major.minor`), nunca sobrescreve a anterior nem afeta o
  arquivo de outro owner.
- `register_type`/`register_vocabulary`/`register_gate` versionam, não
  substituem: conteúdo igual ao vigente é no-op (`unchanged: true`); mudança
  que quebra (ver README, tabela de quebra por definição) exige
  `breaking: true` no input, senão lança `BREAKING_CHANGE`.
- Os 5 gates embutidos passam trivialmente (`passed: true`) num processo com
  zero eventos — ausência de contra-evidência, não prova de saúde do processo.
  `no-forks` reprova quando um Verdict superado tem 2+ sucessores vivos
  (2+ Verdicts que o citam em `supersedes` e não estão eles mesmos superados)
  — um fan-out legítimo de um Verdict ainda vigente não conta.
  Para resolver um fork, registre um Verdict que supere ramos em `supersedes`
  até restar 1 sucessor vivo (superar só um dos dois ramos já basta).
- Se `VOCABULARY_VIOLATED` (ou qualquer dúvida sobre o que o processo
  congelou) surpreender, chame `list({project, process})`: devolve o
  vocabulário e os gates fixados por inteiro, não só o hash.
- `state` aceita `withData: true` para trazer o `data` do Verdict vigente
  junto de cada item de `active`, e sempre devolve `targets` (todo target de
  Verdict já usado, mesmo os totalmente superados) — sem precisar de um
  `events` à parte para achar o vigente de um target.
- Milestone aceita `trace` (opcional) como os demais eventos, mas ele é
  ignorado na comparação de retentativa idempotente: reenviar o mesmo id
  completo com `trace` diferente ainda deduplica.

## Exemplo mínimo: do zero a um `register` e um `evaluate_gate` verdes

```
1. register_vocabulary({
     project: "myproj", owner: "core",
     milestoneType: ["setup"], result: ["ok"], action: ["approve"]
   })
   → { project: "myproj", owner: "core", hash: "<sha256>", version: "1.0",
       previousVersion: null, unchanged: false, warnings: [] }

2. create_process({ project: "myproj", process: "onboarding" })
   → { project: "myproj", process: "onboarding", createdAt: "<iso>",
       hashes: {...}, types: [], owners: ["core"], gates: [],
       versions: { types: {}, vocabulary: { core: "1.0" }, gates: {} },
       existed: false, warnings: [] }

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
Ele responde os 5 gates embutidos (`builtinGates`) sem precisar de nenhum
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
| Rodar `node scripts/install.ts` sem `--check` | Proibido por `AGENTS.md:37` sem pedido explícito — escreve em `~/.claude/settings.json`, `~/.claude.json` e `~/.local/lib/hexlog/` |

Reinstalar a mesma versão com conteúdo diferente **não bloqueia** — só avisa
"consider bumping the version".
