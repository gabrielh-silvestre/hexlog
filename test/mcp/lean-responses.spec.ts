import { afterEach, beforeEach, describe, expect, test } from '@jest/globals';
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

beforeEach(async () => {
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
});

afterEach(async () => {
  await environment.close();
});

const registerNotes = (texts: string[], target = 'run.step') =>
  environment.ok<RegisterResult>('register', {
    project: PROJECT,
    process: PROCESS,
    agent: 'executor',
    records: texts.map((text) => ({ type: 'note', target, data: { text } })),
  });

const evaluate = <T = GateEvaluation>(args: Record<string, unknown>) =>
  environment.ok<T>('evaluate_gate', { project: PROJECT, process: PROCESS, ...args });

describe('evaluate_gate: lean responses', () => {
  test('evaluate_gate defaults to failing: an approved gate answers with counts and no ids', async () => {
    await registerNotes(['olá']);

    const result = await evaluate({ gate: 'has-note' });

    expect(result.passed).toBe(true);
    expect(result.questions).toEqual([
      { index: 0, kind: 'occurred', passed: true, counts: { found: 1 } },
    ]);
  });

  test('evaluate_gate failing returns the ids of what blocks the gate', async () => {
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

  test('evaluate_gate evidence full matches the service default byte for byte', async () => {
    await registerNotes(['proposta']);
    const input = { project: PROJECT, process: PROCESS, gate: 'proposed-approved' } as const;

    const viaTool = await evaluate({ gate: input.gate, evidence: 'full' });

    const viaService = compose({
      dataDir: environment.dataDir,
      cwd: process.cwd(),
      clock: () => new Date('2026-01-01T00:00:00.000Z'),
      logger: () => undefined,
    }).services.query.evaluateGate(input);
    expect(JSON.stringify(viaTool)).toBe(JSON.stringify(viaService));
  });

  test('evaluate_gate evidence counts returns counts only', async () => {
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

  test('evaluate_gate targets returns one result per target and one marker', async () => {
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

  test('evaluate_gate target keeps the single-target shape', async () => {
    await registerNotes(['olá'], 'a.step');

    const result = await evaluate({ gate: 'has-note', target: 'a' });

    expect(result).toMatchObject({ passed: true, questions: [expect.any(Object)] });
    expect(result).not.toHaveProperty('results');
  });

  test('evaluate_gate refuses target with targets, an empty targets list, more than 50 targets and evidence full with targets', async () => {
    const call = (extra: Record<string, unknown>) =>
      environment.call('evaluate_gate', {
        project: PROJECT,
        process: PROCESS,
        gate: 'has-note',
        ...extra,
      });
    const tooMany = Array.from({ length: BATCH_MAX + 1 }, (_, i) => `t${i}`);

    const withTarget = expectError(await call({ target: 'a', targets: ['a'] }), 'INVALID_INPUT');
    const empty = expectError(await call({ targets: [] }), 'INVALID_INPUT');
    const many = expectError(await call({ targets: tooMany }), 'INVALID_INPUT');
    const full = expectError(await call({ targets: ['a'], evidence: 'full' }), 'INVALID_INPUT');

    expect(withTarget.details).toEqual([
      expect.objectContaining({ path: '/targets', code: 'with-target' }),
    ]);
    expect(empty.details).toEqual([expect.objectContaining({ path: '/targets' })]);
    expect(many.details).toEqual([expect.objectContaining({ path: '/targets' })]);
    expect(full.details).toEqual([
      expect.objectContaining({ path: '/evidence', code: 'full-with-targets' }),
    ]);
  });

  test('evaluate_gate caps a failing evidence list at EVIDENCE_ITEMS_CAP and reports omitted', async () => {
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

  test('evaluate_gate caps each batch target evidence list at EVIDENCE_ITEMS_CAP and reports omitted', async () => {
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

describe('query: lean responses', () => {
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

  test('query defaults to relation counts', async () => {
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

  test('query relations full matches the service default byte for byte', async () => {
    await registerDerived(2);

    const viaTool = await query({ relations: 'full' });

    const viaService = compose({
      dataDir: environment.dataDir,
      cwd: process.cwd(),
      clock: () => new Date('2026-01-01T00:00:00.000Z'),
      logger: () => undefined,
    }).services.query.queryRecords({ project: PROJECT, process: PROCESS });
    expect(JSON.stringify(viaTool)).toBe(JSON.stringify(viaService));
  });

  test('query relations none drops the relation fields', async () => {
    await registerDerived(1);

    const { records } = await query({ relations: 'none' });

    for (const record of records) {
      expect(Object.keys(record)).toEqual(
        expect.not.arrayContaining(['in', 'out', 'inCounts', 'outCounts']),
      );
    }
  });

  test('query with fields [] and counts stays small and fits more records per page', async () => {
    await registerDerived(BATCH_MAX * 5);
    const input = { fields: [], limit: 100 };

    const full = await query({ ...input, relations: 'full' });
    const counts = await query(input);

    expect(counts.records.length).toBeGreaterThan(full.records.length);
    expect(JSON.stringify(counts).length).toBeLessThan(JSON.stringify(full).length);
  });

  test('query refuses an unknown relations value', async () => {
    const result = await environment.call('query', {
      project: PROJECT,
      process: PROCESS,
      relations: 'all',
    });

    const body = expectError(result, 'INVALID_INPUT');
    expect(body.details).toEqual([expect.objectContaining({ path: '/relations' })]);
  });
});
