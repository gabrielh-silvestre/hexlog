import { describe, expect, it } from '@jest/globals';
import { countBy } from 'es-toolkit';
import type { Gate } from '../../src/domain/definitions.ts';
import type { Marker, RecordId } from '../../src/domain/ids.ts';
import { NOTE, note } from '../commands/register-fakes.ts';
import { at } from '../helpers.ts';
import { idsOf, PROJECT, querySetup, walkPages } from './query-setup.ts';

const UNIT_APPROVED: Gate = {
  name: 'unit-approved',
  questions: [
    { kind: 'approved', of: { targetPrefix: 'run.unit' }, by: { targetPrefix: 'run.ev' } },
  ],
};
const UNIT_APPROVED_INHERIT: Gate = {
  name: 'unit-approved-inherit',
  questions: [
    {
      kind: 'approved',
      of: { targetPrefix: 'run.unit' },
      by: { targetPrefix: 'run.ev' },
      inherit: true,
    },
  ],
};
const ANSWERED_INHERIT: Gate = {
  name: 'answered-inherit',
  questions: [
    {
      kind: 'no_pending',
      pending: { type: 'finding' },
      resolvedBy: { kind: 'answers' },
      inherit: true,
    },
  ],
};

const PROJECT_APPROVED_INHERIT: Gate = {
  name: 'project-approved-inherit',
  questions: [
    {
      kind: 'approved',
      of: { targetPrefix: 'run.unit' },
      by: { targetPrefix: 'run.ev' },
      scope: 'project',
      inherit: true,
    },
  ],
};
/** `of` sem `targetPrefix` herda o `target` da avaliação. */
const TARGETED_APPROVED_INHERIT: Gate = {
  name: 'targeted-approved-inherit',
  questions: [{ kind: 'approved', of: {}, by: { targetPrefix: 'run.ev' }, inherit: true }],
};

/** Projeto com os gates definidos antes de qualquer processo, que os fixa ao nascer. */
function setup() {
  const base = querySetup();
  base.definitions.write(PROJECT, 'types', 'finding', '1.0', NOTE);
  for (const gate of [
    UNIT_APPROVED,
    UNIT_APPROVED_INHERIT,
    ANSWERED_INHERIT,
    PROJECT_APPROVED_INHERIT,
    TARGETED_APPROVED_INHERIT,
  ]) {
    base.definitions.write(PROJECT, 'gates', gate.name, '1.0', gate);
  }
  const unit = (extra = {}) => note('unidade', { target: 'run.unit', ...extra });
  const evidence = (to: RecordId) =>
    note('evidência', { target: 'run.ev', relations: [{ to, kind: 'supports' }] });
  const supersede = (to: RecordId, extra = {}) =>
    unit({ relations: [{ to, kind: 'supersedes' }], ...extra });
  const evaluate = (
    process: string,
    gate: string,
    evidence?: 'full' | 'counts',
    extra: { marker?: Marker } = {},
  ) =>
    base.queries.evaluateGate({
      project: PROJECT,
      process,
      gate,
      ...(evidence && { evidence }),
      ...extra,
    });

  /** Unidade `u1` apoiada pela evidência `e1`, depois superada por `u2` sem relação nenhuma. */
  async function superseded(process: string, create = base.createProcess) {
    create(process);
    const u1 = await base.registerOne(process, unit(), 1);
    const e1 = await base.registerOne(process, evidence(u1), 2);
    const u2 = await base.registerOne(process, supersede(u1), 3);
    return { u1, e1, u2 };
  }
  return { ...base, unit, evidence, supersede, evaluate, superseded };
}

