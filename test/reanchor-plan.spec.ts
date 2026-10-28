import * as fs from 'node:fs';
import * as path from 'node:path';
import { describe, expect, it } from '@jest/globals';
import { ZodError } from 'zod';
import {
  COPIED_NAMES,
  type DecisionRow,
  type LogRow,
  type PlannedItem,
  type Source,
  formatPlan,
  generationOf,
  isLatestGeneration,
  planReanchor,
  summarizeApply,
  toBatches,
  verifyReanchor,
} from '../scripts/flow/reanchor-plan.ts';
import { anchoredIn, restsOn } from './helpers.ts';

const uuid = (n: number): string => `01a15a00-0000-7000-8000-${String(n).padStart(12, '0')}`;
const id = (generation: number, n: number): string => `directives-${generation}:${uuid(n)}`;
const own = (process: string, n: number): string => `${process}:${uuid(n)}`;

const directive = (generation: number, n: number, target: string, rule: string): Source => ({
  id: id(generation, n),
  type: 'directive',
  target,
  text: rule,
  current: true,
});
const premise = (generation: number, n: number, target: string, statement: string): Source => ({
  id: id(generation, n),
  type: 'premise',
  target,
  text: statement,
  current: true,
});

const OLD_DIRECTIVE = directive(3, 1, 'directives.a.rule', 'Rule text');
const NEW_DIRECTIVE = directive(4, 1, 'directives.a.rule', 'Rule text');
const OLD_PREMISE = premise(3, 2, 'directives.estrategia.p', 'Premise text');
const NEW_PREMISE = premise(4, 2, 'directives.estrategia.p', 'Premise text');

function decision(overrides: Partial<DecisionRow> = {}): DecisionRow {
  return {
    process: 'work-a',
    id: own('work-a', 1),
    target: 'work-a.decision.x',
    data: { choice: 'A' },
    out: [anchoredIn(OLD_DIRECTIVE.id), restsOn(OLD_PREMISE.id)],
    in: [],
    lineage: false,
    ...overrides,
  };
}

function plan(
  decisions: DecisionRow[],
  { older = [OLD_DIRECTIVE, OLD_PREMISE], current = [NEW_DIRECTIVE, NEW_PREMISE] } = {},
) {
  return planReanchor({ to: 'directives-4', decisions, older: { 'directives-3': older }, current });
}

function firstRewrite(decisions: DecisionRow[]) {
  const [first] = plan(decisions).rewrites;
  if (first === undefined) throw new Error('expected a rewrite');
  return first;
}

describe('generationOf', () => {
  it('should read the generation from an id and from a process name', () => {
    expect(generationOf(id(10, 1))).toBe(10);
    expect(generationOf('directives-4')).toBe(4);
  });

  it('should be undefined for a name that is not a generation', () => {
    expect(generationOf('directives-4x')).toBeUndefined();
    expect(generationOf('feat-x:01a15a00')).toBeUndefined();
  });
});

describe('isLatestGeneration', () => {
  it('should compare generations as numbers', () => {
    const names = ['directives-9', 'directives-10', 'work-a'];

    expect(isLatestGeneration('directives-10', names)).toBe(true);
    expect(isLatestGeneration('directives-9', names)).toBe(false);
  });

  it('should be false when the target generation is absent or invalid', () => {
    expect(isLatestGeneration('directives-4', ['directives-3'])).toBe(false);
    expect(isLatestGeneration('work-a', ['work-a'])).toBe(false);
  });
});

