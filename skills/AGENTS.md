# skills

**Parent context:** `../AGENTS.md`
**Generated:** 2026-10-07 · **Updated:** 2026-10-07

## Purpose

As três skills do Claude Code que acompanham o hexlog. Cada pasta tem um `SKILL.md` com frontmatter (`name`, `description`) e, quando preciso, `references/` carregadas sob demanda. O instalador (`scripts/install.ts`) copia toda pasta daqui para `~/.claude/skills/<nome>/` (`installation.ts#writeSkillFolder`); uma skill nova só precisa de `skills/<nome>/SKILL.md`.

## Key Files

| File | Description |
|------|-------------|
| `hexlog-flow/references/audit-types.md` | Exemplo trabalhado do fluxo OMC (plano, revisões do architect e do Critic, desvios, anexos) como tipos, nomes de relação e gate, com a ordem das chamadas |
| `hexlog-flow/references/crossref-rules.md` | As três regras de cruzamento (conflito ou superado na mesma unidade, entre fases e unidades, lacuna que vira pergunta de gate), com um exemplo de cada |
| `hexlog-flow/references/target-format.md` | Sintaxe do `target` e como o projeto a restringe com `targetPattern` do modelo |
| `hexlog-flow/references/unit-lifecycle.md` | Ciclo de vida da unidade de trabalho: achar ou criar o processo, registrar cada fase e fechar a unidade |
| `hexlog-setup/references/interview-guide.md` | Roteiro de perguntas-modelo da entrevista, com os caminhos de descoberta e de entrevista direta |
| `hexlog-setup/references/model-schema.md` | Campos do `hexlog-model.json` gerado no destino |
| `hexlog-setup/references/project-skill.template.md` | Template da skill do projeto gerada no destino |
| `hexlog-setup/references/speckit-model.example.json` | Modelo de exemplo com as fases do Spec Kit |
| `hexlog-setup/references/minimal-model.example.json` | Modelo de exemplo para um projeto sem fluxo reconhecível |
| `hexlog-setup/references/agents-block.template.md` | Texto literal do bloco da camada C no `AGENTS.md` do destino, com o título fixo |
| `hexlog-setup/references/plug-speckit.md` | Camada C do plug no Spec Kit e a tabela de versões provadas |

## Subdirectories

| Directory | Purpose |
|-----------|---------|
| `hexlog/` | Bootstrap de um projeto no hexlog e diagnóstico de saúde do servidor (see `hexlog/AGENTS.md`) |
| `hexlog-flow/` | Mecânica do registro e da consulta, com projeto, processo e gate vindos da skill do projeto (see `hexlog-flow/AGENTS.md`) |
| `hexlog-setup/` | Configuração do hexlog em um repositório de destino, que pode rodar de novo: gera a skill do projeto e o modelo (see `hexlog-setup/AGENTS.md`) |

## Dependencies

### Internal
- `../scripts/install.ts` (`skillNames`) e `../src/installation.ts` (`writeSkillFolder`): instalam e conferem as skills
- `../test/skill-coherence.spec.ts`: confere o `.md` das skills contra `src/`

## Manual Notes

## Diretrizes

- [documentacao.md](../docs/directives/documentacao.md): como citar arquivo e símbolo nas skills, sem número de linha
- [instalacao-e-hooks.md](../docs/directives/instalacao-e-hooks.md): as skills são dinâmicas, instaladas por pasta
