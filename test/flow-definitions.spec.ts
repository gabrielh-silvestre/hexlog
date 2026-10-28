import { afterEach, beforeEach, describe, expect, it } from '@jest/globals';
import { omit } from 'es-toolkit';
import { planSync } from '../scripts/flow/sync.ts';
import type { Defined } from '../src/commands/definition.ts';
import { hashOfJcs } from '../src/domain/chain.ts';
import { classifyTypeChange, type RecordType } from '../src/domain/definitions.ts';
import type { ListResult, VerifyChainResult } from '../src/queries/query-service.ts';
import { KINDS, definitionOf, namesIn } from './flow-data.ts';
import {
  DIRECTIVES,
  PROJECT,
  STRATEGY,
  WORK,
  attachText,
  closeEnvironment,
  closingRules,
  currentDirective,
  decisionData,
  directiveItem,
  docPath,
  environment,
  findingData,
  gapData,
  inputFor,
  openBareEnvironment,
  openEnvironment,
  opening,
  outEdgesOf,
  passed,
  premise,
  premisesOf,
  queryAll,
  register,
  registerGap,
  registerOne,
  rulesOf,
  runSync,
  seedDirective,
  seedPremise,
  staleBatch,
  withRelations,
  workRecord,
  writeBatch,
  type Item,
} from './flow-helpers.ts';
import { at } from './helpers.ts';
import { expectError } from './mcp/environment.ts';

/** Entrada da tool `define_*` para o arquivo: o tipo leva o schema; as demais, o corpo com o nome. */
const defineArgs = (kind: (typeof KINDS)[number], name: string): Record<string, unknown> =>
  kind === 'types' ? { name, schema: definitionOf(kind, name) } : definitionOf(kind, name);

/** Alvos de `directive` que aparecem mais de uma vez no vigente: o que a consulta de auditoria lista. */
async function duplicatedTargets(): Promise<string[]> {
  const { records } = await queryAll({ process: DIRECTIVES, type: 'directive' });
  const targets = records.map(({ target }) => target);
  return targets.filter((target, index) => targets.indexOf(target) !== index);
}

const endpointRecordOf = (type: 'directive' | 'decision' | 'finding'): Item => {
  if (type === 'directive') return directiveItem('r9', 'v1');
  if (type === 'decision') return workRecord('decision', 'b', decisionData());
  return workRecord('finding', 'b', findingData('NORMAL'));
};

