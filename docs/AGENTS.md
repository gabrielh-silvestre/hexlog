<!-- Parent: ../AGENTS.md -->
<!-- Generated: 2026-09-17 | Updated: 2026-10-05 -->

# docs

## Purpose
Documentação do hexlog: as decisões em `directives/` (ADRs 0007 a 0010, da 1.0), os guias de uso, instalação e dados, os estudos de apoio e a pesquisa de libs/padrões que fundamentou as decisões originais do 0.x.

## Key Files
| File | Description |
|---|---|
| `tetos-dominio-v1.md` | Decisão N8 do PR #60: tetos de `relations`, `Batch.key`, `RecordType`, `Gate.questions` e `aliases` no domínio da v1, com o dado medido no 0.x (2026-09-30), quais números são precedente e quais são palpite, e como refazer a medição. |
| `uso.md` | Caminho de um projeto novo em 5 passos, exemplo completo das chamadas e tabela das 11 tools, com as convenções de nomes e `target`. |
| `tools.md` | Referência de entrada, saída e erros de cada uma das 11 tools; o mapa geral está em `uso.md`. |
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
| `directives/` | ADRs 0007 a 0010 (domínio, serviços, ferramental e camada sobre o OMC) (see `directives/AGENTS.md`) |
| `pesquisa/` | Pesquisa de libs e padrões (17 frentes) que embasou as decisões do 0.x (see `pesquisa/AGENTS.md`) |

## For AI Agents
### Working In This Directory
- A partir da 1.0, ADR não é refeito nem apagado: uma mudança de rumo emenda com uma seção nova (ex.: "Amendment") ou um ADR seguinte (`adr-000N-...md`), nunca reescrevendo Decision/Consequences já registrados. A troca dos ADRs 0001, 0002, 0005 e 0006 pelos 0007 a 0009 foi a exceção única. Na aprovação só o cabeçalho muda (Status passa a Aceito e Deciders inclui quem aprovou); depois de Aceito, o corpo só muda por emenda datada. Os ADRs 0007 a 0009 estão Aceitos (aceite do dono em 2026-10-04).
- Antes de propor trocar uma lib ou abordagem já decidida, confira a frente de pesquisa correspondente em `pesquisa/frentes/` e o ADR 0007, 0008 ou 0009 que a trata — a maioria das alternativas já foi avaliada e tem motivo registrado.

### Common Patterns
- IDs de decisão remetem a decisões do usuário ou de execução tomadas durante o planejamento/Ralph e vêm em duas famílias, nenhuma delas definida nos ADRs 0007 a 0009:
  - 0.x (`Q#`, `QN#`, `R-#`, `U-#`, `DE-##`, `M#`, `N#`, `S#`, `B#`, `I#`, `C#`): definidos só no ADR 0001, removido na F8; leia no commit `87237c3` (ancestral da `main`, estável): `git show 87237c3:docs/` lista os ADRs da época.
  - 1.0 (`D-##`, `E#`, `G#`, `L#`, `f#`, `Constraint N`, `P#`, `TM#`, `TB#`, `TF#`, `SL#`, `SE#`): vivem nas specs e no plano em `.omc/` do checkout principal (não nas worktrees), ignorado pelo git; só `D-##` tem sentido inline, nos ADRs 0008 e 0009 e em `docs/tetos-dominio-v1.md`. Os demais ficam como rótulo sem destino versionado: o dono decidiu não versionar as specs nem o plano da 1.0. Código, comentários e testes não citam mais ponteiro `§N.N`; os que restam em `pesquisa/` (congelada) são de seção de RFC ou dos planos 0.x, também em `.omc/` e fora do git. Não crie rótulo novo dessas famílias: decisão nova vira item numerado de ADR, por emenda.

## Dependencies
### Internal
Os ADRs 0007 a 0009 registram as decisões da arquitetura de `src/` (domínio, serviços, ferramental) e o formato do log. A fonte da verdade do estado atual é o código.

<!-- MANUAL: Any manually added notes below this line are preserved on regeneration -->

- **`pesquisa/` segue congelado** desde 2026-09-28 (inclusive os `AGENTS.md` de lá): não edite esses arquivos, nem para corrigir, anotar ou emendar; revisões de doc contra o código os ignoram. O ADR 0001 foi substituído pelos ADRs 0007 a 0009, e os links de `pesquisa/` para ele ficam mortos de propósito. Mudança de rumo sobre o que o ADR 0001 decidiu vai num ADR novo.
