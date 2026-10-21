import { afterEach, beforeEach, describe, expect, it } from '@jest/globals';
import { compose } from '../../src/compose.ts';
import { BATCH_MAX } from '../../src/domain/record.ts';
import type { RegisterResult } from '../../src/commands/process.ts';
import { EVIDENCE_ITEMS_CAP } from '../../src/mcp/tools/query.ts';
import type {
  GateBatchEvaluation,
  GateEvaluation,
  QueryResult,
} from '../../src/queries/query-service.ts';
import { type Environment, createEnvironment, expectError } from './environment.ts';

const PROJECT = 'alpha';
const PROCESS = 'run-1';
const NOTE = {
  type: 'object',
  properties: { text: { type: 'string' } },
  required: ['text'],
  additionalProperties: false,
};

let environment: Environment;

// Cada describe de topo liga estas funções aos hooks: `jest/require-top-level-describe` barra hook fora de describe.
const openEnvironment = async () => {
  environment = await createEnvironment();
  await environment.ok('define_type', { project: PROJECT, name: 'note', schema: NOTE });
  await environment.ok('define_gate', {
    project: PROJECT,
    name: 'has-note',
    questions: [{ kind: 'occurred', select: { type: 'note' } }],
  });
  await environment.ok('define_gate', {
    project: PROJECT,
    name: 'proposed-approved',
    questions: [{ kind: 'approved', of: { type: 'note', where: { text: 'proposta' } } }],
  });
  await environment.ok('create_process', { project: PROJECT, process: PROCESS });
};

const closeEnvironment = async () => {
  await environment.close();
};

const registerNotes = (texts: string[], target = 'run.step') =>
  environment.ok<RegisterResult>('register', {
    project: PROJECT,
    process: PROCESS,
    agent: 'executor',
    records: texts.map((text) => ({ type: 'note', target, data: { text } })),
  });

const evaluate = <T = GateEvaluation>(args: Record<string, unknown>) =>
  environment.ok<T>('evaluate_gate', { project: PROJECT, process: PROCESS, ...args });