describe('register', () => {
  beforeEach(openEnvironment);
  afterEach(closeEnvironment);

  it.each([
    {
      type: 'opening',
      process: WORK,
      build: () => workRecord('opening', 'main', opening()),
    },
    { type: 'decision', process: WORK, build: () => workRecord('decision', 'a', decisionData()) },
    { type: 'gap', process: WORK, build: () => workRecord('gap', 'a', gapData()) },
    {
      type: 'finding',
      process: WORK,
      build: () => workRecord('finding', 'a', findingData('NORMAL')),
    },
    { type: 'premise', process: WORK, build: () => premise('a') },
    {
      type: 'evidence',
      process: WORK,
      build: async () =>
        workRecord('evidence', 'a', { summary: 'Benchmarks agree', source: await attachText() }),
    },
    {
      type: 'directive',
      process: DIRECTIVES,
      build: async () => {
        await attachText('v1');
        return directiveItem('r1', 'v1');
      },
    },
    {
      type: 'doc',
      process: DIRECTIVES,
      build: async () => ({
        type: 'doc',
        target: 'directives.x',
        data: { path: docPath('x'), source: await attachText('v1') },
      }),
    },
  ])('should accept a valid $type record', async ({ process, build }) => {
    const record = await build();

    const { records } = await register(process, [record]);

    expect(records).toHaveLength(1);
  });

  it.each([
    { label: 'without grounds', data: omit(decisionData(), ['grounds']) },
    { label: 'without rationale', data: omit(decisionData(), ['rationale']) },
    { label: 'with an unknown field', data: decisionData({ extra: 'x' }) },
    { label: 'without alternatives', data: decisionData({ alternatives: [] }) },
    { label: 'with confidence outside the enum', data: decisionData({ confidence: 'sure' }) },
  ])('should refuse a decision $label with INVALID_RECORD', async ({ data }) => {
    expectError(await writeBatch(WORK, [workRecord('decision', 'bad', data)]), 'INVALID_RECORD');
  });

  it.each([
    {
      label: 'an opening with a mode outside the enum',
      record: workRecord('opening', 'main', { ...opening(), mode: 'x' }),
    },
    { label: 'a gap without context', record: workRecord('gap', 'a', { question: 'Q?' }) },
    {
      label: 'a finding with a severity outside the enum',
      record: workRecord('finding', 'a', findingData('HIGH')),
    },
  ])('should refuse $label with INVALID_RECORD', async ({ record }) => {
    expectError(await writeBatch(WORK, [record]), 'INVALID_RECORD');
  });

  it('should refuse a commit that is not a git-sha with code format at the field path', async () => {
    const result = await writeBatch(WORK, [
      workRecord('opening', 'main', { ...opening(), commit: 'HEAD' }),
    ]);

    expect(expectError(result, 'INVALID_RECORD').details).toEqual([
      expect.objectContaining({ path: '/records/0/data/commit', code: 'format' }),
    ]);
  });

  it('should accept an opening whose sync is pending', async () => {
    const { records } = await register(WORK, [
      workRecord('opening', 'main', { ...opening(), sync: 'pending' }),
    ]);

    expect(records).toHaveLength(1);
  });

  it('should refuse a doc with an empty path with INVALID_RECORD', async () => {
    const source = await attachText('v1');

    expectError(
      await writeBatch(DIRECTIVES, [
        { type: 'doc', target: 'directives.x', data: { path: '', source } },
      ]),
      'INVALID_RECORD',
    );
  });

  it('should accept a doc path outside docs/directives', async () => {
    const source = await attachText('v1');

    const { records } = await register(DIRECTIVES, [
      { type: 'doc', target: 'directives.x', data: { path: 'docs/x.md', source } },
    ]);

    expect(records).toHaveLength(1);
  });

  it('should refuse an attachment hash that was not stored with ATTACHMENT_NOT_FOUND', async () => {
    expectError(
      await writeBatch(DIRECTIVES, [directiveItem('r1', 'never attached')]),
      'ATTACHMENT_NOT_FOUND',
    );
  });

  it('should store anchored-in, about-gap and resolves-finding on a decision', async () => {
    const directiveId = await seedDirective();
    const gapId = await registerGap();
    const findingId = await registerOne(WORK, workRecord('finding', 'a', findingData('URGENT')));

    const decisionId = await registerOne(
      WORK,
      withRelations(workRecord('decision', 'a', decisionData()), [
        { to: directiveId, as: 'anchored-in' },
        { to: gapId, as: 'about-gap' },
        { to: findingId, as: 'resolves-finding' },
      ]),
    );

    expect((await outEdgesOf(decisionId)).map(({ as }) => as).sort()).toEqual([
      'about-gap',
      'anchored-in',
      'resolves-finding',
    ]);
  });

  it('should store closes-gap from a directive of another process to a gap', async () => {
    const gapId = await registerGap();
    await attachText('v1');

    const closerId = await registerOne(
      DIRECTIVES,
      directiveItem('r2', 'v1', [{ to: gapId, as: 'closes-gap' }]),
    );

    expect((await outEdgesOf(closerId)).map(({ as }) => as)).toEqual(['closes-gap']);
  });

  it.each([
    { process: DIRECTIVES, type: 'directive', relation: 'resolves-finding', to: 'finding' },
    { process: WORK, type: 'decision', relation: 'anchored-in', to: 'gap' },
    { process: WORK, type: 'decision', relation: 'about-gap', to: 'finding' },
    { process: WORK, type: 'decision', relation: 'closes-gap', to: 'gap' },
    { process: WORK, type: 'decision', relation: 'fills-gap', to: 'gap' },
    { process: WORK, type: 'decision', relation: 'rests-on', to: 'directive' },
    { process: WORK, type: 'finding', relation: 'rests-on', to: 'premise' },
  ] as const)(
    'should refuse $relation from a $type to a $to with endpoint-type',
    async ({ process, type, relation, to }) => {
      const ends = {
        directive: await seedDirective(),
        premise: await seedPremise(),
        gap: await registerGap(),
        finding: await registerOne(WORK, workRecord('finding', 'a', findingData('URGENT'))),
      };
      const record = withRelations(endpointRecordOf(type), [{ to: ends[to], as: relation }]);

      const body = expectError(await writeBatch(process, [record]), 'INVALID_RECORD');

      expect(body.details).toEqual([expect.objectContaining({ code: 'endpoint-type' })]);
    },
  );

  it('should accept a premise statement of up to 255 characters', async () => {
    const { records } = await register(WORK, [premise('a', 'x'.repeat(255))]);

    expect(records).toHaveLength(1);
  });

  it.each([
    { label: 'with a statement of 256 characters', data: { statement: 'x'.repeat(256) } },
    { label: 'with an empty statement', data: { statement: '' } },
    { label: 'with an extra field', data: { statement: 'ok', extra: 'x' } },
    { label: 'without a statement', data: {} },
    {
      label: 'with an answeredBy outside the enum',
      data: { statement: 'ok', answeredBy: 'robot' },
    },
    {
      label: 'with an actionUsed outside the enum',
      data: { statement: 'ok', actionUsed: 'robot' },
    },
  ])('should refuse a premise $label with INVALID_RECORD', async ({ data }) => {
    expectError(await writeBatch(WORK, [workRecord('premise', 'bad', data)]), 'INVALID_RECORD');
  });

  it.each(['human', 'simulated', 'simulated-approved'])(
    'should accept a premise with answeredBy %s',
    async (answeredBy) => {
      const { records } = await register(WORK, [
        workRecord('premise', 'a', { statement: 'ok', answeredBy }),
      ]);

      expect(records).toHaveLength(1);
    },
  );

  it.each(['local', 'web', 'jury'])(
    'should accept a premise with actionUsed %s',
    async (actionUsed) => {
      const { records } = await register(WORK, [
        workRecord('premise', 'a', { statement: 'ok', actionUsed }),
      ]);

      expect(records).toHaveLength(1);
    },
  );

  it.each([
    { label: 'without source', build: () => ({ summary: 'Benchmarks agree' }) },
    {
      label: 'with a source that is not a hash',
      build: () => ({ summary: 'Benchmarks agree', source: 'not-a-hash' }),
    },
    {
      label: 'with an extra field',
      build: (source: string) => ({ summary: 'Benchmarks agree', source, extra: 'x' }),
    },
  ])('should refuse evidence $label with INVALID_RECORD', async ({ build }) => {
    const source = await attachText();

    expectError(
      await writeBatch(WORK, [workRecord('evidence', 'bad', build(source))]),
      'INVALID_RECORD',
    );
  });

  it('should store rests-on from a decision to the premise of generation 2', async () => {
    await runSync(DIRECTIVES, STRATEGY, 'v1', premisesOf(1));
    const premiseId = await seedPremise();

    const decisionId = await registerOne(
      WORK,
      withRelations(workRecord('decision', 'a', decisionData()), [
        { to: premiseId, as: 'rests-on' },
      ]),
    );

    expect(await outEdgesOf(decisionId)).toEqual([
      expect.objectContaining({ as: 'rests-on', to: premiseId }),
    ]);
  });

  it('should store a raw derivesFrom from a work premise to a timeless premise', async () => {
    const timelessId = await seedPremise();

    const deliveryId = await registerOne(
      WORK,
      withRelations(premise('delivery'), [{ kind: 'derivesFrom', to: timelessId }]),
    );

    expect(await outEdgesOf(deliveryId)).toEqual([
      expect.objectContaining({ kind: 'derivesFrom', to: timelessId }),
    ]);
  });

  it('should store supports from evidence to the current decision', async () => {
    const source = await attachText();
    const decisionId = await registerOne(WORK, workRecord('decision', 'a', decisionData()));

    const evidenceId = await registerOne(
      WORK,
      withRelations(workRecord('evidence', 'a', { summary: 'Benchmarks agree', source }), [
        { kind: 'supports', to: decisionId },
      ]),
    );

    expect(await outEdgesOf(evidenceId)).toEqual([
      expect.objectContaining({ kind: 'supports', to: decisionId }),
    ]);
  });

  it('should refuse supports to a superseded decision with stale-destination', async () => {
    const source = await attachText();
    const decisionId = await registerOne(WORK, workRecord('decision', 'a', decisionData()));
    await register(WORK, [
      withRelations(workRecord('decision', 'a', decisionData({ choice: 'Redone' })), [
        { kind: 'supersedes', to: decisionId },
      ]),
    ]);

    const late = await writeBatch(WORK, [
      withRelations(workRecord('evidence', 'b', { summary: 'Late evidence', source }), [
        { kind: 'supports', to: decisionId },
      ]),
    ]);

    expect(expectError(late, 'INVALID_RECORD').details).toEqual([
      expect.objectContaining({ code: 'stale-destination' }),
    ]);
  });

  it('should refuse the same key with another batch with IDEMPOTENCY_CONFLICT', async () => {
    const plan = planSync(await inputFor(DIRECTIVES, 'fronteiras', 'v1', rulesOf(60)));
    await attachText('v1');
    const first = at(plan.batches, 0);
    await register(DIRECTIVES, first.records, first.key);

    const other = await writeBatch(DIRECTIVES, at(plan.batches, 1).records, first.key);

    expectError(other, 'IDEMPOTENCY_CONFLICT');
  });

  it('should refuse the stale batch of a concurrent sync with FORK_REJECTED', async () => {
    const stale = await staleBatch();

    expectError(await writeBatch(DIRECTIVES, stale.records, stale.key), 'FORK_REJECTED');
  });

  it('should accept the batch planned from an interpreted rule', async () => {
    const input = await inputFor(DIRECTIVES, 'fronteiras', 'v1', rulesOf(2));
    const plan = planSync({
      ...input,
      extracted: rulesOf(2).map((rule) => ({ ...rule, interpreted: true })),
    });
    await attachText('v1');

    const { records } = await register(
      DIRECTIVES,
      at(plan.batches, 0).records,
      at(plan.batches, 0).key,
    );

    expect(records).toHaveLength(3);
  });
});

