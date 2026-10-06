<!-- Parent: ../AGENTS.md -->
<!-- Generated: 2026-09-17 | Updated: 2026-10-05 -->

# docs

## Purpose
Documentação do hexlog: as diretrizes em `directives/` (docs vivos de regras e ADRs 0007 a 0010, da 1.0), os guias de uso, instalação e dados, os estudos de apoio e a pesquisa de libs/padrões que fundamentou as decisões originais do 0.x.

## Key Files
| File | Description |
|---|---|
| `tetos-dominio-v1.md` | Decisão N8 do PR #60: tetos de `relations`, `Batch.key`, `RecordType`, `Gate.questions` e `aliases` no domínio da v1, com o dado medido no 0.x (2026-09-30), quais números são precedente e quais são palpite, e como refazer a medição. |
| `uso.md` | Caminho de um projeto novo em 5 passos, exemplo completo das chamadas e tabela das 12 tools, com as convenções de nomes e `target`. |
| `tools.md` | Referência de entrada, saída e erros de cada uma das 12 tools; o mapa geral está em `uso.md`. |
| `instalacao.md` | Requisitos, instalação e atualização, instalação concorrente, versões antigas, verificação (`--check`) e como reverter. |
| `migracao.md` | Arquivamento do dado 0.x (`--archive-0x`), releitura da trilha arquivada, volta ao 0.x e migração 0.x para 1.0. |
| `dados.md` | Layout de dados em `<D>`, erros e avisos, tetos do lock, destravamento manual, recuperação de `PROCESS_CORRUPTED` e lacunas de isolamento. |
| `desenvolvimento.md` | Comandos de desenvolvimento, scripts de leitura (`insights`, `export`, `timeline`) e como os testes se organizam. |
| `friction-mining.md` | Como a skill `friction-mining` minera transcripts do Claude Code atrás de atrito no uso de uma tool MCP, e como portá-la a outro projeto. |
| `qualidade-ci.md` | Estudo (nada instalado) de plataformas de qualidade para CI/CD quando o repo for público: camadas agora/depois/nunca, esforço, custo e fonte de cada ferramenta, consultadas em 2026-09-17. |
| `qualidade-codigo.md` | Estudo de qualidade de código e teste — TypeScript, ESLint, jest, property-based testing, mutação — consultado em 2026-09-17; o tier "Agora" já está instalado, o resto é estudo. |
| `ferramentas-similares.md` | Estudo (nada adotado) de decisionlog.ai, mcp-server-decisions e ConPort comparados ao hexlog, com fontes primárias consultadas em 2026-09-17 e 5 ideias ranqueadas. |
| `diagrama-c3-componentes.md` | Diagrama C4 (nível C3, componentes) do servidor MCP em `src/`, gerado a partir do grafo de dependências internas descrito em `src/AGENTS.md`. |

## Subdirectories
| Directory | Description |
|---|---|
| `directives/` | Docs vivos de regras (convenções, fronteiras, invariantes, qualidade e testes, documentação, instalação e hooks) e ADRs 0007 a 0010 (see `directives/AGENTS.md`) |
| `pesquisa/` | Pesquisa de libs e padrões (17 frentes) que embasou as decisões do 0.x (see `pesquisa/AGENTS.md`) |

## Dependencies
### Internal
Os ADRs de `directives/` registram as decisões da arquitetura de `src/` (domínio, serviços, ferramental) e a camada sobre o OMC, e o formato do log. A fonte da verdade do estado atual é o código.

<!-- MANUAL: Any manually added notes below this line are preserved on regeneration -->

## Diretrizes

- [documentacao.md](directives/documentacao.md): ADR só por emenda, como citar, `pesquisa/` congelado e famílias de ID
