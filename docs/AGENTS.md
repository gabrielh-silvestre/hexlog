<!-- Parent: ../AGENTS.md -->
<!-- Generated: 2026-09-17 | Updated: 2026-09-17 -->

# docs

## Purpose
Registro histórico das decisões do MVP do hexlog (ADR) e a pesquisa de libs/padrões que fundamentou essas decisões.

## Key Files
| File | Description |
|---|---|
| `adr-0001-hexlog-mvp.md` | ADR 0001, status Aceito: decide construir o hexlog como servidor MCP stdio único em TypeScript (Node ≥ 24.18.1), com núcleo puro, store JSONL com lock `mkdir`+token+`mtime`, cadeia sha256+JCS via `canonicalize`, 10 tools com Zod, busca via MiniSearch, e instalação como bundle esbuild em `~/.local/lib/hexlog/<versão>/` fora da working tree. Registra alternativas descartadas, consequências, testes portados da POC (`5703a53`) e decisões de execução (DE-01 a DE-19). |
| `qualidade-ci.md` | Estudo (nada instalado) de plataformas de qualidade para CI/CD quando o repo for público: camadas agora/depois/nunca, esforço, custo e fonte de cada ferramenta, consultadas em 2026-09-17. |
| `ferramentas-similares.md` | Estudo (nada adotado) de decisionlog.ai, mcp-server-decisions e ConPort comparados ao hexlog, com fontes primárias consultadas em 2026-09-17 e 5 ideias ranqueadas. |

## Subdirectories
| Directory | Description |
|---|---|
| `pesquisa/` | Pesquisa de libs e padrões (17 frentes) que embasou o ADR 0001 (see `pesquisa/AGENTS.md`) |

## For AI Agents
### Working In This Directory
- `adr-0001-hexlog-mvp.md` é registro histórico de uma decisão já Aceita: não reescreva o corpo para refletir mudanças futuras. Uma mudança de rumo emenda com uma seção nova (ex.: "Amendment" ou um ADR seguinte, `adr-0002-...md`), nunca reescrevendo Decision/Consequences já registrados.
- Antes de propor trocar uma lib ou abordagem já decidida, confira a frente de pesquisa correspondente em `pesquisa/frentes/` e a linha do ADR que a descartou ou adotou — a maioria das alternativas já foi avaliada e tem motivo registrado.

### Common Patterns
- IDs de decisão (`Q1`, `R-1`, `QN2`, `U-1`, `DE-01`, ...) citados no ADR remetem a decisões do usuário ou de execução tomadas durante o planejamento/Ralph; são referenciados por esses códigos em todo o repositório.

## Dependencies
### Internal
O ADR 0001 é a fonte de verdade para a arquitetura implementada em `src/` (núcleo, store, cadeia, tools, instalação) e para o formato do log (envelope de evento, manifesto `process.json`, cadeia de hash).

<!-- MANUAL: Any manually added notes below this line are preserved on regeneration -->
