import { describe, expect, it, jest } from '@jest/globals';
import { createSearchIndex } from '../../src/adapters/search.ts';
import type { Gate } from '../../src/domain/definitions.ts';
import type { Marker, RecordId } from '../../src/domain/ids.ts';
import { createQueryService } from '../../src/queries/query-service.ts';
import type { EvaluateGateInput } from '../../src/queries/query-service.ts';
import { NOTE, note } from '../commands/register-fakes.ts';
import { at, captureError, snapshot } from '../helpers.ts';
import { diskStores, finding, PROJECT, querySetup } from './query-setup.ts';

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

const PROJECT_PROPOSED: Gate = {
  name: 'project-proposed-approved',
  questions: [{ kind: 'approved', of: {}, scope: 'project' }],
};

const WIDE: Gate = {
  name: 'wide',
  questions: [{ kind: 'occurred', select: { type: 'note' }, scope: 'project' }],
};

const answered: Gate = {
  name: 'all-answered',
  questions: [
    { kind: 'no_pending', pending: { type: 'finding' }, resolvedBy: { kind: 'answers' } },
  ],
};

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
  const call = <Input extends Partial<EvaluateGateInput>>(extra: Input) => ({
    project: PROJECT,
    process: 'run-1',
    gate: PROPOSED.name,
    ...extra,
  });
  return { ...setup, proposalA, supportA, proposalB, call };
}

