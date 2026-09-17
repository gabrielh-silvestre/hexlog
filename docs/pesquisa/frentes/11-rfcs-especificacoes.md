## Frente: RFCs e especificações

### Tabela
| Spec | Status / data | Parte que importa | Aplicação no hexlog | Veredito |
|---|---|---|---|---|
| RFC 8785 JCS | Informational, 2020 | Chaves ordenadas, sem espaços, números via serialização ECMAScript | Forma canônica antes de hashear o payload | Adotar integral |
| RFC 8259 JSON | Internet Standard (STD 90) | Gramática base | Base | Adotar integral |
| RFC 7493 I-JSON | Proposed Standard, 2015 | Sem chaves duplicadas; números em double | Perfil seguro para schemas custom | Adotar ideia (documentar) |
| RFC 7464 JSON Text Sequences | Proposed Standard, 2015 | RS+JSON+LF resolve truncamento de escalares top-level | Linhas do hexlog são sempre objetos; jq/tail/grep não entendem RS | Ignorar |
| JSON Lines (jsonlines.org) | spec de comunidade | UTF-8, 1 valor por linha, `\n` | Formato do arquivo | Adotar integral — citar jsonlines.org; **ndjson.org está sequestrado (spam)** |
| RFC 3339 (+ RFC 9557, 2024) | Standards Track / Proposed Standard | Timestamp com `Z` ou offset; 9557 adiciona `[zona]` | `format: date-time` valida RFC 3339 §5.6 | Adotar 3339 puro; ignorar 9557 |
| RFC 9562 UUID (v7) | Proposed Standard, 2024 (obsoleta 4122) | v7 = 48 bits ms Unix + aleatório, ordenável | Campo `id` | Adotar integral para `id` (complementa `seq`) |
| RFC 6962 / RFC 9162 (CT) | **Experimental** | Merkle Tree Hash, inclusão, consistência | Cadeia é lista encadeada; verificação O(n) | Só a ideia (consistência) |
| C2SP tlog-checkpoint / signed-note | community v1.0.0, 2025-11-08 | note assinada; checkpoint = origin/tree-size/root-hash | Checkpoint periódico da cadeia | Adotar integral como feature futura (não MVP) |
| RFC 6901 JSON Pointer | Proposed Standard, 2013 | `/a/b/0`, escapes `~0`/`~1` | Caminho em `detalhes[]` | Adotar integral |
| RFC 9535 JSONPath | Proposed Standard, 2024 | Query com filtros | Overkill | Ignorar |
| RFC 9457 Problem Details | Proposed Standard, 2023 | `type/title/status/detail/instance` + extensões | Molde de `{codigo, mensagem, detalhes[]}` | Adotar ideia (sem `status` HTTP) |
| RFC 3161 TSP | Proposed Standard, 2001 | TSA terceira | Local, sem TSA | Ignorar |
| RFC 5424 syslog | Proposed Standard, 2009 | Mensagem de rede | Não serve | Ignorar |
| JSON Schema 2020-12 | **Internet-Draft expirado (dez/2022), nunca RFC**; mantido por json-schema.org | `format-annotation` (default, não valida) vs `format-assertion` | Zod valida de fato; documentar a pegadinha se schemas forem publicados | Adotar integral como formato |
| CloudEvents 1.0 (1.0.3-wip) | CNCF | `id, source, specversion, type` obrigatórios; `time` opcional; `dataschema`, `subject` | Mesmo shape do envelope; `time` vs `timestamp` | Adotar ideia, não envelope literal |
| W3C PROV-O / PROV-DM | W3C Recommendation, 2013-04-30 | Entity/Activity/Agent, `wasDerivedFrom`, `wasAssociatedWith` | Nomes de proveniência do Veredito (`origem`, `fonte`, `rastro`) | Adotar ideia (nomenclatura) |
| in-toto Attestation v1.2 + SLSA v1.2 | Linux Foundation; SLSA v1.1 Retired, v1.2 Approved | Statement `{_type, subject:[{name,digest}], predicateType, predicate}` | Molde para o campo `prova` do Veredito | Adotar ideia fortemente (sem DSSE) |
| XDG Base Directory 0.8 | freedesktop.org | `$XDG_DATA_HOME` padrão `$HOME/.local/share` | Já usado | Adotar integral |
| Spec MCP **2026-07-28** (corrente) | modelcontextprotocol.io | `structuredContent` + `outputSchema`; `isError: true` no result = erro de execução, distinto de erro JSON-RPC de protocolo; annotations | Confirma `isError + {codigo, mensagem, detalhes[]}` via `structuredContent`; `readOnlyHint` em `estado`/`eventos`/`cadeia`/`listar` | Adotar integral |
| SemVer 2.0.0 | semver.org | MAJOR.MINOR.PATCH | Só no catálogo de schemas; dentro do processo o hash é a âncora | Adotar só no catálogo |

### Recomendações de design (top 5)
1. Erro: ideia RFC 9457 + `isError`/`structuredContent`/`outputSchema` do MCP.
2. Arquivo: JSON Lines (jsonlines.org), não RFC 7464.
3. `id` do envelope em UUIDv7 (RFC 9562), complementando `seq`.
4. `prova` do Veredito no molde Statement do in-toto (`subject` + `predicateType` + `predicate`).
5. JCS (RFC 8785) se o hash cobrir o objeto do evento; dispensável se o hash cobrir os bytes brutos da linha. (Nota do orquestrador: a frente hash-chain recomenda hashear o objeto canônico, como a POC — logo JCS entra.)

### Conflitos entre specs
- CloudEvents `time` opcional vs `timestamp` obrigatório no hexlog → manter obrigatório.
- RFC 8785 (double) vs números arbitrários → proibir bigint/decimal fora de double nos schemas custom ou documentar.
- `format: date-time` annotation-only por padrão → documentar; Zod valida de fato.
- RFC 3339 vs 9557 → emitir 3339 puro.

### Evidência (URLs verificadas)
rfc-editor.org/rfc/{8785,8259,7493,7464,3339,9557,9562,6901,9535,9457,3161,5424,6962,9162}; jsonlines.org; c2sp.org/{tlog-checkpoint,signed-note}; json-schema.org/draft/2020-12/{json-schema-core,json-schema-validation}; github.com/cloudevents/spec; w3.org/TR/{prov-o,prov-dm}; raw.githubusercontent.com/in-toto/attestation/main/spec/{README.md,v1/statement.md}; slsa.dev/spec/{v1.1,v1.2}; specifications.freedesktop.org/basedir-spec/latest; modelcontextprotocol.io/specification/{versioning,2026-07-28/server/tools}; semver.org/spec/v2.0.0.html.
Não verificado por fetch: `openWorldHint` (não apareceu no trecho; 3 outras annotations confirmadas).

### Perguntas em aberto
Nenhuma.
