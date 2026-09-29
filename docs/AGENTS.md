<!-- Parent: ../AGENTS.md -->
<!-- Generated: 2026-09-17 | Updated: 2026-09-17 -->

# docs

## Purpose
Registro histórico das decisões do hexlog (ADRs) e a pesquisa de libs/padrões que fundamentou essas decisões.

## Key Files
| File | Description |
|---|---|
| `adr-0001-hexlog-mvp.md` | ADR 0001, status Aceito: decide construir o hexlog como servidor MCP stdio único em TypeScript (Node ≥ 24.18.1), com núcleo puro, store JSONL com lock `mkdir`+token+`mtime`, cadeia sha256+JCS via `canonicalize`, tools com Zod (dez na origem; doze desde o ADR 0006), busca via MiniSearch, e instalação como bundle esbuild em `~/.local/lib/hexlog/<versão>/` fora da working tree. Registra alternativas descartadas, consequências, testes portados da POC (`5703a53`) e decisões de execução (DE-01 a DE-19). |
| `adr-0002-versionamento-definicoes.md` | ADR 0002, status Aceito: `register_type`/`register_vocabulary`/`register_gate` passam a versionar em semver `major.minor` (`<nome>/<versão>.json`) em vez de sobrescrever, com o legado `<nome>.json` nunca migrado. Decisões estruturais D1 (escrita exclusiva por `linkSync` + retry que refaz a decisão inteira) e D2 (legado não materializado). |
| `adr-0005-hexlog-setup-hexlog-flow.md` | ADR 0005, status Aceito: duas skills novas (`hexlog-setup`, `hexlog-flow`) e o mapa `.hexlog/flow.md` do repositório alvo, que generalizam o instalador de uma skill fixa para N pastas de `skills/`. Emenda de 2026-09-28: o hook opcional `flow-reminder` e o schema Zod `FlowMap` (`src/flow-map.ts`) descritos na decisão original foram retirados do v1 por decisão do usuário — sem consumidor programático do flow map, instalador volta a dois bundles. Emenda de 2026-09-29: o invariante de dez tools cai com o ADR 0006. |
| `adr-0006-anexos-tipos-timeline.md` | ADR 0006, status Aceito: anexos endereçados por sha256 dos bytes (tool `attachment`, `path` restrito a `<cwd>/.omc/plans`), tool e CLI `timeline` cruzando os processos por target, `supersedes` de tipo custom validado no `register`, cinco tipos custom de auditoria (`.hexlog/types/*.json`) e o contrato de veredito do Critic. Passa o servidor a 12 tools e reverte a rejeição de "tool nova de busca multi-processo" do ADR 0001 (congelado, sem emenda). Emenda os ADR 0002 e 0005 sobre o invariante de dez tools. |
| `qualidade-ci.md` | Estudo (nada instalado) de plataformas de qualidade para CI/CD quando o repo for público: camadas agora/depois/nunca, esforço, custo e fonte de cada ferramenta, consultadas em 2026-09-17. |
| `qualidade-codigo.md` | Estudo (nada instalado) de qualidade de código e teste — TypeScript, ESLint, jest, property-based testing, mutação — consultado em 2026-09-17. |
| `ferramentas-similares.md` | Estudo (nada adotado) de decisionlog.ai, mcp-server-decisions e ConPort comparados ao hexlog, com fontes primárias consultadas em 2026-09-17 e 5 ideias ranqueadas. |
| `diagrama-c3-componentes.md` | Diagrama C4 (nível C3, componentes) do servidor MCP em `src/`, gerado a partir do grafo de dependências internas descrito em `src/AGENTS.md`. |

## Subdirectories
| Directory | Description |
|---|---|
| `pesquisa/` | Pesquisa de libs e padrões (17 frentes) que embasou o ADR 0001 (see `pesquisa/AGENTS.md`) |

## For AI Agents
### Working In This Directory
- Os demais ADRs aceitos (`adr-0002-versionamento-definicoes.md`, `adr-0005-hexlog-setup-hexlog-flow.md`, `adr-0006-anexos-tipos-timeline.md`) são registro histórico: não reescreva o corpo para refletir mudanças futuras. Uma mudança de rumo emenda com uma seção nova (ex.: "Amendment") ou um ADR seguinte (`adr-000N-...md`), nunca reescrevendo Decision/Consequences já registrados.
- Antes de propor trocar uma lib ou abordagem já decidida, confira a frente de pesquisa correspondente em `pesquisa/frentes/` e a linha do ADR que a descartou ou adotou — a maioria das alternativas já foi avaliada e tem motivo registrado.

### Common Patterns
- IDs de decisão (`Q1`, `R-1`, `QN2`, `U-1`, `DE-01`, ...) citados no ADR remetem a decisões do usuário ou de execução tomadas durante o planejamento/Ralph; são referenciados por esses códigos em todo o repositório.

## Dependencies
### Internal
O ADR 0001 registra as decisões que originaram a arquitetura de `src/` (núcleo, store, cadeia, tools, instalação) e o formato do log (envelope de evento, manifesto `process.json`, cadeia de hash). A fonte da verdade do estado atual é o código.

<!-- MANUAL: Any manually added notes below this line are preserved on regeneration -->

- **Congelados em 2026-09-28:** `adr-0001-hexlog-mvp.md` e tudo em `pesquisa/` (inclusive os `AGENTS.md` de lá). Não edite esses arquivos, nem para corrigir, anotar ou emendar; revisões de doc contra o código os ignoram. Mudança de rumo sobre o que o ADR 0001 decidiu vai num ADR novo.
