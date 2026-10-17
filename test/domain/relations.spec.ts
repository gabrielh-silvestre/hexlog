import { describe, it, expect, jest } from '@jest/globals';
import { buildInheritance, NO_INHERITANCE } from '../../src/domain/inheritance.ts';
import { buildVigency, checkRelation, hasCycle, needsReview } from '../../src/domain/relations.ts';
import type { Linked, NamedRelation, RuleContext, Vigency } from '../../src/domain/relations.ts';
import type { RelationInput, RelationKind as Kind } from '../../src/domain/record.ts';
import * as rdsc from '../fixtures/domains/rdsc.ts';

const id = (process: string, n: number) => `${process}:${String(n).padStart(8, '0')}`;

function rec(recordId: string, ...relations: [Kind, string][]): Linked {
  return { id: recordId, relations: relations.map(([kind, to]) => ({ kind, to })) };
}

const [e1, e2, v1, v2] = [id('p', 1), id('p', 2), id('p', 3), id('p', 4)];

const SAME_TARGET = 'p.step';
const OTHER_TARGET = 'p.other';

describe('buildVigency', () => {
  const lineage = [rec(e1), rec(e2, ['supersedes', e1]), rec(v1, ['supersedes', e2])];

  it('should treat a record with no incoming relation as current (D-08)', () => {
    const vigency = buildVigency([rec(e1)]);

    expect(vigency.isCurrent(e1)).toBe(true);
    expect(vigency.currentOf(e1)).toBe(e1);
  });

  it('should treat an unknown id as current (D-08)', () => {
    const vigency = buildVigency([rec(e1)]);

    expect(vigency.isCurrent(id('p', 99))).toBe(true);
  });

  it('should remove a superseded record from force (D-08)', () => {
    const vigency = buildVigency(lineage);

    expect([e1, e2, v1].map((x) => vigency.isCurrent(x))).toEqual([false, false, true]);
  });

  it('should resolve every version of a lineage to its last one (D-08)', () => {
    const vigency = buildVigency(lineage);

    expect(vigency.currentOf(e1)).toBe(v1);
    expect(vigency.currentOf(e2)).toBe(v1);
  });

  it('should remove a revoked record from force (D-08)', () => {
    const vigency = buildVigency([rec(e1), rec(e2, ['supersedes', e1]), rec(v1, ['revokes', e2])]);

    expect(vigency.isCurrent(e2)).toBe(false);
    expect(vigency.isCurrent(v1)).toBe(true);
  });

  it('should end the lineage with no current record when the current version is revoked (D-08)', () => {
    const vigency = buildVigency([rec(e1), rec(e2, ['supersedes', e1]), rec(v1, ['revokes', e2])]);

    expect(vigency.currentOf(e1)).toBeNull();
    expect(vigency.currentOf(e2)).toBeNull();
  });

  it('should not change vigency for a relation that is neither supersedes nor revokes (D-08)', () => {
    const vigency = buildVigency([rec(e1), rec(v1, ['supports', e1], ['complements', e1])]);

    expect(vigency.isCurrent(e1)).toBe(true);
  });

  it('should not depend on read order (D-08)', () => {
    const vigency = buildVigency([...lineage].reverse());

    expect(vigency.currentOf(e1)).toBe(v1);
  });

  it('should terminate with no current record on a hand-built cycle (D-08)', () => {
    const vigency = buildVigency([rec(e1, ['supersedes', e2]), rec(e2, ['supersedes', e1])]);

    expect([e1, e2].map((x) => vigency.isCurrent(x))).toEqual([false, false]);
    expect(vigency.currentOf(e1)).toBeNull();
    expect(vigency.currentOf(e2)).toBeNull();
  });
});

describe('hasCycle', () => {
  it('should report a hand-built back edge and a self edge as a cycle', () => {
    expect(hasCycle([rec(e1, ['supersedes', e2]), rec(e2, ['supersedes', e1])])).toBe(true);
    expect(hasCycle([rec(e1, ['supersedes', e1])])).toBe(true);
  });

  it('should not report a replacement chain or a destination outside the records read as a cycle', () => {
    expect(
      hasCycle([
        rec(e1),
        rec(e2, ['supersedes', e1]),
        rec(v1, ['supersedes', e2], ['supersedes', id('q', 1)]),
      ]),
    ).toBe(false);
  });

  it('should not report mutual support as a replacement cycle', () => {
    expect(hasCycle([rec(e1, ['supports', e2]), rec(e2, ['supports', e1])])).toBe(false);
  });

  it('should report a cycle of three records, with or without a tail', () => {
    const ring = [
      rec(e1, ['supersedes', v1]),
      rec(e2, ['supersedes', e1]),
      rec(v1, ['supersedes', e2]),
    ];

    expect(hasCycle(ring)).toBe(true);
    expect(hasCycle([...ring, rec(v2, ['supersedes', v1])])).toBe(true);
  });

  it('should not report a tail that does not close the ring as a cycle', () => {
    expect(
      hasCycle([rec(e1), rec(e2, ['supersedes', e1]), rec(v1, ['supersedes', e2]), rec(v2)]),
    ).toBe(false);
  });
});