describe('evaluate_gate', () => {
  beforeEach(openEnvironment);
  afterEach(closeEnvironment);

  it('should answer a passing gate with counts and no ids by default', async () => {
    await registerNotes(['olá']);

    const result = await evaluate({ gate: 'has-note' });

    expect(result.passed).toBe(true);
    expect(result.questions).toEqual([
      { index: 0, kind: 'occurred', passed: true, counts: { found: 1 } },
    ]);
  });

  it('should return the ids of what blocks a failing gate', async () => {
    const { records } = await registerNotes(['proposta', 'proposta', 'outra']);
    const proposed = records.slice(0, 2).map(({ id }) => id);

    const result = await evaluate({ gate: 'proposed-approved' });

    expect(result.passed).toBe(false);
    expect(result.questions).toEqual([
      {
        index: 0,
        kind: 'approved',
        passed: false,
        counts: { of: 2, supports: 0, contradictions: 0, unsupported: 2 },
        evidence: { unsupported: proposed },
      },
    ]);
  });

  it('should match the service default byte for byte with evidence full', async () => {
    await registerNotes(['proposta']);
    const input = { project: PROJECT, process: PROCESS, gate: 'proposed-approved' } as const;
    const viaService = compose({
      dataDir: environment.dataDir,
      cwd: process.cwd(),
      clock: () => new Date('2026-01-01T00:00:00.000Z'),
      logger: () => undefined,
    }).services.query.evaluateGate(input);

    const viaTool = await evaluate({ gate: input.gate, evidence: 'full' });

    expect(JSON.stringify(viaTool)).toBe(JSON.stringify(viaService));
  });

  it('should return counts only with evidence counts', async () => {
    await registerNotes(['proposta']);

    const result = await evaluate({ gate: 'proposed-approved', evidence: 'counts' });

    expect(result.questions).toEqual([
      {
        index: 0,
        kind: 'approved',
        passed: false,
        counts: { of: 1, supports: 0, contradictions: 0, unsupported: 1 },
      },
    ]);
  });

  it('should return one result per target with a single marker', async () => {
    await registerNotes(['olá'], 'a.step');

    const result = await evaluate<GateBatchEvaluation>({
      gate: 'has-note',
      targets: ['a', 'b', 'a'],
    });

    expect(result.passed).toBe(false);
    expect(result.results.map(({ target, passed }) => [target, passed])).toEqual([
      ['a', true],
      ['b', false],
      ['a', true],
    ]);
    expect(result.results[0]?.questions).toEqual([
      { index: 0, kind: 'occurred', passed: true, counts: { found: 1 } },
    ]);
    expect(result.marker).toEqual({ [PROCESS]: expect.any(String) });
    expect(result).not.toHaveProperty('questions');
  });

  it('should default targets to counts without ids', async () => {
    await registerNotes(['proposta'], 'a.step');

    const batch = await evaluate<GateBatchEvaluation>({
      gate: 'proposed-approved',
      targets: ['a'],
    });

    expect(batch.results[0]?.questions).toEqual([
      {
        index: 0,
        kind: 'approved',
        passed: false,
        counts: { of: 1, supports: 0, contradictions: 0, unsupported: 1 },
      },
    ]);
  });

  it('should return the ids of a failing target with targets and evidence failing', async () => {
    await registerNotes(['proposta'], 'a.step');

    const explicit = await evaluate<GateBatchEvaluation>({
      gate: 'proposed-approved',
      targets: ['a'],
      evidence: 'failing',
    });

    expect(explicit.results[0]?.questions[0]).toMatchObject({
      evidence: { unsupported: expect.any(Array) },
    });
  });

  it('should replay one target with the batch marker and return its ids', async () => {
    const { records } = await registerNotes(['proposta'], 'a.step');
    const batch = await evaluate<GateBatchEvaluation>({
      gate: 'proposed-approved',
      targets: ['a'],
    });
    await registerNotes(['proposta'], 'a.step');

    const replay = await evaluate({
      gate: 'proposed-approved',
      target: 'a',
      marker: batch.marker,
    });

    const proposed = records.map(({ id }) => id);

    expect(replay.questions).toEqual([
      expect.objectContaining({ evidence: { unsupported: proposed } }),
    ]);
  });

  it('should accept exactly 50 targets and answer each one', async () => {
    await registerNotes(['olá'], 't0.step');
    const targets = Array.from({ length: 50 }, (_, index) => `t${index}`);

    const result = await evaluate<GateBatchEvaluation>({ gate: 'has-note', targets });

    expect(result.results.map(({ target }) => target)).toEqual(targets);
    expect(result.results.filter(({ passed }) => passed)).toHaveLength(1);
  });

  it('should keep the single-target shape with target', async () => {
    await registerNotes(['olá'], 'a.step');

    const result = await evaluate({ gate: 'has-note', target: 'a' });

    expect(result).toMatchObject({ passed: true, questions: [expect.any(Object)] });
    expect(result).not.toHaveProperty('results');
  });

  it.each([
    {
      scenario: 'target together with targets',
      patch: { target: 'a', targets: ['a'] },
      expected: { path: '/targets', code: 'with-target' },
    },
    {
      scenario: 'an empty targets list',
      patch: { targets: [] },
      expected: { path: '/targets' },
    },
    {
      scenario: 'more than 50 targets',
      patch: { targets: Array.from({ length: BATCH_MAX + 1 }, (_, i) => `t${i}`) },
      expected: { path: '/targets' },
    },
    {
      scenario: 'evidence full with targets',
      patch: { targets: ['a'], evidence: 'full' },
      expected: { path: '/evidence', code: 'full-with-targets' },
    },
  ])('should refuse $scenario with INVALID_INPUT', async ({ patch, expected }) => {
    const result = await environment.call('evaluate_gate', {
      project: PROJECT,
      process: PROCESS,
      gate: 'has-note',
      ...patch,
    });

    const body = expectError(result, 'INVALID_INPUT');

    expect(body.details).toEqual([expect.objectContaining(expected)]);
  });

  it('should cap a failing evidence list at EVIDENCE_ITEMS_CAP and report omitted', async () => {
    const total = BATCH_MAX * 3;
    for (let batch = 0; batch < 3; batch += 1) {
      await registerNotes(Array.from({ length: BATCH_MAX }, () => 'proposta'));
    }

    const result = await evaluate<GateEvaluation & { questions: { omitted?: unknown }[] }>({
      gate: 'proposed-approved',
    });

    const [question] = result.questions;

    expect(question).toMatchObject({
      passed: false,
      counts: { of: total, unsupported: total },
      omitted: { unsupported: total - EVIDENCE_ITEMS_CAP },
    });
    expect(question?.evidence).toHaveProperty('unsupported.length', EVIDENCE_ITEMS_CAP);
  });

  it('should cap every list of a full evidence at EVIDENCE_ITEMS_CAP and report omitted', async () => {
    const total = BATCH_MAX * 3;
    for (let batch = 0; batch < 3; batch += 1) {
      await registerNotes(Array.from({ length: BATCH_MAX }, () => 'proposta'));
    }

    const result = await evaluate<GateEvaluation & { questions: { omitted?: unknown }[] }>({
      gate: 'proposed-approved',
      evidence: 'full',
    });

    const [question] = result.questions;

    expect(question).toMatchObject({
      passed: false,
      omitted: { of: total - EVIDENCE_ITEMS_CAP, unsupported: total - EVIDENCE_ITEMS_CAP },
    });
    expect(question?.evidence).toMatchObject({
      of: { length: EVIDENCE_ITEMS_CAP },
      unsupported: { length: EVIDENCE_ITEMS_CAP },
      supports: [],
      contradictions: [],
    });
  });

  it('should cap each batch target evidence list at EVIDENCE_ITEMS_CAP and report omitted', async () => {
    const total = BATCH_MAX * 3;
    for (let batch = 0; batch < 3; batch += 1) {
      await registerNotes(Array.from({ length: BATCH_MAX }, () => 'proposta'));
    }

    const result = await evaluate<GateBatchEvaluation>({
      gate: 'proposed-approved',
      targets: ['run.step'],
      evidence: 'failing',
    });

    const [question] = result.results[0]!.questions as {
      omitted?: unknown;
      evidence?: { unsupported: unknown[] };
    }[];

    expect(question).toMatchObject({ omitted: { unsupported: total - EVIDENCE_ITEMS_CAP } });
    expect(question?.evidence?.unsupported).toHaveLength(EVIDENCE_ITEMS_CAP);
  });
});

