# hexlog

**Parent context:** `../AGENTS.md`
**Generated:** 2026-10-07 · **Updated:** 2026-10-07

## Purpose

Skill de entrada do hexlog. Dispara quando o agente precisa montar um projeto novo no hexlog (definir tipos, nomes de relação e gates, criar um processo, registrar, avaliar um gate) ou checar se um servidor já instalado está saudável. Exemplos de pedido: "configura o hexlog nesse projeto", "o hexlog está funcionando?". Não cobre o registro do dia a dia contra um fluxo mapeado (`hexlog-flow`) nem o mapeamento inicial de um repositório alvo (`hexlog-setup`).

## Key Files

| File | Description |
|------|-------------|
| `SKILL.md` | Modelo mental em uma tela, ordem obrigatória de bootstrap (`define_*`, `create_process`, `register`, `evaluate_gate`), regra de versão de definição e `breaking`, armadilhas, exemplo mínimo do zero a um `register` e um `evaluate_gate` e o diagnóstico de saúde (só Linux). O sinal de que o servidor está vivo é `list` sem parâmetros; `node scripts/install.ts --check` não prova isso. Lista o que só o humano faz (arquivar dado 0.x, destravar `LOCK_TIMEOUT`, reiniciar a sessão) |

## Dependencies

### Internal
- `../hexlog-flow/AGENTS.md` e `../hexlog-setup/AGENTS.md`: skills que assumem o que esta explica
- `../../src/installation.ts` (`verifyPreparedArtifact`, `installArtifact`): citados no diagnóstico

## Manual Notes
