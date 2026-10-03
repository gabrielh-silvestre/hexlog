import { describe, expect, test } from '@jest/globals';
import { median } from 'es-toolkit';
import { createSearchIndex } from '../../src/adapters/search.ts';
import type { ProcessRef, SearchIndex } from '../../src/ports.ts';
import { writeRecordsCorpus } from '../fixtures/records-corpus.ts';
import { createTempDir } from '../helpers.ts';

const SIZE = 10_000;
const ROUNDS = 5;
// O teto é do corpus de ~1,2 KB por registro e vocabulário aberto, que custa ~0,2 ms de índice por
// registro (medido em 2026-10-03: ~1,85 s para 10.000); o teto de 500 ms herdado do 0.x media
// frases curtas. O SL4 da F4 (750 ms, 5.000 registros) segue aberto e mede o caminho completo,
// não este.
const MEDIAN_CEILING_MS = 4_000;
const MAX_CEILING_MS = 7_000;
// Busca repetida sobre o índice já em cache: só a consulta, sem montar nada.
const WARM_MEDIAN_CEILING_MS = 250;
const WARM_MAX_CEILING_MS = 500;
const PROCESS: ProcessRef = { project: 'proj', process: 'proc' };

describe('M13', () => {
  // `writeRecordsCorpus` grava no disco para os outros specs; aqui só `records` importa e a
  // medição não lê nada de volta.
  const { records } = writeRecordsCorpus(createTempDir('search-budget'), {
    recordsPerProcess: SIZE,
  });

  function timeSearch(index: SearchIndex): number {
    const start = performance.now();
    const ids = index.search(PROCESS, records, 'webhook');
    const elapsed = performance.now() - start;
    expect(ids.length).toBeGreaterThan(0);
    return elapsed;
  }

  test(`orçamento sem cache: índice + busca ≤ ${MEDIAN_CEILING_MS} ms (mediana de ${ROUNDS}, ${SIZE} registros em memória)`, () => {
    const times = Array.from({ length: ROUNDS }, () => timeSearch(createSearchIndex()));

    process.stdout.write(`M13 median index (build+query): ${median(times).toFixed(2)} ms\n`);
    expect(median(times)).toBeLessThanOrEqual(MEDIAN_CEILING_MS);
    expect(Math.max(...times)).toBeLessThanOrEqual(MAX_CEILING_MS);
  }, 60_000);

  test(`orçamento com cache: busca repetida ≤ ${WARM_MEDIAN_CEILING_MS} ms (mediana de ${ROUNDS}, ${SIZE} registros em memória)`, () => {
    const index = createSearchIndex();
    timeSearch(index);

    const times = Array.from({ length: ROUNDS }, () => timeSearch(index));

    process.stdout.write(`M13 median cached query: ${median(times).toFixed(2)} ms\n`);
    expect(median(times)).toBeLessThanOrEqual(WARM_MEDIAN_CEILING_MS);
    expect(Math.max(...times)).toBeLessThanOrEqual(WARM_MAX_CEILING_MS);
  }, 60_000);
});
