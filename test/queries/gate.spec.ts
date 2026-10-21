import fs from 'node:fs';
import { describe, expect, jest, test } from '@jest/globals';
import { createSearchIndex } from '../../src/adapters/search.ts';
import type { Gate } from '../../src/domain/definitions.ts';
import type { Marker } from '../../src/domain/ids.ts';
import { GateQuestion } from '../../src/domain/gate.ts';
import { createQueryService } from '../../src/queries/query-service.ts';
import type { EvaluateGateInput } from '../../src/queries/query-service.ts';
import { NOTE, note, refusal } from '../commands/register-fakes.ts';
import * as omc from '../fixtures/domains/omc.ts';
import { captureError } from '../helpers.ts';
import { defineDomain, diskStores, PROJECT, querySetup } from './query-setup.ts';

type Extra = Pick<EvaluateGateInput, 'target' | 'marker'>;

/** Projeto com `note`, `doc` e `finding`, mais os gates, definidos antes de qualquer `createProcess`. */
function gateSetup(...gates: Gate[]) {
  const setup = querySetup();
  setup.definitions.write(PROJECT, 'types', 'finding', '1.0', NOTE);
  for (const gate of gates) setup.definitions.write(PROJECT, 'gates', gate.name, '1.0', gate);
  const evaluate = (process: string, gate: string, extra: Extra = {}) =>
    setup.queries.evaluateGate({ project: PROJECT, process, gate, ...extra });
  return { ...setup, evaluate };
}

const PROPOSED: Gate = {
  name: 'proposed-approved',
  questions: [{ kind: 'approved', of: { type: 'note', where: { text: 'proposta' } } }],
};

describe('evaluateGate: marker and inherited names', () => {
  test('process scope: a marker without the entry of the process read is MARKER_NOT_FOUND at /marker, not vacuity', async () => {
    const { createProcess, registerOne, evaluate } = gateSetup(PROPOSED);
    createProcess('run-1');
    const head = await registerOne('run-1', note('proposta'));

    const malformed: Marker[] = [{}, { 'run-2': null }, { 'run-1': head, 'run-2': null }];
    for (const marker of malformed) {
      const error = captureError(() => evaluate('run-1', PROPOSED.name, { marker }));
      expect(error.code).toBe('MARKER_NOT_FOUND');
      expect(error.details).toEqual([
        expect.objectContaining({ path: '/marker', code: 'process-not-found' }),
      ]);
    }
    expect(evaluate('run-1', PROPOSED.name, { marker: { 'run-1': null } }).marker).toEqual({
      'run-1': null,
    });
  });

  test('a gate named `constructor` and not pinned is GATE_NOT_FOUND, not INTERNAL', () => {
    const { createProcess, evaluate } = gateSetup(PROPOSED);
    createProcess('run-1');

    const error = captureError(() => evaluate('run-1', 'constructor'));

    expect(error.code).toBe('GATE_NOT_FOUND');
  });
});