describe('checkRelation', () => {
  const names = new Map<string, NamedRelation>([
    ...rdsc.relations.map((relation): [string, NamedRelation] => [relation.name, relation]),
    ['replaces-doc', { kind: 'supersedes', to: ['doc'] }],
  ]);

  /** Mesma vigência para qualquer tipo de relação. */
  const inForce = (vigency: Vigency) => ({ vigencyFor: () => vigency });

  function ctx(overrides: Partial<RuleContext> = {}): RuleContext {
    return {
      from: { id: id('p', 10), type: 'verdict', target: SAME_TARGET },
      to: { id: e1, type: 'evidence', target: SAME_TARGET },
      siblings: [],
      names,
      ...inForce(buildVigency([rec(e1)])),
      ...overrides,
    };
  }

  const violationOf = (result: ReturnType<typeof checkRelation>) =>
    'violation' in result ? result.violation : undefined;

  it('should return the kind for a valid relation (D-10)', () => {
    expect(checkRelation({ kind: 'supports' }, ctx())).toEqual({ kind: 'supports' });
  });

  it('should report self-relation (D-10)', () => {
    const result = checkRelation(
      { kind: 'supports' },
      ctx({ to: { id: id('p', 10), type: 'verdict', target: SAME_TARGET } }),
    );

    expect(violationOf(result)).toEqual({ code: 'self-relation' });
  });

  it('should fill in the kind from as (D-10)', () => {
    expect(checkRelation({ as: 'based-on' }, ctx())).toEqual({ kind: 'supports' });
  });

  it('should accept a kind equal to that of the name (D-10)', () => {
    expect(checkRelation({ as: 'based-on', kind: 'supports' }, ctx())).toEqual({
      kind: 'supports',
    });
  });

  it('should report unknown-relation-name (D-10)', () => {
    expect(violationOf(checkRelation({ as: 'nope' }, ctx()))).toEqual({
      code: 'unknown-relation-name',
    });
  });

  it('should report kind-mismatch (D-10)', () => {
    expect(violationOf(checkRelation({ as: 'based-on', kind: 'contradicts' }, ctx()))).toEqual({
      code: 'kind-mismatch',
    });
  });

  it.each([
    ['source', { from: { id: id('p', 10), type: 'evidence', target: SAME_TARGET } }],
    ['destination', { to: { id: e1, type: 'verdict', target: SAME_TARGET } }],
  ])('should refuse a %s outside the name lists with endpoint-type (D-10)', (_end, overrides) => {
    expect(violationOf(checkRelation({ as: 'based-on' }, ctx(overrides)))).toEqual({
      code: 'endpoint-type',
    });
  });

  it('should accept any type for an endpoint with no declared list (D-10)', () => {
    const base = ctx({ from: { id: id('p', 10), type: 'evidence', target: SAME_TARGET } });

    expect(checkRelation({ as: 'replaces' }, base)).toEqual({ kind: 'supersedes' });
  });

  it('should report cross-process-currency on supersedes and on revokes across processes (D-10)', () => {
    const other = { to: { id: id('q', 1), type: 'verdict', target: SAME_TARGET } };

    expect(violationOf(checkRelation({ kind: 'supersedes' }, ctx(other)))).toEqual({
      code: 'cross-process-currency',
    });
    expect(violationOf(checkRelation({ kind: 'revokes' }, ctx(other)))).toEqual({
      code: 'cross-process-currency',
    });
  });

  it('should report type-mismatch only on supersedes, since revokes accepts another type (D-10)', () => {
    expect(violationOf(checkRelation({ kind: 'supersedes' }, ctx()))).toEqual({
      code: 'type-mismatch',
    });
    expect(checkRelation({ kind: 'revokes' }, ctx())).toEqual({ kind: 'revokes' });
  });

  it('should report target-mismatch only on supersedes, since revokes accepts another target (D-10)', () => {
    const sameType = { from: { id: id('p', 10), type: 'evidence', target: SAME_TARGET } };
    const elsewhere = { to: { id: e1, type: 'evidence', target: OTHER_TARGET } };

    expect(
      violationOf(checkRelation({ kind: 'supersedes' }, ctx({ ...sameType, ...elsewhere }))),
    ).toEqual({ code: 'target-mismatch' });
    expect(checkRelation({ kind: 'revokes' }, ctx({ ...sameType, ...elsewhere }))).toEqual({
      kind: 'revokes',
    });
  });

  it('should accept supersedes on the same target and type (D-10)', () => {
    const sameType = { from: { id: id('p', 10), type: 'evidence', target: SAME_TARGET } };

    expect(checkRelation({ kind: 'supersedes' }, ctx(sameType))).toEqual({ kind: 'supersedes' });
  });

  it('should report supports-and-contradicts in both directions (D-10)', () => {
    const contradicts = [{ kind: 'contradicts' as const, to: e1 }];
    const supports = [{ kind: 'supports' as const, to: e1 }];

    expect(
      violationOf(checkRelation({ kind: 'supports' }, ctx({ siblings: contradicts }))),
    ).toEqual({
      code: 'supports-and-contradicts',
    });
    expect(
      violationOf(checkRelation({ kind: 'contradicts' }, ctx({ siblings: supports }))),
    ).toEqual({
      code: 'supports-and-contradicts',
    });
  });

  it('should not report supports-and-contradicts for different destinations (D-10)', () => {
    expect(
      checkRelation({ kind: 'contradicts' }, ctx({ siblings: [{ kind: 'supports', to: e2 }] })),
    ).toEqual({
      kind: 'contradicts',
    });
  });

  it.each([
    ['a replaced destination', buildVigency([rec(e1), rec(e2, ['supersedes', e1])]), e2],
    ['a revoked destination', buildVigency([rec(e1), rec(v1, ['revokes', e1])]), null],
  ] as [string, Vigency, string | null][])(
    'should report stale-destination for %s, carrying the current version of the lineage or null (D-10)',
    (_case, vigency, current) => {
      expect(violationOf(checkRelation({ kind: 'supports' }, ctx(inForce(vigency))))).toEqual({
        code: 'stale-destination',
        current,
      });
    },
  );

  it.each(['contradicts', 'answers', 'derivesFrom', 'complements', 'reopens'] as const)(
    'should skip the destination vigency check for %s (D-10)',
    (kind) => {
      const replaced = buildVigency([rec(e1), rec(e2, ['supersedes', e1])]);

      expect(checkRelation({ kind }, ctx(inForce(replaced)))).toEqual({ kind });
    },
  );

  it.each([
    [
      'supersedes over a superseded record',
      'supersedes',
      buildVigency([rec(e1), rec(e2, ['supersedes', e1])]),
      e2,
    ],
    [
      'revokes over a revoked record',
      'revokes',
      buildVigency([rec(e1), rec(v1, ['revokes', e1])]),
      null,
    ],
  ] as [string, Kind, Vigency, string | null][])(
    'should report not-current for %s (D-10)',
    (_case, kind, vigency, current) => {
      const sameType = { from: { id: id('p', 10), type: 'evidence', target: SAME_TARGET } };

      expect(
        violationOf(checkRelation({ kind }, ctx({ ...sameType, ...inForce(vigency) }))),
      ).toEqual({
        code: 'not-current',
        current,
      });
    },
  );

  describe('when the vigency depends on the relation kind', () => {
    const sameType = { from: { id: id('p', 10), type: 'evidence', target: SAME_TARGET } };
    const self = id('p', 10);

    /** Um lote de um item: `before` é o que vigora antes dele, `whole` inclui as relações dele. */
    function checkInBatch(relations: [Kind, string][], index: number) {
      const [kind, to] = relations[index]!;
      const before = buildVigency([rec(e1)]);
      const whole = buildVigency([rec(e1), rec(self, ...relations)]);
      const vigencyFor = jest.fn((relationKind: Kind) =>
        relationKind === 'supports' ? whole : before,
      );
      const siblings = relations
        .filter((_, i) => i !== index)
        .map(([k, t]) => ({ kind: k, to: t }));
      const result = checkRelation(
        { kind },
        ctx({
          ...sameType,
          to: { id: to, type: 'evidence', target: SAME_TARGET },
          siblings,
          vigencyFor,
        }),
      );
      return { result, vigencyFor };
    }

    it.each([
      [
        'supersedes first',
        [
          ['supersedes', e1],
          ['supports', e1],
        ],
      ],
      [
        'supports first',
        [
          ['supports', e1],
          ['supersedes', e1],
        ],
      ],
    ] as [string, [Kind, string][]][])(
      'should pass supersedes and refuse supports in the batch [supersedes → E, supports → E], %s (U1, D-10)',
      (_label, relations) => {
        const supersedesIndex = relations.findIndex(([kind]) => kind === 'supersedes');
        const supportsIndex = relations.findIndex(([kind]) => kind === 'supports');

        expect(checkInBatch(relations, supersedesIndex).result).toEqual({ kind: 'supersedes' });
        expect(violationOf(checkInBatch(relations, supportsIndex).result)).toEqual({
          code: 'stale-destination',
          current: self,
        });
      },
    );

    it.each(['supports', 'revokes'] as const)(
      'should ask for the vigency of %s itself (U1, D-10)',
      (kind) => {
        const { vigencyFor } = checkInBatch([[kind, e1]], 0);

        expect(vigencyFor).toHaveBeenCalledWith(kind);
      },
    );
  });

  it('should report supersedes-and-revokes in both directions (D-10)', () => {
    const sameType = { from: { id: id('p', 10), type: 'evidence', target: SAME_TARGET } };
    const revokes = [{ kind: 'revokes' as const, to: e1 }];
    const supersedes = [{ kind: 'supersedes' as const, to: e1 }];

    expect(
      violationOf(checkRelation({ kind: 'supersedes' }, ctx({ ...sameType, siblings: revokes }))),
    ).toEqual({ code: 'supersedes-and-revokes' });
    expect(
      violationOf(checkRelation({ kind: 'revokes' }, ctx({ ...sameType, siblings: supersedes }))),
    ).toEqual({ code: 'supersedes-and-revokes' });
  });

  it('should not report supersedes-and-revokes for different destinations (D-10)', () => {
    const sameType = { from: { id: id('p', 10), type: 'evidence', target: SAME_TARGET } };
    const elsewhere = [{ kind: 'revokes' as const, to: e2 }];

    expect(
      checkRelation({ kind: 'supersedes' }, ctx({ ...sameType, siblings: elsewhere })),
    ).toEqual({ kind: 'supersedes' });
  });

  describe('when two rules are violated at once', () => {
    const sameType = { from: { id: id('p', 10), type: 'evidence', target: SAME_TARGET } };
    const otherProcess = { to: { id: id('q', 1), type: 'verdict', target: SAME_TARGET } };
    const replaced = buildVigency([rec(e1), rec(e2, ['supersedes', e1])]);

    // Cada caso viola duas regras vizinhas da ordem; vale a primeira.
    it.each([
      [
        'self-relation before unknown-relation-name',
        { as: 'nope' },
        { to: { id: id('p', 10), type: 'verdict', target: SAME_TARGET } },
        'self-relation',
      ],
      [
        'kind-mismatch before cross-process-currency',
        { as: 'replaces', kind: 'revokes' },
        otherProcess,
        'kind-mismatch',
      ],
      [
        'cross-process-currency before type-mismatch',
        { kind: 'supersedes' },
        otherProcess,
        'cross-process-currency',
      ],
      [
        'type-mismatch before target-mismatch',
        { kind: 'supersedes' },
        { to: { id: e1, type: 'evidence', target: OTHER_TARGET } },
        'type-mismatch',
      ],
      [
        'cross-process-currency before target-mismatch',
        { kind: 'supersedes' },
        { ...sameType, to: { id: id('q', 1), type: 'evidence', target: OTHER_TARGET } },
        'cross-process-currency',
      ],
      [
        'target-mismatch before endpoint-type',
        { as: 'replaces-doc' },
        {
          from: { id: id('p', 10), type: 'verdict', target: SAME_TARGET },
          to: { id: e1, type: 'verdict', target: OTHER_TARGET },
        },
        'target-mismatch',
      ],
      ['type-mismatch before endpoint-type', { as: 'replaces-doc' }, {}, 'type-mismatch'],
      [
        'endpoint-type before supports-and-contradicts',
        { as: 'based-on' },
        { ...sameType, siblings: [{ kind: 'contradicts', to: e1 }] },
        'endpoint-type',
      ],
      [
        'supports-and-contradicts before stale-destination',
        { kind: 'supports' },
        { siblings: [{ kind: 'contradicts', to: e1 }], ...inForce(replaced) },
        'supports-and-contradicts',
      ],
      [
        'supersedes-and-revokes before not-current',
        { kind: 'supersedes' },
        { ...sameType, siblings: [{ kind: 'revokes', to: e1 }], ...inForce(replaced) },
        'supersedes-and-revokes',
      ],
      [
        'target-mismatch before not-current',
        { kind: 'supersedes' },
        {
          ...sameType,
          to: { id: e1, type: 'evidence', target: OTHER_TARGET },
          ...inForce(replaced),
        },
        'target-mismatch',
      ],
    ] as [string, Parameters<typeof checkRelation>[0], Partial<RuleContext>, string][])(
      'should report %s (D-06, D-10)',
      (_label, input, overrides, code) => {
        expect(violationOf(checkRelation(input, ctx(overrides)))?.code).toBe(code);
      },
    );

    it('should let as stand in for the name kind in the rules that read the kind (D-06, D-10)', () => {
      expect(violationOf(checkRelation({ as: 'replaces' }, ctx(otherProcess)))?.code).toBe(
        'cross-process-currency',
      );
      expect(
        violationOf(checkRelation({ as: 'replaces' }, ctx({ ...sameType, ...inForce(replaced) }))),
      ).toEqual({ code: 'not-current', current: e2 });
      expect(violationOf(checkRelation({ as: 'based-on' }, ctx(inForce(replaced))))).toEqual({
        code: 'stale-destination',
        current: e2,
      });
    });
  });

  it('should accept a relation with kind, with or without as (D-10)', () => {
    const parsed: RelationInput = { to: e1, kind: 'supports' };

    expect(checkRelation(parsed, ctx())).toEqual({ kind: 'supports' });
    expect(checkRelation({ kind: 'supports', as: 'based-on' }, ctx())).toEqual({
      kind: 'supports',
    });
  });

  it('should refuse a relation with neither kind nor as at the type level (D-10)', () => {
    // @ts-expect-error nem kind nem as
    const withoutBoth = () => checkRelation({}, ctx());

    expect(withoutBoth).toBeInstanceOf(Function);
  });
});

