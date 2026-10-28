import { describe, it, expect } from '@jest/globals';
import { buildInheritance, NO_INHERITANCE } from '../../src/domain/inheritance.ts';
import {
  buildVigency,
  checkRelation,
  endsVigency,
  hasCycle,
  needsReview,
} from '../../src/domain/relations.ts';
import type { Linked, NamedRelation, RuleContext, Vigency } from '../../src/domain/relations.ts';
import { RelationKind, type RelationKind as Kind } from '../../src/domain/record.ts';
import * as rdsc from '../fixtures/domains/rdsc.ts';
import { at, recordId } from '../helpers.ts';

function rec(id: string, ...relations: [Kind, string][]): Linked {
  return { id, relations: relations.map(([kind, to]) => ({ kind, to })) };
}

const [e1, e2, v1, v2] = [recordId('p', 1), recordId('p', 2), recordId('p', 3), recordId('p', 4)];

const SAME_TARGET = 'p.step';
const OTHER_TARGET = 'p.other';
const SELF = recordId('p', 10);
const FROM_EVIDENCE = { from: { id: SELF, type: 'evidence', target: SAME_TARGET } };

describe('endsVigency', () => {
  // percorre o enum inteiro: uma espécie nova entra no teste sem edição e cai em "não encerra"
  const ENDING: Kind[] = ['supersedes', 'revokes'];

  it.each(RelationKind.options)('should tell whether %s ends the vigency', (kind) => {
    const ends = endsVigency(kind);

    expect(ends).toBe(ENDING.includes(kind));
  });
});

