import { beforeAll, describe, expect, it } from '@jest/globals';
import fs from 'node:fs';
import { isUndefined } from 'es-toolkit';
import { processPaths } from '../../src/adapters/fs/data-format.ts';
import { createProcessStore } from '../../src/adapters/fs/process-store.ts';
import type { ProcessRef } from '../../src/ports.ts';
import { createTempDir } from '../helpers.ts';
import { writeRecordsCorpus } from '../fixtures/records-corpus.ts';

const MIB = 1024 * 1024;
// o registro do corpus pesa ~1.205 bytes na linha: 25.000 registros dão ~28,7 MiB
const RECORDS = 25_000;
const RUNS = 5;
const BUDGET_MS = 150;

describe('createProcessStore', () => {
  let dataDir: string;
  let ref: ProcessRef;

  beforeAll(() => {
    dataDir = createTempDir('process-store-budget');
    const {
      refs: [first],
    } = writeRecordsCorpus(dataDir, { recordsPerProcess: RECORDS });
    if (isUndefined(first)) throw new Error('corpus without process');
    ref = first;
  }, 60_000);

  /** Mínimo de `RUNS` leituras do processo, depois de 1 aquecimento. */
  function minReadMs(onLoad?: () => void): number {
    const store = createProcessStore({ dataDir, log: () => undefined, onLoad });
    store.read(ref);

    const times = Array.from({ length: RUNS }, () => {
      const start = performance.now();
      store.read(ref);
      return performance.now() - start;
    });

    return Math.min(...times);
  }

  it('should read a ~30 MiB log with onLoad no more than 150 ms slower than without it (minimum of 5, after 1 warm-up)', () => {
    const bytes = fs.statSync(processPaths(dataDir, ref).log).size;

    expect(bytes).toBeGreaterThanOrEqual(24 * MIB);
    expect(bytes).toBeLessThanOrEqual(40 * MIB);

    const withoutMin = minReadMs();
    const withMin = minReadMs(() => undefined);

    process.stdout.write(
      `min read without onLoad: ${withoutMin.toFixed(2)} ms; with onLoad: ${withMin.toFixed(2)} ms; diff: ${(withMin - withoutMin).toFixed(2)} ms\n`,
    );

    // o teto pega a contagem que interpreta os registros em vez de contar linhas (centenas de ms em 30 MiB); não é para micro-regressão
    expect(withMin - withoutMin).toBeLessThanOrEqual(BUDGET_MS);
  }, 60_000);
});
