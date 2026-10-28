# hexlog-setup

**Parent context:** `../AGENTS.md`
**Generated:** 2026-10-07 · **Updated:** 2026-10-28

## Purpose

Skill que configura o hexlog num repositório de destino. Dispara quando o pedido é configurar o hexlog num projeto ("configura o hexlog nesse repositório"). Aprende o fluxo do projeto por descoberta no repositório ou por entrevista (uma pergunta por turno; o dev escolhe), confere o projeto hexlog por `list` antes de qualquer `define_*`, registra só tipos, relações e gate, e gera no destino uma skill do projeto e um modelo declarativo. Pode rodar de novo: com o modelo local, compara em vez de reperguntar. Registro e avaliação de gate do dia a dia, e o ciclo de vida da unidade, são da `hexlog-flow`.

## Key Files

| File | Description |
|------|-------------|
| `SKILL.md` | Os dez passos do fluxo (caminho, setup anterior, descoberta, projeto hexlog, entrevista, plano, registro, geração, ponteiro e alcance do bloco) e a conferência de anexo |
| `references/interview-guide.md` | Perguntas-modelo da entrevista e dos dois caminhos, em inglês |
| `references/model-schema.md` | Campos do `hexlog-model.json` |
| `references/project-skill.template.md` | Template da skill do projeto gerada no destino |
| `references/three-phase-model.example.json` | Modelo de exemplo de um fluxo de três fases encadeadas |
| `references/minimal-model.example.json` | Modelo de exemplo sem fluxo reconhecível |
| `references/agents-block.template.md` | Texto literal do bloco do hexlog no `AGENTS.md` do destino |

## Subdirectories

| Directory | Purpose |
|-----------|---------|
| `references/` | Carregado sob demanda, sem `AGENTS.md` próprio |

## Dependencies

### Internal
- `../hexlog/AGENTS.md`: ordem de bootstrap e replay das definições; armadilhas do registro (fonte única)
- `../hexlog-flow/AGENTS.md`: consome o modelo gerado; traz o ciclo de vida da unidade em `references/unit-lifecycle.md`

## Manual Notes
