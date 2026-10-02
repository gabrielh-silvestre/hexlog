import { describe, expect, test } from '@jest/globals';
import { median } from 'es-toolkit';
import { createSearchIndex } from '../../src/adapters/search.ts';
import { writeRecordsCorpus } from '../fixtures/records-corpus.ts';
import { createTempDir } from '../helpers.ts';

const SIZE = 10_000;
const ROUNDS = 5;
// O teto é do corpus de ~1,2 KB por registro, que custa ~0,12 ms de índice por registro; o
// teto de 500 ms herdado do 0.x media frases curtas. O SL4 da F4 (750 ms, 5.000 registros)
// segue aberto e mede o caminho completo, não este.
const MEDIAN_CEILING_MS = 2_500;
const MAX_CEILING_MS = 5_000;

describe('M13', () => {
  test(`orçamento: índice + busca ≤ ${MEDIAN_CEILING_MS} ms (mediana de ${ROUNDS}, ${SIZE} registros em memória)`, () => {
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
    expect(median(times)).toBeLessThanOrEqual(MEDIAN_CEILING_MS);
    expect(Math.max(...times)).toBeLessThanOrEqual(MAX_CEILING_MS);
  }, 60_000);
});
