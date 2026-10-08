# hexlog-setup

**Parent context:** `../AGENTS.md`
**Generated:** 2026-10-07 · **Updated:** 2026-10-07

## Purpose

Skill que roda uma vez por repositório alvo. Dispara quando o pedido é configurar o hexlog ali pela primeira vez ou mapear o fluxo pré-código do projeto ("configura o hexlog nesse repositório pela primeira vez"). Entrevista o usuário (uma pergunta por turno), lê as skills e tools que ele aponta, propõe o plano de chamadas (`define_type`, `define_relation`, `define_gate`, `create_process`), espera aprovação, registra e grava `.hexlog/flow.md`. Para e avisa se o arquivo já existe: reconfigurar está fora do escopo. Registro e avaliação de gate do dia a dia são da `hexlog-flow`.

## Key Files

| File | Description |
|------|-------------|
| `SKILL.md` | Parada se o flow map já existe, os seis passos do fluxo (entrevista, leitura, plano, registro, frontmatter, ponteiro no `AGENTS.md` do alvo), conferência de anexo, edição opcional das skills apontadas para chamarem a `hexlog-flow` e armadilhas do registro |

## Subdirectories

| Directory | Purpose |
|-----------|---------|
| `references/` | Carregado sob demanda, sem `AGENTS.md` próprio: `interview-guide.md` (perguntas-modelo da entrevista) e `flow-map-schema.md` (campos do frontmatter de `.hexlog/flow.md`) |

## Dependencies

### Internal
- `../hexlog/AGENTS.md`: ordem de bootstrap e replay das definições
- `../hexlog-flow/AGENTS.md`: consome o `.hexlog/flow.md` gravado; `hexlog-flow/references/target-format.md` define o `targetIdPattern` do schema

## Manual Notes
