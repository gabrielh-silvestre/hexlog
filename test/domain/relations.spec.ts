import { describe, test, expect, jest } from '@jest/globals';
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

describe('vigency and lineage (D-08)', () => {
  test('a record with no incoming relation is current, and so is an unknown id', () => {
    const vigency = buildVigency([rec(e1)]);
    expect(vigency.isCurrent(e1)).toBe(true);
    expect(vigency.isCurrent(id('p', 99))).toBe(true);
    expect(vigency.currentOf(e1)).toBe(e1);
  });

  test('supersedes removes the old one from force and the current version is the last of the lineage', () => {
    const vigency = buildVigency([
      rec(e1),
      rec(e2, ['supersedes', e1]),
      rec(v1, ['supersedes', e2]),
    ]);
    expect([e1, e2, v1].map((x) => vigency.isCurrent(x))).toEqual([false, false, true]);
    expect(vigency.currentOf(e1)).toBe(v1);
    expect(vigency.currentOf(e2)).toBe(v1);
  });

  test('revokes removes it from force, and revoking the current version ends the lineage with no current record', () => {
    const vigency = buildVigency([rec(e1), rec(e2, ['supersedes', e1]), rec(v1, ['revokes', e2])]);
    expect(vigency.isCurrent(e2)).toBe(false);
    expect(vigency.currentOf(e1)).toBeNull();
    expect(vigency.currentOf(e2)).toBeNull();
    expect(vigency.isCurrent(v1)).toBe(true);
  });

  test('a relation that is neither supersedes nor revokes does not change vigency', () => {
    const vigency = buildVigency([rec(e1), rec(v1, ['supports', e1], ['complements', e1])]);
    expect(vigency.isCurrent(e1)).toBe(true);
  });

  test('the result does not depend on read order', () => {
    const records = [rec(e1), rec(e2, ['supersedes', e1]), rec(v1, ['supersedes', e2])];
    const vigency = buildVigency([...records].reverse());
    expect(vigency.currentOf(e1)).toBe(v1);
  });

  test('currentOf terminates and returns null on a hand-built cycle', () => {
    const vigency = buildVigency([rec(e1, ['supersedes', e2]), rec(e2, ['supersedes', e1])]);
    expect([e1, e2].map((x) => vigency.isCurrent(x))).toEqual([false, false]);
    expect(vigency.currentOf(e1)).toBeNull();
    expect(vigency.currentOf(e2)).toBeNull();
  });
});

describe('cycle', () => {
  test('a hand-built back edge is a cycle, and so is a self edge', () => {
    expect(hasCycle([rec(e1, ['supersedes', e2]), rec(e2, ['supersedes', e1])])).toBe(true);
    expect(hasCycle([rec(e1, ['supersedes', e1])])).toBe(true);
  });

  test('a replacement chain and a destination outside the records read are not a cycle', () => {
    expect(
      hasCycle([
        rec(e1),
        rec(e2, ['supersedes', e1]),
        rec(v1, ['supersedes', e2], ['supersedes', id('q', 1)]),
      ]),
    ).toBe(false);
  });

  test('mutual support is not a replacement cycle', () => {
    expect(hasCycle([rec(e1, ['supports', e2]), rec(e2, ['supports', e1])])).toBe(false);
  });

  test('a cycle of three records is a cycle, with or without a tail', () => {
    const ring = [
      rec(e1, ['supersedes', v1]),
      rec(e2, ['supersedes', e1]),
      rec(v1, ['supersedes', e2]),
    ];
    expect(hasCycle(ring)).toBe(true);
    expect(hasCycle([...ring, rec(v2, ['supersedes', v1])])).toBe(true);
  });

  test('a tail that does not close the ring is not a cycle', () => {
    expect(
      hasCycle([rec(e1), rec(e2, ['supersedes', e1]), rec(v1, ['supersedes', e2]), rec(v2)]),
    ).toBe(false);
  });
});