describe('planReanchor', () => {
  it('should rewrite a decision whose anchors are all the same', () => {
    const result = plan([
      decision({
        out: [
          anchoredIn(OLD_DIRECTIVE.id),
          restsOn(OLD_PREMISE.id),
          restsOn(own('work-a', 50)),
          { kind: 'derivesFrom', as: 'about-gap', to: own('work-a', 51) },
          { kind: 'derivesFrom', as: 'resolves-finding', to: own('work-a', 52) },
          { kind: 'derivesFrom', to: own('work-a', 53) },
        ],
      }),
    ]);

    expect(result.owner).toEqual([]);
    expect(result.rewrites).toEqual([
      {
        process: 'work-a',
        id: own('work-a', 1),
        item: {
          type: 'decision',
          target: 'work-a.decision.x',
          data: { choice: 'A' },
          relations: [
            { kind: 'supersedes', to: own('work-a', 1) },
            anchoredIn(NEW_DIRECTIVE.id),
            restsOn(NEW_PREMISE.id),
            restsOn(own('work-a', 50)),
            { kind: 'derivesFrom', as: 'about-gap', to: own('work-a', 51) },
            { kind: 'derivesFrom', as: 'resolves-finding', to: own('work-a', 52) },
            { kind: 'derivesFrom', to: own('work-a', 53) },
          ],
        },
      },
    ]);
  });

  it('should keep the sentinel premise as an ordinary same anchor', () => {
    const oldSentinel = premise(3, 9, 'directives.estrategia.none', 'No premise applies');
    const newSentinel = premise(4, 9, 'directives.estrategia.none', 'No premise applies');

    const result = plan([decision({ out: [restsOn(oldSentinel.id)] })], {
      older: [oldSentinel],
      current: [newSentinel],
    });

    expect(result.rewrites[0]?.item.relations).toEqual([
      { kind: 'supersedes', to: own('work-a', 1) },
      restsOn(newSentinel.id),
    ]);
  });

  it('should copy about-gap and raw derivesFrom to an old generation as they are', () => {
    const result = plan([
      decision({
        out: [
          anchoredIn(OLD_DIRECTIVE.id),
          { kind: 'derivesFrom', as: 'about-gap', to: OLD_DIRECTIVE.id },
          { kind: 'derivesFrom', to: OLD_PREMISE.id },
        ],
      }),
    ]);

    expect(result.rewrites[0]?.item.relations).toEqual([
      { kind: 'supersedes', to: own('work-a', 1) },
      anchoredIn(NEW_DIRECTIVE.id),
      { kind: 'derivesFrom', as: 'about-gap', to: OLD_DIRECTIVE.id },
      { kind: 'derivesFrom', to: OLD_PREMISE.id },
    ]);
  });

  it('should drop the stored current flag from the copied relations', () => {
    const stored = { ...anchoredIn(OLD_DIRECTIVE.id), current: true };

    const result = plan([decision({ out: [stored] })]);

    expect(result.rewrites[0]?.item.relations[1]).toEqual(anchoredIn(NEW_DIRECTIVE.id));
  });

  it.each([
    ['changed rule', { current: [directive(4, 1, 'directives.a.rule', 'Other text')] }, 'changed'],
    ['changed type', { current: [premise(4, 1, 'directives.a.rule', 'Rule text')] }, 'changed'],
    ['missing target', { current: [] }, 'gone'],
    [
      'repeated target',
      { current: [NEW_DIRECTIVE, directive(4, 7, 'directives.a.rule', 'Rule text')] },
      'ambiguous',
    ],
  ])('should send the decision to the owner on %s', (_label, options, state) => {
    const result = plan([decision({ out: [anchoredIn(OLD_DIRECTIVE.id)] })], {
      older: [OLD_DIRECTIVE],
      ...options,
    });

    expect(result.rewrites).toEqual([]);
    expect(result.owner).toEqual([
      {
        process: 'work-a',
        id: own('work-a', 1),
        target: 'work-a.decision.x',
        reasons: [
          {
            code: 'anchor',
            name: 'anchored-in',
            to: OLD_DIRECTIVE.id,
            target: 'directives.a.rule',
            state,
          },
        ],
      },
    ]);
  });

  it('should send a type without a text field to the owner as changed', () => {
    const oldDoc: Source = { id: id(3, 5), type: 'doc', target: 'directives.a', current: true };
    const newDoc: Source = { id: id(4, 5), type: 'doc', target: 'directives.a', current: true };

    const result = plan([decision({ out: [anchoredIn(oldDoc.id)] })], {
      older: [oldDoc],
      current: [newDoc],
    });

    expect(result.owner[0]?.reasons).toMatchObject([{ state: 'changed' }]);
  });

  it('should flag a non-current cited record as stale even when the new text is equal', () => {
    const result = plan([decision({ out: [anchoredIn(OLD_DIRECTIVE.id)] })], {
      older: [{ ...OLD_DIRECTIVE, current: false }],
    });

    expect(result.owner[0]?.reasons).toMatchObject([{ state: 'stale' }]);
  });

  it('should flag a cited id missing from the old generation as stale', () => {
    const result = plan([decision({ out: [anchoredIn(id(3, 99))] })]);

    expect(result.owner[0]?.reasons).toEqual([
      { code: 'anchor', name: 'anchored-in', to: id(3, 99), target: undefined, state: 'stale' },
    ]);
  });

  it('should handle anchors in two old generations', () => {
    const older = {
      'directives-2': [directive(2, 1, 'directives.a.rule', 'Rule text')],
      'directives-3': [OLD_PREMISE],
    };

    const result = planReanchor({
      to: 'directives-4',
      decisions: [decision({ out: [anchoredIn(id(2, 1)), restsOn(OLD_PREMISE.id)] })],
      older,
      current: [NEW_DIRECTIVE, NEW_PREMISE],
    });

    expect(result.rewrites[0]?.item.relations).toEqual([
      { kind: 'supersedes', to: own('work-a', 1) },
      anchoredIn(NEW_DIRECTIVE.id),
      restsOn(NEW_PREMISE.id),
    ]);
  });

  it('should ignore anchors to the target generation or later', () => {
    const result = plan([decision({ out: [anchoredIn(NEW_DIRECTIVE.id), anchoredIn(id(5, 1))] })]);

    expect(result).toEqual({ rewrites: [], owner: [] });
  });

  it('should ignore a decision without old anchors', () => {
    const result = plan([decision({ out: [restsOn(own('work-a', 60))] })]);

    expect(result).toEqual({ rewrites: [], owner: [] });
  });

  it('should take the whole decision out, listing every anchor, when one anchor is outside same', () => {
    const result = plan([decision()], {
      current: [NEW_DIRECTIVE, { ...NEW_PREMISE, text: 'Changed' }],
    });

    expect(result.rewrites).toEqual([]);
    expect(result.owner[0]?.reasons).toMatchObject([
      { name: 'anchored-in', state: 'same' },
      { name: 'rests-on', state: 'changed' },
    ]);
  });

  it.each(['supports', 'contradicts', 'answers', 'complements', 'reopens', 'revokes'])(
    'should send a decision with an outgoing %s to the owner',
    (kind) => {
      const result = plan([
        decision({ out: [anchoredIn(OLD_DIRECTIVE.id), { kind, to: own('work-a', 70) }] }),
      ]);

      expect(result.rewrites).toEqual([]);
      expect(result.owner[0]?.reasons).toEqual([
        { code: 'other-relation', name: kind, to: own('work-a', 70) },
      ]);
    },
  );

  it('should rewrite a decision that was already a version, dropping the old outgoing supersedes', () => {
    const result = plan([
      decision({
        out: [{ kind: 'supersedes', to: own('work-a', 0) }, anchoredIn(OLD_DIRECTIVE.id)],
      }),
    ]);

    expect(result.rewrites[0]?.item.relations).toEqual([
      { kind: 'supersedes', to: own('work-a', 1) },
      anchoredIn(NEW_DIRECTIVE.id),
    ]);
  });

  it.each(['work-a', 'work-b'])(
    'should send a decision with a current incoming supports from %s to the owner without lineage',
    (origin) => {
      const supports = { kind: 'supports', from: own(origin, 80), current: true };

      const result = plan([decision({ in: [supports] })]);

      expect(result.rewrites).toEqual([]);
      expect(result.owner[0]?.reasons).toEqual([{ code: 'supported' }]);
    },
  );

  it('should rewrite a supported decision when the process has lineage inheritance', () => {
    const supports = { kind: 'supports', from: own('work-a', 80), current: true };

    const result = plan([decision({ in: [supports], lineage: true })]);

    expect(result.rewrites).toHaveLength(1);
    expect(result.owner).toEqual([]);
  });

  it('should ignore a non-current incoming supports', () => {
    const result = plan([
      decision({ in: [{ kind: 'supports', from: own('work-a', 80), current: false }] }),
    ]);

    expect(result.rewrites).toHaveLength(1);
  });

  it('should ignore an incoming edge that is not supports', () => {
    const result = plan([
      decision({ in: [{ kind: 'derivesFrom', from: own('work-a', 81), current: true }] }),
    ]);

    expect(result.rewrites).toHaveLength(1);
  });

  it('should plan nothing over a decision that was already rewritten', () => {
    const rewritten = decision({
      id: own('work-a', 2),
      out: firstRewrite([decision()]).item.relations.map((relation) => ({ ...relation })),
    });

    expect(plan([rewritten])).toEqual({ rewrites: [], owner: [] });
  });

  it('should order the plan by process, target and id', () => {
    const result = plan([
      decision({ process: 'work-b', id: own('work-b', 1), target: 'work-b.decision.x' }),
      decision({ id: own('work-a', 2), target: 'work-a.decision.y' }),
      decision({ id: own('work-a', 1), target: 'work-a.decision.x' }),
    ]);

    expect(result.rewrites.map(({ item }) => item.target)).toEqual([
      'work-a.decision.x',
      'work-a.decision.y',
      'work-b.decision.x',
    ]);
  });

  it('should order decisions of the same process and target by id', () => {
    const result = plan([decision({ id: own('work-a', 2) }), decision({ id: own('work-a', 1) })]);

    expect(result.rewrites.map(({ id: rewritten }) => rewritten)).toEqual([
      own('work-a', 1),
      own('work-a', 2),
    ]);
  });
});

