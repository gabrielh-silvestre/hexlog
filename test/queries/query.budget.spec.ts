import { beforeAll, describe, expect, it } from '@jest/globals';
import { median } from 'es-toolkit';
import type { QueryInput } from '../../src/queries/query-service.ts';
import { writeRecordsCorpus } from '../fixtures/records-corpus.ts';
import { at, createTempDir } from '../helpers.ts';
import { diskQueryService } from './query-setup.ts';

const SIZE = 5_000;
const ROUNDS = 5;
// Primeira página de um processo de 5.000 registros de ~1,2 KB, tempo da chamada inteira
// (leitura, verificação da cadeia e, com `text`, a busca sobre o índice em cache ou montado a frio).
const PLAIN_MEDIAN_CEILING_MS = 500;
const TEXT_MEDIAN_CEILING_MS = 750;
// Índice frio: montar o índice de 5.000 registros de ~1,2 KB custa ~1.000 ms sozinho (o orçamento de busca mede
// 10.000 em ~2.000 ms), então o teto de 750 ms só se sustenta com o índice em cache. O teto frio
// foi decidido em 2026-10-02 sobre a medição de ~1.420 ms da chamada inteira (ADR 0008 (e)): folga
// de ~40%. Subiu para 3.000 ms em 2026-10-08: o runner do CI mediu 2.030 a 2.089 ms (ADR 0008,
// emenda datada de 2026-10-08).
const COLD_TEXT_MEDIAN_CEILING_MS = 3_000;
const MAX_FACTOR = 2;

describe('QueryService.queryRecords', () => {
  let dataDir: string;
  let input: Pick<QueryInput, 'project' | 'process'>;

  // O corpus vai direto para o disco; cada rodada lê o processo de novo, como uma chamada real.
  beforeAll(() => {
    dataDir = createTempDir('query-budget');
    const { refs } = writeRecordsCorpus(dataDir, { recordsPerProcess: SIZE });
    input = { project: at(refs, 0).project, process: at(refs, 0).process };
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

  it.each([
    ['without text', {}, PLAIN_MEDIAN_CEILING_MS, false],
    ['with text and the index already cached', { text: 'webhook' }, TEXT_MEDIAN_CEILING_MS, true],
    ['with text and a cold index', { text: 'webhook' }, COLD_TEXT_MEDIAN_CEILING_MS, false],
  ])(
    `should return the first page %s within %i ms (median of ${ROUNDS}, ${SIZE} records)`,
    (label, extra, ceiling, cached) => {
      // Índice em cache: um só serviço, aquecido por uma chamada; senão, índice novo a cada chamada.
      const shared = cached ? service() : undefined;
      if (shared) timeFirstPage(extra, shared);
      const times = Array.from({ length: ROUNDS }, () => timeFirstPage(extra, shared));

      process.stdout.write(`median first page ${label}: ${median(times).toFixed(2)} ms\n`);

      expect(median(times)).toBeLessThanOrEqual(ceiling);
      expect(Math.max(...times)).toBeLessThanOrEqual(ceiling * MAX_FACTOR);
    },
    120_000,
  );

  describe('with lineage inheritance', () => {
    // Mínimo das rodadas, como em `adapters/load.budget.spec.ts`: o teto vale para a melhor medição e
    // não para o pior ruído do runner. Mesmo teto da página sem `text`: a herança liga o cálculo,
    // não o custo.
    const MIN_CEILING_MS = PLAIN_MEDIAN_CEILING_MS;

    // Os dois corpora têm os mesmos registros, com `supersedes` nos dois; só o manifesto liga a
    // herança.
    function minFirstPage(lineageInheritance: boolean) {
      const dataDir = createTempDir('query-budget-inheritance');
      const { refs } = writeRecordsCorpus(dataDir, {
        recordsPerProcess: SIZE,
        supersedes: true,
        lineageInheritance,
      });
      const input = { project: at(refs, 0).project, process: at(refs, 0).process };
      const runs = Array.from({ length: ROUNDS }, () => {
        const start = performance.now();
        const page = diskQueryService(dataDir).queryRecords(input);
        return { ms: performance.now() - start, page };
      });
      return { min: Math.min(...runs.map(({ ms }) => ms)), page: at(runs, 0).page };
    }

    it.each([
      ['on', true],
      ['off', false],
    ])(
      `should serve the first page with the inheritance %s in ≤ ${MIN_CEILING_MS} ms (minimum of ${ROUNDS}, ${SIZE} records)`,
      (label, lineageInheritance) => {
        const { min, page } = minFirstPage(lineageInheritance);

        process.stdout.write(`min first page, inheritance ${label}: ${min.toFixed(2)} ms\n`);

        // Prova que o corpus exercita a herança: sem ela ligada nenhum registro traz relação herdada.
        expect(page.records.some((record) => 'inheritedIn' in record)).toBe(lineageInheritance);
        expect(min).toBeLessThanOrEqual(MIN_CEILING_MS);
      },
      120_000,
    );
  });
});