describe('buildVigency', () => {
  const lineage = [rec(e1), rec(e2, ['supersedes', e1]), rec(v1, ['supersedes', e2])];

  it('should treat a record with no incoming relation as current', () => {
    const vigency = buildVigency([rec(e1)]);

    expect(vigency.isCurrent(e1)).toBe(true);
    expect(vigency.currentOf(e1)).toBe(e1);
  });

  it('should treat an unknown id as current', () => {
    const vigency = buildVigency([rec(e1)]);

    expect(vigency.isCurrent(recordId('p', 99))).toBe(true);
  });

  it('should remove a superseded record from force', () => {
    const vigency = buildVigency(lineage);

    expect([e1, e2, v1].map((x) => vigency.isCurrent(x))).toEqual([false, false, true]);
  });

  it('should resolve every version of a lineage to its last one', () => {
    const vigency = buildVigency(lineage);

    expect(vigency.currentOf(e1)).toBe(v1);
    expect(vigency.currentOf(e2)).toBe(v1);
  });

  it('should remove a revoked record from force', () => {
    const vigency = buildVigency([rec(e1), rec(e2, ['supersedes', e1]), rec(v1, ['revokes', e2])]);

    expect(vigency.isCurrent(e2)).toBe(false);
    expect(vigency.isCurrent(v1)).toBe(true);
  });

  it('should end the lineage with no current record when the current version is revoked', () => {
    const vigency = buildVigency([rec(e1), rec(e2, ['supersedes', e1]), rec(v1, ['revokes', e2])]);

    expect(vigency.currentOf(e1)).toBeNull();
    expect(vigency.currentOf(e2)).toBeNull();
  });

  it('should not change vigency for a relation that is neither supersedes nor revokes', () => {
    const vigency = buildVigency([rec(e1), rec(v1, ['supports', e1], ['complements', e1])]);

    expect(vigency.isCurrent(e1)).toBe(true);
  });

  it('should terminate with no current record on a hand-built cycle', () => {
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
        rec(v1, ['supersedes', e2], ['supersedes', recordId('q', 1)]),
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

  const replaced = buildVigency([rec(e1), rec(e2, ['supersedes', e1])]);
  const revoked = buildVigency([rec(e1), rec(v1, ['revokes', e1])]);
  const OTHER_PROCESS = { to: { id: recordId('q', 1), type: 'verdict', target: SAME_TARGET } };

  function ctx(overrides: Partial<RuleContext> = {}): RuleContext {
    return {
      from: { id: SELF, type: 'verdict', target: SAME_TARGET },
      to: { id: e1, type: 'evidence', target: SAME_TARGET },
      siblings: [],
      names,
      ...inForce(buildVigency([rec(e1)])),
      ...overrides,
    };
  }

  const violationOf = (result: ReturnType<typeof checkRelation>) =>
    'violation' in result ? result.violation : undefined;

  it('should return the kind for a valid relation', () => {
    expect(checkRelation({ kind: 'supports' }, ctx())).toEqual({ kind: 'supports' });
  });

  it('should report self-relation', () => {
    const result = checkRelation(
      { kind: 'supports' },
      ctx({ to: { id: SELF, type: 'verdict', target: SAME_TARGET } }),
    );

    expect(violationOf(result)).toEqual({ code: 'self-relation' });
  });

  it('should fill in the kind from as', () => {
    expect(checkRelation({ as: 'based-on' }, ctx())).toEqual({ kind: 'supports' });
  });

  it('should accept a kind equal to that of the name', () => {
    expect(checkRelation({ as: 'based-on', kind: 'supports' }, ctx())).toEqual({
      kind: 'supports',
    });
  });

  it('should report unknown-relation-name', () => {
    expect(violationOf(checkRelation({ as: 'nope' }, ctx()))).toEqual({
      code: 'unknown-relation-name',
    });
  });

  it('should report kind-mismatch with the kind of the pinned name', () => {
    expect(violationOf(checkRelation({ as: 'based-on', kind: 'contradicts' }, ctx()))).toEqual({
      code: 'kind-mismatch',
      kind: 'supports',
    });
  });

  it.each([
    ['source', FROM_EVIDENCE],
    ['destination', { to: { id: e1, type: 'verdict', target: SAME_TARGET } }],
  ])('should refuse a %s outside the name lists with endpoint-type', (_end, overrides) => {
    expect(violationOf(checkRelation({ as: 'based-on' }, ctx(overrides)))).toEqual({
      code: 'endpoint-type',
    });
  });

  it('should accept any type for an endpoint with no declared list', () => {
    expect(checkRelation({ as: 'replaces' }, ctx(FROM_EVIDENCE))).toEqual({ kind: 'supersedes' });
  });

  it('should report cross-process-currency on supersedes and on revokes across processes', () => {
    expect(violationOf(checkRelation({ kind: 'supersedes' }, ctx(OTHER_PROCESS)))).toEqual({
      code: 'cross-process-currency',
    });
    expect(violationOf(checkRelation({ kind: 'revokes' }, ctx(OTHER_PROCESS)))).toEqual({
      code: 'cross-process-currency',
    });
  });

  it('should report type-mismatch only on supersedes, since revokes accepts another type', () => {
    expect(violationOf(checkRelation({ kind: 'supersedes' }, ctx()))).toEqual({
      code: 'type-mismatch',
    });
    expect(checkRelation({ kind: 'revokes' }, ctx())).toEqual({ kind: 'revokes' });
  });

  it('should report target-mismatch only on supersedes, since revokes accepts another target', () => {
    const elsewhere = { to: { id: e1, type: 'evidence', target: OTHER_TARGET } };

    expect(
      violationOf(checkRelation({ kind: 'supersedes' }, ctx({ ...FROM_EVIDENCE, ...elsewhere }))),
    ).toEqual({ code: 'target-mismatch' });
    expect(checkRelation({ kind: 'revokes' }, ctx({ ...FROM_EVIDENCE, ...elsewhere }))).toEqual({
      kind: 'revokes',
    });
  });

  it('should accept supersedes on the same target and type', () => {
    expect(checkRelation({ kind: 'supersedes' }, ctx(FROM_EVIDENCE))).toEqual({
      kind: 'supersedes',
    });
  });

  it('should report supports-and-contradicts in both directions', () => {
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

  it('should not report supports-and-contradicts for different destinations', () => {
    expect(
      checkRelation({ kind: 'contradicts' }, ctx({ siblings: [{ kind: 'supports', to: e2 }] })),
    ).toEqual({
      kind: 'contradicts',
    });
  });

  it.each<[string, Vigency, string | null]>([
    ['a replaced destination', replaced, e2],
    ['a revoked destination', revoked, null],
  ])(
    'should report stale-destination for %s, carrying the current version of the lineage or null',
    (_case, vigency, current) => {
      expect(violationOf(checkRelation({ kind: 'supports' }, ctx(inForce(vigency))))).toEqual({
        code: 'stale-destination',
        current,
      });
    },
  );

  it.each(['contradicts', 'answers', 'derivesFrom', 'complements', 'reopens'] as const)(
    'should skip the destination vigency check for %s',
    (kind) => {
      expect(checkRelation({ kind }, ctx(inForce(replaced)))).toEqual({ kind });
    },
  );

  it.each<[string, Kind, Vigency, string | null]>([
    ['supersedes over a superseded record', 'supersedes', replaced, e2],
    ['revokes over a revoked record', 'revokes', revoked, null],
  ])('should report not-current for %s', (_case, kind, vigency, current) => {
    expect(
      violationOf(checkRelation({ kind }, ctx({ ...FROM_EVIDENCE, ...inForce(vigency) }))),
    ).toEqual({
      code: 'not-current',
      current,
    });
  });

  describe('when the vigency depends on the relation kind', () => {
    /** Um lote de um item: `before` é o que vigora antes dele, `whole` inclui as relações dele. */
    function checkInBatch(relations: [Kind, string][], index: number) {
      const [kind, to] = at(relations, index);
      const before = buildVigency([rec(e1)]);
      const whole = buildVigency([rec(e1), rec(SELF, ...relations)]);
      const siblings = relations
        .filter((_, i) => i !== index)
        .map(([k, t]) => ({ kind: k, to: t }));

      return checkRelation(
        { kind },
        ctx({
          ...FROM_EVIDENCE,
          to: { id: to, type: 'evidence', target: SAME_TARGET },
          siblings,
          vigencyFor: (relationKind) => (relationKind === 'supports' ? whole : before),
        }),
      );
    }

    // Só o `supports` lê o lote inteiro: a espécie que encerra a vigência passa, e o `supports` vê
    // o destino já encerrado pelo próprio lote.
    const batches: [string, [Kind, string][], string | null][] = [
      [
        'supersedes then supports',
        [
          ['supersedes', e1],
          ['supports', e1],
        ],
        SELF,
      ],
      [
        'supports then supersedes',
        [
          ['supports', e1],
          ['supersedes', e1],
        ],
        SELF,
      ],
      [
        'revokes then supports',
        [
          ['revokes', e1],
          ['supports', e1],
        ],
        null,
      ],
      [
        'supports then revokes',
        [
          ['supports', e1],
          ['revokes', e1],
        ],
        null,
      ],
    ];

    it.each(batches)('should accept the ending relation in the batch %s', (_label, relations) => {
      const index = relations.findIndex(([kind]) => kind !== 'supports');

      expect(checkInBatch(relations, index)).toEqual({ kind: at(relations, index)[0] });
    });

    it.each(batches)(
      'should refuse the supports of the same destination in the batch %s',
      (_label, relations, current) => {
        const index = relations.findIndex(([kind]) => kind === 'supports');

        expect(violationOf(checkInBatch(relations, index))).toEqual({
          code: 'stale-destination',
          current,
        });
      },
    );
  });

  it('should report supersedes-and-revokes in both directions', () => {
    const revokes = [{ kind: 'revokes' as const, to: e1 }];
    const supersedes = [{ kind: 'supersedes' as const, to: e1 }];

    expect(
      violationOf(
        checkRelation({ kind: 'supersedes' }, ctx({ ...FROM_EVIDENCE, siblings: revokes })),
      ),
    ).toEqual({ code: 'supersedes-and-revokes' });
    expect(
      violationOf(
        checkRelation({ kind: 'revokes' }, ctx({ ...FROM_EVIDENCE, siblings: supersedes })),
      ),
    ).toEqual({ code: 'supersedes-and-revokes' });
  });

  it('should not report supersedes-and-revokes for different destinations', () => {
    const elsewhere = [{ kind: 'revokes' as const, to: e2 }];

    expect(
      checkRelation({ kind: 'supersedes' }, ctx({ ...FROM_EVIDENCE, siblings: elsewhere })),
    ).toEqual({ kind: 'supersedes' });
  });

  describe('when two rules are violated at once', () => {
    // Cada caso viola duas regras vizinhas da ordem; vale a primeira.
    it.each<[string, Parameters<typeof checkRelation>[0], Partial<RuleContext>, string]>([
      [
        'self-relation before unknown-relation-name',
        { as: 'nope' },
        { to: { id: SELF, type: 'verdict', target: SAME_TARGET } },
        'self-relation',
      ],
      [
        'kind-mismatch before cross-process-currency',
        { as: 'replaces', kind: 'revokes' },
        OTHER_PROCESS,
        'kind-mismatch',
      ],
      [
        'cross-process-currency before type-mismatch',
        { kind: 'supersedes' },
        OTHER_PROCESS,
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
        { ...FROM_EVIDENCE, to: { id: recordId('q', 1), type: 'evidence', target: OTHER_TARGET } },
        'cross-process-currency',
      ],
      [
        'target-mismatch before endpoint-type',
        { as: 'replaces-doc' },
        {
          from: { id: SELF, type: 'verdict', target: SAME_TARGET },
          to: { id: e1, type: 'verdict', target: OTHER_TARGET },
        },
        'target-mismatch',
      ],
      ['type-mismatch before endpoint-type', { as: 'replaces-doc' }, {}, 'type-mismatch'],
      [
        'endpoint-type before supports-and-contradicts',
        { as: 'based-on' },
        { ...FROM_EVIDENCE, siblings: [{ kind: 'contradicts', to: e1 }] },
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
        { ...FROM_EVIDENCE, siblings: [{ kind: 'revokes', to: e1 }], ...inForce(replaced) },
        'supersedes-and-revokes',
      ],
      [
        'target-mismatch before not-current',
        { kind: 'supersedes' },
        {
          ...FROM_EVIDENCE,
          to: { id: e1, type: 'evidence', target: OTHER_TARGET },
          ...inForce(replaced),
        },
        'target-mismatch',
      ],
    ])('should report %s', (_label, input, overrides, code) => {
      expect(violationOf(checkRelation(input, ctx(overrides)))?.code).toBe(code);
    });
  });

  it.each<[string, Parameters<typeof checkRelation>[0], Partial<RuleContext>, object]>([
    [
      'cross-process-currency',
      { as: 'replaces' },
      OTHER_PROCESS,
      { code: 'cross-process-currency' },
    ],
    [
      'not-current',
      { as: 'replaces' },
      { ...FROM_EVIDENCE, ...inForce(replaced) },
      { code: 'not-current', current: e2 },
    ],
    [
      'stale-destination',
      { as: 'based-on' },
      inForce(replaced),
      { code: 'stale-destination', current: e2 },
    ],
  ])(
    'should let as stand in for the name kind in the %s rule',
    (_rule, input, overrides, violation) => {
      expect(violationOf(checkRelation(input, ctx(overrides)))).toEqual(violation);
    },
  );

  it('should require kind or as in the type of the relation input', () => {
    // Só o `tsc` (`npm run typecheck`) confere o `@ts-expect-error`: o ts-jest roda com
    // `isolatedModules`. O `expect` só atende o `jest/expect-expect`.
    // @ts-expect-error nem kind nem as
    const withoutBoth = () => checkRelation({}, ctx());

    expect(withoutBoth).toBeInstanceOf(Function);
  });
});

describe('needsReview', () => {
  // Caso rdsc: veredito (v1) apoiado por evidência (e1) via based-on = supports.
  it('should give staleOut to a current verdict that cites evidence later superseded', () => {
    const marks = needsReview([rec(e1), rec(v1, ['supports', e1]), rec(e2, ['supersedes', e1])]);

    expect(marks.get(v1)).toEqual({ staleIn: [], staleOut: [e1] });
    expect(marks.has(e2)).toBe(false);
  });

  it('should clear the mark when a new verdict version supersedes the old one citing the new evidence', () => {
    const marks = needsReview([
      rec(e1),
      rec(v1, ['supports', e1]),
      rec(e2, ['supersedes', e1]),
      rec(v2, ['supersedes', v1], ['supports', e2]),
    ]);

    expect(marks.size).toBe(0);
  });

  it('should leave no mark when the new verdict version cites no evidence, since it supports nothing anymore', () => {
    const marks = needsReview([
      rec(e1),
      rec(v1, ['supports', e1]),
      rec(e2, ['supersedes', e1]),
      rec(v2, ['supersedes', v1]),
    ]);

    expect(marks.size).toBe(0);
  });

  it('should mark the current verdict when its evidence is revoked', () => {
    const marks = needsReview([
      rec(e1),
      rec(v1, ['supports', e1]),
      rec(recordId('p', 5), ['revokes', e1]),
    ]);

    expect(marks.get(v1)).toEqual({ staleIn: [], staleOut: [e1] });
  });

  it('should give no mark to a current verdict citing current evidence', () => {
    expect(needsReview([rec(e1), rec(v1, ['supports', e1])]).size).toBe(0);
  });

  // Plano aprovado por revisão: a revisão (review) apoia o plano (plan).
  const plan = recordId('p', 11);
  const review = recordId('p', 12);
  const review2 = recordId('p', 13);

  it('should give staleIn to a plan approved by a review later superseded when the current one no longer supports it', () => {
    const marks = needsReview([
      rec(plan),
      rec(review, ['supports', plan]),
      rec(review2, ['supersedes', review]),
    ]);

    expect(marks.get(plan)).toEqual({ staleIn: [review], staleOut: [] });
  });

  it('should keep the support alive and the plan unmarked when the new review version repeats supports for the plan', () => {
    const marks = needsReview([
      rec(plan),
      rec(review, ['supports', plan]),
      rec(review2, ['supersedes', review], ['supports', plan]),
    ]);

    expect(marks.size).toBe(0);
  });

  it('should mark the plan when the support lineage of its review is revoked', () => {
    const marks = needsReview([
      rec(plan),
      rec(review, ['supports', plan]),
      rec(recordId('p', 14), ['revokes', review]),
    ]);

    expect(marks.get(plan)).toEqual({ staleIn: [review], staleOut: [] });
  });

  it('should return the lists sorted', () => {
    const marks = needsReview([
      rec(e1),
      rec(e2),
      rec(v1, ['supports', e2], ['supports', e1]),
      rec(recordId('p', 6), ['supersedes', e1]),
      rec(recordId('p', 7), ['supersedes', e2]),
    ]);

    expect(marks.get(v1)?.staleOut).toEqual([e1, e2]);
  });

  it('should return staleIn sorted too, whatever the read order', () => {
    const [reviewA, reviewB] = [recordId('p', 12), recordId('p', 13)];
    const marks = needsReview([
      rec(plan),
      rec(reviewB, ['supports', plan]),
      rec(reviewA, ['supports', plan]),
      rec(recordId('p', 14), ['supersedes', reviewA]),
      rec(recordId('p', 15), ['supersedes', reviewB]),
    ]);

    expect(marks.get(plan)?.staleIn).toEqual([reviewA, reviewB]);
  });

  it('should generate no mark for a destination not in records', () => {
    const unread = recordId('q', 1);
    const marks = needsReview([rec(e1, ['supports', unread]), rec(e2, ['supersedes', e1])]);

    expect(marks.size).toBe(0);
  });

  it('should mark the current source when its support destination is among the records read', () => {
    const marks = needsReview([rec(e1), rec(e2, ['supersedes', e1]), rec(v1, ['supports', e1])]);

    expect(marks.get(v1)).toEqual({ staleIn: [], staleOut: [e1] });
  });

  describe('with inheritance', () => {
    const [unit, unit2, supporter, supporter2] = [
      recordId('p', 2),
      recordId('p', 3),
      recordId('p', 4),
      recordId('p', 5),
    ];

    function marksOf(records: Linked[]) {
      const vigency = buildVigency(records);
      return needsReview(
        records,
        vigency,
        buildInheritance(records, vigency, () => true),
      );
    }

    const superseded = [rec(unit), rec(e1, ['supports', unit]), rec(unit2, ['supersedes', unit])];

    it('should mark the superseded unit when there is no inheritance', () => {
      expect(needsReview(superseded).get(e1)).toEqual({ staleIn: [], staleOut: [unit] });
    });

    it('should count an inherited support as alive, so the superseded unit leaves no mark', () => {
      expect(marksOf(superseded).size).toBe(0);
    });

    it('should cut the inheritance and bring the mark back when a contradicts sits between the lineages', () => {
      const marks = marksOf([
        rec(unit),
        rec(e1, ['supports', unit]),
        rec(unit2, ['supersedes', unit], ['contradicts', e1]),
      ]);

      expect(marks.get(e1)).toEqual({ staleIn: [], staleOut: [unit] });
    });

    it('should keep a direct support alive even when a contradicts cuts the lineage pair', () => {
      const records = [
        rec(unit),
        rec(e1, ['supports', unit], ['supports', unit2]),
        rec(unit2, ['supersedes', unit], ['contradicts', e1]),
      ];

      expect(marksOf(records).size).toBe(0);
    });

    it('should still mark the plan for a support from a superseded review', () => {
      const records = [
        rec(unit),
        rec(supporter, ['supports', unit]),
        rec(supporter2, ['supersedes', supporter]),
      ];

      expect(marksOf(records).get(unit)).toEqual({ staleIn: [supporter], staleOut: [] });
    });

    it('should behave as without inheritance when given NO_INHERITANCE', () => {
      expect(needsReview(superseded, buildVigency(superseded), NO_INHERITANCE)).toEqual(
        needsReview(superseded),
      );
    });
  });
});