describe('toBatches', () => {
  const item = (n: number): PlannedItem => ({
    type: 'decision',
    target: `work-a.decision.d${n}`,
    data: { choice: `C${n}` },
    relations: [{ kind: 'supersedes', to: own('work-a', n) }],
  });
  const rewrite = (n: number) => ({ process: 'work-a', id: own('work-a', n), item: item(n) });
  const rewrites = (count: number) => Array.from({ length: count }, (_unused, n) => rewrite(n + 1));

  it('should slice 120 rewrites into batches of 50, 50 and 20 for the process', () => {
    const batches = toBatches('work-a', 'directives-4', rewrites(120));

    expect(batches.map(({ records }) => records.length)).toEqual([50, 50, 20]);
    expect(batches.every(({ process }) => process === 'work-a')).toBe(true);
  });

  it('should carry in each batch the rewrites its records came from, in the same order', () => {
    const all = rewrites(120);

    const batches = toBatches('work-a', 'directives-4', all);

    expect(batches.flatMap((batch) => batch.rewrites)).toEqual(all);
    expect(batches.map((batch) => batch.rewrites.map(({ item: { target } }) => target))).toEqual(
      batches.map((batch) => batch.records.map(({ target }) => target)),
    );
  });

  it('should derive a deterministic key that follows the content', () => {
    const [first] = toBatches('work-a', 'directives-4', rewrites(3));
    const [again] = toBatches('work-a', 'directives-4', rewrites(3));
    const [other] = toBatches('work-a', 'directives-4', rewrites(4));

    expect(first?.key).toBe(again?.key);
    expect(first?.key).not.toBe(other?.key);
  });

  it('should derive a key of the reanchor-<to>-<process>-<hash> form within 200 characters', () => {
    const [first] = toBatches('work-a', 'directives-4', rewrites(3));

    expect(first?.key).toMatch(/^reanchor-directives-4-work-a-[0-9a-f]{12}$/);
    expect(first?.key.length).toBeLessThanOrEqual(200);
  });

  it('should reject an item that BatchItem refuses before returning any batch', () => {
    const bad = { ...rewrite(1), item: { ...item(1), target: 'Not A Target' } };

    expect(() => toBatches('work-a', 'directives-4', [rewrite(2), bad])).toThrow(ZodError);
  });
});

