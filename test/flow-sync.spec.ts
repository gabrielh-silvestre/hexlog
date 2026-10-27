import { afterEach, beforeAll, beforeEach, describe, expect, it } from '@jest/globals';
import { omit } from 'es-toolkit';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { parsePremises, planSync, type SyncInput, type SyncPlan } from '../scripts/flow/sync.ts';
import { sha256hex } from '../src/domain/chain.ts';
import {
  DIRECTIVES,
  STRATEGY,
  attachText,
  closeEnvironment,
  closingRules,
  currentDirective,
  currentPremise,
  docPath,
  inputFor,
  openEnvironment,
  passed,
  premisesOf,
  queryAll,
  register,
  registerGap,
  rulesOf,
  runSync,
  staleBatch,
  writeBatch,
} from './flow-helpers.ts';
import { flowPath, repoRoot, runNode } from './flow-repo.ts';
import { at, createTempDir } from './helpers.ts';
import { expectError } from './mcp/environment.ts';

const REFUSED = { upToDate: false, batches: [], warnings: [], error: 'invalid-path' };
const UP_TO_DATE = { upToDate: true, batches: [], warnings: [] };
const R1_AND_RETRY = [...rulesOf(1), ...rulesOf(1, 'retry')];
const R1_AND_RETRY_V2 = [...rulesOf(1), ...rulesOf(1, 'retry', 2)];

const inputWith = (docSlug: string, path: string, extracted = rulesOf(1)): SyncInput => ({
  docSlug,
  path,
  hash: sha256hex('v1'),
  current: null,
  vigent: [],
  extracted,
});

const typesOf = (plan: SyncPlan) =>
  plan.batches.flatMap(({ records }) => records.map(({ type }) => type));

/** `convencoes` v1 com `count` regras e uma lacuna aberta; devolve o id da lacuna. */
async function seedGap(short = 'retry', count = 1): Promise<string> {
  await runSync(DIRECTIVES, 'convencoes', 'v1', rulesOf(count));
  return registerGap(short);
}

/** `convencoes` v1 com `r1`, uma lacuna e a v2 cuja regra `retry1` a fecha; devolve o id da lacuna. */
async function seedClosedGap(): Promise<string> {
  const gapId = await seedGap();
  await runSync(DIRECTIVES, 'convencoes', 'v2', [
    ...rulesOf(1),
    ...closingRules(rulesOf(1, 'retry'), gapId),
  ]);
  return gapId;
}

/** Planeja 60 regras, grava o 1º lote e recusa o 2º (doc com `removed` inválido). */
async function failSecondBatch() {
  const rules = rulesOf(60);
  const plan = planSync(await inputFor(DIRECTIVES, 'fronteiras', 'v1', rules));
  await attachText('v1');
  const [first, second] = [at(plan.batches, 0), at(plan.batches, 1)];
  const firstResult = await register(DIRECTIVES, first.records, first.key);
  const refused = second.records.map((record) =>
    record.type === 'doc' ? { ...record, data: { ...record.data, removed: 'x' } } : record,
  );
  expectError(await writeBatch(DIRECTIVES, refused, second.key), 'INVALID_RECORD');
  return { rules, first, second, firstResult };
}

