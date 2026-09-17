## Frente: Servidores MCP de log/auditoria existentes

### Perguntas respondidas
Sim, existem vários: audit/event log com hash chain, decision log/ADR, e o "memory" oficial. Nenhum cobre a combinação hash chain + schemas custom via JSON Schema/Zod + escrita multi-processo no mesmo arquivo + isolamento de leitura do agente. Veredito geral: **Construir**, aproveitando ideias específicas listadas abaixo.

### Candidatos

| Candidato | Versão/release | Licença | Manutenção | ESM/TS/Node24 | Deps | Encaixe hexlog | Veredito |
|---|---|---|---|---|---|---|---|
| `@modelcontextprotocol/server-memory` | 2026.8.31 (2026-08-31) | MIT (campo npm diz "SEE LICENSE IN LICENSE", README confirma MIT) | Oficial Anthropic/MCP, ativo | Sim, ESM+TS, só `@modelcontextprotocol/sdk ^1.30.0`, sem peerDeps | 1 dep direta | Knowledge graph JSONL, não é log de eventos com hash chain; schema fixo (entity/relation/observation), não custom | Nativo/inspiração, não adotável |
| Decision Log (`ai.decisionlog`) | SaaS, sem versão npm/GitHub pública | Fechado (não achei repo) | Health check 2026-09-13, "healthy", 30 tools | Remoto (web/API/CLI/MCP), não self-host | N/A | Vocabulário quase idêntico ao Marco/Veredito+Estado projetado (provenance, supersessão, DecisionCandidate→ativa), mas é serviço fechado hospedado | Não adotável (só a ideia de lifecycle) |
| `@adrkit/mcp` (mbeacom/adrkit) | 0.13.0 (2026-08-30) | Apache-2.0 | Ativo, 14 stars, CI verde | Sim, Node 22+, TS | shells out ao CLI `adr` | Só leitura (4 tools), sem writes/rede/índice persistente; decisões vêm de git+CLI, não do MCP | Não adotável, ideia de API sim |
| `agent-audit-mcp` (Rumblingb) | npm 1.0.0 (2026-06-03) | **Divergência**: npm `license:"MIT"`, mas README do repo diz "Proprietary — subscription $19/mo" | Baixa (2 stars, Python) | Não (Python 3.10+, fastmcp) | mcp, fastmcp | Hash chain SHA-256 em JSON único (`~/.agentaudit/chain.json`, não JSONL append), write atômico tmp+rename | Não adotável |
| `@kajaril/audit-event-mcp` (mightbesaad) | 0.2.0 (2026-07-12) | MIT | Baixo tráfego (2 stars), CI ativo | TS, mas é **endpoint remoto HTTPS** (Cloudflare Workers+Durable Objects+SQLite), não stdio local | — | Hash chain documentado (`chain_hash=SHA256(id\|type\|input_hash\|prev_hash)`), tipos de evento reservados (`approval.*` que o agente não pode forjar), exclusão de campo sensível na resposta | Não adotável (SaaS), ideias sim |
| `journal-mcp` (ynishi) | WIP, sem release/pacote publicado | MIT OR Apache-2.0 | 0 stars, ativo (ST7, 2026-08-25) | Rust (rmcp), não Node | — | Muito próximo conceitualmente: EventLog SQLite = fonte da verdade, política de append por seção declarada no schema (`append-only-chain`/`append-once`/...), imutabilidade via trigger SQLite `RAISE(ABORT)`, projeção reconstruída só sob demanda (`journal_projection_rebuild`) | Não adotável (linguagem/stack), ideias fortes |
| `mcp-audit-gateway`/`@mcp-audit-gateway/core` (elang2) | versão exata não capturada, repo ativo (2026-09-16) | MIT | Ativo, CI/DOI Zenodo | TS, Node, mas é **proxy que envolve outro servidor stdio** (`mcp-audit wrap -- <server>`), não um servidor com tools próprias | @mcp-audit-gateway/core | Testou canonicalização determinística de JSON entre 10 SDKs MCP e achou 26 divergências (floats, ordenação de chaves, encoding) que quebram hash chains silenciosamente; checkpoint records p/ detectar truncamento; `chain_break` assinado em restart forçado | Não adotável (formato errado), ideia de canonicalização é importante |

### Decisão recomendada
**Construir hexlog do zero.** Nenhum candidato é um servidor MCP stdio local, multi-processo, com schemas custom fixados por hash e hash chain nativa — o mais parecido (`ai.decisionlog`) é SaaS fechado, e o mais parecido em mecânica de storage (`journal-mcp`) está em Rust/WIP.

Ideias a aproveitar:
1. **Canonicalização antes de hashear** (`mcp-audit-gateway`): fixar forma canônica (chaves ordenadas, números seguros) antes de existirem logs gravados.
2. **Tipos de evento reservados** (`audit-event-mcp`): o Marco de gate é escrito pelo servidor; `registrar` normal não pode forjá-lo.
3. **Política de append declarada no schema** (`journal-mcp`): `append-only-chain`/`append-once`/`replace-forbidden`.
4. **Estado projetado sob demanda** (`journal-mcp`): recomputar só em `estado`, não a cada `registrar`.
5. **Granularidade de tools do memory server**: mutações pequenas e idempotentes, reportando o que faltou em vez de falhar.
6. **Resource com notificação de mutação** (`memory://knowledge-graph` + `notifications/resources/updated`): opcional para `estado`/`eventos`.

### Riscos e armadilhas
- README de `agent-audit-mcp` contradiz o campo `license` do npm — ler LICENSE real antes de citar licença.
- Nenhum candidato resolve N processos no mesmo JSONL — usam SQLite ou 1 processo por arquivo.
- "MCP-native"/"tamper-evident" nem sempre é self-hosted: 2 dos 4 "audit" são gateways remotos.

### Perguntas em aberto
Nenhuma.
