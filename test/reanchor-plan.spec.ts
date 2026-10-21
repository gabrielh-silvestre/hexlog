import { describe, expect, test } from '@jest/globals';
import {
  type DecisionRow,
  type LogRow,
  type PlannedItem,
  type Source,
  formatPlan,
  generationOf,
  isLatestGeneration,
  planReanchor,
  toBatches,
  verifyReanchor,
} from '../scripts/flow/reanchor-plan.ts';

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

const anchoredIn = (to: string) => ({ kind: 'derivesFrom', as: 'anchored-in', to });
const restsOn = (to: string) => ({ kind: 'derivesFrom', as: 'rests-on', to });

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

describe('generationOf and isLatestGeneration', () => {
  test('reads the generation from an id and from a process name', () => {
    expect(generationOf(id(10, 1))).toBe(10);
    expect(generationOf('directives-4')).toBe(4);
    expect(generationOf('directives-4x')).toBeUndefined();
    expect(generationOf('feat-x:01a15a00')).toBeUndefined();
  });

  test('compares generations as numbers', () => {
    const names = ['directives-9', 'directives-10', 'work-a'];

    expect(isLatestGeneration('directives-10', names)).toBe(true);
    expect(isLatestGeneration('directives-9', names)).toBe(false);
  });

  test('is false when the target generation is absent or invalid', () => {
    expect(isLatestGeneration('directives-4', ['directives-3'])).toBe(false);
    expect(isLatestGeneration('work-a', ['work-a'])).toBe(false);
  });
});

