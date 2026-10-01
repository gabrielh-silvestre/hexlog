import { describe, expect, test } from '@jest/globals';
import { median } from 'es-toolkit';
import { createSearchIndex } from '../../src/adapters/search.ts';
import { writeRecordsCorpus } from '../fixtures/records-corpus.ts';
import { createTempDir } from '../helpers.ts';

const SIZE = 10_000;
const ROUNDS = 5;

describe('M13', () => {
  test(`orçamento: índice + busca ≤ 500 ms (mediana de ${ROUNDS}, ${SIZE} registros em memória)`, () => {
    // `writeRecordsCorpus` grava no disco para os outros specs; aqui só `records` importa e a
    // medição não lê nada de volta.
    const { records } = writeRecordsCorpus(createTempDir('search-budget'), {
      recordsPerProcess: SIZE,
    });
    const index = createSearchIndex();

    const times = Array.from({ length: ROUNDS }, () => {
      const start = performance.now();
      const ids = index.search(records, 'webhook');
      const elapsed = performance.now() - start;
      expect(ids.length).toBeGreaterThan(0);
      return elapsed;
    });

    process.stdout.write(`M13 median index (build+query): ${median(times).toFixed(2)} ms\n`);
    expect(median(times)).toBeLessThanOrEqual(500);
    expect(Math.max(...times)).toBeLessThanOrEqual(2000);
  }, 60_000);
});
