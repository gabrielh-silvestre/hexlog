# hexlog-flow

**Parent context:** `../AGENTS.md`
**Generated:** 2026-10-07 · **Updated:** 2026-10-28

## Purpose

Skill de uso diário: a mecânica das tools. Recebe projeto, processo e gate da skill do projeto que a invocou (gerada pela `hexlog-setup`) e traz o ciclo de vida da unidade de trabalho em `references/unit-lifecycle.md`. Dispara quando o pedido é registrar um marco, cruzar um registro com o que já existe, avaliar o gate de uma fase, guardar um texto longo como anexo ou mostrar a trilha de um target ("registra esse marco no hexlog", "avalia o gate dessa fase", "mostra a trilha completa desse target"). Escolhe a tool conforme a fase atual (`register`, `query`, `evaluate_gate`, `verify_chain`, `attach`, `read_attachment`, `list`, `describe_type`). Não configura o hexlog em repositório novo (`hexlog-setup`).

## Key Files

| File | Description |
|------|-------------|
| `SKILL.md` | De onde vêm projeto, processo e gate, árvore de decisão de tool, busca e id, leitura enxuta (`fields`, `relations`, `changesSince` com `limit: 0`, gate em lote), `key` contra duplicata, regras de relação que o servidor impõe, alcance de leitura (`scope`), marcador e cursor, erros e reenvio após erro incerto, anexos (com o ponteiro do `unmarked-attachment`) e mudança de gate |

## Subdirectories

| Directory | Purpose |
|-----------|---------|
| `references/` | Material carregado sob demanda, sem `AGENTS.md` próprio: `attachments.md` (regras de `path` e recusas do `attach`, saídas do `unmarked-attachment`), `audit-types.md` (exemplo do fluxo OMC como tipos, relações e gate), `crossref-rules.md` (as três regras de cruzamento e a herança de relações pela linhagem; processo novo, corte por `contradicts`, `inherit` no gate), `target-format.md` (sintaxe do `target` e `targetPattern` do modelo) e `unit-lifecycle.md` (achar ou criar o processo da unidade, registrar cada fase e fechar a unidade) |

## Dependencies

### Internal
- `../hexlog/AGENTS.md`: bootstrap e diagnóstico que esta skill pressupõe
- `../hexlog-setup/AGENTS.md`: gera a skill do projeto que passa projeto, processo e gate a esta skill

## Manual Notes