describe('evaluateGate: no writes, marker and replay', () => {
  test('evaluating the gate does not write: the log stays byte for byte equal', async () => {
    const { logPath, createProcess, registerOne, evaluate } = gateSetup(PROPOSED);
    createProcess('run-1');
    await registerOne('run-1', note('proposta'));
    const before = fs.readFileSync(logPath('run-1'));

    evaluate('run-1', PROPOSED.name);
    evaluate('run-1', PROPOSED.name);

    expect(fs.readFileSync(logPath('run-1')).equals(before)).toBe(true);
  });

  test('the marker covers only the process of the call, even with others in the project', async () => {
    const { createProcess, registerOne, evaluate } = gateSetup(PROPOSED);
    createProcess('run-1');
    createProcess('run-2');
    const head = await registerOne('run-1', note('proposta'));
    await registerOne('run-2', note('outra'));

    expect(evaluate('run-1', PROPOSED.name).marker).toEqual({ 'run-1': head });
  });

  test('the marker of a question with scope project covers every process read, the empty one as null', async () => {
    const wide: Gate = {
      name: 'wide',
      questions: [{ kind: 'occurred', select: { type: 'note' }, scope: 'project' }],
    };
    const { createProcess, registerOne, evaluate } = gateSetup(wide);
    createProcess('run-1');
    createProcess('run-2');
    const head = await registerOne('run-1', note('a'));

    expect(evaluate('run-1', 'wide').marker).toEqual({ 'run-1': head, 'run-2': null });
  });

  test('a replay with a marker gives the earlier result, even with a new record that would change the answer', async () => {
    const { createProcess, registerOne, evaluate } = gateSetup(PROPOSED);
    createProcess('run-1');
    const proposal = await registerOne('run-1', note('proposta'));
    await registerOne(
      'run-1',
      note('aprovação', { relations: [{ to: proposal, kind: 'supports' }] }),
      1,
    );
    const before = evaluate('run-1', PROPOSED.name);
    await registerOne('run-1', note('proposta'), 2);

    expect(before.passed).toBe(true);
    expect(evaluate('run-1', PROPOSED.name).passed).toBe(false);
    expect(evaluate('run-1', PROPOSED.name, { marker: before.marker })).toEqual(before);
  });

  test('a replay in project scope reads the process born later as empty', async () => {
    const wide: Gate = {
      name: 'wide-approved',
      questions: [{ ...PROPOSED.questions[0]!, scope: 'project' }],
    };
    const { createProcess, registerOne, evaluate } = gateSetup(wide);
    createProcess('run-1');
    const proposal = await registerOne('run-1', note('proposta'));
    await registerOne(
      'run-1',
      note('aprovação', { relations: [{ to: proposal, kind: 'supports' }] }),
      1,
    );
    const before = evaluate('run-1', 'wide-approved');
    createProcess('run-2');
    await registerOne('run-2', note('proposta'), 2);

    expect(evaluate('run-1', 'wide-approved').passed).toBe(false);
    const replayed = evaluate('run-1', 'wide-approved', { marker: before.marker });
    expect(replayed.passed).toBe(true);
    expect(replayed.marker).toEqual({ ...before.marker, 'run-2': null });
  });
});

describe('evaluateGate: per-question scope and nonexistent names', () => {
  test('per-question scope: an approval from another process counts only with scope project', async () => {
    const gate = (scope: 'process' | 'project'): Gate => ({
      name: `cross-${scope}`,
      questions: [{ kind: 'approved', of: { type: 'note', where: { text: 'proposta' } }, scope }],
    });
    const { createProcess, registerOne, evaluate } = gateSetup(gate('process'), gate('project'));
    createProcess('run-1');
    createProcess('run-2');
    const proposal = await registerOne('run-1', note('proposta'));
    await registerOne(
      'run-2',
      note('aprovação', { relations: [{ to: proposal, kind: 'supports' }] }),
      1,
    );

    expect(evaluate('run-1', 'cross-process').passed).toBe(false);
    expect(evaluate('run-1', 'cross-project').passed).toBe(true);
  });

  test('a nonexistent gate is GATE_NOT_FOUND and a nonexistent process is PROCESS_NOT_FOUND', () => {
    const { createProcess, evaluate } = gateSetup(PROPOSED);
    createProcess('run-1');

    const gate = captureError(() => evaluate('run-1', 'nope'));
    const process = captureError(() => evaluate('ghost', PROPOSED.name));

    expect(gate.code).toBe('GATE_NOT_FOUND');
    expect(gate.details[0]).toMatchObject({ path: '/gate', code: 'unknown-name' });
    expect(process.code).toBe('PROCESS_NOT_FOUND');
  });
});

describe('evaluateGate: chain hygiene', () => {
  test('hygiene: the chain is always verified and a break gives PROCESS_CORRUPTED naming the process', async () => {
    const { createProcess, registerOne, tamper, evaluate } = gateSetup(PROPOSED);
    createProcess('run-1');
    await registerOne('run-1', note('proposta'));
    await registerOne('run-1', note('seguinte'), 1);
    tamper('run-1');

    const error = captureError(() => evaluate('run-1', PROPOSED.name));

    expect(error.code).toBe('PROCESS_CORRUPTED');
    expect(error.details[0]).toMatchObject({ code: 'broken-chain', process: 'run-1' });
  });

  test('hygiene: a project-scope question fails closed with the broken process, not the one of the call', async () => {
    const wide: Gate = {
      name: 'wide-hygiene',
      questions: [{ kind: 'occurred', select: { type: 'note' }, scope: 'project' }],
    };
    const { createProcess, registerOne, tamper, evaluate } = gateSetup(wide);
    createProcess('run-1');
    createProcess('run-2');
    await registerOne('run-1', note('a'));
    await registerOne('run-2', note('b'), 1);
    await registerOne('run-2', note('c'), 2);
    tamper('run-2');

    const error = captureError(() => evaluate('run-1', 'wide-hygiene'));

    expect(error.code).toBe('PROCESS_CORRUPTED');
    expect(error.details[0]).toMatchObject({ process: 'run-2' });
  });

  test('hygiene: "no fork" does not exist as a gate question', () => {
    expect(GateQuestion.safeParse({ kind: 'no_fork' }).success).toBe(false);
  });
});