describe('query', () => {
  beforeEach(openEnvironment);
  afterEach(closeEnvironment);

  const query = (args: Record<string, unknown> = {}) =>
    environment.ok<QueryResult>('query', { project: PROJECT, process: PROCESS, ...args });

  /** Uma nota alvo e `count` notas que derivam dela, em lotes de `BATCH_MAX`. */
  async function registerDerived(count: number) {
    const { records } = await registerNotes(['alvo']);
    const targetId = records[0]!.id;
    for (let done = 0; done < count; done += BATCH_MAX) {
      await environment.ok('register', {
        project: PROJECT,
        process: PROCESS,
        agent: 'executor',
        records: Array.from({ length: Math.min(BATCH_MAX, count - done) }, () => ({
          type: 'note',
          target: 'run.derived',
          data: { text: 'x' },
          relations: [{ to: targetId, kind: 'derivesFrom' }],
        })),
      });
    }
    return targetId;
  }

  it('should default to relation counts', async () => {
    const targetId = await registerDerived(1);

    const { records } = await query();

    const target = records.find(({ id }) => id === targetId);
    const derived = records.find(({ id }) => id !== targetId);

    expect(target).toMatchObject({ inCounts: { derivesFrom: 1 } });
    expect(derived).toMatchObject({ outCounts: { derivesFrom: 1 } });

    for (const record of records) {
      expect(Object.keys(record)).toEqual(expect.not.arrayContaining(['in', 'out']));
    }
  });

  it('should match the service default byte for byte with relations full', async () => {
    await registerDerived(2);
    const viaService = compose({
      dataDir: environment.dataDir,
      cwd: process.cwd(),
      clock: () => new Date('2026-01-01T00:00:00.000Z'),
      logger: () => undefined,
    }).services.query.queryRecords({ project: PROJECT, process: PROCESS });

    const viaTool = await query({ relations: 'full' });

    expect(JSON.stringify(viaTool)).toBe(JSON.stringify(viaService));
  });

  it('should drop the relation fields with relations none', async () => {
    await registerDerived(1);

    const { records } = await query({ relations: 'none' });

    for (const record of records) {
      expect(Object.keys(record)).toEqual(
        expect.not.arrayContaining(['in', 'out', 'inCounts', 'outCounts']),
      );
    }
  });

  it('should fit more records in a smaller page with fields [] and counts than with full relations', async () => {
    await registerDerived(BATCH_MAX * 5);
    const input = { fields: [], limit: 100 };
    const full = await query({ ...input, relations: 'full' });

    const counts = await query(input);

    expect(counts.records.length).toBeGreaterThan(full.records.length);
    expect(JSON.stringify(counts).length).toBeLessThan(JSON.stringify(full).length);
  });

  it('should refuse an unknown relations value with INVALID_INPUT', async () => {
    const result = await environment.call('query', {
      project: PROJECT,
      process: PROCESS,
      relations: 'all',
    });

    const body = expectError(result, 'INVALID_INPUT');

    expect(body.details).toEqual([expect.objectContaining({ path: '/relations' })]);
  });
});