const OLD = own('work-a', 1);
const NEW = own('work-a', 2);

const plannedRewrites = (): ReturnType<typeof plan>['rewrites'] => plan([decision()]).rewrites;
const oldRow = (extra: Partial<LogRow> = {}): LogRow => ({
  id: OLD,
  target: 'work-a.decision.x',
  data: { choice: 'A' },
  out: [anchoredIn(OLD_DIRECTIVE.id), restsOn(OLD_PREMISE.id)],
  in: [],
  ...extra,
});
const newRow = (extra: Partial<LogRow> = {}): LogRow => {
  const [rewrite] = plannedRewrites();
  return {
    id: NEW,
    target: 'work-a.decision.x',
    data: { choice: 'A' },
    out: rewrite?.item.relations ?? [],
    in: [],
    ...extra,
  };
};
const superseded = (): LogRow => oldRow({ in: [{ kind: 'supersedes', from: NEW, current: true }] });

describe('verifyReanchor', () => {
  it('should pass when the replacement is current with the same data and relations', () => {
    expect(verifyReanchor(plannedRewrites(), [oldRow()], [superseded(), newRow()])).toEqual([]);
  });

  it('should pass in a process that already had two current decisions on the target', () => {
    const sibling: LogRow = { ...oldRow(), id: own('work-a', 9) };

    expect(
      verifyReanchor(plannedRewrites(), [oldRow(), sibling], [superseded(), sibling, newRow()]),
    ).toEqual([]);
  });

  it('should report different data', () => {
    expect(
      verifyReanchor(
        plannedRewrites(),
        [oldRow()],
        [superseded(), newRow({ data: { choice: 'B' } })],
      ),
    ).toEqual([{ id: OLD, problem: 'data-differs' }]);
  });

  it('should report an old record that is still current, with the count of current records changed', () => {
    expect(verifyReanchor(plannedRewrites(), [oldRow()], [oldRow(), newRow()])).toEqual([
      { id: OLD, problem: 'old-still-current' },
      { id: OLD, problem: 'current-count-changed' },
    ]);
  });

  it('should report a missing replacement, with the old record still current', () => {
    expect(verifyReanchor(plannedRewrites(), [oldRow()], [oldRow()])).toEqual([
      { id: OLD, problem: 'new-missing' },
      { id: OLD, problem: 'old-still-current' },
    ]);
  });

  it('should report a replacement that is not current, with the count of current records changed', () => {
    const replaced = newRow({
      in: [{ kind: 'supersedes', from: own('work-a', 3), current: true }],
    });

    expect(verifyReanchor(plannedRewrites(), [oldRow()], [superseded(), replaced])).toEqual([
      { id: OLD, problem: 'new-not-current' },
      { id: OLD, problem: 'current-count-changed' },
    ]);
  });

  it('should report a replacement revoked by a later record as not current', () => {
    const revoked = newRow({ in: [{ kind: 'revokes', from: own('work-a', 3), current: true }] });

    expect(verifyReanchor(plannedRewrites(), [oldRow()], [superseded(), revoked])).toContainEqual({
      id: OLD,
      problem: 'new-not-current',
    });
  });

  it('should report a missing relation', () => {
    const [rewrite] = plannedRewrites();
    const out = (rewrite?.item.relations ?? []).slice(0, -1);

    expect(verifyReanchor(plannedRewrites(), [oldRow()], [superseded(), newRow({ out })])).toEqual([
      { id: OLD, problem: 'relations-differ' },
    ]);
  });
});