describe('QueryService.queryRecords', () => {
  it('should let the superseding version inherit the support, with the physical edge as origin, in full mode', async () => {
    const { superseded, query } = setup();
    const { u1, e1, u2 } = await superseded('run-1');

    const page = query({ process: 'run-1', relations: 'full', ids: [e1, u2] });

    expect(at(page.records, 1).inheritedIn).toEqual([
      { kind: 'supports', from: e1, origin: { from: e1, to: u1 } },
    ]);
    expect(at(page.records, 1).in).toEqual([]);
    expect(at(page.records, 0).inheritedOut).toEqual([
      { kind: 'supports', to: u2, origin: { from: e1, to: u1 } },
    ]);
    expect(at(page.records, 0).out).toEqual([{ kind: 'supports', to: u1, current: false }]);
  });

  it('should keep `as` in the inherited edge for named relations', async () => {
    const { createProcess, registerOne, unit, supersede, query } = setup();
    createProcess('run-1');
    const u1 = await registerOne('run-1', unit(), 1);
    const e1 = await registerOne(
      'run-1',
      note('evidência', { target: 'run.ev', relations: [{ to: u1, as: 'approves' }] }),
      2,
    );
    const u2 = await registerOne('run-1', supersede(u1), 3);

    const page = query({ process: 'run-1', relations: 'full', ids: [u2] });

    expect(at(page.records, 0).inheritedIn).toEqual([
      { kind: 'supports', as: 'approves', from: e1, origin: { from: e1, to: u1 } },
    ]);
  });

  it('should tally in counts mode the same inherited edges that full mode lists, over five records', async () => {
    const { createProcess, registerOne, unit, evidence, supersede, query } = setup();
    createProcess('run-1');
    const u1 = await registerOne('run-1', unit(), 1);
    const e1 = await registerOne('run-1', evidence(u1), 2);
    const e2 = await registerOne(
      'run-1',
      note('evidência', { target: 'run.ev', relations: [{ to: u1, as: 'approves' }] }),
      3,
    );
    const u2 = await registerOne('run-1', supersede(u1), 4);
    const u3 = await registerOne('run-1', supersede(u2), 5);
    const everything = { process: 'run-1', ids: [u1, e1, e2, u2, u3], includeNonCurrent: true };

    const full = query({ ...everything, relations: 'full' });
    const counts = query({ ...everything, relations: 'counts' });

    const tally = (edges: readonly { kind: string; as?: string }[] = []) =>
      edges.length === 0 ? undefined : countBy(edges, ({ as, kind }) => as ?? kind);

    expect(idsOf(counts)).toEqual(idsOf(full));

    full.records.forEach((record, index) => {
      expect(at(counts.records, index).inheritedInCounts).toEqual(tally(record.inheritedIn));
      expect(at(counts.records, index).inheritedOutCounts).toEqual(tally(record.inheritedOut));
    });
    const latest = at(counts.records, idsOf(counts).indexOf(u3));

    expect(latest.inheritedInCounts).toEqual({ supports: 1, approves: 1 });
  });

  it('should follow only the stored edges with `relatedTo`, never the inherited ones', async () => {
    const { superseded, query } = setup();
    const { u1, e1, u2 } = await superseded('run-1');

    const aroundSuperseding = query({ process: 'run-1', relatedTo: u2, includeNonCurrent: true });
    const aroundSupport = query({ process: 'run-1', relatedTo: e1, includeNonCurrent: true });

    // `e1` herda o apoio de `u2` e `u2` herda `e1`, mas nenhum dos dois grava a aresta.
    expect(idsOf(aroundSuperseding)).toEqual([u1]);
    expect(idsOf(aroundSupport)).toEqual([u1]);
  });

  it('should count the inherited edges by name in counts mode', async () => {
    const { superseded, query } = setup();
    const { e1, u2 } = await superseded('run-1');

    const counts = query({ process: 'run-1', relations: 'counts', ids: [e1, u2] });

    expect(at(counts.records, 1).inheritedInCounts).toEqual({ supports: 1 });
    expect(at(counts.records, 1)).not.toHaveProperty('inheritedIn');
    expect(at(counts.records, 0).inheritedOutCounts).toEqual({ supports: 1 });
    expect(at(counts.records, 0)).not.toHaveProperty('inheritedInCounts');
  });

  it('should keep the inherited counts out of the vigency split of the stored counts', async () => {
    const { superseded, query } = setup();
    const { e1 } = await superseded('run-1');

    const counts = query({ process: 'run-1', relations: 'counts', ids: [e1] });

    expect(at(counts.records, 0)).toMatchObject({
      nonCurrentOutCounts: { supports: 1 },
      inheritedOutCounts: { supports: 1 },
    });
    expect(at(counts.records, 0)).not.toHaveProperty('outCounts');
  });

  it('should bring no inherited field in none mode', async () => {
    const { superseded, query } = setup();
    const { e1, u2 } = await superseded('run-1');

    const none = query({ process: 'run-1', relations: 'none', ids: [e1, u2] });

    for (const record of none.records) {
      expect(record).not.toHaveProperty('inheritedIn');
      expect(record).not.toHaveProperty('inheritedOut');
      expect(record).not.toHaveProperty('inheritedInCounts');
      expect(record).not.toHaveProperty('inheritedOutCounts');
    }
  });

  it('should keep the inherited fields as it keeps `in` and `out` with `fields: []`', async () => {
    const { superseded, query } = setup();
    const { u2 } = await superseded('run-1');

    const page = query({ process: 'run-1', relations: 'full', ids: [u2], fields: [] });

    expect(at(page.records, 0)).not.toHaveProperty('data');
    expect(at(page.records, 0).inheritedIn).toHaveLength(1);
  });

  it('should answer as before for a legacy process: no inherited field and the support goes stale', async () => {
    const { superseded, createLegacyProcess, query } = setup();
    const { e1, u1, u2 } = await superseded('run-1', createLegacyProcess);

    const full = query({ process: 'run-1', relations: 'full', ids: [e1, u2] });
    const counts = query({ process: 'run-1', relations: 'counts', ids: [e1, u2] });

    for (const record of [...full.records, ...counts.records]) {
      expect(Object.keys(record).filter((key) => key.startsWith('inherited'))).toEqual([]);
    }

    expect(at(full.records, 0).needsReview).toEqual({ staleIn: [], staleOut: [u1] });
  });

  it('should not mark `needsReview` for a live inherited support', async () => {
    const { superseded, query } = setup();
    const { e1, u2 } = await superseded('run-1');

    const page = query({ process: 'run-1', ids: [e1, u2] });

    for (const record of page.records) expect(record).not.toHaveProperty('needsReview');
  });

  it('should cut the inheritance with a `contradicts` between the two lineages, and the support goes stale', async () => {
    const { superseded, supersede, registerOne, query } = setup();
    const { e1, u1, u2 } = await superseded('run-1');
    const u3 = await registerOne(
      'run-1',
      supersede(u2, {
        relations: [
          { to: u2, kind: 'supersedes' },
          { to: e1, kind: 'contradicts' },
        ],
      }),
      4,
    );

    const page = query({ process: 'run-1', relations: 'full', ids: [e1, u3] });

    expect(at(page.records, 1)).not.toHaveProperty('inheritedIn');
    expect(at(page.records, 0)).not.toHaveProperty('inheritedOut');
    expect(at(page.records, 0).needsReview).toEqual({ staleIn: [], staleOut: [u1] });
  });

  it('should carry the support only to the current version in a lineage of three versions', async () => {
    const { superseded, supersede, registerOne, query } = setup();
    const { e1, u1, u2 } = await superseded('run-1');
    const u3 = await registerOne('run-1', supersede(u2), 4);

    const page = query({ process: 'run-1', relations: 'full', includeNonCurrent: true });
    const byId = new Map(page.records.map((record) => [record.id, record]));

    expect(byId.get(u3)?.inheritedIn).toEqual([
      { kind: 'supports', from: e1, origin: { from: e1, to: u1 } },
    ]);
    expect(byId.get(u2)).not.toHaveProperty('inheritedIn');
    expect(byId.get(u1)).not.toHaveProperty('inheritedIn');
    expect(byId.get(e1)?.inheritedOut).toEqual([
      { kind: 'supports', to: u3, origin: { from: e1, to: u1 } },
    ]);
  });

  it('should reconnect the inheritance when the version that holds the cutting `contradicts` is superseded', async () => {
    const { superseded, supersede, registerOne, query } = setup();
    const { e1, u1, u2 } = await superseded('run-1');
    const u3 = await registerOne(
      'run-1',
      supersede(u2, {
        relations: [
          { to: u2, kind: 'supersedes' },
          { to: e1, kind: 'contradicts' },
        ],
      }),
      4,
    );
    const cut = query({ process: 'run-1', relations: 'full', ids: [u3] });
    const u4 = await registerOne('run-1', supersede(u3), 5);

    const reconnected = query({ process: 'run-1', relations: 'full', ids: [u4] });

    expect(at(cut.records, 0)).not.toHaveProperty('inheritedIn');
    expect(at(reconnected.records, 0).inheritedIn).toEqual([
      { kind: 'supports', from: e1, origin: { from: e1, to: u1 } },
    ]);
  });

  it('should keep `changesSince` coherent with the inheritance', async () => {
    const { createProcess, registerOne, unit, evidence, supersede, query } = setup();
    createProcess('run-1');
    const u1 = await registerOne('run-1', unit(), 1);
    const e1 = await registerOne('run-1', evidence(u1), 2);
    const before = query({ process: 'run-1', relations: 'full' });
    const u2 = await registerOne('run-1', supersede(u1), 3);

    const delta = query({ process: 'run-1', relations: 'full', changesSince: before.marker });

    expect(delta.changes).toMatchObject({ entered: [u2], left: [{ id: u1 }] });
    expect(delta.records.map(({ id }) => id)).toEqual([e1, u2]);
  });

  it('should keep `includeNonCurrent` coherent with the inheritance', async () => {
    const { createProcess, registerOne, unit, evidence, supersede, query } = setup();
    createProcess('run-1');
    const u1 = await registerOne('run-1', unit(), 1);
    await registerOne('run-1', evidence(u1), 2);
    const before = query({ process: 'run-1', relations: 'full' });
    const u2 = await registerOne('run-1', supersede(u1), 3);

    const all = query({ process: 'run-1', relations: 'full', includeNonCurrent: true });

    expect(
      all.records.filter(({ inheritedIn }) => inheritedIn !== undefined).map(({ id }) => id),
    ).toEqual([u2]);
    expect(before.records.filter(({ inheritedIn }) => inheritedIn !== undefined)).toEqual([]);
  });

  it('should not see a support from another process in process scope', async () => {
    const { createProcess, registerOne, unit, evidence, supersede, query } = setup();
    createProcess('run-1');
    createProcess('run-2');
    const u1 = await registerOne('run-1', unit(), 1);
    await registerOne('run-2', evidence(u1), 2);
    const u2 = await registerOne('run-1', supersede(u1), 3);

    const own = query({ process: 'run-1', relations: 'full', ids: [u2] });

    expect(at(own.records, 0)).not.toHaveProperty('inheritedIn');
  });

  it('should see a support from another process in project scope', async () => {
    const { createProcess, registerOne, unit, evidence, supersede, query } = setup();
    createProcess('run-1');
    createProcess('run-2');
    const u1 = await registerOne('run-1', unit(), 1);
    const e1 = await registerOne('run-2', evidence(u1), 2);
    const u2 = await registerOne('run-1', supersede(u1), 3);

    const project = query({ scope: 'project', relations: 'full', ids: [u2] });

    expect(at(project.records, 0).inheritedIn).toEqual([
      { kind: 'supports', from: e1, origin: { from: e1, to: u1 } },
    ]);
  });

  it('should inherit nothing in a legacy destination process, because the process of the lineage that rises decides', async () => {
    const { createLegacyProcess, createProcess, registerOne, unit, evidence, supersede, query } =
      setup();
    createLegacyProcess('run-1');
    createProcess('run-2');
    const u1 = await registerOne('run-1', unit(), 1);
    await registerOne('run-2', evidence(u1), 2);
    const u2 = await registerOne('run-1', supersede(u1), 3);

    const project = query({ scope: 'project', relations: 'full', ids: [u2] });

    expect(at(project.records, 0)).not.toHaveProperty('inheritedIn');
  });

  it('should count and keep the records that carry inheritance in the page cap and the cursor', async () => {
    const { createProcess, registerOne, unit, evidence, supersede, query } = setup();
    createProcess('run-1');
    const units: RecordId[] = [];
    for (const [index, target] of ['run.unit.a', 'run.unit.b', 'run.unit.c'].entries()) {
      const u1 = await registerOne('run-1', unit({ target }), index * 3 + 1);
      await registerOne('run-1', evidence(u1), index * 3 + 2);
      units.push(await registerOne('run-1', supersede(u1, { target }), index * 3 + 3));
    }

    const pages = walkPages(query, {
      process: 'run-1',
      relations: 'full',
      targetPrefix: 'run.unit',
      maxChars: 1,
    });

    expect(pages).toHaveLength(3);
    expect(pages.flatMap(({ records }) => records.map(({ id }) => id))).toEqual(units);

    for (const page of pages) expect(at(page.records, 0).inheritedIn).toHaveLength(1);
  });
});