describe('structural rules (D-10)', () => {
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

  test('a valid relation returns the kind', () => {
    expect(checkRelation({ kind: 'supports' }, ctx())).toEqual({ kind: 'supports' });
  });

  test('self-relation', () => {
    const result = checkRelation(
      { kind: 'supports' },
      ctx({ to: { id: id('p', 10), type: 'verdict', target: SAME_TARGET } }),
    );
    expect(violationOf(result)).toEqual({ code: 'self-relation' });
  });

  test('as fills in the kind; a kind equal to that of the name passes', () => {
    expect(checkRelation({ as: 'based-on' }, ctx())).toEqual({ kind: 'supports' });
    expect(checkRelation({ as: 'based-on', kind: 'supports' }, ctx())).toEqual({
      kind: 'supports',
    });
  });

  test('unknown-relation-name e kind-mismatch', () => {
    expect(violationOf(checkRelation({ as: 'nope' }, ctx()))).toEqual({
      code: 'unknown-relation-name',
    });
    expect(violationOf(checkRelation({ as: 'based-on', kind: 'contradicts' }, ctx()))).toEqual({
      code: 'kind-mismatch',
    });
  });

  test('endpoint-type refuses a source or destination outside the name lists', () => {
    const wrongFrom = ctx({ from: { id: id('p', 10), type: 'evidence', target: SAME_TARGET } });
    const wrongTo = ctx({ to: { id: e1, type: 'verdict', target: SAME_TARGET } });
    expect(violationOf(checkRelation({ as: 'based-on' }, wrongFrom))).toEqual({
      code: 'endpoint-type',
    });
    expect(violationOf(checkRelation({ as: 'based-on' }, wrongTo))).toEqual({
      code: 'endpoint-type',
    });
  });

  test('endpoints with no declared list accept any type', () => {
    const base = ctx({ from: { id: id('p', 10), type: 'evidence', target: SAME_TARGET } });
    expect(checkRelation({ as: 'replaces' }, base)).toEqual({ kind: 'supersedes' });
  });

  test('cross-process-currency on supersedes and on revokes across processes', () => {
    const other = { to: { id: id('q', 1), type: 'verdict', target: SAME_TARGET } };
    expect(violationOf(checkRelation({ kind: 'supersedes' }, ctx(other)))).toEqual({
      code: 'cross-process-currency',
    });
    expect(violationOf(checkRelation({ kind: 'revokes' }, ctx(other)))).toEqual({
      code: 'cross-process-currency',
    });
  });

  test('type-mismatch only on supersedes: revokes accepts another type', () => {
    expect(violationOf(checkRelation({ kind: 'supersedes' }, ctx()))).toEqual({
      code: 'type-mismatch',
    });
    expect(checkRelation({ kind: 'revokes' }, ctx())).toEqual({ kind: 'revokes' });
  });

  test('target-mismatch only on supersedes: revokes accepts another target', () => {
    const sameType = { from: { id: id('p', 10), type: 'evidence', target: SAME_TARGET } };
    const elsewhere = { to: { id: e1, type: 'evidence', target: OTHER_TARGET } };
    expect(
      violationOf(checkRelation({ kind: 'supersedes' }, ctx({ ...sameType, ...elsewhere }))),
    ).toEqual({ code: 'target-mismatch' });
    expect(checkRelation({ kind: 'revokes' }, ctx({ ...sameType, ...elsewhere }))).toEqual({
      kind: 'revokes',
    });
  });

  test('supersedes on the same target and type passes', () => {
    const sameType = { from: { id: id('p', 10), type: 'evidence', target: SAME_TARGET } };
    expect(checkRelation({ kind: 'supersedes' }, ctx(sameType))).toEqual({ kind: 'supersedes' });
  });

  test('supports-and-contradicts in both directions', () => {
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
    expect(
      checkRelation({ kind: 'contradicts' }, ctx({ siblings: [{ kind: 'supports', to: e2 }] })),
    ).toEqual({
      kind: 'contradicts',
    });
  });

  test('stale-destination carries the current version of the lineage, or null', () => {
    const replaced = buildVigency([rec(e1), rec(e2, ['supersedes', e1])]);
    const revoked = buildVigency([rec(e1), rec(v1, ['revokes', e1])]);
    expect(violationOf(checkRelation({ kind: 'supports' }, ctx(inForce(replaced))))).toEqual({
      code: 'stale-destination',
      current: e2,
    });
    expect(violationOf(checkRelation({ kind: 'supports' }, ctx(inForce(revoked))))).toEqual({
      code: 'stale-destination',
      current: null,
    });
  });

  test('only supports checks the destination vigency: contradicts, answers and derivesFrom pass', () => {
    const replaced = buildVigency([rec(e1), rec(e2, ['supersedes', e1])]);
    for (const kind of [
      'contradicts',
      'answers',
      'derivesFrom',
      'complements',
      'reopens',
    ] as const) {
      expect(checkRelation({ kind }, ctx(inForce(replaced)))).toEqual({ kind });
    }
  });

  test('not-current on supersedes and revokes over an already superseded or revoked record', () => {
    const sameType = { from: { id: id('p', 10), type: 'evidence', target: SAME_TARGET } };
    const replaced = buildVigency([rec(e1), rec(e2, ['supersedes', e1])]);
    const revoked = buildVigency([rec(e1), rec(v1, ['revokes', e1])]);
    expect(
      violationOf(
        checkRelation({ kind: 'supersedes' }, ctx({ ...sameType, ...inForce(replaced) })),
      ),
    ).toEqual({
      code: 'not-current',
      current: e2,
    });
    expect(
      violationOf(checkRelation({ kind: 'revokes' }, ctx({ ...sameType, ...inForce(revoked) }))),
    ).toEqual({
      code: 'not-current',
      current: null,
    });
  });

  describe('vigency by relation kind (U1, D-10)', () => {
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

    test.each([
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
      'batch [supersedes → E, supports → E], %s: supersedes passes and supports is refused',
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

    test('checkRelation asks for the vigency of the relation kind itself', () => {
      const { vigencyFor: forSupports } = checkInBatch([['supports', e1]], 0);
      expect(forSupports).toHaveBeenCalledWith('supports');
      const { vigencyFor: forRevokes } = checkInBatch([['revokes', e1]], 0);
      expect(forRevokes).toHaveBeenCalledWith('revokes');
    });
  });

  test('supersedes-and-revokes in both directions, and only for the same destination', () => {
    const sameType = { from: { id: id('p', 10), type: 'evidence', target: SAME_TARGET } };
    const revokes = [{ kind: 'revokes' as const, to: e1 }];
    const supersedes = [{ kind: 'supersedes' as const, to: e1 }];
    expect(
      violationOf(checkRelation({ kind: 'supersedes' }, ctx({ ...sameType, siblings: revokes }))),
    ).toEqual({ code: 'supersedes-and-revokes' });
    expect(
      violationOf(checkRelation({ kind: 'revokes' }, ctx({ ...sameType, siblings: supersedes }))),
    ).toEqual({ code: 'supersedes-and-revokes' });
    const elsewhere = [{ kind: 'revokes' as const, to: e2 }];
    expect(
      checkRelation({ kind: 'supersedes' }, ctx({ ...sameType, siblings: elsewhere })),
    ).toEqual({ kind: 'supersedes' });
  });

  describe('fixed rule order (D-06, D-10)', () => {
    const sameType = { from: { id: id('p', 10), type: 'evidence', target: SAME_TARGET } };
    const otherProcess = { to: { id: id('q', 1), type: 'verdict', target: SAME_TARGET } };
    const replaced = buildVigency([rec(e1), rec(e2, ['supersedes', e1])]);

    // Cada caso viola duas regras vizinhas da ordem; vale a primeira.
    test.each([
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
      '%s',
      (_label, input, overrides, code) => {
        expect(violationOf(checkRelation(input, ctx(overrides)))?.code).toBe(code);
      },
    );

    test('as stands in for the name kind in the rules that read the kind', () => {
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

  test('kind or as is required: the type refuses a relation with neither', () => {
    const parsed: RelationInput = { to: e1, kind: 'supports' };
    expect(checkRelation(parsed, ctx())).toEqual({ kind: 'supports' });
    expect(checkRelation({ kind: 'supports', as: 'based-on' }, ctx())).toEqual({
      kind: 'supports',
    });
    // @ts-expect-error nem kind nem as
    const withoutBoth = () => checkRelation({}, ctx());
    expect(withoutBoth).toBeInstanceOf(Function);
  });
});

describe('proof expired by the lineage (D-09)', () => {
  // Caso rdsc: veredito (verdict) apoiado por evidência (evidence) via based-on = supports.
  const evidence = id('p', 1);
  const evidence2 = id('p', 2);
  const verdict = id('p', 3);
  const verdict2 = id('p', 4);

  test('a current verdict that cites evidence later superseded gets staleOut', () => {
    const marks = needsReview([
      rec(evidence),
      rec(verdict, ['supports', evidence]),
      rec(evidence2, ['supersedes', evidence]),
    ]);
    expect(marks.get(verdict)).toEqual({ staleIn: [], staleOut: [evidence] });
    expect(marks.has(evidence2)).toBe(false);
  });

  test('the mark clears when verdict V’ supersedes V citing the new evidence', () => {
    const marks = needsReview([
      rec(evidence),
      rec(verdict, ['supports', evidence]),
      rec(evidence2, ['supersedes', evidence]),
      rec(verdict2, ['supersedes', verdict], ['supports', evidence2]),
    ]);
    expect(marks.size).toBe(0);
  });

  test('V’ superseding V without citing the new evidence has no mark, since it supports nothing anymore', () => {
    const marks = needsReview([
      rec(evidence),
      rec(verdict, ['supports', evidence]),
      rec(evidence2, ['supersedes', evidence]),
      rec(verdict2, ['supersedes', verdict]),
    ]);
    expect(marks.size).toBe(0);
  });

  test('revoked evidence marks the current verdict', () => {
    const marks = needsReview([
      rec(evidence),
      rec(verdict, ['supports', evidence]),
      rec(id('p', 5), ['revokes', evidence]),
    ]);
    expect(marks.get(verdict)).toEqual({ staleIn: [], staleOut: [evidence] });
  });

  test('a current verdict citing current evidence gets no mark', () => {
    expect(needsReview([rec(evidence), rec(verdict, ['supports', evidence])]).size).toBe(0);
  });

  // Plano aprovado por revisão: a revisão (review) apoia o plano (plan).
  const plan = id('p', 11);
  const review = id('p', 12);
  const review2 = id('p', 13);

  test('a plan approved by a review later superseded gets staleIn if the current one no longer supports it', () => {
    const marks = needsReview([
      rec(plan),
      rec(review, ['supports', plan]),
      rec(review2, ['supersedes', review]),
    ]);
    expect(marks.get(plan)).toEqual({ staleIn: [review], staleOut: [] });
  });

  test('R’ repeating supports for the plan keeps the support alive and the plan unmarked', () => {
    const marks = needsReview([
      rec(plan),
      rec(review, ['supports', plan]),
      rec(review2, ['supersedes', review], ['supports', plan]),
    ]);
    expect(marks.size).toBe(0);
  });

  test('a revoked review (revoked support lineage) marks the plan', () => {
    const marks = needsReview([
      rec(plan),
      rec(review, ['supports', plan]),
      rec(id('p', 14), ['revokes', review]),
    ]);
    expect(marks.get(plan)).toEqual({ staleIn: [review], staleOut: [] });
  });

  test('the lists come out sorted', () => {
    const marks = needsReview([
      rec(evidence),
      rec(evidence2),
      rec(verdict, ['supports', evidence2], ['supports', evidence]),
      rec(id('p', 6), ['supersedes', evidence]),
      rec(id('p', 7), ['supersedes', evidence2]),
    ]);
    expect(marks.get(verdict)?.staleOut).toEqual([evidence, evidence2]);
  });

  test('staleIn also comes out sorted, whatever the read order', () => {
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

  test('a destination not in records generates no mark (D-24, D-09)', () => {
    const unread = id('q', 1);
    const marks = needsReview([
      rec(evidence, ['supports', unread]),
      rec(evidence2, ['supersedes', evidence]),
    ]);
    expect(marks.size).toBe(0);
  });

  test('control: the same support with the destination read marks the current source', () => {
    const marks = needsReview([
      rec(evidence),
      rec(evidence2, ['supersedes', evidence]),
      rec(verdict, ['supports', evidence]),
    ]);
    expect(marks.get(verdict)).toEqual({ staleIn: [], staleOut: [evidence] });
  });
});

describe('needsReview with inheritance (ADR 0007, item 10)', () => {
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

  test('an inherited support counts as alive: the superseded unit leaves no mark', () => {
    expect(needsReview(superseded).get(evidence)).toEqual({ staleIn: [], staleOut: [unit] });
    expect(marksOf(superseded).size).toBe(0);
  });

  test('a contradicts between the lineages cuts the inheritance and the mark returns', () => {
    const marks = marksOf([
      rec(unit),
      rec(evidence, ['supports', unit]),
      rec(unit2, ['supersedes', unit], ['contradicts', evidence]),
    ]);
    expect(marks.get(evidence)).toEqual({ staleIn: [], staleOut: [unit] });
  });

  test('a direct support stays alive even when a contradicts cuts the lineage pair', () => {
    const records = [
      rec(unit),
      rec(evidence, ['supports', unit], ['supports', unit2]),
      rec(unit2, ['supersedes', unit], ['contradicts', evidence]),
    ];
    expect(marksOf(records).size).toBe(0);
  });

  test('a support from a superseded review still marks the plan', () => {
    const records = [
      rec(unit),
      rec(review, ['supports', unit]),
      rec(review2, ['supersedes', review]),
    ];
    expect(marksOf(records).get(unit)).toEqual({ staleIn: [review], staleOut: [] });
  });

  test('without an inheritance argument the behavior is the one without inheritance', () => {
    const records = [...superseded];
    expect(needsReview(records, buildVigency(records), NO_INHERITANCE)).toEqual(
      needsReview(records),
    );
  });
});
