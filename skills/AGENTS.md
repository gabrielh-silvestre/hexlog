# skills

**Parent context:** `../AGENTS.md`
**Generated:** 2026-10-07 · **Updated:** 2026-10-07

## Purpose

As três skills do Claude Code que acompanham o hexlog. Cada pasta tem um `SKILL.md` com frontmatter (`name`, `description`) e, quando preciso, `references/` carregadas sob demanda. O instalador (`scripts/install.ts`) copia toda pasta daqui para `~/.claude/skills/<nome>/` (`installation.ts#writeSkillFolder`); uma skill nova só precisa de `skills/<nome>/SKILL.md`.

## Key Files

| File | Description |
|------|-------------|
| `hexlog-flow/references/audit-types.md` | Exemplo trabalhado do fluxo OMC (plano, revisões do architect e do Critic, desvios, anexos) como tipos, nomes de relação e gate, com a ordem das chamadas |
| `hexlog-flow/references/crossref-rules.md` | As três regras de cruzamento (conflito ou superado na mesma fase, entre fases, lacuna que vira pergunta de gate), com um exemplo de cada |
| `hexlog-flow/references/target-format.md` | Sintaxe do `target` e como o projeto a restringe com `targetIdPattern` |
| `hexlog-setup/references/flow-map-schema.md` | Schema do frontmatter YAML do `.hexlog/flow.md` (`FlowMap`), campo a campo |
| `hexlog-setup/references/interview-guide.md` | Roteiro de perguntas-modelo da entrevista de configuração, uma por turno |

## Subdirectories

| Directory | Purpose |
|-----------|---------|
| `hexlog/` | Bootstrap de um projeto no hexlog e diagnóstico de saúde do servidor (see `hexlog/AGENTS.md`) |
| `hexlog-flow/` | Registro e consulta do dia a dia contra o `.hexlog/flow.md` (see `hexlog-flow/AGENTS.md`) |
| `hexlog-setup/` | Mapeamento único do fluxo de um repositório alvo em `.hexlog/flow.md` (see `hexlog-setup/AGENTS.md`) |

## Dependencies

### Internal
- `../scripts/install.ts` e `../src/installation.ts` (`skillNames`, `writeSkillFolder`): instalam e conferem as skills
- `../test/skill-coherence.spec.ts`: confere o `.md` das skills contra `src/`

## Manual Notes

## Diretrizes

- [documentacao.md](../docs/directives/documentacao.md): como citar arquivo e símbolo nas skills, sem número de linha
- [instalacao-e-hooks.md](../docs/directives/instalacao-e-hooks.md): as skills são dinâmicas, instaladas por pasta