describe('evaluate_gate', () => {
  beforeEach(openEnvironment);
  afterEach(closeEnvironment);

  describe('with the pre-pr gate', () => {
    it('should pass without any finding', async () => {
      expect(await passed('pre-pr')).toBe(true);
    });

    it('should fail with an URGENT finding that no decision resolves', async () => {
      await register(WORK, [workRecord('finding', 'a', findingData('URGENT'))]);

      expect(await passed('pre-pr')).toBe(false);
    });

    it('should pass when a decision resolves the URGENT finding', async () => {
      const directiveId = await seedDirective();
      const findingId = await registerOne(WORK, workRecord('finding', 'a', findingData('URGENT')));
      await register(WORK, [
        withRelations(
          workRecord(
            'decision',
            'fix',
            decisionData({ rationale: 'Accepted as is: the loop is bounded by the caller' }),
          ),
          [
            { to: findingId, as: 'resolves-finding' },
            { to: directiveId, as: 'anchored-in' },
          ],
        ),
      ]);

      expect(await passed('pre-pr')).toBe(true);
    });

    it('should not be blocked by a NORMAL finding', async () => {
      await registerOne(WORK, workRecord('finding', 'n', findingData('NORMAL')));

      expect(await passed('pre-pr')).toBe(true);
    });

    it('should keep failing when a raw answers of another type points to the URGENT finding', async () => {
      const urgentId = await registerOne(WORK, workRecord('finding', 'u', findingData('URGENT')));
      await register(WORK, [
        withRelations(workRecord('gap', 'g', gapData()), [{ kind: 'answers', to: urgentId }]),
      ]);

      expect(await passed('pre-pr')).toBe(false);
    });
  });

  describe('with the gaps gate', () => {
    const closeWithDirective = async (gapId: string) => {
      await attachText('v1');
      return register(DIRECTIVES, [
        directiveItem('retries', 'v1', [{ to: gapId, as: 'closes-gap' }]),
      ]);
    };
    const fillsGap = (gapId: string) => [{ to: gapId, as: 'fills-gap' }];

    it('should pass when there is no gap', async () => {
      expect(await passed('gaps')).toBe(true);
    });

    it('should fail when a gap is open', async () => {
      await registerGap();

      expect(await passed('gaps')).toBe(false);
    });

    it('should pass when a directive from another process closes the gap', async () => {
      const gapId = await registerGap();
      await closeWithDirective(gapId);

      expect(await passed('gaps')).toBe(true);
    });

    it('should keep failing when a redone decision and a raw answers point to the gap', async () => {
      const gapId = await registerGap();
      const firstId = await registerOne(
        WORK,
        withRelations(workRecord('decision', 'a', decisionData({ grounds: 'gap' })), [
          { to: gapId, as: 'about-gap' },
        ]),
      );
      await register(WORK, [
        withRelations(
          workRecord('decision', 'a', decisionData({ grounds: 'gap', choice: 'Redone' })),
          [
            { kind: 'supersedes', to: firstId },
            { to: gapId, as: 'about-gap' },
            { kind: 'answers', to: gapId },
          ],
        ),
      ]);

      expect(await passed('gaps')).toBe(false);
    });

    it('should pass for a premise recorded with no gap', async () => {
      await register(WORK, [premise('early')]);

      expect(await passed('gaps')).toBe(true);
    });

    it('should keep failing for a premise recorded before the gap with no relation to it', async () => {
      await register(WORK, [premise('early')]);
      await registerGap();

      expect(await passed('gaps')).toBe(false);
    });

    it('should pass when a premise in the same batch, after the gap, fills it by alias', async () => {
      await register(WORK, [
        { ...workRecord('gap', 'retry', gapData()), alias: 'gap' },
        withRelations(premise('fill'), [{ to: '@gap', as: 'fills-gap' }]),
      ]);

      expect(await passed('gaps')).toBe(true);
    });

    it('should pass when a premise recorded after the gap fills it by id', async () => {
      const gapId = await registerGap();
      await register(WORK, [withRelations(premise('fill'), fillsGap(gapId))]);

      expect(await passed('gaps')).toBe(true);
    });

    it('should fail while a directive closes one gap and the other is still open', async () => {
      const byDirective = await registerGap('a');
      await registerGap('b');
      await closeWithDirective(byDirective);

      expect(await passed('gaps')).toBe(false);
    });

    it('should pass when a directive closes one gap and a premise fills another', async () => {
      const [byDirective, byPremise] = [await registerGap('a'), await registerGap('b')];
      await closeWithDirective(byDirective);
      await register(WORK, [withRelations(premise('fill'), fillsGap(byPremise))]);

      expect(await passed('gaps')).toBe(true);
    });

    it('should reopen the gap when the premise that filled it is revoked', async () => {
      const gapId = await registerGap();
      const firstId = await registerOne(WORK, withRelations(premise('first'), fillsGap(gapId)));
      await register(WORK, [withRelations(premise('other'), [{ kind: 'revokes', to: firstId }])]);

      expect(await passed('gaps')).toBe(false);
    });

    it('should close the gap again when a third premise fills it after the revoke', async () => {
      const gapId = await registerGap();
      const firstId = await registerOne(WORK, withRelations(premise('first'), fillsGap(gapId)));
      await register(WORK, [withRelations(premise('other'), [{ kind: 'revokes', to: firstId }])]);
      await register(WORK, [withRelations(premise('third'), fillsGap(gapId))]);

      expect(await passed('gaps')).toBe(true);
    });

    it('should fail while only generation 2 holds a rule and nothing closes the gap', async () => {
      await registerGap();
      await runSync(`${DIRECTIVES}-2`, 'convencoes', 'v1', rulesOf(1));

      expect(await passed('gaps')).toBe(false);
    });

    it('should pass when generation 1 closes the gap with generation 2 present', async () => {
      const gapId = await registerGap();
      await runSync(`${DIRECTIVES}-2`, 'convencoes', 'v1', rulesOf(1));
      await runSync(DIRECTIVES, 'convencoes', 'v1', closingRules(rulesOf(1), gapId));

      expect(await passed('gaps')).toBe(true);
    });
  });

  describe('with a gate that resolves a decision by an incoming derivesFrom from a premise', () => {
    const process = 'anchor-check';
    let decisionId: string;

    const anchored = async (): Promise<boolean> =>
      (
        await environment.ok<{ passed: boolean }>('evaluate_gate', {
          project: PROJECT,
          process,
          gate: 'decision-anchored',
          target: process,
        })
      ).passed;

    beforeEach(async () => {
      await environment.ok('define_gate', {
        project: PROJECT,
        name: 'decision-anchored',
        questions: [
          {
            kind: 'no_pending',
            pending: { type: 'decision' },
            resolvedBy: { kind: 'derivesFrom', from: ['premise'] },
          },
        ],
      });
      await environment.ok('create_process', { project: PROJECT, process });
      const premiseId = await seedPremise();
      decisionId = await registerOne(
        process,
        withRelations({ type: 'decision', target: `${process}.decision.a`, data: decisionData() }, [
          { to: premiseId, as: 'rests-on' },
        ]),
      );
    });

    it('should keep a decision pending when it only rests on a premise', async () => {
      expect(await anchored()).toBe(false);
    });

    it('should resolve a pending decision by an incoming derivesFrom from a premise', async () => {
      await register(process, [
        withRelations(
          { type: 'premise', target: `${process}.premise.a`, data: { statement: 'p' } },
          [{ kind: 'derivesFrom', to: decisionId }],
        ),
      ]);

      expect(await anchored()).toBe(true);
    });
  });
});