describe('planSync', () => {
  describe('with static input', () => {
    it('should plan normally for the right path', () => {
      expect(planSync(inputWith('fronteiras', docPath('fronteiras'))).error).toBeUndefined();
    });

    it.each([
      { label: 'an empty path', docSlug: 'fronteiras', path: '' },
      { label: 'a path outside docs/directives', docSlug: 'fronteiras', path: 'docs/x.md' },
      { label: 'an absolute path', docSlug: 'fronteiras', path: `/tmp/${docPath('fronteiras')}` },
      { label: 'a path with ..', docSlug: 'fronteiras', path: 'docs/directives/../x.md' },
      {
        label: 'a path from another document',
        docSlug: 'fronteiras',
        path: docPath('convencoes'),
      },
      { label: 'a docSlug outside [a-z0-9-]', docSlug: '../x', path: docPath('../x') },
      {
        label: 'an absolute path in estrategia',
        docSlug: STRATEGY,
        path: `/tmp/${docPath(STRATEGY)}`,
      },
      {
        label: 'a path outside the pattern in estrategia',
        docSlug: STRATEGY,
        path: 'docs/estrategia.md',
      },
    ])('should return invalid-path with no batch for $label', ({ docSlug, path }) => {
      expect(planSync(inputWith(docSlug, path))).toEqual(REFUSED);
    });

    it('should return invalid-path for an up-to-date document', () => {
      const upToDate: SyncInput = {
        ...inputWith('fronteiras', 'docs/x.md'),
        current: { id: 'directives:0', source: sha256hex('v1') },
      };

      expect(planSync(upToDate)).toEqual(REFUSED);
    });

    it('should return invalid-path for a tombstone (extracted null)', () => {
      expect(planSync({ ...inputWith('fronteiras', ''), extracted: null })).toEqual(REFUSED);
    });

    it('should return too-many-relations when 100 rules are revoked at once', () => {
      const vigent = Array.from({ length: 100 }, (_, index) => ({
        id: `directives:${index}`,
        target: `directives.big.r${index}`,
        rule: 'r',
        section: 's',
        out: [],
      }));

      const plan = planSync({ ...inputWith('big', docPath('big'), []), vigent });

      expect(plan).toMatchObject({ upToDate: false, batches: [], error: 'too-many-relations' });
    });

    it('should split 60 rules into batches of 50 and 11 records', () => {
      const plan = planSync(inputWith('fronteiras', docPath('fronteiras'), rulesOf(60)));

      expect(plan.batches.map(({ records }) => records.length)).toEqual([50, 11]);
    });

    it('should put the doc last in the final batch', () => {
      const plan = planSync(inputWith('fronteiras', docPath('fronteiras'), rulesOf(60)));

      expect(at(plan.batches, 1).records.at(-1)?.type).toBe('doc');
    });

    it('should name each batch key after the doc and the content hashes', () => {
      const plan = planSync(inputWith('fronteiras', docPath('fronteiras'), rulesOf(60)));

      expect(plan.batches.map(({ key }) => key)).toEqual([
        expect.stringMatching(/^sync-fronteiras-[0-9a-f]{12}-[0-9a-f]{12}$/),
        expect.stringMatching(/^sync-fronteiras-[0-9a-f]{12}-[0-9a-f]{12}$/),
      ]);
    });

    it('should derive a different key for each batch', () => {
      const plan = planSync(inputWith('fronteiras', docPath('fronteiras'), rulesOf(60)));

      expect(at(plan.batches, 0).key).not.toBe(at(plan.batches, 1).key);
    });

    it('should not change the generated records for an interpreted rule', () => {
      const input = inputWith('fronteiras', docPath('fronteiras'), rulesOf(2));
      const interpreted = {
        ...input,
        extracted: rulesOf(2).map((rule) => ({ ...rule, interpreted: true })),
      };

      expect(planSync(interpreted)).toEqual(planSync(input));
    });

    it('should generate a premise whose data is only the statement', () => {
      const plan = planSync(inputWith(STRATEGY, docPath(STRATEGY), premisesOf(2)));

      expect(at(plan.batches, 0).records[0]).toEqual({
        type: 'premise',
        target: `directives.${STRATEGY}.p1`,
        data: { statement: 'Premise p1 v1' },
        relations: [],
      });
    });

    it('should put the premises before the doc', () => {
      const plan = planSync(inputWith(STRATEGY, docPath(STRATEGY), premisesOf(2)));

      expect(typesOf(plan)).toEqual(['premise', 'premise', 'doc']);
    });
  });

  describe('with a synced hexlog', () => {
    beforeEach(openEnvironment);
    afterEach(closeEnvironment);

    it('should load 60 rules in at least two query pages', async () => {
      await runSync(DIRECTIVES, 'fronteiras', 'v1', rulesOf(60));

      const loaded = await queryAll({
        process: DIRECTIVES,
        type: 'directive',
        targetPrefix: 'directives.fronteiras',
      });

      expect(loaded.records).toHaveLength(60);
      expect(loaded.pages).toBeGreaterThanOrEqual(2);
    });

    it('should swap only the doc on an editorial edit', async () => {
      const rules = rulesOf(60);
      await runSync(DIRECTIVES, 'fronteiras', 'v1', rules);

      const edit = await runSync(DIRECTIVES, 'fronteiras', 'v1 with a typo fixed', rules);

      expect(edit.batches).toHaveLength(1);
      expect(at(edit.batches, 0).records.map(({ type }) => type)).toEqual(['doc']);
    });

    it('should be up to date when the same edited text is synced again', async () => {
      const rules = rulesOf(60);
      await runSync(DIRECTIVES, 'fronteiras', 'v1', rules);
      await runSync(DIRECTIVES, 'fronteiras', 'v1 with a typo fixed', rules);

      const again = await runSync(DIRECTIVES, 'fronteiras', 'v1 with a typo fixed', rules);

      expect(again.upToDate).toBe(true);
    });

    it('should return up to date with no batch when the hash did not change', async () => {
      await runSync(DIRECTIVES, 'fronteiras', 'v1', rulesOf(3));

      const again = await runSync(DIRECTIVES, 'fronteiras', 'v1', rulesOf(3));

      expect(again).toEqual(UP_TO_DATE);
    });

    it('should keep the record of an untouched rule', async () => {
      await runSync(DIRECTIVES, 'fronteiras', 'v1', rulesOf(2));
      const untouched = await currentDirective('r1', 'fronteiras');

      await runSync(DIRECTIVES, 'fronteiras', 'v2', [at(rulesOf(2), 0), at(rulesOf(2, 'r', 2), 1)]);

      expect((await currentDirective('r1', 'fronteiras')).id).toBe(untouched.id);
    });

    it('should give a changed rule a new record', async () => {
      await runSync(DIRECTIVES, 'fronteiras', 'v1', rulesOf(2));
      const changed = await currentDirective('r2', 'fronteiras');

      await runSync(DIRECTIVES, 'fronteiras', 'v2', [at(rulesOf(2), 0), at(rulesOf(2, 'r', 2), 1)]);

      expect((await currentDirective('r2', 'fronteiras')).id).not.toBe(changed.id);
    });

    it('should plan only the changed rule and the doc', async () => {
      await runSync(DIRECTIVES, 'fronteiras', 'v1', rulesOf(2));

      const plan = await runSync(DIRECTIVES, 'fronteiras', 'v2', [
        at(rulesOf(2), 0),
        at(rulesOf(2, 'r', 2), 1),
      ]);

      expect(at(plan.batches, 0).records.map(({ target }) => target)).toEqual([
        'directives.fronteiras.r2',
        'directives.fronteiras',
      ]);
    });

    const rewrite = (): Promise<SyncPlan> =>
      runSync(DIRECTIVES, 'convencoes', 'v3', R1_AND_RETRY_V2);

    it('should copy closes-gap to the rewritten rule when the rewritten rule had closed a gap', async () => {
      const gapId = await seedClosedGap();

      const plan = await rewrite();

      expect(at(plan.batches, 0).records[0]?.relations).toEqual(
        expect.arrayContaining([expect.objectContaining({ as: 'closes-gap', to: gapId })]),
      );
    });

    it('should keep the gaps gate passing when the rewritten rule had closed a gap', async () => {
      await seedClosedGap();

      await rewrite();

      expect(await passed('gaps')).toBe(true);
    });

    it('should fail the gaps gate again when the rewrite of a rule that had closed a gap does not copy closes-gap', async () => {
      await seedClosedGap();

      await runSync(DIRECTIVES, 'convencoes', 'v3', R1_AND_RETRY_V2, (records) =>
        records.map((record) => ({
          ...record,
          relations: record.relations.filter(({ as }) => as !== 'closes-gap'),
        })),
      );

      expect(await passed('gaps')).toBe(false);
    });

    it('should keep the gap open when a new rule is synced without closes', async () => {
      await seedGap();
      await runSync(DIRECTIVES, 'convencoes', 'v2', R1_AND_RETRY);

      expect(await passed('gaps')).toBe(false);
    });

    const closeByRewrite = async () => {
      const gapId = await seedGap();
      await runSync(DIRECTIVES, 'convencoes', 'v2', R1_AND_RETRY);
      const before = await currentDirective('retry1');
      const plan = await runSync(DIRECTIVES, 'convencoes', 'v3', [
        ...rulesOf(1),
        ...closingRules(rulesOf(1, 'retry', 2), gapId),
      ]);
      return { gapId, before, plan };
    };

    it('should plan supersedes and closes-gap when a rewritten rule closes the gap', async () => {
      const { gapId, before, plan } = await closeByRewrite();

      expect(at(plan.batches, 0).records[0]?.relations).toEqual([
        { kind: 'supersedes', to: before.id },
        { to: gapId, as: 'closes-gap' },
      ]);
    });

    it('should pass the gaps gate when a rewritten rule closes the gap', async () => {
      await closeByRewrite();

      expect(await passed('gaps')).toBe(true);
    });

    const closeByNewRule = async () => {
      const gapId = await seedGap();
      const plan = await runSync(DIRECTIVES, 'convencoes', 'v2', [
        ...rulesOf(1),
        ...closingRules(rulesOf(1, 'retry'), gapId),
      ]);
      return { gapId, plan };
    };

    it('should plan only closes-gap, without supersedes, when a new rule closes the gap', async () => {
      const { gapId, plan } = await closeByNewRule();

      expect(at(plan.batches, 0).records[0]?.relations).toEqual([{ to: gapId, as: 'closes-gap' }]);
    });

    it('should pass the gaps gate when a new rule closes the gap', async () => {
      await closeByNewRule();

      expect(await passed('gaps')).toBe(true);
    });

    const closeByExistingRule = async () => {
      const gapId = await seedGap('retry', 2);
      const before = await currentDirective('r1');
      const plan = await runSync(DIRECTIVES, 'convencoes', 'v2', [
        ...closingRules(rulesOf(1), gapId),
        ...rulesOf(2).slice(1),
      ]);
      return { gapId, before, plan };
    };

    it('should plan the rule and the doc when an existing unchanged rule closes the gap', async () => {
      const { plan } = await closeByExistingRule();

      expect(at(plan.batches, 0).records.map(({ target }) => target)).toEqual([
        'directives.convencoes.r1',
        'directives.convencoes',
      ]);
    });

    it('should turn the rule into supersedes plus closes-gap when an existing unchanged rule closes the gap', async () => {
      const { gapId, before, plan } = await closeByExistingRule();

      expect(at(plan.batches, 0).records[0]?.relations).toEqual([
        { kind: 'supersedes', to: before.id },
        { to: gapId, as: 'closes-gap' },
      ]);
    });

    it('should pass the gaps gate when an existing unchanged rule closes the gap', async () => {
      await closeByExistingRule();

      expect(await passed('gaps')).toBe(true);
    });

    const closeWithoutNewDoc = async () => {
      const gapId = await seedGap();
      const before = await currentDirective('r1');
      const plan = await runSync(DIRECTIVES, 'convencoes', 'v1', closingRules(rulesOf(1), gapId));
      return { gapId, before, plan };
    };

    it('should plan only the rule, with no new doc, when the doc text is up to date and a rule closes the gap', async () => {
      const { plan } = await closeWithoutNewDoc();

      expect(plan.upToDate).toBe(false);
      expect(at(plan.batches, 0).records.map(({ target }) => target)).toEqual([
        'directives.convencoes.r1',
      ]);
    });

    it('should plan supersedes plus closes-gap when the doc text is up to date and a rule closes the gap', async () => {
      const { gapId, before, plan } = await closeWithoutNewDoc();

      expect(at(plan.batches, 0).records[0]?.relations).toEqual([
        { kind: 'supersedes', to: before.id },
        { to: gapId, as: 'closes-gap' },
      ]);
    });

    it('should pass the gaps gate when the doc text is up to date and a rule closes the gap', async () => {
      await closeWithoutNewDoc();

      expect(await passed('gaps')).toBe(true);
    });

    it('should yield no new record for a rule that already closes the gap', async () => {
      const firstGap = await seedGap('a');
      await registerGap('b');
      await runSync(DIRECTIVES, 'convencoes', 'v2', closingRules(rulesOf(1), firstGap));

      const again = planSync(
        await inputFor(DIRECTIVES, 'convencoes', 'v3', closingRules(rulesOf(1), firstGap)),
      );

      expect(typesOf(again)).toEqual(['doc']);
    });

    const repeatClose = async () => {
      const firstGap = await seedGap('a');
      const secondGap = await registerGap('b');
      await runSync(DIRECTIVES, 'convencoes', 'v2', closingRules(rulesOf(1), firstGap));
      const plan = await runSync(DIRECTIVES, 'convencoes', 'v4', [
        { ...at(rulesOf(1, 'r', 2), 0), closes: [firstGap, secondGap, secondGap] },
      ]);
      return { firstGap, secondGap, plan };
    };

    it('should not duplicate the copied closes-gap edge when closes repeats a gap', async () => {
      const { firstGap, secondGap, plan } = await repeatClose();

      const closes = at(plan.batches, 0).records[0]?.relations.filter(
        ({ as }) => as === 'closes-gap',
      );

      expect(closes?.map(({ to }) => to).sort()).toEqual([firstGap, secondGap].sort());
    });

    it('should pass the gaps gate when closes repeats a gap', async () => {
      await repeatClose();

      expect(await passed('gaps')).toBe(true);
    });

    it('should warn that the gap reopens when a rule that closed a gap is removed', async () => {
      const gapId = await seedClosedGap();

      const plan = await runSync(DIRECTIVES, 'convencoes', 'v3', rulesOf(1));

      expect(plan.warnings).toEqual([{ code: 'reopens-gap', rule: 'retry1', gaps: [gapId] }]);
    });

    it('should drop a removed rule that closed a gap from the current set', async () => {
      await seedClosedGap();

      await runSync(DIRECTIVES, 'convencoes', 'v3', rulesOf(1));

      const rules = await queryAll({
        process: DIRECTIVES,
        type: 'directive',
        targetPrefix: 'directives.convencoes',
      });

      expect(rules.records.map(({ target }) => target)).toEqual(['directives.convencoes.r1']);
    });

    it('should fail the gaps gate when a rule that closed a gap is removed', async () => {
      await seedClosedGap();

      await runSync(DIRECTIVES, 'convencoes', 'v3', rulesOf(1));

      expect(await passed('gaps')).toBe(false);
    });

    const removeSecondRule = async () => {
      await seedGap('retry', 2);
      return runSync(DIRECTIVES, 'convencoes', 'v2', rulesOf(1));
    };

    it('should yield no warning when a rule that closed no gap is removed', async () => {
      const plan = await removeSecondRule();

      expect(plan.warnings).toEqual([]);
    });

    it('should revoke the rule in the doc when a rule that closed no gap is removed', async () => {
      const plan = await removeSecondRule();

      expect(
        at(plan.batches, 0)
          .records.at(-1)
          ?.relations.filter(({ kind }) => kind === 'revokes'),
      ).toHaveLength(1);
    });

    const deleteDocument = async () => {
      await runSync(DIRECTIVES, 'fronteiras', 'v1', rulesOf(2));
      const before = await inputFor(DIRECTIVES, 'fronteiras', null, null);
      const plan = await runSync(DIRECTIVES, 'fronteiras', null, null);
      return { before, plan };
    };

    it('should write a tombstone doc that keeps the source of a deleted document', async () => {
      const { before, plan } = await deleteDocument();

      expect(at(plan.batches, 0).records.at(-1)?.data).toEqual({
        path: docPath('fronteiras'),
        source: before.current?.source,
        removed: true,
      });
    });

    it('should revoke each rule and supersede the doc in the tombstone of a deleted document', async () => {
      const { plan } = await deleteDocument();

      expect(at(plan.batches, 0).records.at(-1)?.relations).toHaveLength(3);
    });

    it('should drop the rules of the deleted document from the current set', async () => {
      await deleteDocument();

      const after = await inputFor(DIRECTIVES, 'fronteiras', null, null);

      expect(after.vigent).toEqual([]);
    });

    it('should mark the current doc as removed when the document is deleted', async () => {
      await deleteDocument();

      const after = await inputFor(DIRECTIVES, 'fronteiras', null, null);

      expect(after.current?.removed).toBe(true);
    });

    it('should be up to date when the deleted document is synced again', async () => {
      await deleteDocument();

      const again = await runSync(DIRECTIVES, 'fronteiras', null, null);

      expect(again.upToDate).toBe(true);
    });

    it('should supersede the tombstone when the deleted document is recreated', async () => {
      await deleteDocument();
      const tombstoned = await inputFor(DIRECTIVES, 'fronteiras', null, null);

      const back = await runSync(DIRECTIVES, 'fronteiras', 'v2', rulesOf(1));

      expect(at(back.batches, 0).records.at(-1)?.relations).toEqual([
        { kind: 'supersedes', to: tombstoned.current?.id },
      ]);
    });

    it('should no longer mark the doc as removed when the deleted document is recreated', async () => {
      await deleteDocument();
      await runSync(DIRECTIVES, 'fronteiras', 'v2', rulesOf(1));

      const recreated = await inputFor(DIRECTIVES, 'fronteiras', 'v2', null);

      expect(recreated.current?.removed).toBe(false);
    });

    it('should yield no batch for a document that never had a sync and was deleted', async () => {
      expect(await runSync(DIRECTIVES, 'fantasma', null, null)).toEqual(UP_TO_DATE);
    });

    it('should plan only the missing batch of 11 records after the second batch failed', async () => {
      const { rules } = await failSecondBatch();

      const resync = await runSync(DIRECTIVES, 'fronteiras', 'v1', rules);

      expect(resync.batches.map(({ records }) => records.length)).toEqual([11]);
    });

    // o lote recusado não gravou nada, então o replanejamento gera o mesmo lote e a mesma key
    it('should plan the missing batch with the same key after the second batch failed', async () => {
      const { rules, second } = await failSecondBatch();

      const resync = await runSync(DIRECTIVES, 'fronteiras', 'v1', rules);

      expect(at(resync.batches, 0).key).toBe(second.key);
    });

    it('should be up to date after a re-sync that follows the failed second batch', async () => {
      const { rules } = await failSecondBatch();
      await runSync(DIRECTIVES, 'fronteiras', 'v1', rules);

      const again = await runSync(DIRECTIVES, 'fronteiras', 'v1', rules);

      expect(again.upToDate).toBe(true);
    });

    it('should replay the first batch when it is resent after the re-sync of a failed second batch', async () => {
      const { rules, first, firstResult } = await failSecondBatch();
      await runSync(DIRECTIVES, 'fronteiras', 'v1', rules);

      const replay = await register(DIRECTIVES, first.records, first.key);

      expect(replay.replayed).toBe(true);
      expect(replay.records).toEqual(firstResult.records);
    });

    it('should redo the sync from the new state after FORK_REJECTED', async () => {
      await staleBatch();

      const redone = await runSync(DIRECTIVES, 'fronteiras', 'v2', rulesOf(1, 'r', 2));

      expect(redone.upToDate).toBe(false);
      expect((await currentDirective('r1', 'fronteiras')).data?.rule).toContain('v2');
    });

    it('should fit the revocation of 99 rules in 100 relations', async () => {
      await runSync(DIRECTIVES, 'fronteiras', 'v1', rulesOf(99));

      const plan = await runSync(DIRECTIVES, 'fronteiras', 'v2', []);

      expect(plan.error).toBeUndefined();
      expect(at(plan.batches, 0).records[0]?.relations).toHaveLength(100);
    });

    it('should still generate a directive with source and section after a strategy doc is synced', async () => {
      await runSync(DIRECTIVES, STRATEGY, 'v1', premisesOf(1));

      const convencoes = await runSync(DIRECTIVES, 'convencoes', 'v1', rulesOf(1));

      expect(at(convencoes.batches, 0).records[0]).toMatchObject({
        type: 'directive',
        data: { section: 'Section', source: sha256hex('v1') },
      });
    });
  });

  describe('with the estrategia document', () => {
    beforeEach(openEnvironment);
    afterEach(closeEnvironment);

    it('should generate nothing when the same text is synced twice', async () => {
      await runSync(DIRECTIVES, STRATEGY, 'v1', premisesOf(2));

      const again = await runSync(DIRECTIVES, STRATEGY, 'v1', premisesOf(2));

      expect(again).toEqual(UP_TO_DATE);
    });

    it('should plan only a supersedes relation for a changed premise, ignoring closes', async () => {
      await runSync(DIRECTIVES, STRATEGY, 'v1', premisesOf(2));
      const before = await currentPremise('p2');
      const gapId = await registerGap();
      const edited = [at(premisesOf(2), 0), { ...at(premisesOf(2, 'p', 2), 1), closes: [gapId] }];

      const plan = await runSync(DIRECTIVES, STRATEGY, 'v2', edited);

      expect(at(plan.batches, 0).records.map(({ target }) => target)).toEqual([
        `directives.${STRATEGY}.p2`,
        `directives.${STRATEGY}`,
      ]);
      expect(at(plan.batches, 0).records[0]?.relations).toEqual([
        { kind: 'supersedes', to: before.id },
      ]);
    });

    it('should revoke, in the doc, a slug that was removed', async () => {
      await runSync(DIRECTIVES, STRATEGY, 'v1', premisesOf(2));
      const removed = await currentPremise('p2');

      const plan = await runSync(DIRECTIVES, STRATEGY, 'v2', premisesOf(1));

      expect(
        at(plan.batches, 0)
          .records.at(-1)
          ?.relations.filter(({ kind }) => kind === 'revokes'),
      ).toEqual([{ kind: 'revokes', to: removed.id }]);
    });

    it('should stay up to date when closes and section change on an up-to-date doc', async () => {
      await runSync(DIRECTIVES, STRATEGY, 'v1', premisesOf(1));
      const gapId = await registerGap();
      const noisy = premisesOf(1).map((rule) => ({ ...rule, section: 'Theme', closes: [gapId] }));

      const upToDate = await runSync(DIRECTIVES, STRATEGY, 'v1', noisy);

      expect(upToDate).toEqual(UP_TO_DATE);
    });

    it('should plan the same batches with or without closes and section on a changed doc', async () => {
      await runSync(DIRECTIVES, STRATEGY, 'v1', premisesOf(1));
      const gapId = await registerGap();
      const input = await inputFor(DIRECTIVES, STRATEGY, 'v2', premisesOf(1, 'p', 2));
      const clean = planSync(input);

      expect(clean.batches).not.toEqual([]);

      const withNoise = planSync({
        ...input,
        extracted: premisesOf(1, 'p', 2).map((rule) => ({
          ...rule,
          section: 'Theme',
          closes: [gapId],
        })),
      });

      expect(withNoise).toEqual(clean);
    });

    it('should not rewrite the premise on an up-to-date doc, even with a different statement and closes', async () => {
      await runSync(DIRECTIVES, STRATEGY, 'v1', premisesOf(1));
      const gapId = await registerGap();
      const closing = premisesOf(1, 'p', 2).map((rule) => ({ ...rule, closes: [gapId] }));

      const plan = planSync(await inputFor(DIRECTIVES, STRATEGY, 'v1', closing));

      expect(plan).toEqual(UP_TO_DATE);
    });
  });
});

