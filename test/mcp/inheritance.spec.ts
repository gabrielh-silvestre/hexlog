import { afterEach, beforeEach, describe, expect, test } from '@jest/globals';
import type { RegisterResult } from '../../src/commands/process.ts';
import type { GateEvaluation, QueryResult } from '../../src/queries/query-service.ts';
import { at } from '../helpers.ts';
import { type Environment, createEnvironment } from './environment.ts';

const PROJECT = 'alpha';
const NOTE = {
  type: 'object',
  properties: { text: { type: 'string' } },
  required: ['text'],
  additionalProperties: false,
};
const GATE = {
  name: 'unit-approved',
  questions: [
    {
      kind: 'approved',
      of: { targetPrefix: 'run.unit' },
      by: { targetPrefix: 'run.ev' },
      inherit: true,
    },
  ],
};

let environment: Environment;
let unit: string;
let evidence: string;
let revised: string;

const register = async (target: string, relations: object[] = []) => {
  const { records } = await environment.ok<RegisterResult>('register', {
    project: PROJECT,
    process: 'run-1',
    agent: 'executor',
    records: [{ type: 'note', target, data: { text: 'x' }, relations }],
  });
  return at(records, 0).id;
};

// run-1: a evidência apoia a unidade, que é superada por uma versão sem relações.
beforeEach(async () => {
  environment = await createEnvironment();
  await environment.ok('define_type', { project: PROJECT, name: 'note', schema: NOTE });
  await environment.ok('define_gate', { project: PROJECT, ...GATE });
  await environment.ok('create_process', { project: PROJECT, process: 'run-1' });
  unit = await register('run.unit');
  evidence = await register('run.ev', [{ to: unit, kind: 'supports' }]);
  revised = await register('run.unit', [{ to: unit, kind: 'supersedes' }]);
});

afterEach(async () => {
  await environment.close();
});

const query = (args: Record<string, unknown>) =>
  environment.ok<QueryResult>('query', {
    project: PROJECT,
    process: 'run-1',
    ids: [revised],
    ...args,
  });

describe('query tool: inherited relations', () => {
  test('the default mode counts the inherited edges', async () => {
    const page = await query({});

    expect(at(page.records, 0)).toMatchObject({ inheritedInCounts: { supports: 1 } });
    expect(at(page.records, 0)).not.toHaveProperty('inheritedIn');
  });

  test('full lists them with the stored edge as origin and none brings nothing', async () => {
    const full = await query({ relations: 'full' });
    const none = await query({ relations: 'none' });

    expect(at(full.records, 0)).toMatchObject({
      inheritedIn: [{ kind: 'supports', from: evidence, origin: { from: evidence, to: unit } }],
    });
    expect(Object.keys(at(none.records, 0)).filter((key) => key.startsWith('inherited'))).toEqual(
      [],
    );
  });
});

describe('evaluate_gate tool: inherit', () => {
  test('counts the inherited supporter in counts mode and lists it in full mode', async () => {
    const counts = await environment.ok<GateEvaluation<{ counts?: Record<string, number> }>>(
      'evaluate_gate',
      { project: PROJECT, process: 'run-1', gate: GATE.name, evidence: 'counts' },
    );
    const full = await environment.ok<{ questions: { evidence?: { inherited?: string[] } }[] }>(
      'evaluate_gate',
      { project: PROJECT, process: 'run-1', gate: GATE.name, evidence: 'full' },
    );

    expect(counts.passed).toBe(true);
    expect(at(counts.questions, 0).counts).toMatchObject({ inherited: 1 });
    expect(at(full.questions, 0).evidence?.inherited).toEqual([evidence]);
  });
});
