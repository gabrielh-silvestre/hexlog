---
name: hexlog-setup
description: "Use to bootstrap hexlog's pre-code flow map for a target repository for the first time: interview the user, read the skills/tools they point to, extract decision points, propose a hexlog call plan (register_vocabulary/register_type/register_gate/create_process), wait for approval, register, and write `.hexlog/flow.md`. Examples: \"configura o hexlog nesse repositório pela primeira vez\", \"quero mapear o fluxo de processo deste projeto no hexlog\". Not for a repo that already has `.hexlog/flow.md` — stop and say it already exists, reconfiguration is out of scope. Not for registering a day-to-day milestone or evaluating a gate — that's hexlog-flow."
---

# hexlog-setup

Configura o hexlog pela primeira vez num repositório alvo: entrevista o usuário sobre
as fases do fluxo pré-código, lê as skills/tools que ele aponta, extrai pontos de
decisão, propõe um plano de chamadas ao hexlog, espera aprovação, registra e escreve
`.hexlog/flow.md`. Roda uma vez por repositório.

## Parar se já existe

Antes de qualquer pergunta, procure `.hexlog/flow.md` a partir da raiz do repositório
alvo. Se existir, pare e diga ao usuário que o repositório já está configurado —
manutenção/reconfiguração do flow map é v2, fora do escopo desta skill.

## Fluxo (uma decisão por turno)

Siga a entrevista uma pergunta por vez — nunca despeje todas as perguntas de uma vez
nem agrupe decisões no mesmo turno (ver `references/interview-guide.md` para o roteiro).

| # | Passo | O quê |
|---|---|---|
| 1 | Entrevista | Uma pergunta por turno: quais fases o processo pré-código tem, e quais skills/tools o usuário usa em cada fase |
| 2 | Leitura | Lê o SKILL.md de cada skill apontada; extrai os pontos de decisão (onde o agente decide algo que vale registrar como marco ou veredito) |
| 3 | Plano de chamadas | Monta a lista de `register_vocabulary`/`register_type`/`register_gate`/`create_process` necessária a partir do que foi extraído; mostra ao usuário; espera "aprovado" antes de chamar qualquer tool |
| 4 | Registro | Chama na ordem do plano. Convenção: `owner` do vocabulário é o nome do projeto (repositório alvo); `agent` é o nome da skill que disparou a chamada — nesta fase, hexlog-setup |
| 5 | Frontmatter | Grava `.hexlog/flow.md` com o schema `FlowMap` (`flow-map.ts:28`, ver `references/flow-map-schema.md`): 1 processo por fase, gate custom por fase quando aplicável, versões devolvidas no passo 4 |
| 6 | Ponteiro | Verifica o `AGENTS.md` da raiz do repositório alvo: cria se não existir. Verifica se o `CLAUDE.md` do repositório alvo importa o `AGENTS.md` (`@AGENTS.md` ou equivalente); se não importa, propõe adicionar essa linha e espera aprovação antes de escrever |

## Opcionais independentes

Depois do passo 6, ofereça os dois — não dependem um do outro, o usuário pode
aceitar os dois, um só, ou nenhum.

### A. Editar as skills apontadas para chamarem a hexlog-flow

Para cada skill apontada na descoberta (passo 2), no ponto de decisão já extraído
ali (nunca escolhido ad-hoc agora): gera um diff que insere a chamada à
hexlog-flow naquele ponto. Mostra **uma skill por vez**, nunca em lote — espera
aprovação explícita antes de gravar cada arquivo. Toda skill efetivamente editada
entra no array `editedSkills` (`flow-map.ts:45`) do frontmatter.

### B. Hook flow-reminder

Script instalado pelo instalador do hexlog em `$HOME/.local/lib/hexlog/flow-reminder.mjs`, que
só lembra (nunca bloqueia) quando uma skill mapeada é invocada num repositório com a flag
ativada no frontmatter (`flow-map.ts:43`). Se o usuário aprovar, adicione em
`.claude/settings.json` do **repositório alvo** (não no harness global):

```json
{
  "hooks": {
    "PostToolUse": [
      {
        "matcher": "^Skill$",
        "hooks": [
          { "type": "command", "command": "node \"$HOME/.local/lib/hexlog/flow-reminder.mjs\"", "timeout": 10 }
        ]
      }
    ]
  }
}
```

Esse caminho é estável entre upgrades do hexlog (fora do diretório de versão) e
não carrega caminho pessoal do usuário pro repositório alvo.

## Armadilhas do registro (passo 3-4)

| Situação | Resultado |
|---|---|
| Nenhuma chamada a `register_vocabulary` antes de `create_process` | `VOCABULARY_MISSING` (`definitions.ts:575`) |
| Nome de processo em `RESERVED_PROCESS_NAMES` (`definitions.ts:21`) | `RESERVED_NAME` |
| Nome de tipo em `RESERVED_TYPE_NAMES` (`definitions.ts:24`) | `RESERVED_NAME` |
| Nome de gate em `BUILTIN_GATE_NAMES` (`definitions.ts:27-33`) | `RESERVED_NAME` |
| Mudança que quebra em `register_type`/`register_vocabulary`/`register_gate` sem `breaking: true` | `BREAKING_CHANGE` (`definitions.ts:667`) |

## Referências

- `references/flow-map-schema.md` — forma completa do `FlowMap`, campo a campo.
  Carregue só na hora de escrever o frontmatter (passo 5), não antes.
- `references/interview-guide.md` — perguntas-modelo da entrevista, uma por turno.
  Carregue no início do passo 1.