describe('needsReview', () => {
  // Caso rdsc: veredito (verdict) apoiado por evidência (evidence) via based-on = supports.
  const evidence = id('p', 1);
  const evidence2 = id('p', 2);
  const verdict = id('p', 3);
  const verdict2 = id('p', 4);

  it('should give staleOut to a current verdict that cites evidence later superseded (D-09)', () => {
    const marks = needsReview([
      rec(evidence),
      rec(verdict, ['supports', evidence]),
      rec(evidence2, ['supersedes', evidence]),
    ]);

    expect(marks.get(verdict)).toEqual({ staleIn: [], staleOut: [evidence] });
    expect(marks.has(evidence2)).toBe(false);
  });

  it('should clear the mark when verdict V’ supersedes V citing the new evidence (D-09)', () => {
    const marks = needsReview([
      rec(evidence),
      rec(verdict, ['supports', evidence]),
      rec(evidence2, ['supersedes', evidence]),
      rec(verdict2, ['supersedes', verdict], ['supports', evidence2]),
    ]);

    expect(marks.size).toBe(0);
  });

  it('should leave no mark when V’ supersedes V without citing the new evidence, since it supports nothing anymore (D-09)', () => {
    const marks = needsReview([
      rec(evidence),
      rec(verdict, ['supports', evidence]),
      rec(evidence2, ['supersedes', evidence]),
      rec(verdict2, ['supersedes', verdict]),
    ]);

    expect(marks.size).toBe(0);
  });

  it('should mark the current verdict when its evidence is revoked (D-09)', () => {
    const marks = needsReview([
      rec(evidence),
      rec(verdict, ['supports', evidence]),
      rec(id('p', 5), ['revokes', evidence]),
    ]);

    expect(marks.get(verdict)).toEqual({ staleIn: [], staleOut: [evidence] });
  });

  it('should give no mark to a current verdict citing current evidence (D-09)', () => {
    expect(needsReview([rec(evidence), rec(verdict, ['supports', evidence])]).size).toBe(0);
  });

  // Plano aprovado por revisão: a revisão (review) apoia o plano (plan).
  const plan = id('p', 11);
  const review = id('p', 12);
  const review2 = id('p', 13);

  it('should give staleIn to a plan approved by a review later superseded when the current one no longer supports it (D-09)', () => {
    const marks = needsReview([
      rec(plan),
      rec(review, ['supports', plan]),
      rec(review2, ['supersedes', review]),
    ]);

    expect(marks.get(plan)).toEqual({ staleIn: [review], staleOut: [] });
  });

  it('should keep the support alive and the plan unmarked when R’ repeats supports for the plan (D-09)', () => {
    const marks = needsReview([
      rec(plan),
      rec(review, ['supports', plan]),
      rec(review2, ['supersedes', review], ['supports', plan]),
    ]);

    expect(marks.size).toBe(0);
  });

  it('should mark the plan when the support lineage of its review is revoked (D-09)', () => {
    const marks = needsReview([
      rec(plan),
      rec(review, ['supports', plan]),
      rec(id('p', 14), ['revokes', review]),
    ]);

    expect(marks.get(plan)).toEqual({ staleIn: [review], staleOut: [] });
  });

  it('should return the lists sorted (D-09)', () => {
    const marks = needsReview([
      rec(evidence),
      rec(evidence2),
      rec(verdict, ['supports', evidence2], ['supports', evidence]),
      rec(id('p', 6), ['supersedes', evidence]),
      rec(id('p', 7), ['supersedes', evidence2]),
    ]);

    expect(marks.get(verdict)?.staleOut).toEqual([evidence, evidence2]);
  });

  it('should return staleIn sorted too, whatever the read order (D-09)', () => {
    const [reviewA, reviewB] = [id('p', 12), id('p', 13)];
    const marks = needsReview([
      rec(plan),
      rec(reviewB, ['supports', plan]),
      rec(reviewA, ['supports', plan]),
      rec(id('p', 14), ['supersedes', reviewA]),
      rec(id('p', 15), ['supersedes', reviewB]),
    ]);

    expect(marks.get(plan)?.staleIn).toEqual([reviewA, reviewB]);
  });

  it('should generate no mark for a destination not in records (D-24, D-09)', () => {
    const unread = id('q', 1);
    const marks = needsReview([
      rec(evidence, ['supports', unread]),
      rec(evidence2, ['supersedes', evidence]),
    ]);

    expect(marks.size).toBe(0);
  });

  it('should mark the current source when the same support has its destination read, as a control (D-09)', () => {
    const marks = needsReview([
      rec(evidence),
      rec(evidence2, ['supersedes', evidence]),
      rec(verdict, ['supports', evidence]),
    ]);

    expect(marks.get(verdict)).toEqual({ staleIn: [], staleOut: [evidence] });
  });

  describe('with inheritance (ADR 0007, item 10)', () => {
    const [evidence, unit, unit2, review, review2] = [
      id('p', 1),
      id('p', 2),
      id('p', 3),
      id('p', 4),
      id('p', 5),
    ];

    function marksOf(records: Linked[]) {
      const vigency = buildVigency(records);
      return needsReview(
        records,
        vigency,
        buildInheritance(records, vigency, () => true),
      );
    }

    const superseded = [
      rec(unit),
      rec(evidence, ['supports', unit]),
      rec(unit2, ['supersedes', unit]),
    ];

    it('should mark the superseded unit when there is no inheritance', () => {
      expect(needsReview(superseded).get(evidence)).toEqual({ staleIn: [], staleOut: [unit] });
    });

    it('should count an inherited support as alive, so the superseded unit leaves no mark', () => {
      expect(marksOf(superseded).size).toBe(0);
    });

    it('should cut the inheritance and bring the mark back when a contradicts sits between the lineages', () => {
      const marks = marksOf([
        rec(unit),
        rec(evidence, ['supports', unit]),
        rec(unit2, ['supersedes', unit], ['contradicts', evidence]),
      ]);

      expect(marks.get(evidence)).toEqual({ staleIn: [], staleOut: [unit] });
    });

    it('should keep a direct support alive even when a contradicts cuts the lineage pair', () => {
      const records = [
        rec(unit),
        rec(evidence, ['supports', unit], ['supports', unit2]),
        rec(unit2, ['supersedes', unit], ['contradicts', evidence]),
      ];

      expect(marksOf(records).size).toBe(0);
    });

    it('should still mark the plan for a support from a superseded review', () => {
      const records = [
        rec(unit),
        rec(review, ['supports', unit]),
        rec(review2, ['supersedes', review]),
      ];

      expect(marksOf(records).get(unit)).toEqual({ staleIn: [review], staleOut: [] });
    });

    it('should behave as without inheritance when given NO_INHERITANCE', () => {
      const records = [...superseded];

      expect(needsReview(records, buildVigency(records), NO_INHERITANCE)).toEqual(
        needsReview(records),
      );
    });
  });
});