/** Gate plano-pronto de 4.1 (`test/fixtures/domains/omc.ts`) e uma cópia com as perguntas em alcance projeto. */
const READY = omc.gates[0]!;
const READY_PROJECT: Gate = {
  name: 'plan-ready-project',
  questions: READY.questions.map((question) => ({ ...question, scope: 'project' as const })),
};

function planSetup() {
  const setup = querySetup({ defaults: false });
  defineDomain(setup.definitions, {
    ...omc,
    gates: [READY, READY_PROJECT],
  });
  const plan = (extra = {}) => ({
    type: 'plan',
    target: 'run.plan',
    data: { isRevision: false },
    ...extra,
  });
  const approves = (to: string, extra = {}) => ({
    type: 'review',
    target: 'run.plan',
    data: { summary: 'ok' },
    relations: [{ to, as: 'approves' }],
    ...extra,
  });
  const deviation = { type: 'deviation', target: 'run.plan', data: { description: 'desvio' } };
  const settles = (to: string) => ({
    type: 'review',
    target: 'run.plan',
    data: { summary: 'resolvido' },
    relations: [{ to, as: 'settles' }],
  });
  const ready = (process: string, gate = READY.name) =>
    setup.queries.evaluateGate({ project: PROJECT, process, gate });
  return { ...setup, plan, approves, deviation, settles, ready };
}

describe('D4: plan-ready gate', () => {
  test('plan-ready: a plan revision without diff is refused at write time by the type schema', async () => {
    const { createProcess, registerOne, plan } = planSetup();
    createProcess('run-1');
    const first = await registerOne('run-1', plan());

    const error = await refusal(
      registerOne(
        'run-1',
        plan({ data: { isRevision: true }, relations: [{ to: first, kind: 'supersedes' }] }),
        1,
      ),
    );

    expect(error.code).toBe('INVALID_RECORD');
  });

  test('plan-ready: with scope project the approval and the outcome come from another process', async () => {
    const { createProcess, registerOne, plan, approves, deviation, settles, ready } = planSetup();
    createProcess('run-1');
    createProcess('review-1');
    const first = await registerOne('run-1', plan());
    const open = await registerOne('run-1', deviation, 1);
    await registerOne('review-1', approves(first), 2);
    await registerOne('review-1', settles(open), 3);

    expect(ready('run-1').passed).toBe(false);
    expect(ready('run-1', READY_PROJECT.name).passed).toBe(true);
  });
});

describe('D5 and SG4: findings and planned gate', () => {
  const answered: Gate = {
    name: 'all-answered',
    questions: [
      { kind: 'no_pending', pending: { type: 'finding' }, resolvedBy: { kind: 'answers' } },
    ],
  };

  test('finding: fails when a finding has no incoming `answers` and passes when all have one', async () => {
    const { createProcess, registerOne, evaluate } = gateSetup(answered);
    createProcess('run-1');
    const answeredFinding = await registerOne('run-1', {
      type: 'finding',
      target: 'run.a',
      data: { text: 'a' },
    });
    const openFinding = await registerOne(
      'run-1',
      { type: 'finding', target: 'run.b', data: { text: 'b' } },
      1,
    );
    await registerOne(
      'run-1',
      note('resposta a', { relations: [{ to: answeredFinding, kind: 'answers' }] }),
      2,
    );

    expect(evaluate('run-1', 'all-answered').questions[0]).toMatchObject({
      passed: false,
      evidence: { unresolved: [openFinding] },
    });

    await registerOne(
      'run-1',
      note('resposta b', { relations: [{ to: openFinding, kind: 'answers' }] }),
      3,
    );
    expect(evaluate('run-1', 'all-answered').passed).toBe(true);
  });

  test('planned: every planned item of type X on target Y needs a done item, and the gate points at the planned item without one', async () => {
    const planned: Gate = {
      name: 'planned-done',
      questions: [
        {
          kind: 'no_pending',
          pending: { type: 'finding', targetPrefix: 'run.step' },
          resolvedBy: { kind: 'derivesFrom', from: ['note'] },
        },
      ],
    };
    const { createProcess, registerOne, evaluate } = gateSetup(planned);
    createProcess('run-1');
    const done = await registerOne('run-1', {
      type: 'finding',
      target: 'run.step.one',
      data: { text: 'a' },
    });
    const missing = await registerOne(
      'run-1',
      { type: 'finding', target: 'run.step.two', data: { text: 'b' } },
      1,
    );
    await registerOne(
      'run-1',
      { type: 'finding', target: 'run.elsewhere', data: { text: 'c' } },
      2,
    );
    await registerOne(
      'run-1',
      note('feito', { relations: [{ to: done, kind: 'derivesFrom' }] }),
      3,
    );

    expect(evaluate('run-1', 'planned-done').questions[0]).toMatchObject({
      passed: false,
      evidence: { unresolved: [missing] },
    });
  });
});

