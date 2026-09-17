## Frente: Append-only JSONL com lock multi-processo

### Perguntas respondidas
- **Seção crítica:** ler último hash/seq + dedupe por id + calcular `prevHash` + escrever = uma única seção crítica (padrão `withLock` da POC: `core.poc-motor-log/src/adapters/fs/appendlog.ts:119-129`, `poc/src/append.ts:23-49`). Lock só no `write` deixaria dois escritores com o mesmo `prevHash`.
- **Melhor forma em Node 24:** `fs.mkdirSync` atômico como mutex + arquivo `owner` com token (fencing) + `mtime` para lock órfão. Zero deps, validado na POC (`poc/test/append.spec.ts:140-230`) e no probe abaixo.
- **SQLite (contraponto):** `node:sqlite`/`better-sqlite3` dariam lock, `UNIQUE(id)` e seq de graça; custam formato binário opaco (sem `tail -f`/grep) e o ganho do WAL não se aplica.
- **Lock morto / crash / linha parcial:** `mtime` do diretório de lock + limiar (POC: 10 s prod, 50 ms teste); linha parcial detectada na leitura (falha de `JSON.parse`/sem `\n` final) → `.rejected.jsonl`, responsabilidade de `lerLog` (`append.ts:52-56`).
- **WSL2:** `~/.local/share` é ext4 (`df -T`); garantias valem. **Não** valem em `/mnt/c` (DrvFs/9p).

### Candidatos
| Candidato | Versão / release | Licença | Manutenção | Node 24/TS/ESM | Deps | Encaixe | Veredito |
|---|---|---|---|---|---|---|---|
| **mkdir + token + stale (nativo)** | stdlib | — | POC testada | nativo | 0 | seção crítica completa; probe íntegro | **Adotar** |
| proper-lockfile | 4.1.2 (2022-06-24) | MIT | último commit de código 2021-01-25; issue #121 (2025-09-20) "race condition with stale locks?" | CJS+ESM | graceful-fs, retry, signal-exit | só mutex | Descartar |
| lockfile (isaacs) | 1.0.4 (2022-06-19) | ISC | superado | CJS | signal-exit | só mutex | Descartar |
| fs-ext (flock) | 2.1.1 (2024-11-04) | — | só dependabot | addon C (node-gyp) | nan | exige compilação | Descartar |
| os-lock | 2.0.0 (2022-05-12) | MIT | 2 stars | addon C | 0 | idem | Descartar |
| write-file-atomic | 8.0.0 (2026-09-09) | ISC | ativo | ESM/CJS | signal-exit | replace, não append | Não se aplica |
| better-sqlite3 | 13.0.3 (2026-08-05) | MIT | ativo | nativo | node-addon-api | binário opaco | Contraponto |
| node:sqlite | builtin 24.18.1 | — | Stability 1.2 Release candidate desde v24.15.0 | sem flag | 0 | idem, ainda RC | Contraponto |

### Decisão recomendada
- **Lock + append: Nativo** (mkdir + token + mtime), desenho da POC.
- **Dedupe/seq sob lock: Construir** reaproveitando o padrão de `appendEvento`.
- **SQLite: não adotar** (JSONL é decisão do usuário).

### Evidência
- `npm view` para proper-lockfile, lockfile, fs-ext, write-file-atomic, better-sqlite3, os-lock.
- GitHub: moxystudio/node-proper-lockfile último commit real 2021-01-25; baudehlo/node-fs-ext só dependabot 2026-08.
- `node -e "require('node:sqlite')"` OK sem flag; nodejs.org/docs/latest-v24.x/api/sqlite.html → Stability 1.2 RC.
- **Probe 1 (C1):** 4 processos `fork`, cada um gravando os mesmos 200 ids → `{"elapsedMs":1561,"totalLines":200,"uniqueIdsFound":200,"duplicateIds":0,"seqMonotonicNoGaps":true,"chainIntact":true,"writersByPid":4}`. Código em `scratchpad/jsonl-lock/{lock,worker,main}.mjs`.
- **Probe 2 (escala):** 4 processos × 2.500 ids distintos = 10.000 appends, reread completo + fsync por escrita → `elapsedMs: 180931`, `avgMsPerAppend: 18.09`.

### Riscos e armadilhas
- Reread completo por append é O(n): ok até ~10k linhas (medido). Upgrade futuro: sidecar de tail/índice (`ponytail:`).
- Staleness por `mtime` assume clock local e FS POSIX local — nunca `/mnt/c`.
- `fsync` por escrita: custo aceitável para dezenas de eventos/min.
- Linha parcial: isolar em `.rejected.jsonl` sem quebrar a cadeia.

### Perguntas em aberto
Nenhuma.
