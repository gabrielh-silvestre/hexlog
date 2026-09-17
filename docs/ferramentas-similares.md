# Ferramentas similares ao hexlog

Estudo das três ferramentas que mais se aproximam do objetivo do hexlog: fonte
única da verdade para o trabalho pré-código do agente (discovery, refinamento,
brainstorm), com rastreio de decisões e descobertas. **Nada daqui foi adotado.**

Fontes primárias (site e docs do produto, código-fonte, PyPI, API do GitHub)
consultadas em **2026-09-17**. O que não deu para confirmar na fonte está
marcado como _não verificado_.

## Resumo

| | hexlog | decisionlog.ai | mcp-server-decisions | ConPort |
|---|---|---|---|---|
| Modelo de dados | Processo, Marco, Veredito + tipos registrados | Decision, DecisionCandidate, DecisionSupersession, DecisionSource, SourceContent, AuditEvent | decision, prediction, outcome | decisions, progress, system_patterns, custom_data, product/active context, context_links |
| Armazenamento | JSONL por processo, local | SaaS (GraphQL canônico + REST + MCP HTTP) | Um JSONL local | SQLite por workspace + ChromaDB |
| Corrigir uma decisão | Novo Veredito com `supera[]` | `supersedeDecision`, atômico e auditado | Nenhum mecanismo; `status` é texto livre | `delete_decision_by_id` (DELETE físico) |
| Tamper-evidence | Cadeia sha256+JCS, tool `cadeia` | Não documentado (append-only arquitetural) | Não | Não |
| Fases / gates | Gates embutidos e custom (`avaliar_gate`) | Candidato → revisão → Decision | Só documentação + aviso não bloqueante | Não |
| Tipos customizáveis | `registrar_tipo`, `registrar_vocabulario` | Não documentado | Enums só declarativos, não validados | `category`/`relationship_type`/tags em texto livre |
| Bloqueia edição direta | Hook PreToolUse + 4 regras deny | Estrutural: API sem update, RBAC/ABAC | Não; linha corrompida é ignorada em silêncio | Não |
| Licença | Sem licença pública | Produto fechado; SDK/CLI Apache-2.0 | MIT | Apache-2.0 |
| Manutenção | Ativo | Site atualizado em 2026-08-23 | Último commit 2026-09-03, 16 commits, 0 stars | PyPI 0.3.13 (2025-12-31), último commit 2026-01-19 |

## decisionlog.ai

SaaS focado só em decisões de pessoas e agentes; se declara "deliberadamente
estreito" (não é PM, ticket, wiki).

**Modelo de dados.** `Decision` imutável, com `decisionKey` estável, texto,
`rationale`, Actor e proveniência. `DecisionCandidate` é uma decisão proposta
(por extração de fonte ou por agente) que ainda não vale. `DecisionSupersession`
liga antecessora e sucessora. `AuditEvent` é append-only. A lista completa de
campos está no `components.schemas` do OpenAPI e ficou _não verificada_ (o
fetch truncou).

**API e MCP.** GraphQL em `/api/graphql`; REST gerado em `/openapi.json`
(`/api/v1/graphql/{query|mutation}/{operation}`); MCP streamable-http em
`/api/mcp`. Operações confirmadas: `createDecision`, `supersedeDecision`,
`approveDecisionAction`, `extractSource`, `decisionSources`,
`decisionSupersession`, `candidate(s)`, `auditEvents`. Nomes exatos das tools
MCP: _não verificado_ (a docs usa `decision_log.list_audit_events`, um
diretório de terceiros usa `decision_log_get_source`; só o `tools/list` ao vivo
resolve).

**Imutabilidade e supersession.** "Decisions remain immutable. Changes are
recorded through supersession." Criação idempotente; supersession e criação da
substituta são atômicas e auditadas. Resolver um candidato (aprovar, rejeitar
ou converter em supersession) é terminal. Hash ou assinatura: não aparece em
nenhuma página.

**Fluxo.** Envia `SourceContent` → `extractSource` gera candidatos → revisor
confere proveniência, rationale e se já existe decisão com a mesma chave →
resolução terminal. Não há enum de fases nomeadas documentado.

**Pontos fortes a copiar.**
- Separar **candidato** de **decisão**: o que ainda está em revisão não polui o
  estado vigente. No hexlog, seria um tipo registrado + gate antes de virar
  Veredito.
- **Chave estável** (`decisionKey`) para "a decisão atual sobre X", derivada da
  ponta da cadeia de supersession.