describe('COPIED_NAMES', () => {
  it('should list the relations fluxo-hexlog.md says a rewritten decision keeps', () => {
    const doc = fs.readFileSync(path.join(__dirname, '../docs/directives/fluxo-hexlog.md'), 'utf8');
    const section = doc.split('## Verificação e achados')[1] ?? '';
    const [, list = ''] = /as mesmas relações \(([^)]*)\)/.exec(section) ?? [];
    const documented = (list.match(/`[^`]+`/g) ?? []).map((quoted) => quoted.slice(1, -1));

    expect([...COPIED_NAMES].sort()).toEqual(documented.sort());
  });
});

describe('summarizeApply', () => {
  it('should count every written decision and exit 0 when the reread log matches the plan', () => {
    const summary = summarizeApply({
      written: plannedRewrites(),
      planned: 1,
      refused: false,
      before: [oldRow()],
      after: [superseded(), newRow()],
    });

    expect(summary).toEqual({ out: ['rewrote 1 of 1 decisions'], err: [], code: 0 });
  });

  it('should exit 1 and print a verify failed line for each divergence of the reread log', () => {
    const summary = summarizeApply({
      written: plannedRewrites(),
      planned: 1,
      refused: false,
      before: [oldRow()],
      after: [superseded(), newRow({ data: { choice: 'B' } })],
    });

    expect(summary).toEqual({
      out: ['rewrote 1 of 1 decisions'],
      err: [`verify failed: ${OLD}: data-differs`],
      code: 1,
    });
  });

  it('should exit 1 without a verify failed line when a batch was refused and nothing diverged', () => {
    const summary = summarizeApply({
      written: [],
      planned: 1,
      refused: true,
      before: [oldRow()],
      after: [oldRow()],
    });

    expect(summary).toEqual({ out: ['rewrote 0 of 1 decisions'], err: [], code: 1 });
  });
});

describe('formatPlan', () => {
  const options = { to: 'directives-4', apply: false };

  it('should say there is nothing to reanchor when both lists are empty', () => {
    expect(formatPlan({ rewrites: [], owner: [] }, options)).toBe('nothing to reanchor');
  });

  it('should print the apply header and both lists when one of them is empty', () => {
    const planned = plan([decision()]);

    const text = formatPlan(planned, { to: 'directives-4', apply: true });

    expect(text).toContain('reanchor to directives-4 (apply)');
    expect(text).toContain('rewritable: 1\n  work-a: 1\nfor the owner: 0');
  });

  it('should print the dry-run header and list the owner items with the state of each anchor', () => {
    const planned = plan([decision()], { current: [NEW_DIRECTIVE] });

    const text = formatPlan(planned, options);

    expect(text).toContain('(dry-run)');
    expect(text).toContain(
      `  work-a\twork-a.decision.x\t${own('work-a', 1)}\tanchored-in ${OLD_DIRECTIVE.id} (directives.a.rule): same; rests-on ${OLD_PREMISE.id} (directives.estrategia.p): gone`,
    );
  });

  it.each([
    [
      'an anchor whose cited record is unknown',
      decision({ out: [anchoredIn(id(3, 99))] }),
      `anchored-in ${id(3, 99)}: stale`,
    ],
    [
      'an outgoing relation outside the copied ones',
      decision({
        out: [anchoredIn(OLD_DIRECTIVE.id), { kind: 'supports', to: own('work-a', 70) }],
      }),
      `other-relation supports->${own('work-a', 70)}`,
    ],
    [
      'a current incoming supports',
      decision({ in: [{ kind: 'supports', from: own('work-a', 80), current: true }] }),
      'supported',
    ],
  ])('should describe %s in the owner list', (_label, owned, reason) => {
    const text = formatPlan(plan([owned]), options);

    expect(text).toContain(`  work-a\twork-a.decision.x\t${own('work-a', 1)}\t${reason}`);
  });

  it('should cap the owner list at 100 lines and say how many it cut', () => {
    const decisions = Array.from({ length: 130 }, (_unused, n) =>
      decision({ id: own('work-a', n + 1), target: `work-a.decision.d${n}` }),
    );
    const planned = plan(decisions, { current: [] });

    const lines = formatPlan(planned, options).split('\n');

    expect(lines.filter((line) => line.startsWith('  work-a\t'))).toHaveLength(100);
    expect(lines.at(-1)).toBe('... 30 more omitted');
  });
});
