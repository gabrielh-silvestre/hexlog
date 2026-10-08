import { beforeAll, describe, expect, test } from '@jest/globals';
import { median } from 'es-toolkit';
import type { QueryInput } from '../../src/queries/query-service.ts';
import { writeRecordsCorpus } from '../fixtures/records-corpus.ts';
import { createTempDir } from '../helpers.ts';
import { diskQueryService } from './query-setup.ts';

const SIZE = 5_000;
const ROUNDS = 5;
// SL4: primeira página de um processo de 5.000 registros de ~1,2 KB, tempo da chamada inteira
// (leitura, verificação da cadeia e, com `text`, a busca sobre o índice em cache ou montado a frio).
const PLAIN_MEDIAN_CEILING_MS = 500;
const TEXT_MEDIAN_CEILING_MS = 750;
// Índice frio: montar o índice de 5.000 registros de ~1,2 KB custa ~1.000 ms sozinho (M13 mede
// 10.000 em ~2.000 ms), então o teto de 750 ms só se sustenta com o índice em cache. O teto frio
// foi decidido em 2026-10-02 sobre a medição de ~1.420 ms da chamada inteira (ADR 0008 (e)): folga
// de ~40%. Subiu para 3.000 ms em 2026-10-08: o runner do CI mediu 2.030 a 2.089 ms (ADR 0008,
// emenda datada de 2026-10-08).
const COLD_TEXT_MEDIAN_CEILING_MS = 3_000;
const MAX_FACTOR = 2;

describe('SL4', () => {
  let dataDir: string;
  let input: Pick<QueryInput, 'project' | 'process'>;

  // O corpus vai direto para o disco; cada rodada lê o processo de novo, como uma chamada real.
  beforeAll(() => {
    dataDir = createTempDir('query-budget');
    const { refs } = writeRecordsCorpus(dataDir, { recordsPerProcess: SIZE });
    input = { project: refs[0]!.project, process: refs[0]!.process };
  });

  // Índice novo por chamada: o cache de `search` não pode esconder o custo de montar o índice.
  const service = () => diskQueryService(dataDir);

  function timeFirstPage(extra: Partial<QueryInput>, queries = service()): number {
    const start = performance.now();
    const page = queries.queryRecords({ ...input, ...extra });
    const elapsed = performance.now() - start;
    expect(page.records.length).toBeGreaterThan(0);
    return elapsed;
  }

  test(`primeira página sem text ≤ ${PLAIN_MEDIAN_CEILING_MS} ms (mediana de ${ROUNDS}, ${SIZE} registros)`, () => {
    const times = Array.from({ length: ROUNDS }, () => timeFirstPage({}));

    process.stdout.write(`SL4 median first page: ${median(times).toFixed(2)} ms\n`);
    expect(median(times)).toBeLessThanOrEqual(PLAIN_MEDIAN_CEILING_MS);
    expect(Math.max(...times)).toBeLessThanOrEqual(PLAIN_MEDIAN_CEILING_MS * MAX_FACTOR);
  }, 120_000);

  test(`primeira página com text ≤ ${TEXT_MEDIAN_CEILING_MS} ms com o índice já em cache (mediana de ${ROUNDS})`, () => {
    const queries = service();
    timeFirstPage({ text: 'webhook' }, queries);
    const times = Array.from({ length: ROUNDS }, () => timeFirstPage({ text: 'webhook' }, queries));

    process.stdout.write(`SL4 median first page with text, warm: ${median(times).toFixed(2)} ms\n`);
    expect(median(times)).toBeLessThanOrEqual(TEXT_MEDIAN_CEILING_MS);
    expect(Math.max(...times)).toBeLessThanOrEqual(TEXT_MEDIAN_CEILING_MS * MAX_FACTOR);
  }, 120_000);

  test(`primeira página com text e índice frio ≤ ${COLD_TEXT_MEDIAN_CEILING_MS} ms (mediana de ${ROUNDS}, índice novo a cada chamada)`, () => {
    const times = Array.from({ length: ROUNDS }, () => timeFirstPage({ text: 'webhook' }));

    process.stdout.write(`SL4 median first page with text, cold: ${median(times).toFixed(2)} ms\n`);
    expect(median(times)).toBeLessThanOrEqual(COLD_TEXT_MEDIAN_CEILING_MS);
    expect(Math.max(...times)).toBeLessThanOrEqual(COLD_TEXT_MEDIAN_CEILING_MS * MAX_FACTOR);
  }, 120_000);
});