describe('evaluateGate: evidence and targets', () => {
  /** `run.a` aprovado, `run.b` com proposta sem apoio, `run.c` sem proposta. */
  async function proposals() {
    const setup = gateSetup(PROPOSED);
    setup.createProcess('run-1');
    const proposalA = await setup.registerOne('run-1', note('proposta', { target: 'run.a' }));
    const supportA = await setup.registerOne(
      'run-1',
      note('apoio', { target: 'run.a', relations: [{ to: proposalA, kind: 'supports' }] }),
      1,
    );
    const proposalB = await setup.registerOne('run-1', note('proposta', { target: 'run.b' }), 2);
    const call = <Extra extends Partial<EvaluateGateInput>>(extra: Extra) => ({
      project: PROJECT,
      process: 'run-1',
      gate: PROPOSED.name,
      ...extra,
    });
    return { ...setup, proposalA, supportA, proposalB, call };
  }

  test('evaluateGate without options keeps the full evidence', async () => {
    const { queries, call, proposalA, supportA } = await proposals();

    const { questions } = queries.evaluateGate(call({ target: 'run.a' }));

    expect(questions).toEqual([
      {
        index: 0,
        kind: 'approved',
        passed: true,
        evidence: { of: [proposalA], supports: [supportA], contradictions: [], unsupported: [] },
      },
    ]);
  });

  test('evaluateGate with evidence counts returns counts and no evidence', async () => {
    const { queries, call } = await proposals();

    const { questions } = queries.evaluateGate(call({ target: 'run.b', evidence: 'counts' }));

    expect(questions).toEqual([
      {
        index: 0,
        kind: 'approved',
        passed: false,
        counts: { of: 1, supports: 0, contradictions: 0, unsupported: 1 },
      },
    ]);
  });

  test('evaluateGate with evidence failing lists only the unsupported ids of a failing approved question', async () => {
    const { queries, call, proposalB } = await proposals();

    const { questions } = queries.evaluateGate(call({ target: 'run.b', evidence: 'failing' }));

    expect(questions).toEqual([
      {
        index: 0,
        kind: 'approved',
        passed: false,
        counts: { of: 1, supports: 0, contradictions: 0, unsupported: 1 },
        evidence: { unsupported: [proposalB] },
      },
    ]);
  });

  test('evaluateGate with targets returns one result per target in input order', async () => {
    const { queries, call, proposalB } = await proposals();

    const evaluation = queries.evaluateGate(
      call({ targets: ['run.b', 'run.a', 'run.c', 'run.a'], evidence: 'failing' }),
    );

    expect(evaluation.results.map(({ target, passed }) => [target, passed])).toEqual([
      ['run.b', false],
      ['run.a', true],
      ['run.c', false],
      ['run.a', true],
    ]);
    expect(evaluation.results[0]!.questions[0]).toMatchObject({
      evidence: { unsupported: [proposalB] },
    });
    expect(evaluation.results[1]!.questions[0]).not.toHaveProperty('evidence');
  });

  test('evaluateGate with targets reads once and returns a single marker', async () => {
    const { queries, call, proposalB } = await proposals();

    const evaluation = queries.evaluateGate(
      call({ targets: ['run.a', 'run.b'], evidence: 'counts' }),
    );

    expect(evaluation.marker).toEqual({ 'run-1': proposalB });
    expect(evaluation.marker).toEqual(queries.evaluateGate(call({ target: 'run.a' })).marker);
  });

  test('evaluateGate with targets and a marker replays every target over the same records', async () => {
    const { queries, call, registerOne, proposalB } = await proposals();
    const targets = ['run.a', 'run.b'];
    const before = queries.evaluateGate(call({ targets, evidence: 'counts' }));
    await registerOne(
      'run-1',
      note('apoio', { target: 'run.b', relations: [{ to: proposalB, kind: 'supports' }] }),
      3,
    );

    expect(queries.evaluateGate(call({ targets, evidence: 'counts' })).passed).toBe(true);
    expect(
      queries.evaluateGate(call({ targets, evidence: 'counts', marker: before.marker })),
    ).toEqual(before);
  });

  test('evaluateGate with targets passes only when every target passes', async () => {
    const { queries, call } = await proposals();

    expect(queries.evaluateGate(call({ targets: ['run.a'], evidence: 'counts' })).passed).toBe(
      true,
    );
    expect(
      queries.evaluateGate(call({ targets: ['run.a', 'run.b'], evidence: 'counts' })).passed,
    ).toBe(false);
  });

  test('evaluateGate rejects target together with targets', () => {
    const { queries } = gateSetup(PROPOSED);

    const error = captureError(() =>
      queries.evaluateGate({
        project: PROJECT,
        process: 'missing',
        gate: PROPOSED.name,
        target: 'run.a',
        targets: ['run.a'],
        evidence: 'counts',
      }),
    );

    expect(error.code).toBe('INVALID_INPUT');
    expect(error.details).toEqual([
      expect.objectContaining({ path: '/targets', code: 'with-target' }),
    ]);
  });

  test('evaluateGate rejects an empty targets list', () => {
    const { queries } = gateSetup(PROPOSED);

    const error = captureError(() =>
      queries.evaluateGate({
        project: PROJECT,
        process: 'missing',
        gate: PROPOSED.name,
        targets: [],
        evidence: 'counts',
      }),
    );

    expect(error.code).toBe('INVALID_INPUT');
    expect(error.details).toEqual([expect.objectContaining({ path: '/targets', code: 'empty' })]);
  });

  test('evaluateGate rejects evidence full together with targets', () => {
    const { queries } = gateSetup(PROPOSED);
    const input = { project: PROJECT, process: 'missing', gate: PROPOSED.name, targets: ['run.a'] };

    for (const evidence of [undefined, 'full' as const]) {
      const error = captureError(() => queries.evaluateGate({ ...input, evidence }));

      expect(error.code).toBe('INVALID_INPUT');
      expect(error.details).toEqual([
        expect.objectContaining({ path: '/evidence', code: 'full-with-targets' }),
      ]);
    }
  });

  test('evaluateGate with 50 targets reads each process once, in the process and project scopes', async () => {
    const projectProposed: Gate = {
      name: 'project-proposed-approved',
      questions: [{ kind: 'approved', of: {}, scope: 'project' }],
    };
    const { dataDir, createProcess, registerOne } = gateSetup(PROPOSED, projectProposed);
    createProcess('run-1');
    createProcess('run-2');
    await registerOne('run-1', note('proposta', { target: 'run.t0' }));
    await registerOne('run-2', note('proposta', { target: 'run.t1' }), 1);
    const stores = diskStores(dataDir);
    const read = jest.spyOn(stores.store, 'read');
    const queries = createQueryService({ ...stores, search: createSearchIndex() });
    const targets = Array.from({ length: 50 }, (_, index) => `run.t${index}`);

    for (const [gate, reads] of [
      [PROPOSED.name, 1],
      [projectProposed.name, 2],
    ] as const) {
      read.mockClear();

      const { results } = queries.evaluateGate({
        project: PROJECT,
        process: 'run-1',
        gate,
        targets,
        evidence: 'counts',
      });

      expect(results).toHaveLength(50);
      expect(read).toHaveBeenCalledTimes(reads);
    }
  });

  test('evaluateGate with targets does not write', async () => {
    const { queries, call, logPath } = await proposals();
    const before = fs.readFileSync(logPath('run-1'));

    queries.evaluateGate(call({ targets: ['run.a', 'run.b'], evidence: 'failing' }));

    expect(fs.readFileSync(logPath('run-1')).equals(before)).toBe(true);
  });
});