describe('scripts/flow/flow.ts sync-plan on estrategia.md', () => {
  const estrategiaPath = docPath(STRATEGY);

  /** O mesmo caminho da skill: o CLI lê o documento em `input.path`, extrai as premissas e planeja. */
  const runFlow = (input: Omit<SyncInput, 'extracted'>, cwd = repoRoot, script = flowPath) =>
    runNode(script, ['sync-plan'], { cwd, input: JSON.stringify(input) });

  const flowPlan = (input: Omit<SyncInput, 'extracted'>): SyncPlan => {
    const result = runFlow(input);

    expect(result.stderr).toBe('');
    expect(result.status).toBe(0);

    return JSON.parse(result.stdout) as SyncPlan;
  };

  const inputForFile = (file: string): Omit<SyncInput, 'extracted'> => ({
    docSlug: STRATEGY,
    path: file,
    hash: '',
    current: null,
    vigent: [],
  });

  // conta os bullets `- \`slug\`:` por regex, sem o parser do alvo
  const premiseCountOf = (text: string): number => text.match(/^- `[a-z0-9-]+`:/gm)?.length ?? 0;

  describe('with the real document registered in a hexlog', () => {
    beforeEach(openEnvironment);
    afterEach(closeEnvironment);

    const realText = (): string => fs.readFileSync(path.join(repoRoot, estrategiaPath), 'utf8');
    const realInput = async () =>
      omit(await inputFor(DIRECTIVES, STRATEGY, realText(), []), ['extracted']);

    it('should turn the real estrategia.md into one batch of premises plus the doc', async () => {
      const count = premiseCountOf(realText());

      const plan = flowPlan(await realInput());

      expect(plan.batches).toHaveLength(1);
      expect(at(plan.batches, 0).records.map(({ type }) => type)).toEqual([
        ...Array.from({ length: count }, () => 'premise'),
        'doc',
      ]);
    }, 30_000);

    it('should be up to date on the second run once the batch is registered', async () => {
      const batch = at(flowPlan(await realInput()).batches, 0);
      await attachText(realText());
      await register(DIRECTIVES, batch.records, batch.key);

      const again = flowPlan(await realInput());

      expect(again).toEqual(UP_TO_DATE);
    }, 30_000);
  });

  it('should resolve a relative path from the repository root, with the cwd in another directory', () => {
    const result = runFlow(inputForFile(estrategiaPath), createTempDir('other-cwd'));

    expect(result.stderr).toBe('');
    expect(result.status).toBe(0);
    expect((JSON.parse(result.stdout) as SyncPlan).batches).toHaveLength(1);
  }, 15_000);

  describe('with a malformed document in a temporary repository', () => {
    const flowDir = path.join(repoRoot, 'scripts/flow');
    let root: string;

    // o `REPO_ROOT` do CLI é o repositório temporário, então o `path` relativo vale ali
    beforeAll(() => {
      root = createTempDir('strategy');
      fs.mkdirSync(path.join(root, 'scripts/flow'), { recursive: true });
      for (const file of fs.readdirSync(flowDir).filter((f) => f.endsWith('.ts'))) {
        fs.copyFileSync(path.join(flowDir, file), path.join(root, 'scripts/flow', file));
      }
      fs.mkdirSync(path.join(root, 'docs/directives'), { recursive: true });
    }, 15_000);

    it.each([
      {
        name: 'a malformed line',
        lines: ['- sem crase: linha ruim'],
        reason: /- sem crase: linha ruim/,
      },
      {
        name: 'a repeated slug',
        lines: ['- `a`: Um. Ver: [x](x.md)', '- `a`: Dois. Ver: [x](x.md)'],
        reason: /duplicate slug "a"/,
      },
      {
        name: 'a statement of 256 code points',
        lines: [`- \`a\`: ${'𝒳'.repeat(256)}`],
        reason: /"a" has 256 code points/,
      },
    ])(
      'should exit with 2 and the reason on stderr for $name',
      ({ lines, reason }) => {
        fs.writeFileSync(path.join(root, estrategiaPath), ['## Tema', ...lines].join('\n'));

        const result = runFlow(
          inputForFile(estrategiaPath),
          root,
          path.join(root, 'scripts/flow/flow.ts'),
        );

        expect(result.status).toBe(2);
        expect(result.stdout).toBe('');
        expect(result.stderr).toMatch(reason);
      },
      15_000,
    );
  });
});

describe('parsePremises', () => {
  it('should pass a statement of 255 code points, even with 510 UTF-16 units', () => {
    const text = ['## Tema', `- \`a\`: ${'𝒳'.repeat(255)} Ver: [x](x.md)`].join('\n');

    expect(parsePremises(text)).toEqual({
      rules: [{ slug: 'a', rule: '𝒳'.repeat(255), section: '' }],
      malformed: [],
    });
  });
});