describe('query', () => {
  beforeEach(openEnvironment);
  afterEach(closeEnvironment);

  it('should return only the record of the generation named by process', async () => {
    await runSync(DIRECTIVES, 'convencoes', 'v1', rulesOf(1));
    await runSync(`${DIRECTIVES}-2`, 'convencoes', 'v1', rulesOf(1));

    const { records } = await queryAll({
      process: `${DIRECTIVES}-2`,
      type: 'directive',
      targetPrefix: 'directives.convencoes.r1',
    });

    expect(records.map(({ id }) => id.split(':')[0])).toEqual([`${DIRECTIVES}-2`]);
  });

  it('should return the record of both generations with scope project', async () => {
    await runSync(DIRECTIVES, 'convencoes', 'v1', rulesOf(1));
    await runSync(`${DIRECTIVES}-2`, 'convencoes', 'v1', rulesOf(1));

    const { records } = await queryAll({
      scope: 'project',
      type: 'directive',
      targetPrefix: 'directives.convencoes.r1',
    });

    expect(records).toHaveLength(2);
  });

  it('should return only the premise of generation 2 with process', async () => {
    await runSync(DIRECTIVES, STRATEGY, 'v1', premisesOf(1));
    const premiseId = await seedPremise();

    const { records } = await queryAll({
      process: `${DIRECTIVES}-2`,
      type: 'premise',
      targetPrefix: `directives.${STRATEGY}.p1`,
    });

    expect(records.map(({ id }) => id)).toEqual([premiseId]);
  });

  it('should return the premise of both generations with scope project', async () => {
    await runSync(DIRECTIVES, STRATEGY, 'v1', premisesOf(1));
    await seedPremise();

    const { records } = await queryAll({
      scope: 'project',
      type: 'premise',
      targetPrefix: `directives.${STRATEGY}.p1`,
    });

    expect(records).toHaveLength(2);
  });

  it('should show the rests-on edge as not current when a sync supersedes the premise', async () => {
    const premiseId = await seedPremise();
    await registerOne(
      WORK,
      withRelations(workRecord('decision', 'a', decisionData()), [
        { to: premiseId, as: 'rests-on' },
      ]),
    );
    await runSync(`${DIRECTIVES}-2`, STRATEGY, 'v2', premisesOf(1, 'p', 2));

    const { records } = await queryAll({
      scope: 'project',
      targetPrefix: `${WORK}.decision.a`,
    });

    expect(records.flatMap(({ out }) => out)).toEqual([
      expect.objectContaining({ as: 'rests-on', to: premiseId, current: false }),
    ]);
  });

  it('should not list a duplicated current target after a normal sync', async () => {
    await runSync(DIRECTIVES, 'fronteiras', 'v1', rulesOf(2));

    expect(await duplicatedTargets()).toEqual([]);
  });

  it('should list a duplicated current target after two syncs planned from the same empty state', async () => {
    await runSync(DIRECTIVES, 'fronteiras', 'v1', rulesOf(2));
    // dois syncs que planejaram do mesmo estado vazio criam a mesma regra nova, sem supersedes
    await register(DIRECTIVES, [
      { ...directiveItem('r1', 'v1'), target: 'directives.fronteiras.r1' },
    ]);

    expect(await duplicatedTargets()).toEqual(['directives.fronteiras.r1']);
  });
});

