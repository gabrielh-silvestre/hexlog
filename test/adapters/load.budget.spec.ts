import { describe, expect, test } from '@jest/globals';
import { createProcessStore } from '../../src/adapters/fs/process-store.ts';
import { loadVerified } from '../../src/shared/loader.ts';
import { createTempDir } from '../helpers.ts';
import { writeRecordsCorpus } from '../fixtures/records-corpus.ts';

const SIZE = 5_000;
const RUNS = 5;
const BUDGET_MS = 500;

describe('TF6', () => {
  test('orçamento: carregar e verificar 5.000 registros ≤ 500 ms (mínimo de 5, depois de 1 aquecimento)', () => {
    const dataDir = createTempDir('load-budget');
    const {
      refs: [ref],
      records,
    } = writeRecordsCorpus(dataDir, { recordsPerProcess: SIZE });
    if (ref === undefined) throw new Error('corpus without process');
    const store = createProcessStore({ dataDir, log: () => undefined });

    loadVerified(store, ref);
    const times = Array.from({ length: RUNS }, () => {
      const start = performance.now();
      const verified = loadVerified(store, ref);
      const elapsed = performance.now() - start;
      expect(verified.chain.ok).toBe(true);
      expect(verified.records).toEqual(records);
      return elapsed;
    });

    const loadMin = Math.min(...times);
    process.stdout.write(`TF6 min load+verify (${SIZE} records): ${loadMin.toFixed(2)} ms\n`);
    expect(loadMin).toBeLessThanOrEqual(BUDGET_MS);
  }, 60_000);
});