- **Não confiar no Actor informado pelo cliente** ("client-supplied Actor
  identifiers are context — not authorization proof"). No hexlog, o campo
  `agente` do `registrar` é declarado pelo próprio agente.

**Lacunas em relação ao hexlog.** Sem tamper-evidence criptográfica
documentada, sem gates com critério, sem tipos customizáveis, só nuvem.

**Fontes.** [home](https://www.decisionlog.ai/),
[decision-model](https://www.decisionlog.ai/docs/decision-model),
[sources-extraction](https://www.decisionlog.ai/docs/sources-extraction),
[mcp-agents](https://www.decisionlog.ai/docs/mcp-agents),
[security](https://www.decisionlog.ai/docs/security),
[api-cli](https://www.decisionlog.ai/docs/api-cli),
[openapi.json](https://www.decisionlog.ai/openapi.json),
[pricing](https://www.decisionlog.ai/pricing.md),
[mcp.json](https://www.decisionlog.ai/.well-known/mcp.json),
[decisionlog-developer](https://github.com/burn2delete/decisionlog-developer).

## mcp-server-decisions

Servidor MCP stdio em Python (JSON-RPC escrito à mão, sem o SDK oficial, zero
dependências). Mesmo formato do hexlog, mas bem mais simples. Citações contra
`server.py` no commit `e8963a0`.

**Modelo de dados.**
- `decision`: `decision_id` (`DEC-<ano>-NNNN`), `ts`, `problem`,
  `chosen_solution`, `rejected_alternatives[]`, `technologies[]`, `status`
  (ACTIVE/SUPERSEDED/DEPRECATED, não validado), `adr_ref`, `domain`
  (server.py:87-98).
- `prediction`: `prediction_id`, `decision_id` (existência checada),
  `prediction_type` (enum só declarativo), `predicted_value` (server.py:126-133).
- `outcome`: `prediction_id`, `actual_value`, `measurement_source`,
  `accuracy_score` 0-100 e `validation_status` calculado pelo servidor
  (≥90 SUCCESS, 50-89 PARTIAL_SUCCESS, <50 FAILED) (server.py:151-166).

**Tools.** `record-decision` (aceita `predictions[]` e cria as predições na
mesma chamada), `record-prediction`, `record-outcome` (abaixo de 75 devolve
`lesson_recommended`), `query-decisions` (filtro por keyword, tecnologia,
domínio).

**Imutabilidade.** Append-only de fato: só abre o arquivo em modo `"a"`, não há
update, delete nem lock (server.py:47-54; `docs/ARCHITECTURE.md`: "no
implementation, by design"). Mas não há hash, nem vínculo entre decisão nova e
a que ela substitui, e `_read_log()` descarta linha corrompida sem avisar
(server.py:38-41).

**Fluxo.** Decide → Predict → Implement → Measure → Validate → Learn existe só
no README. O único "gate" é o campo `OUTCOME_GATE` na resposta das tools,
listando predições da sessão ainda sem outcome; é aviso, não bloqueia
(server.py:391-397, 424-430; `docs/OUTCOME-GATE-PATTERN.md`).

**Pontos fortes a copiar.**
- **Aviso embutido na resposta** (`OUTCOME_GATE`): o agente vê a pendência onde
  já está olhando. No hexlog, `registrar` poderia devolver um resumo de
  `estado.orfaos` antes de o gate bloquear.
- **Ciclo decisão → predição → resultado**: fecha o loop "o que achávamos vs. o
  que aconteceu". Cabe no hexlog como tipo registrado ligado ao Veredito.
- **Criação encadeada numa chamada** (decisão + predições): menos round-trips.

**Lacunas em relação ao hexlog.** Sem cadeia de hash, sem supersession real,
enums não validados, sem proteção do arquivo, versão reportada no `initialize`
(1.0.0) diverge do pacote (1.0.2), projeto de 2 meses sem adoção externa.

**Fontes.** [repo](https://github.com/Roberton003/mcp-server-decisions),
[server.py](https://raw.githubusercontent.com/Roberton003/mcp-server-decisions/main/server.py),
[ARCHITECTURE.md](https://raw.githubusercontent.com/Roberton003/mcp-server-decisions/main/docs/ARCHITECTURE.md),
[OUTCOME-GATE-PATTERN.md](https://raw.githubusercontent.com/Roberton003/mcp-server-decisions/main/docs/OUTCOME-GATE-PATTERN.md),
[pyproject.toml](https://raw.githubusercontent.com/Roberton003/mcp-server-decisions/main/pyproject.toml).

## ConPort (Context Portal)

Servidor MCP em Python com 30 tools; é um "memory bank" de projeto, não um log.
Esquema definido como migração Alembic embutida em
`src/context_portal_mcp/db/database.py`.

**Modelo de dados.**
- `decisions`: `summary`, `rationale`, `implementation_details`, `tags` (JSON).
  Sem status, sem supersession.
- `progress_entries` (com `parent_id`), `system_patterns`, `custom_data`
  (`category` + `key` únicos).
- `product_context` e `active_context`: documento único, com tabelas
  `*_history` (snapshot anterior + `version` + `change_source`).
- `context_links`: aresta tipada `source_item_type/id → target_item_type/id`
  com `relationship_type` em texto livre.
- FTS5 em `decisions_fts` e `custom_data_fts`; busca semântica em ChromaDB
  (`vector_store_service.py`).

**Tools.** Decisões: `log_decision`, `get_decisions`, `delete_decision_by_id`,
`search_decisions_fts`. Também progress, system patterns, custom data,
`link_conport_items`/`get_linked_items`, `semantic_search_conport`,
`export_conport_to_markdown`/`import_markdown_to_conport`, `get_item_history`,
`get_conport_schema`, `get_recent_activity_summary`, `batch_log_items`.

**Imutabilidade.** Decisões são apagadas com `DELETE` físico, sem histórico.
Só product/active context guardam versões. Nenhuma ocorrência de "supersed" no
código ou README. Nada impede editar o `context.db` direto.

**Fluxo.** Nenhum: `progress_entries.status` é texto livre, sem gates.

**Pontos fortes a copiar.**
- **Relações tipadas** entre itens (`context_links`), com enum fechado em vez de
  texto livre: `supera`, `refina`, `conflita`, `relacionado`. Hoje o hexlog só
  modela `supera[]`.
- **`change_source`**: registrar qual ação gerou a mudança. O hexlog tem
  `origem`/`rastro` no Veredito; vale checar se cobre Marco também.
- **Export para Markdown** e **`get_recent_activity_summary`**: leitura humana
  do log e resumo para retomar sessão.

**Lacunas em relação ao hexlog.** Sem append-only, sem hash, sem gates, sem
supersession, vocabulário todo livre, dados editáveis e deletáveis pelo agente.

**Fontes.** [repo](https://github.com/GreatScottyMac/context-portal),
[database.py](https://github.com/GreatScottyMac/context-portal/blob/main/src/context_portal_mcp/db/database.py),
[main.py](https://github.com/GreatScottyMac/context-portal/blob/main/src/context_portal_mcp/main.py),
[vector_store_service.py](https://github.com/GreatScottyMac/context-portal/blob/main/src/context_portal_mcp/db/vector_store_service.py),
[README](https://github.com/GreatScottyMac/context-portal/blob/main/README.md),
[LICENSE](https://github.com/GreatScottyMac/context-portal/blob/main/LICENSE),
[PyPI](https://pypi.org/project/context-portal-mcp/).

## O que levar para o hexlog

Só estudo. Qualquer item que acrescente tool quebra o "exatamente 10 tools" do
ADR 0001 e pede um ADR novo; a coluna "Toca" indica onde caberia sem isso.

| # | Ideia | Origem | Toca | Esforço |
|---|---|---|---|---|
| 1 | Resumo de pendências (órfãos, conflitos) na resposta de `registrar` | mcp-server-decisions (`OUTCOME_GATE`) | `registrar` | ~2 h |
| 2 | Relações tipadas além de `supera[]` (`refina`, `conflita`) com enum fechado, projetadas no `estado` | ConPort (`context_links`) | `registrar`, `estado`, gate `sem-referencias-invalidas` | ~1 dia |
| 3 | Candidato vs. Veredito: tipo "candidato" que só vira Veredito após gate | decisionlog.ai (`DecisionCandidate`) | `registrar_tipo`, `avaliar_gate` | ~meio dia se couber em tipo registrado; mais se exigir regra no núcleo |
| 4 | Ciclo predição → resultado ligado a um Veredito | mcp-server-decisions | `registrar_tipo`, `estado` | ~meio dia via tipos registrados |
| 5 | Export do processo para Markdown legível | ConPort (`export_conport_to_markdown`) | Script fora das 10 tools, ou tool nova (ADR) | ~meio dia |

## Não verificado

- decisionlog.ai: esquema completo das entidades, nomes exatos das tools MCP,
  ausência de hash (só não é mencionado), data do último commit do SDK.
- mcp-server-decisions: conteúdo do wheel em `dist/` (assumido igual ao
  `server.py`); a métrica "3,8% → 14,5%" do OUTCOME-GATE é autodeclarada.
- ConPort: modelo de embedding usado, filtro SQL de
  `search_project_glossary_fts`.
