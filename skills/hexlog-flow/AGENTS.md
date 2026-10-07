# hexlog-flow

**Parent context:** `../AGENTS.md`
**Generated:** 2026-10-07 · **Updated:** 2026-10-07

## Purpose

Skill de uso diário, para um repositório que já tem `.hexlog/flow.md`. Dispara quando o pedido é registrar um marco, cruzar um registro com o que já existe, avaliar o gate de uma fase, guardar um texto longo como anexo ou mostrar a trilha de um target ("registra esse marco no hexlog", "avalia o gate dessa fase", "mostra a trilha completa desse target"). Lê a fase atual no flow map e escolhe a tool (`register`, `query`, `evaluate_gate`, `verify_chain`, `attach`, `read_attachment`, `list`). Não configura o hexlog em repositório novo (`hexlog-setup`).

## Key Files

| File | Description |
|------|-------------|
| `SKILL.md` | Leitura do flow map, árvore de decisão de tool, busca e id, `key` contra duplicata, regras de relação que o servidor impõe, alcance de leitura (`scope`), marcador e cursor, reenvio após erro incerto, anexos (inclusive `unmarked-attachment`) e mudança de gate |

## Subdirectories

| Directory | Purpose |
|-----------|---------|
| `references/` | Material carregado sob demanda, sem `AGENTS.md` próprio: `audit-types.md` (exemplo do fluxo OMC como tipos, relações e gate), `crossref-rules.md` (as três regras de cruzamento) e `target-format.md` (sintaxe do `target` e `targetIdPattern`) |

## Dependencies

### Internal
- `../hexlog/AGENTS.md`: bootstrap e diagnóstico que esta skill pressupõe
- `../hexlog-setup/AGENTS.md`: gera o `.hexlog/flow.md` que esta skill lê

## Manual Notes
