import { beforeAll, describe, expect, it } from '@jest/globals';
import { median } from 'es-toolkit';
import type { Gate } from '../../src/domain/definitions.ts';
import { writeRecordsCorpus } from '../fixtures/records-corpus.ts';
import { at, createTempDir } from '../helpers.ts';
import { diskQueryService } from './query-setup.ts';

const PROCESSES = 10;
const PER_PROCESS = 500;
const ROUNDS = 5;
// Projeto de 10 processos somando 5.000 registros de ~1,2 KB, tempo da chamada inteira
// (leitura e verificação dos 10 processos, vigência e a primeira página ou a avaliação do gate).
const CEILING_MS = 500;
const MAX_FACTOR = 2;

// Uma pergunta de cada família que precisa de relações: todas leem o projeto inteiro.
const WIDE_GATE: Gate = {
  name: 'wide',
  questions: [
    { kind: 'approved', of: { type: 'verdict' }, scope: 'project' },
    { kind: 'occurred', select: { type: 'milestone' }, min: 3, scope: 'project' },
    {
      kind: 'no_pending',
      pending: { type: 'decision' },
      resolvedBy: { kind: 'answers' },
      scope: 'project',
    },
    { kind: 'no_open_contradiction', scope: 'project' },
  ],
};

let dataDir: string;
let project: string;
let first: string;

function writeCorpus() {
  dataDir = createTempDir('project-budget');
  const processes = Array.from({ length: PROCESSES }, (_, index) => `proc-${index + 1}`);
  const { refs } = writeRecordsCorpus(dataDir, {
    processes,
    recordsPerProcess: PER_PROCESS,
    gates: [WIDE_GATE],
  });
  project = at(refs, 0).project;
  first = at(refs, 0).process;
}

const service = () => diskQueryService(dataDir);

/** Mede `call` sobre um serviço novo; as asserções sobre o retorno ficam fora do trecho cronometrado. */
function time<T>(call: (queries: ReturnType<typeof service>) => T): { ms: number; result: T } {
  const queries = service();
  const start = performance.now();
  const result = call(queries);
  return { ms: performance.now() - start, result };
}

function expectWithinCeiling(label: string, times: number[]): void {
  process.stdout.write(`${label} median: ${median(times).toFixed(2)} ms\n`);

  expect(median(times)).toBeLessThanOrEqual(CEILING_MS);
  expect(Math.max(...times)).toBeLessThanOrEqual(CEILING_MS * MAX_FACTOR);
}

describe('QueryService.queryRecords', () => {
  beforeAll(writeCorpus);

  it(`should query the project scope without text within ${CEILING_MS} ms (median of ${ROUNDS}, ${PROCESSES} processes, ${PROCESSES * PER_PROCESS} records)`, () => {
    const runs = Array.from({ length: ROUNDS }, () =>
      time((queries) => queries.queryRecords({ project, scope: 'project' })),
    );

    for (const { result } of runs) {
      expect(result.records.length).toBeGreaterThan(0);
      expect(Object.keys(result.marker)).toHaveLength(PROCESSES);
    }
    expectWithinCeiling(
      'query',
      runs.map(({ ms }) => ms),
    );
  }, 120_000);
});

describe('QueryService.evaluateGate', () => {
  beforeAll(writeCorpus);

  it(`should evaluate a gate with a project-scope question within ${CEILING_MS} ms (median of ${ROUNDS})`, () => {
    const runs = Array.from({ length: ROUNDS }, () =>
      time((queries) => queries.evaluateGate({ project, process: first, gate: WIDE_GATE.name })),
    );

    for (const { result } of runs) {
      expect(result.questions).toHaveLength(WIDE_GATE.questions.length);
      expect(Object.keys(result.marker)).toHaveLength(PROCESSES);
    }
    expectWithinCeiling(
      'evaluateGate',
      runs.map(({ ms }) => ms),
    );
  }, 120_000);
});