describe('planReanchor', () => {
  test('rewrites a decision whose anchors are all the same', () => {
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

  test('keeps the sentinel premise as an ordinary same anchor', () => {
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

  test('copies about-gap and raw derivesFrom to an old generation as they are', () => {
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

  test('drops the stored current flag from the copied relations', () => {
    const result = plan([
      decision({
        out: [{ ...anchoredIn(OLD_DIRECTIVE.id), current: true } as never],
      }),
    ]);

    expect(result.rewrites[0]?.item.relations[1]).toEqual(anchoredIn(NEW_DIRECTIVE.id));
  });

  test.each([
    ['changed rule', { current: [directive(4, 1, 'directives.a.rule', 'Other text')] }, 'changed'],
    ['changed type', { current: [premise(4, 1, 'directives.a.rule', 'Rule text')] }, 'changed'],
    ['missing target', { current: [] }, 'gone'],
    [
      'repeated target',
      { current: [NEW_DIRECTIVE, directive(4, 7, 'directives.a.rule', 'Rule text')] },
      'ambiguous',
    ],
  ])('sends the decision to the owner on %s', (_label, options, state) => {
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

  test('sends a type without a text field to the owner as changed', () => {
    const oldDoc: Source = { id: id(3, 5), type: 'doc', target: 'directives.a', current: true };
    const newDoc: Source = { id: id(4, 5), type: 'doc', target: 'directives.a', current: true };

    const result = plan([decision({ out: [anchoredIn(oldDoc.id)] })], {
      older: [oldDoc],
      current: [newDoc],
    });

    expect(result.owner[0]?.reasons).toMatchObject([{ state: 'changed' }]);
  });

  test('flags a non-current cited record as stale even when the new text is equal', () => {
    const result = plan([decision({ out: [anchoredIn(OLD_DIRECTIVE.id)] })], {
      older: [{ ...OLD_DIRECTIVE, current: false }],
    });

    expect(result.owner[0]?.reasons).toMatchObject([{ state: 'stale' }]);
  });

  test('flags a cited id missing from the old generation as stale', () => {
    const result = plan([decision({ out: [anchoredIn(id(3, 99))] })]);

    expect(result.owner[0]?.reasons).toEqual([
      { code: 'anchor', name: 'anchored-in', to: id(3, 99), target: undefined, state: 'stale' },
    ]);
  });

  test('handles anchors in two old generations', () => {
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

  test('ignores anchors to the target generation or later and decisions without old anchors', () => {
    const result = plan([
      decision({ out: [anchoredIn(NEW_DIRECTIVE.id), anchoredIn(id(5, 1))] }),
      decision({ id: own('work-a', 2), out: [restsOn(own('work-a', 60))] }),
    ]);

    expect(result).toEqual({ rewrites: [], owner: [] });
  });

  test('one anchor outside same takes the whole decision out, listing every anchor', () => {
    const result = plan([decision()], {
      current: [NEW_DIRECTIVE, { ...NEW_PREMISE, text: 'Changed' }],
    });

    expect(result.rewrites).toEqual([]);
    expect(result.owner[0]?.reasons).toMatchObject([
      { name: 'anchored-in', state: 'same' },
      { name: 'rests-on', state: 'changed' },
    ]);
  });

  test.each(['supports', 'contradicts', 'answers', 'complements', 'reopens', 'revokes'])(
    'sends a decision with an outgoing %s to the owner',
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

  test('rewrites a decision that was already a version, dropping the old outgoing supersedes', () => {
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

  test('sends a decision with a current incoming supports to the owner without lineage', () => {
    const supports = { kind: 'supports', from: own('work-a', 80), current: true };

    const result = plan([decision({ in: [supports] })]);

    expect(result.rewrites).toEqual([]);
    expect(result.owner[0]?.reasons).toEqual([{ code: 'supported' }]);
  });

  test('sends a decision supported by a current evidence of another process to the owner', () => {
    const supports = { kind: 'supports', from: own('work-b', 80), current: true };

    const result = plan([decision({ in: [supports] })]);

    expect(result.rewrites).toEqual([]);
    expect(result.owner[0]?.reasons).toEqual([{ code: 'supported' }]);
  });

  test('rewrites a supported decision when the process has lineage inheritance', () => {
    const supports = { kind: 'supports', from: own('work-a', 80), current: true };

    const result = plan([decision({ in: [supports], lineage: true })]);

    expect(result.rewrites).toHaveLength(1);
    expect(result.owner).toEqual([]);
  });

  test('ignores a non-current incoming supports and other incoming edges', () => {
    const result = plan([
      decision({
        in: [
          { kind: 'supports', from: own('work-a', 80), current: false },
          { kind: 'derivesFrom', from: own('work-a', 81), current: true },
        ],
      }),
    ]);

    expect(result.rewrites).toHaveLength(1);
  });

  test('plans nothing over a decision that was already rewritten', () => {
    const [first] = plan([decision()]).rewrites;
    if (first === undefined) throw new Error('expected a rewrite');
    const rewritten = decision({
      id: own('work-a', 2),
      out: first.item.relations.map((relation) => ({ ...relation })),
    });

    expect(plan([rewritten])).toEqual({ rewrites: [], owner: [] });
  });

  test('orders the plan by process, target and id', () => {
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

  test('slices 120 rewrites into batches of 50, 50 and 20', () => {
    const batches = toBatches('work-a', 'directives-4', rewrites(120));

    expect(batches.map(({ records }) => records.length)).toEqual([50, 50, 20]);
    expect(batches.every(({ process }) => process === 'work-a')).toBe(true);
  });

  test('carries in each batch the rewrites its records came from, in the same order', () => {
    const all = rewrites(120);
    const batches = toBatches('work-a', 'directives-4', all);

    expect(batches.flatMap((batch) => batch.rewrites)).toEqual(all);
    for (const batch of batches) {
      expect(batch.rewrites.map(({ item: { target } }) => target)).toEqual(
        batch.records.map(({ target }) => target),
      );
    }
  });

  test('derives a deterministic key that follows the content and stays within 200 characters', () => {
    const [first] = toBatches('work-a', 'directives-4', rewrites(3));
    const [again] = toBatches('work-a', 'directives-4', rewrites(3));
    const [other] = toBatches('work-a', 'directives-4', rewrites(4));

    expect(first?.key).toBe(again?.key);
    expect(first?.key).not.toBe(other?.key);
    expect(first?.key).toMatch(/^reanchor-directives-4-work-a-[0-9a-f]{12}$/);
    expect(first?.key.length).toBeLessThanOrEqual(200);
  });

  test('rejects an item that BatchItem refuses before returning any batch', () => {
    const bad = { ...rewrite(1), item: { ...item(1), target: 'Not A Target' } };

    expect(() => toBatches('work-a', 'directives-4', [rewrite(2), bad])).toThrow();
  });
});

describe('verifyReanchor', () => {
  const planned = (): ReturnType<typeof plan>['rewrites'] => plan([decision()]).rewrites;
  const OLD = own('work-a', 1);
  const NEW = own('work-a', 2);

  const oldRow = (extra: Partial<LogRow> = {}): LogRow => ({
    id: OLD,
    target: 'work-a.decision.x',
    data: { choice: 'A' },
    out: [anchoredIn(OLD_DIRECTIVE.id), restsOn(OLD_PREMISE.id)],
    in: [],
    ...extra,
  });
  const newRow = (extra: Partial<LogRow> = {}): LogRow => {
    const [rewrite] = planned();
    return {
      id: NEW,
      target: 'work-a.decision.x',
      data: { choice: 'A' },
      out: rewrite?.item.relations ?? [],
      in: [],
      ...extra,
    };
  };
  const superseded = (): LogRow =>
    oldRow({ in: [{ kind: 'supersedes', from: NEW, current: true }] });

  test('passes when the replacement is current with the same data and relations', () => {
    expect(verifyReanchor(planned(), [oldRow()], [superseded(), newRow()])).toEqual([]);
  });

  test('passes in a process that already had two current decisions on the target', () => {
    const sibling: LogRow = { ...oldRow(), id: own('work-a', 9) };

    expect(
      verifyReanchor(planned(), [oldRow(), sibling], [superseded(), sibling, newRow()]),
    ).toEqual([]);
  });

  test('reports different data', () => {
    expect(
      verifyReanchor(planned(), [oldRow()], [superseded(), newRow({ data: { choice: 'B' } })]),
    ).toEqual([{ id: OLD, problem: 'data-differs' }]);
  });

  test('reports an old record that is still current', () => {
    expect(verifyReanchor(planned(), [oldRow()], [oldRow(), newRow()])).toEqual([
      { id: OLD, problem: 'old-still-current' },
      { id: OLD, problem: 'current-count-changed' },
    ]);
  });

  test('reports a missing replacement', () => {
    expect(verifyReanchor(planned(), [oldRow()], [oldRow()])).toEqual([
      { id: OLD, problem: 'new-missing' },
      { id: OLD, problem: 'old-still-current' },
    ]);
  });

  test('reports a replacement that is not current', () => {
    const replaced = newRow({
      in: [{ kind: 'supersedes', from: own('work-a', 3), current: true }],
    });

    expect(verifyReanchor(planned(), [oldRow()], [superseded(), replaced])).toEqual([
      { id: OLD, problem: 'new-not-current' },
      { id: OLD, problem: 'current-count-changed' },
    ]);
  });

  test('reports a missing relation', () => {
    const [rewrite] = planned();
    const out = (rewrite?.item.relations ?? []).slice(0, -1);

    expect(verifyReanchor(planned(), [oldRow()], [superseded(), newRow({ out })])).toEqual([
      { id: OLD, problem: 'relations-differ' },
    ]);
  });
});

describe('formatPlan', () => {
  const options = { to: 'directives-4', apply: false };

  test('says there is nothing to reanchor when both lists are empty', () => {
    expect(formatPlan({ rewrites: [], owner: [] }, options)).toBe('nothing to reanchor');
  });

  test('prints both lists when one of them is empty', () => {
    const text = formatPlan(plan([decision()]), { to: 'directives-4', apply: true });

    expect(text).toContain('reanchor to directives-4 (apply)');
    expect(text).toContain('rewritable: 1\n  work-a: 1\nfor the owner: 0');
  });

  test('lists the owner items with the state of each anchor', () => {
    const text = formatPlan(plan([decision()], { current: [NEW_DIRECTIVE] }), options);

    expect(text).toContain('(dry-run)');
    expect(text).toContain(
      `  work-a\twork-a.decision.x\t${own('work-a', 1)}\tanchored-in ${OLD_DIRECTIVE.id} (directives.a.rule): same; rests-on ${OLD_PREMISE.id} (directives.estrategia.p): gone`,
    );
  });

  test('caps the owner list at 100 lines and says how many it cut', () => {
    const decisions = Array.from({ length: 130 }, (_unused, n) =>
      decision({ id: own('work-a', n + 1), target: `work-a.decision.d${n}` }),
    );

    const lines = formatPlan(plan(decisions, { current: [] }), options).split('\n');

    expect(lines.filter((line) => line.startsWith('  work-a\t'))).toHaveLength(100);
    expect(lines.at(-1)).toBe('... 30 more omitted');
  });
});
