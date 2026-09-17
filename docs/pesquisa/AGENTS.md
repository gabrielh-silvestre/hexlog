<!-- Parent: ../AGENTS.md -->
<!-- Generated: 2026-09-17 | Updated: 2026-09-17 -->

# pesquisa

## Purpose
Índice da pesquisa de libs e padrões do hexlog: 17 frentes (11 da fase inicial + 6 pós-consenso) que compararam bibliotecas e abordagens candidatas antes da decisão registrada no ADR 0001.

## Key Files
| File | Description |
|---|---|
| `hexlog-pesquisa-libs.md` | Índice das 17 frentes, tabela "Decisão por componente" (pacote escolhido, motivo curto, frente de origem) por peça do sistema (MCP, lock, hash, Zod, isolamento, event sourcing, hook, testes, utilitários, RFCs, lodash, logging, zod, busca, Effect, bundle), decisões do usuário na fase (2026-09-16) e achados que mudaram a spec original. |

## Subdirectories
| Directory | Description |
|---|---|
| `frentes/` | Relatório individual de cada uma das 17 frentes de pesquisa (see `frentes/AGENTS.md`) |

## For AI Agents
### Working In This Directory
- Esta pesquisa é a base das decisões do ADR 0001: antes de propor trocar uma lib ou padrão já escolhido, confira a linha correspondente na tabela "Decisão por componente" de `hexlog-pesquisa-libs.md` e o relatório da frente em `frentes/` — a comparação e o motivo já existem.
- Algumas recomendações de frente individual foram depois revertidas por decisão do usuário na síntese pós-consenso (ex.: frente 14 recomendou adotar `zod-schema-faker`, mas U-3 no ADR 0001 rejeitou); ao citar uma frente, confira também a tabela de decisão final antes de assumir que a recomendação da frente é a decisão vigente.

### Common Patterns
- Cada linha da tabela "Decisão por componente" cita a frente (1–17) que a sustenta; os "Achados que mudam ou detalham a spec" e as "Decisões do usuário nesta fase" ficam soltos no índice, sem link 1:1 para uma frente.

## Dependencies
### Internal
Fundamenta o ADR 0001 (`../adr-0001-hexlog-mvp.md`) e, por extensão, as escolhas de dependências e padrões implementados em `src/` (SDK MCP, Zod, canonicalize, MiniSearch, es-toolkit, esbuild).

<!-- MANUAL: Any manually added notes below this line are preserved on regeneration -->
