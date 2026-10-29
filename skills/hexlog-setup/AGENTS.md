# hexlog-setup

**Parent context:** `../AGENTS.md`
**Generated:** 2026-10-07 · **Updated:** 2026-10-28

## Purpose

Skill que configura o hexlog num repositório de destino. Dispara quando o pedido é configurar o hexlog num projeto ("configura o hexlog nesse repositório"). Aprende o fluxo do projeto por descoberta no repositório ou por entrevista (uma pergunta por turno; o dev escolhe), confere o projeto hexlog por `list` antes de qualquer `define_*`, registra só tipos, relações e gate, e gera no destino uma skill do projeto e um modelo declarativo; com opt-in do dev, liga também a cadeira do dono (pacote de definições, documento de critérios, contrato e receita do ocupante). Pode rodar de novo: com o modelo local, compara em vez de reperguntar. Registro e avaliação de gate do dia a dia, e o ciclo de vida da unidade, são da `hexlog-flow`.

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
| `references/owner-seat.md` | Procedimento do ramo opcional da cadeira do dono (pt-BR): quando entra, perguntas, regra de colisão de nomes e de reaplicação, pré-condição de assento, `ownerSeat` no modelo e placeholders de geração e de execução; o `SKILL.md` o aponta nos passos 2, 5, 6, 7 e 8 |
| `references/owner-seat/` | Pacote de definições da cadeira, um JSON por definição no layout de `.hexlog/`: `types/` (`gap`, `premise`, `evidence`, `audit`), `relations/` (`fills-gap`, `audits`) e `gates/` (`gaps`); ensaiado em memória por `test/owner-seat-package.spec.ts` |
| `references/owner-seat-criteria.template.md` | Template do documento de critérios do dev (regras com chave estável), escrito uma vez e nunca sobrescrito |
| `references/owner-seat-contract.template.md` | Template do contrato neutro do ocupante, com os nomes aplicados e as regras de gravação |
| `references/owner-seat-recipe-claude.template.md` | Template da receita do ocupante Claude (`claude -p`, seis tools do hexlog liberadas) |
| `references/owner-seat-recipe-agy.template.md` | Template da receita do ocupante `agy` (CLI direto, sem deny nem allowlist) |

## Subdirectories

| Directory | Purpose |
|-----------|---------|
| `references/` | Carregado sob demanda, sem `AGENTS.md` próprio |
| `references/owner-seat/` | Pacote de definições da cadeira do dono (`types/`, `relations/`, `gates/`), só JSON |

## Dependencies

### Internal
- `../hexlog/AGENTS.md`: ordem de bootstrap e replay das definições; armadilhas do registro (fonte única)
- `../hexlog-flow/AGENTS.md`: consome o modelo gerado; traz o ciclo de vida da unidade em `references/unit-lifecycle.md`
- `../../scripts/seat-report.ts`: o relatório de auditoria que a skill do projeto chama por `$HEXLOG_CHECKOUT` quando a cadeira está ligada (não é instalado com a skill)

## Manual Notes