describe('QueryService.evaluateGate', () => {
  it.each<[string, (head: RecordId) => Marker]>([
    ['an empty marker', () => ({})],
    ['a marker of another process', () => ({ 'run-2': null })],
    ['a marker with an extra process', (head) => ({ 'run-1': head, 'run-2': null })],
  ])(
    'should refuse %s with MARKER_NOT_FOUND at /marker, not vacuity, in process scope',
    async (_label, markerOf) => {
      const { createProcess, registerOne, evaluate } = gateSetup(PROPOSED);
      createProcess('run-1');
      const head = await registerOne('run-1', note('proposta'));

      const error = captureError(() =>
        evaluate('run-1', PROPOSED.name, { marker: markerOf(head) }),
      );

      expect(error.code).toBe('MARKER_NOT_FOUND');
      expect(error.details).toEqual([
        expect.objectContaining({ path: '/marker', code: 'process-not-found' }),
      ]);
    },
  );

  it('should accept a null entry for the process read as the marker of an empty read', () => {
    const { createProcess, evaluate } = gateSetup(PROPOSED);
    createProcess('run-1');

    const evaluation = evaluate('run-1', PROPOSED.name, { marker: { 'run-1': null } });

    expect(evaluation.marker).toEqual({ 'run-1': null });
  });

  it('should not write: the log stays byte for byte equal', async () => {
    const { dataDir, createProcess, registerOne, evaluate } = gateSetup(PROPOSED);
    createProcess('run-1');
    await registerOne('run-1', note('proposta'));
    const before = snapshot(dataDir);

    evaluate('run-1', PROPOSED.name);
    evaluate('run-1', PROPOSED.name);

    expect(snapshot(dataDir)).toEqual(before);
  });

  it('should cover only the process of the call in the marker, even with others in the project', async () => {
    const { createProcess, registerOne, evaluate } = gateSetup(PROPOSED);
    createProcess('run-1');
    createProcess('run-2');
    const head = await registerOne('run-1', note('proposta'));
    await registerOne('run-2', note('outra'));

    expect(evaluate('run-1', PROPOSED.name).marker).toEqual({ 'run-1': head });
  });

  it('should cover every process read in the marker of a question with scope project, the empty one as null', async () => {
    const { createProcess, registerOne, evaluate } = gateSetup(WIDE);
    createProcess('run-1');
    createProcess('run-2');
    const head = await registerOne('run-1', note('a'));

    expect(evaluate('run-1', WIDE.name).marker).toEqual({ 'run-1': head, 'run-2': null });
  });

  it('should give the earlier result on a replay with a marker, even with a new record that would change the answer', async () => {
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

  it('should read a process born later as empty on a replay in project scope', async () => {
    const wide: Gate = {
      name: 'wide-approved',
      questions: [{ ...at(PROPOSED.questions, 0), scope: 'project' }],
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

  it('should count an approval from another process only in a question with scope project', async () => {
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

  it('should throw PROCESS_NOT_FOUND for a nonexistent process', () => {
    const { createProcess, evaluate } = gateSetup(PROPOSED);
    createProcess('run-1');

    const error = captureError(() => evaluate('ghost', PROPOSED.name));

    expect(error.code).toBe('PROCESS_NOT_FOUND');
  });

  it('should verify the chain and give PROCESS_CORRUPTED naming the process on a break', async () => {
    const { createProcess, registerOne, tamper, evaluate } = gateSetup(PROPOSED);
    createProcess('run-1');
    await registerOne('run-1', note('proposta'));
    await registerOne('run-1', note('seguinte'), 1);
    tamper('run-1');

    const error = captureError(() => evaluate('run-1', PROPOSED.name));

    expect(error.code).toBe('PROCESS_CORRUPTED');
    expect(at(error.details, 0)).toMatchObject({ code: 'broken-chain', process: 'run-1' });
  });

  it('should fail closed in a project-scope question with the broken process, not the one of the call', async () => {
    const { createProcess, registerOne, tamper, evaluate } = gateSetup(WIDE);
    createProcess('run-1');
    createProcess('run-2');
    await registerOne('run-1', note('a'));
    await registerOne('run-2', note('b'), 1);
    await registerOne('run-2', note('c'), 2);
    tamper('run-2');

    const error = captureError(() => evaluate('run-1', WIDE.name));

    expect(error.code).toBe('PROCESS_CORRUPTED');
    expect(at(error.details, 0)).toMatchObject({ process: 'run-2' });
  });

  it.each([
    ['fail when a finding has no incoming `answers`', false],
    ['pass when every finding has an incoming `answers`', true],
  ])('should %s', async (_label, answeredAll) => {
    const { createProcess, registerOne, evaluate } = gateSetup(answered);
    createProcess('run-1');
    const answeredFinding = await registerOne('run-1', finding('run.a', 'a'));
    const openFinding = await registerOne('run-1', finding('run.b', 'b'), 1);
    await registerOne(
      'run-1',
      note('resposta a', { relations: [{ to: answeredFinding, kind: 'answers' }] }),
      2,
    );
    if (answeredAll) {
      await registerOne(
        'run-1',
        note('resposta b', { relations: [{ to: openFinding, kind: 'answers' }] }),
        3,
      );
    }

    const evaluation = evaluate('run-1', 'all-answered');

    expect(at(evaluation.questions, 0)).toMatchObject({
      passed: answeredAll,
      evidence: { unresolved: answeredAll ? [] : [openFinding] },
    });
  });

  it('should leave unresolved the planned finding without a derived note, ignoring other targets', async () => {
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
    const done = await registerOne('run-1', finding('run.step.one', 'a'));
    const missing = await registerOne('run-1', finding('run.step.two', 'b'), 1);
    await registerOne('run-1', finding('run.elsewhere', 'c'), 2);
    await registerOne(
      'run-1',
      note('feito', { relations: [{ to: done, kind: 'derivesFrom' }] }),
      3,
    );

    const evaluation = evaluate('run-1', 'planned-done');

    expect(at(evaluation.questions, 0)).toMatchObject({
      passed: false,
      evidence: { unresolved: [missing] },
    });
  });

  it('should keep the full evidence without options', async () => {
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

  it('should return counts and no evidence with evidence counts', async () => {
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

  it('should list only the unsupported ids of a failing approved question with evidence failing', async () => {
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

  it('should return one result per target in input order with targets', async () => {
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
    expect(at(at(evaluation.results, 0).questions, 0)).toMatchObject({
      evidence: { unsupported: [proposalB] },
    });
    expect(at(at(evaluation.results, 1).questions, 0)).not.toHaveProperty('evidence');
  });

  it('should read once and return a single marker with targets', async () => {
    const { queries, call, proposalB } = await proposals();

    const evaluation = queries.evaluateGate(
      call({ targets: ['run.a', 'run.b'], evidence: 'counts' }),
    );

    expect(evaluation.marker).toEqual({ 'run-1': proposalB });
    expect(evaluation.marker).toEqual(queries.evaluateGate(call({ target: 'run.a' })).marker);
  });

  it('should replay every target over the same records with targets and a marker', async () => {
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

  it('should pass with targets only when every target passes', async () => {
    const { queries, call } = await proposals();

    expect(queries.evaluateGate(call({ targets: ['run.a'], evidence: 'counts' })).passed).toBe(
      true,
    );
    expect(
      queries.evaluateGate(call({ targets: ['run.a', 'run.b'], evidence: 'counts' })).passed,
    ).toBe(false);
  });

  it.each([
    { scope: 'process', gate: PROPOSED.name, reads: 1 },
    { scope: 'project', gate: PROJECT_PROPOSED.name, reads: 2 },
  ])(
    'should read each process once with 50 targets in the $scope scope',
    async ({ gate, reads }) => {
      const { dataDir, createProcess, registerOne } = gateSetup(PROPOSED, PROJECT_PROPOSED);
      createProcess('run-1');
      createProcess('run-2');
      await registerOne('run-1', note('proposta', { target: 'run.t0' }));
      await registerOne('run-2', note('proposta', { target: 'run.t1' }), 1);
      const stores = diskStores(dataDir);
      const read = jest.spyOn(stores.store, 'read');
      const queries = createQueryService({ ...stores, search: createSearchIndex() });
      const targets = Array.from({ length: 50 }, (_, index) => `run.t${index}`);

      const { results } = queries.evaluateGate({
        project: PROJECT,
        process: 'run-1',
        gate,
        targets,
        evidence: 'counts',
      });

      expect(results).toHaveLength(50);
      expect(read).toHaveBeenCalledTimes(reads);
    },
  );

  it('should not write with targets', async () => {
    const { queries, call, dataDir } = await proposals();
    const before = snapshot(dataDir);

    queries.evaluateGate(call({ targets: ['run.a', 'run.b'], evidence: 'failing' }));

    expect(snapshot(dataDir)).toEqual(before);
  });
});