describe('QueryService.evaluateGate', () => {
  it('should reprove approved without `inherit`', async () => {
    const { superseded, evaluate } = setup();
    await superseded('run-1');

    const without = evaluate('run-1', UNIT_APPROVED.name);

    expect(without.passed).toBe(false);
  });

  it('should pass approved with `inherit`, listing the inherited supporter', async () => {
    const { superseded, evaluate } = setup();
    const { e1 } = await superseded('run-1');

    const withFull = evaluate('run-1', UNIT_APPROVED_INHERIT.name, 'full');
    const withCounts = evaluate('run-1', UNIT_APPROVED_INHERIT.name, 'counts');

    expect(withFull.passed).toBe(true);
    expect(at(withFull.questions, 0)).toMatchObject({
      kind: 'approved',
      evidence: { supports: [e1], inherited: [e1] },
    });
    expect(at(withCounts.questions, 0)).toMatchObject({ counts: { inherited: 1 } });
  });

  it('should add nothing for a legacy process: the inherited list is empty', async () => {
    const { superseded, createLegacyProcess, evaluate } = setup();
    await superseded('run-1', createLegacyProcess);

    const full = evaluate('run-1', UNIT_APPROVED_INHERIT.name, 'full');
    const counts = evaluate('run-1', UNIT_APPROVED_INHERIT.name, 'counts');

    expect(full.passed).toBe(false);
    expect(at(full.questions, 0)).toMatchObject({ evidence: { inherited: [] } });
    expect(at(counts.questions, 0)).toMatchObject({ counts: { inherited: 0 } });
  });

  it('should still reprove with `inherit` while a contradiction stands', async () => {
    const { superseded, registerOne, evaluate } = setup();
    const { u2 } = await superseded('run-1');
    await registerOne(
      'run-1',
      note('contra', { target: 'run.ev', relations: [{ to: u2, kind: 'contradicts' }] }),
      4,
    );

    expect(evaluate('run-1', UNIT_APPROVED_INHERIT.name).passed).toBe(false);
  });

  it('should count the support given from another process in a project-scoped question', async () => {
    const { createProcess, registerOne, unit, evidence, supersede, evaluate } = setup();
    createProcess('run-1');
    createProcess('run-2');
    const u1 = await registerOne('run-1', unit(), 1);
    const e1 = await registerOne('run-2', evidence(u1), 2);
    await registerOne('run-1', supersede(u1), 3);

    const result = evaluate('run-1', PROJECT_APPROVED_INHERIT.name, 'full');

    expect(result.passed).toBe(true);
    expect(at(result.questions, 0)).toMatchObject({ evidence: { inherited: [e1] } });
    expect(evaluate('run-1', UNIT_APPROVED.name).passed).toBe(false);
  });

  it('should evaluate each target with `inherit` and count the inherited supporter for targets', async () => {
    const { createProcess, registerOne, unit, evidence, supersede, queries } = setup();
    createProcess('run-1');
    const a1 = await registerOne('run-1', unit({ target: 'run.unit.a' }), 1);
    await registerOne('run-1', evidence(a1), 2);
    await registerOne('run-1', supersede(a1, { target: 'run.unit.a' }), 3);
    await registerOne('run-1', unit({ target: 'run.unit.b' }), 4);

    const evaluation = queries.evaluateGate({
      project: PROJECT,
      process: 'run-1',
      gate: TARGETED_APPROVED_INHERIT.name,
      targets: ['run.unit.a', 'run.unit.b'],
      evidence: 'counts',
    });

    expect(evaluation.passed).toBe(false);
    expect(evaluation.results.map(({ target, passed }) => [target, passed])).toEqual([
      ['run.unit.a', true],
      ['run.unit.b', false],
    ]);
    expect(at(evaluation.results, 0).questions[0]).toMatchObject({ counts: { inherited: 1 } });
  });

  it('should replay the evaluation without inheritance with a marker from before the supersede', async () => {
    const { createProcess, registerOne, unit, evidence, supersede, query, evaluate } = setup();
    createProcess('run-1');
    const u1 = await registerOne('run-1', unit(), 1);
    const e1 = await registerOne('run-1', evidence(u1), 2);
    const { marker } = query({ process: 'run-1' });
    await registerOne('run-1', supersede(u1), 3);

    const replayed = evaluate('run-1', UNIT_APPROVED_INHERIT.name, 'full', { marker });
    const current = evaluate('run-1', UNIT_APPROVED_INHERIT.name, 'full');

    expect(at(replayed.questions, 0)).toMatchObject({
      passed: true,
      evidence: { supports: [e1], inherited: [] },
    });
    expect(at(current.questions, 0)).toMatchObject({
      passed: true,
      evidence: { supports: [e1], inherited: [e1] },
    });
  });

  it('should reprove the gate with a cutting `contradicts` until its version is superseded', async () => {
    const { superseded, supersede, registerOne, evaluate } = setup();
    const { e1, u2 } = await superseded('run-1');
    const u3 = await registerOne(
      'run-1',
      supersede(u2, {
        relations: [
          { to: u2, kind: 'supersedes' },
          { to: e1, kind: 'contradicts' },
        ],
      }),
      4,
    );
    const cut = evaluate('run-1', UNIT_APPROVED_INHERIT.name);
    await registerOne('run-1', supersede(u3), 5);

    expect(cut.passed).toBe(false);
    expect(evaluate('run-1', UNIT_APPROVED_INHERIT.name).passed).toBe(true);
  });

  it('should count the resolution a superseded answer carried for `no_pending`', async () => {
    const { createProcess, registerOne, evaluate } = setup();
    createProcess('run-1');
    const finding = await registerOne(
      'run-1',
      { type: 'finding', target: 'run.f', data: { text: 'f' } },
      1,
    );
    const answer = await registerOne(
      'run-1',
      note('resposta', { target: 'run.a', relations: [{ to: finding, kind: 'answers' }] }),
      2,
    );
    const revised = await registerOne(
      'run-1',
      note('resposta 2', { target: 'run.a', relations: [{ to: answer, kind: 'supersedes' }] }),
      3,
    );

    const result = evaluate('run-1', ANSWERED_INHERIT.name, 'full');

    expect(result.passed).toBe(true);
    expect(at(result.questions, 0)).toMatchObject({
      evidence: { unresolved: [], inherited: [revised] },
    });
  });
});