describe('define_type', () => {
  beforeEach(openBareEnvironment);
  afterEach(closeEnvironment);

  it.each(namesIn('types').map((name) => ({ name })))(
    'should return the JCS hash of types/$name.json on the first definition',
    async ({ name }) => {
      const input = defineArgs('types', name);

      const result = await environment.ok<Defined>('define_type', { project: PROJECT, ...input });

      expect(result.hash).toBe(hashOfJcs(definitionOf('types', name)));
    },
  );
});

describe('define_relation', () => {
  beforeEach(openBareEnvironment);
  afterEach(closeEnvironment);

  it.each(namesIn('relations').map((name) => ({ name })))(
    'should return the JCS hash of relations/$name.json on the first definition',
    async ({ name }) => {
      const input = defineArgs('relations', name);

      const result = await environment.ok<Defined>('define_relation', {
        project: PROJECT,
        ...input,
      });

      expect(result.hash).toBe(hashOfJcs(definitionOf('relations', name)));
    },
  );
});

describe('define_gate', () => {
  beforeEach(openBareEnvironment);
  afterEach(closeEnvironment);

  it.each(namesIn('gates').map((name) => ({ name })))(
    'should return the JCS hash of gates/$name.json on the first definition',
    async ({ name }) => {
      const input = defineArgs('gates', name);

      const result = await environment.ok<Defined>('define_gate', { project: PROJECT, ...input });

      expect(result.hash).toBe(hashOfJcs(definitionOf('gates', name)));
    },
  );
});

