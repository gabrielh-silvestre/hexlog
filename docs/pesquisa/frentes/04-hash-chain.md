## Frente: Hash chain / log tamper-evident e JSON canônico

### Perguntas respondidas
- **Libs de hash chain prontas — nenhuma encaixa.** `hypercore` é replicação P2P (17 deps). `merkle-tools`/`merkletreejs` constroem Merkle tree em lote para prova de inclusão, não cadeia sequencial com índice quebrado. `@sigstore/rekor` e `@transparency-dev/merkle` não existem no npm (404 verificado).
- **JSON canônico:** nos casos comuns (`-0`, `1e21`, `0.1+0.2`, unicode/emoji, ordem de chaves, arrays), `canonicalize` (RFC 8785), `safe-stable-stringify`, `fast-json-stable-stringify` e a função da POC produzem a mesma string (todas delegam números/unicode ao `JSON.stringify` do V8). Diferenças só em `Date`, `NaN`/`Infinity` e `BigInt`.
- **O que entra no hash:** a POC hasheia `prevHash + canonicalizar(payload sem prevHash)` — sobre o objeto canônico, não a string gravada. Correto: hashear a string bruta acopla à formatação. Concatenação sem delimitador é segura porque `prevHash` tem tamanho fixo (64 hex ou vazio no primeiro elo).
- **Algoritmo:** `sha256` via `node:crypto` basta. Sem motivo para BLAKE3.
- **Ideias CT/Merkle:** só ganham com verificador externo. Fora de escopo agora. Único item barato para depois: expor o head hash.

### Candidatos
| Candidato | Versão / release | Licença | Manutenção | ESM/TS/Node 24 | Deps | Encaixe | Veredito |
|---|---|---|---|---|---|---|---|
| hypercore | 11.36.1 / 2026-09-10 | MIT | Ativo, 131k dl/mês | ok | 17 | P2P — problema errado | Não adotar |
| merkle-tools | 1.4.1 / 2022-06-19 | Apache-2.0 | Parado | CJS | js-sha3 | Merkle em lote | Não adotar |
| merkletreejs | 0.6.0 / 2025-09-15 | MIT | Ativo, 1,1M dl/mês | CJS/TS | crypto-js, buffer-reverse, treeify | Merkle em lote | Não adotar |
| **canonicalize** | 5.0.0 / 2026-09-08 | Apache-2.0 | Ativo, 11,6M dl/mês | ESM puro + `.d.ts` | 0 | RFC 8785, fail-fast em NaN/Infinity | **Adotar** |
| json-canonicalize | 3.0.1 / 2026-09-10 | MIT | 666k dl/mês | TS | — | Redundante | Descartar |
| safe-stable-stringify | 2.5.0 / 2024-08-24 | MIT | 218M dl/mês | dual | 0 | Trunca BigInt silenciosamente | Não adotar p/ hash |
| fast-json-stable-stringify | 2.1.0 / 2023-06-22 | MIT | 589M dl/mês | CJS | 0 | Sem tratamento NaN/Date | Descartar |
| fast-safe-stringify | 2.1.1 / 2022-06-17 | MIT | 159M dl/mês | CJS | 0 | Foco em ciclos | Fora de escopo |

Referência de domínio: `@cendor/acttrace` (npm, 2026-07-27, Apache-2.0) — "log tamper-evident de decisões de agente de IA, verificável offline"; framework com dep `@cendor/core`. Concorrente/referência, não peça.

### Decisão recomendada
- **Hash chain: Nativo** (`sha256(prevHash + canonical(payload))`, ~10 linhas).
- **Canonicalização: Adotar `canonicalize` (RFC 8785)**, versão exata. Corrige bug real da POC (`Date` → `{}`) e falha rápido em `NaN`/`Infinity`.
- **Algoritmo: Nativo** `node:crypto` sha256.
- **CT/Merkle: nada agora.**

### Evidência
- `npm view canonicalize ...` → 5.0.0, 2026-09-08, Apache-2.0, deps {}.
- `npm view merkle-tools ...` → 2022-06-19. `merkletreejs` → 0.6.0, 2025-09-15.
- Downloads via api.npmjs.org/downloads/point/last-month.
- Probe `scratchpad/hash-chain/probe.mjs` (Node 24.18.1):

| Caso | canonicalize | safe-stable-stringify | fast-json-stable-stringify | POC |
|---|---|---|---|---|
| casos comuns | idêntico | idêntico | idêntico | idêntico |
| `NaN`/`Infinity` | **lança** "NaN is not allowed" | `null` silencioso | `null` silencioso | `null` silencioso |
| `Date` | ISO via `toJSON` | idem | idem | **`{}` — perde o dado** |
| `BigInt` | lança | **`10` (trunca)** | lança | lança |

### Riscos e armadilhas
- `poc/src/hash.ts:10-23` (`ordenarChaves`) não trata `Date`.
- A lib de canonicalização vira parte do contrato do log: trocar depois invalida hashes antigos → versão exata e registrada.
- Ordenação de chaves com surrogate pairs não testada (risco baixo; chaves ASCII).

### Pergunta em aberto
Função caseira (20 linhas, bug em Date) vs `canonicalize` (0 deps, fail-fast). Recomendação: adotar a lib.
