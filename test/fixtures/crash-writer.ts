// Processo filho do kill -9 (TF1, SE3b): `crash-writer.ts <dataDir> <project> <process> <run>`.
// Carrega os módulos e espera uma linha no stdin (o pai sobe os filhos adiantados, porque o
// carregamento custa ~340 ms); depois grava lotes de 10 registros, um atrás do outro, pelo
// `ProcessStore` real, sem parar. Antes de cada gravação (dentro de `decide`, com o lote montado e
// o lock na mão) imprime a `key` do lote numa linha; o pai espera essa linha, deixa passar alguns
// milissegundos e mata o filho com SIGKILL, no meio do lote.
import { createProcessStore } from '../../src/adapters/fs/process-store.ts';
import type { RawProcess } from '../../src/ports.ts';
import { verifyProcess } from '../../src/shared/loader.ts';
import { chainLine } from './chain-line.ts';

const BATCH_SIZE = 10;

const [, , dataDir, project, processName, run] = process.argv;
if (
  dataDir === undefined ||
  project === undefined ||
  processName === undefined ||
  run === undefined
) {
  throw new Error('usage: crash-writer.ts <dataDir> <project> <process> <run>');
}

/** Lote de 10 elos encadeados a partir do fim do log lido, com `batch.key` no primeiro. */
const batchLine = (raw: RawProcess, key: string): string =>
  chainLine(processName, verifyProcess(raw).end, BATCH_SIZE, {
    agent: 'crash-writer',
    text: (item) => `lote ${key} item ${item} ${'x'.repeat(200)}`,
    key,
  });

// o stdout é só o anúncio da `key`; os eventos do store (ex.: `lock-orphan-removed`) vão em JSON no stderr
const store = createProcessStore({
  dataDir,
  log: (record) => process.stderr.write(`${JSON.stringify(record)}\n`),
});

await new Promise<void>((resolve) => process.stdin.once('data', () => resolve()));

for (let batch = 0; ; batch += 1) {
  const key = `${run}-${batch}`;
  await store.write({ project, process: processName }, (raw) => {
    const line = batchLine(raw, key);
    process.stdout.write(`${key}\n`);
    return { line, result: undefined };
  });
}