describe('list', () => {
  beforeEach(openEnvironment);
  afterEach(closeEnvironment);

  it('should return, for a process, the hash of each kind map and every pinned definition', async () => {
    const list = await environment.ok<ListResult>('list', {
      project: PROJECT,
      process: DIRECTIVES,
    });

    const expected = Object.fromEntries(
      KINDS.map((kind) => [
        kind,
        hashOfJcs(
          Object.fromEntries(namesIn(kind).map((name) => [name, definitionOf(kind, name)])),
        ),
      ]),
    );

    expect(list.process?.hashes).toEqual(expected);
    expect(list.process?.pinned.types).toHaveLength(namesIn('types').length);
    expect(list.process?.pinned.relations).toHaveLength(namesIn('relations').length);
    expect(list.process?.pinned.gates).toHaveLength(namesIn('gates').length);
  });
});

describe('verify_chain', () => {
  beforeEach(openEnvironment);
  afterEach(closeEnvironment);

  /** Do abrir ao fechar os dois gates: abertura, decisões, lacuna, achado e a regra que fecha a lacuna. */
  async function completeWork(): Promise<void> {
    await runSync(DIRECTIVES, 'convencoes', 'v1', rulesOf(1));
    const directiveId = (await currentDirective('r1')).id;
    await register(WORK, [workRecord('opening', 'main', { ...opening(), sync: 'initial-load' })]);
    await register(WORK, [
      withRelations(workRecord('decision', 'a', decisionData()), [
        { to: directiveId, as: 'anchored-in' },
      ]),
    ]);
    const gapId = await registerGap();
    const gapDecisionId = await registerOne(
      WORK,
      withRelations(
        workRecord(
          'decision',
          'b',
          decisionData({ grounds: 'gap', choice: 'Provisional: 3 attempts' }),
        ),
        [{ to: gapId, as: 'about-gap' }],
      ),
    );
    const findingId = await registerOne(WORK, workRecord('finding', 'a', findingData('URGENT')));
    await register(WORK, [
      withRelations(
        workRecord('decision', 'fix', decisionData({ rationale: 'Bounded the retry loop' })),
        [
          { to: findingId, as: 'resolves-finding' },
          { to: directiveId, as: 'anchored-in' },
        ],
      ),
    ]);
    await runSync(DIRECTIVES, 'convencoes', 'v2', [
      ...rulesOf(1),
      ...closingRules(rulesOf(1, 'retry'), gapId),
    ]);
    const retryId = (await currentDirective('retry1')).id;
    await register(WORK, [
      withRelations(
        workRecord('decision', 'b', decisionData({ choice: 'Retry at most 3 times' })),
        [
          { kind: 'supersedes', to: gapDecisionId },
          { to: retryId, as: 'anchored-in' },
        ],
      ),
    ]);
  }

  it('should report both chains intact after a complete work', async () => {
    await completeWork();

    const chains = await Promise.all(
      [DIRECTIVES, WORK].map((process) =>
        environment.ok<VerifyChainResult>('verify_chain', { project: PROJECT, process }),
      ),
    );

    expect(chains.map(({ ok }) => ok)).toEqual([true, true]);
  });
});

describe('classifyTypeChange', () => {
  // o `premise.json` real, e não um tipo montado: o caso trava que a evolução do tipo entregue segue compatível
  it('should classify the optional answeredBy added to premise as compatible', () => {
    const previous: RecordType = {
      type: 'object',
      properties: { statement: { type: 'string', minLength: 1, maxLength: 255 } },
      required: ['statement'],
      additionalProperties: false,
    };

    expect(classifyTypeChange(previous, definitionOf('types', 'premise') as RecordType)).toBe(
      'compatible',
    );
  });

  it('should classify the optional actionUsed added to premise with answeredBy as compatible', () => {
    const previous: RecordType = {
      type: 'object',
      properties: {
        statement: { type: 'string', minLength: 1, maxLength: 255 },
        answeredBy: { type: 'string', enum: ['human', 'simulated', 'simulated-approved'] },
      },
      required: ['statement'],
      additionalProperties: false,
    };

    expect(classifyTypeChange(previous, definitionOf('types', 'premise') as RecordType)).toBe(
      'compatible',
    );
  });
});
