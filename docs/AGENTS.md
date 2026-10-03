<!-- Parent: ../AGENTS.md -->
<!-- Generated: 2026-09-17 | Updated: 2026-10-03 -->

# docs

## Purpose
Registro das decisões do hexlog (ADRs 0007 a 0009, da 1.0) e a pesquisa de libs/padrões que fundamentou as decisões originais do 0.x.

## Key Files
| File | Description |
|---|---|
| `adr-0007-dominio.md` | ADR 0007, status Proposto: domínio da 1.0 — catálogo de entidades, regra "`supersedes`/`revokes` só no processo", vigência e conferência do destino de `supports`, `revokes` sobre não vigente recusado com `FORK_REJECTED`, anexo por palavra-chave de schema e guarda `unmarked-attachment`, versionamento (gate sem detecção de quebra, processo novo depois de `breaking: true`) e as quatro perguntas de gate (21 decisões numeradas, com a seção de emendas). |
| `adr-0008-servicos.md` | ADR 0008, status Proposto: serviços da 1.0 — emendas às specs (vigência só no processo, lock só da origem, E5 e `CYCLE_REJECTED`, cursor, teto de `text` e a reversão do "sem cache"), reavaliação do lock, precedência dos erros do `register` em seis níveis (D-06), regra de leitura D-24, ordem de saída da `query`, cegueira do alcance processo e reprodução do gate só pelo marcador (D-19) e limites aceitos da busca (7). |
| `adr-0009-ferramental.md` | ADR 0009, status Proposto: ferramental da 1.0 (criado na F6, estendido na F8) — 11 tools e alcance do `attach` (item 1), premissa de pid e taxas aceitas do lock (itens 2 e 3), orçamentos só no CI (4), contrato dos scripts de leitura por `compose.ts` (5), SE8 do insights (6), os 25 códigos de erro (7, `INVALID_ID`/`UNKNOWN_ID` removidos), ponto de retorno (8), raiz `.v1` e detecção positiva (9), emenda da regra de sequência (10), `details` (11), tetos do `register` (12), ampliações sobre a spec (13), `attach` por `path` (14), trilha 0.x só no `.tar` (15), mensagem do hook (16), ADR só recebe emenda (17), tetos do lock com destravamento manual (18) recuperação manual de processo corrompido (19) e limites aceitos do validador, ReDoS e `$ref` (20). |
| `tetos-dominio-v1.md` | Decisão N8 do PR #60: tetos de `relations`, `Batch.key`, `RecordType`, `Gate.questions` e `aliases` no domínio da v1, com o dado medido no 0.x (2026-09-30), quais números são precedente e quais são palpite, e como refazer a medição. |
| `friction-mining.md` | Como a skill `friction-mining` minera transcripts do Claude Code atrás de atrito no uso de uma tool MCP, e como portá-la a outro projeto. |
| `piloto-omc-fork.md` | Piloto do `oh-my-claudecode@omc-hexlog` (fork com hexlog) ligado só neste repositório, no lugar do upstream. |
| `qualidade-ci.md` | Estudo (nada instalado) de plataformas de qualidade para CI/CD quando o repo for público: camadas agora/depois/nunca, esforço, custo e fonte de cada ferramenta, consultadas em 2026-09-17. |
| `qualidade-codigo.md` | Estudo (nada instalado) de qualidade de código e teste — TypeScript, ESLint, jest, property-based testing, mutação — consultado em 2026-09-17. |
| `ferramentas-similares.md` | Estudo (nada adotado) de decisionlog.ai, mcp-server-decisions e ConPort comparados ao hexlog, com fontes primárias consultadas em 2026-09-17 e 5 ideias ranqueadas. |
| `diagrama-c3-componentes.md` | Diagrama C4 (nível C3, componentes) do servidor MCP em `src/`, gerado a partir do grafo de dependências internas descrito em `src/AGENTS.md`. |

## Subdirectories
| Directory | Description |
|---|---|
| `pesquisa/` | Pesquisa de libs e padrões (17 frentes) que embasou as decisões do 0.x (see `pesquisa/AGENTS.md`) |

## For AI Agents
### Working In This Directory
- A partir da 1.0, ADR não é refeito nem apagado: uma mudança de rumo emenda com uma seção nova (ex.: "Amendment") ou um ADR seguinte (`adr-000N-...md`), nunca reescrevendo Decision/Consequences já registrados. A troca dos ADRs 0001, 0002, 0005 e 0006 pelos 0007 a 0009 foi a exceção única. Os ADRs 0007 a 0009 estão Propostos até o usuário aprovar.
- Antes de propor trocar uma lib ou abordagem já decidida, confira a frente de pesquisa correspondente em `pesquisa/frentes/` e o ADR 0007, 0008 ou 0009 que a trata — a maioria das alternativas já foi avaliada e tem motivo registrado.

### Common Patterns
- IDs de decisão (`Q1`, `R-1`, `QN2`, `U-1`, `DE-01`, ...) citados no ADR remetem a decisões do usuário ou de execução tomadas durante o planejamento/Ralph; são referenciados por esses códigos em todo o repositório.

## Dependencies
### Internal
Os ADRs 0007 a 0009 registram as decisões da arquitetura de `src/` (domínio, serviços, ferramental) e o formato do log. A fonte da verdade do estado atual é o código.

<!-- MANUAL: Any manually added notes below this line are preserved on regeneration -->

- **`pesquisa/` segue congelado** desde 2026-09-28 (inclusive os `AGENTS.md` de lá): não edite esses arquivos, nem para corrigir, anotar ou emendar; revisões de doc contra o código os ignoram. O ADR 0001 foi substituído pelos ADRs 0007 a 0009, e os links de `pesquisa/` para ele ficam mortos de propósito. Mudança de rumo sobre o que o ADR 0001 decidiu vai num ADR novo.
