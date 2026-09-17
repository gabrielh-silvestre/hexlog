## Frente: Utilitários pequenos

### 1. Resolução XDG
- Spec 0.8 (specifications.freedesktop.org/basedir-spec/0.8/): se `$XDG_DATA_HOME` não estiver definida **ou estiver vazia**, usar `$HOME/.local/share`. A spec também exige caminhos absolutos (relativo deve ser ignorado) — nenhuma lib valida isso.
- `xdg-basedir` 5.1.0: 3 linhas (`env.XDG_DATA_HOME || path.join(home,'.local','share')`), 0 deps.
- `env-paths` 4.0.0: mesmo cálculo + nome do app + sufixo `-nodejs` por padrão (remover com `{suffix:''}`) + macOS/Windows; v4 ganhou dep `is-safe-filename`.
- `xdg-app-paths` 8.3.0: CJS, 2 deps (inclui fsevents) — descartar.

### 2. IDs de evento
- POC (`poc/src/envelope.ts`): `id: z.string()` — "unicidade não é garantida na escrita, só detectada na leitura"; `timestamp` "gerado pelo processo que grava — nunca pelo LLM". Implica **id fornecido pelo agente** como chave de idempotência (N2 só faz sentido assim).
- `crypto.randomUUID()` nativo: só v4. `randomUUID({version:7})` ignora `version` → **Node 24 não gera UUIDv7 nativo**.
- `uuid` 14.0.2: `uuidv7()` (RFC 9562 §5.7), 0 deps, ~207M dl/sem.
- `ulid` 3.0.2: 26 chars Crockford, `monotonicFactory()`, 0 deps.
- `nanoid` 6.0.1: só aleatório, ESM only.

### 3. Erro estruturado (Zod 4.6.5, probe com enum inválido + datetime inválida + chave extra)
- `error.issues`: array plano `[{path, code, message, ...}]` → mapeia 1:1 para `details[]`.
- `z.treeifyError`: árvore `{errors, properties}`; `z.flattenError`: `{formErrors, fieldErrors}`; `z.prettifyError`: string humana.
- `zod-validation-error` 5.0.0: redundante com `prettifyError`.
- **Melhor encaixe:** `error.issues` direto (+ conversão de `path` para JSON Pointer).

### 4. Datas
- `z.iso.datetime()` padrão: **só UTC com `Z`** (regex termina em `Z)$`). Com `{offset:true}` aceita offset (é o que `fromJSONSchema` usa para `format: date-time`).
- POC (`orfaos.ts`) compara vencimento como string: `marco.prazoExecucao >= agora` — válido só com ISO-8601 UTC de largura fixa.
- `Temporal` indisponível no Node 24.18.1 (`typeof Temporal === 'undefined'`; só flag V8 experimental).
- Leap seconds irrelevantes (Unix time).

### Candidatos
| Candidato | Versão/release | Licença | Manutenção | ESM/Node 24 | Deps | Encaixe | Veredito |
|---|---|---|---|---|---|---|---|
| xdg-basedir | 5.1.0 (2023-03) | MIT | estável | ESM | 0 | I1 | Nativo (3 linhas) basta |
| env-paths | 4.0.0 (2026-01) | MIT | ativo | ESM, node≥20 | 1 | multi-OS | Só se precisar macOS/Windows |
| xdg-app-paths | 8.3.0 (2023-02) | MIT | pouco ativo | CJS | 2 | redundante | Descartar |
| crypto.randomUUID | nativo | — | — | nativo | 0 | v4 | Nativo se ordenação não importa |
| uuid | 14.0.2 (2026-08) | MIT | muito ativo | ESM | 0 | UUIDv7 | Adotar se ordenação importar |
| ulid | 3.0.2 (2025-11) | MIT | ativo | ESM+CJS | 0 | compacto, monotônico | Alternativa |
| nanoid | 6.0.1 (2026-09) | MIT | muito ativo | ESM only | 0 | sem ordenação | Não serve |
| zod (nativo) | 4.6.5 | MIT | ativo | ESM+CJS | 0 | issues | Nativo |
| zod-validation-error | 5.0.0 (2025-11) | MIT | ativo | — | zod | redundante | Descartar |

### Decisão recomendada
- **XDG:** Nativo (3 linhas) + ignorar valor relativo (spec).
- **IDs:** decisão de design (quem gera); depois `uuid` v7 se ordenação importar, senão `crypto.randomUUID`.
- **Erro estruturado:** Nativo `error.issues`.
- **Datas:** Nativo; normalizar para UTC `Z` ao gravar para manter comparação lexicográfica válida.

### Riscos e armadilhas
- Libs XDG não validam caminho absoluto.
- `env-paths` adiciona `-nodejs`.
- `uuid`/`ulid` não fazem dedupe — dedupe depende de quem reenvia o mesmo id.
- Id vindo do agente precisa validação de formato.
- Comparação lexicográfica de datas quebra se algum timestamp tiver offset em vez de `Z`.

### Perguntas em aberto para o usuário
1. Só Linux/XDG ou também macOS/Windows?
2. Quem gera o `id`: agente (idempotência) ou servidor?
3. Ordenação temporal do `id` importa?
