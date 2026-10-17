import { beforeAll, describe, expect, it } from '@jest/globals';
import { median } from 'es-toolkit';
import type { Gate } from '../../src/domain/definitions.ts';
import { writeRecordsCorpus } from '../fixtures/records-corpus.ts';
import { createTempDir } from '../helpers.ts';
import { diskQueryService } from './query-setup.ts';

const PROCESSES = 10;
const PER_PROCESS = 500;
const ROUNDS = 5;
// P7: projeto de 10 processos somando 5.000 registros de ~1,2 KB, tempo da chamada inteira
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

// Os dois `describe` leem o mesmo corpus; `require-top-level-describe` não deixa o hook fora deles.
function writeCorpus() {
  dataDir = createTempDir('project-budget');
  const processes = Array.from({ length: PROCESSES }, (_, index) => `proc-${index + 1}`);
  const { refs } = writeRecordsCorpus(dataDir, {
    processes,
    recordsPerProcess: PER_PROCESS,
    gates: [WIDE_GATE],
  });
  project = refs[0]!.project;
  first = refs[0]!.process;
}

const service = () => diskQueryService(dataDir);

function time(call: (queries: ReturnType<typeof service>) => void): number {
  const queries = service();
  const start = performance.now();
  call(queries);
  return performance.now() - start;
}

function expectWithinCeiling(label: string, times: number[]): void {
  process.stdout.write(`P7 ${label} median: ${median(times).toFixed(2)} ms\n`);

  expect(median(times)).toBeLessThanOrEqual(CEILING_MS);
  expect(Math.max(...times)).toBeLessThanOrEqual(CEILING_MS * MAX_FACTOR);
}

describe('QueryService.queryRecords', () => {
  beforeAll(writeCorpus);

  it(`should query the project scope without text within ${CEILING_MS} ms (median of ${ROUNDS}, ${PROCESSES} processes, ${PROCESSES * PER_PROCESS} records) (P7)`, () => {
    const times = Array.from({ length: ROUNDS }, () =>
      time((queries) => {
        const page = queries.queryRecords({ project, scope: 'project' });

        expect(page.records.length).toBeGreaterThan(0);
        expect(Object.keys(page.marker)).toHaveLength(PROCESSES);
      }),
    );

    expectWithinCeiling('query', times);
  }, 120_000);
});

describe('QueryService.evaluateGate', () => {
  beforeAll(writeCorpus);

  it(`should evaluate a gate with a project-scope question within ${CEILING_MS} ms (median of ${ROUNDS}) (P7)`, () => {
    const times = Array.from({ length: ROUNDS }, () =>
      time((queries) => {
        const result = queries.evaluateGate({ project, process: first, gate: WIDE_GATE.name });

        expect(result.questions).toHaveLength(WIDE_GATE.questions.length);
        expect(Object.keys(result.marker)).toHaveLength(PROCESSES);
      }),
    );

    expectWithinCeiling('evaluateGate', times);
  }, 120_000);
});
