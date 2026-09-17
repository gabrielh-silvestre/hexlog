## Frente: Libs de event sourcing em TypeScript

### Perguntas respondidas
Nenhuma lib de ES em TS ativa oferece armazenamento em arquivo JSONL local com escrita multi-processo e cadeia de hash por evento — todas assumem backend externo (Postgres/EventStoreDB/MongoDB/DynamoDB) ou, no máximo, SQLite. Todas forçam vocabulário de agregado/stream/comando. Recomendação: construir o núcleo e usar o padrão Decider (decide/evolve) sem lib, como a POC já faz.

### Candidatos
| Candidato | Versão / release | Licença | Manutenção | ESM/TS/Node 24 | Deps | Encaixe | Veredito |
|---|---|---|---|---|---|---|---|
| `@event-driven-io/emmett` | 0.42.4 (2026-08-12); 0.43.0-beta.45 (2026-09-15) | não verificado | 538★, 26 issues, push 2026-09-15 | `type: module`, TS; sem `engines` | stores via subpacotes (PostgreSQL, EventStoreDB, MongoDB, SQLite, In-Memory) | Sem store de arquivo; modelo aggregate/stream/CommandHandler | Não adotar a lib; usar o padrão |
| `@ocoda/event-sourcing` | 3.0.0 (2026-04-17) | MIT | 269★, push 2026-08-07 | peerDeps NestJS ^11, rxjs, reflect-metadata | Nest completo | — | Não adotar |
| `@castore/core` | 2.4.2 (2025-04-18) | MIT | repo ativo (2026-08-30), npm parado | TS; `@babel/runtime`, `ts-toolbelt` | stores DynamoDB + in-memory | — | Não adotar |
| `@rotorsoft/eventually` | 5.8.10 (2024-12-20) | MIT | estagnado | depende de `zod ^3.23.8` (incompatível com zod 4.6.5) | framework completo | — | Descartar |
| `evtstore` | 12.0.1 (2023-01-27) | MIT | abandonado | — | — | — | Descartar |
| `eventstore` (adrai) | 1.15.5 (2024-02-05) | não verificado | deps antigas, exige backend | CJS | — | — | Descartar |
| `wolkenkit-eventstore` | 2.6.2 (2024-10-18) | **AGPL-3.0** | — | pg+mysql2+mongodb+tedious | — | — | Descartar |
| `sourced` | 4.0.7 (2022-11-18) | MIT | parado | — | — | não é ES persistente | Descartar |
| `@nestjs/cqrs` | 12.0.0 (2026-08-27) | MIT | ativo | — | — | CQRS do Nest, não event store | Fora de escopo |

### Decisão recomendada
- **Store JSONL + hash chain + lock multi-processo: Construir.**
- **Projeção do Estado: padrão Decider sem lib** (`evolve` puro + `reduce`). Fonte: https://event-driven-io.github.io/emmett/getting-started.html (Business logic and decisions; `DeciderSpecification`).

```ts
function evolve(estado: Estado, evento: Evento): Estado {
  switch (evento.tipo) {
    case 'marco':    return aplicarMarco(estado, evento);
    case 'veredito': return aplicarVeredito(estado, evento);
    default:         return estado; // tipos custom são inertes no Estado
  }
}
const estado = eventos.reduce(evolve, estadoInicial);
const marcoGate = avaliarGate(estado); // gates leem o Estado → Marco
```

- **Validação de schema custom:** `parse` antes do append; nenhuma lib de ES agrega valor.
- **Fold genérico / expiração temporal (órfãos):** confirmado que não vale lib — comparação de datas sobre o Estado.

### Evidência
- `npm view @event-driven-io/emmett version time.modified ...` → 0.42.4, modified 2026-09-15; `type: module`, sem `engines`.
- `npm view @event-driven-io/emmett-filesystem` → 404.
- GitHub `repo:event-driven-io/emmett` → 538★, push 2026-09-15.
- `npm view @castore/core` → modified 2025-04-18; repo push 2026-08-30.
- `npm view @rotorsoft/eventually dependencies` → `zod ^3.23.8`.
- `npm view @ocoda/event-sourcing peerDependencies` → NestJS ^11.
- `npm view wolkenkit-eventstore license` → AGPL-3.0.

### Riscos e armadilhas
- Nenhuma lib resolve lock multi-processo (frente JSONL).
- Adotar emmett exigiria traduzir Marco/Veredito para aggregate/command/stream e escrever o store à mão de qualquer forma.

### Perguntas em aberto
Nenhuma.
