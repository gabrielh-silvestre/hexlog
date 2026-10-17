import { describe, it, expect } from '@jest/globals';
import { buildInheritance, NO_INHERITANCE } from '../../src/domain/inheritance.ts';
import { buildVigency } from '../../src/domain/relations.ts';
import type { Linked } from '../../src/domain/relations.ts';
import type { RelationKind as Kind } from '../../src/domain/record.ts';

const id = (process: string, n: number) => `${process}:${String(n).padStart(8, '0')}`;

type Rel = [Kind, string] | [Kind, string, string];

function rec(recordId: string, ...relations: Rel[]): Linked {
  return {
    id: recordId,
    relations: relations.map(([kind, to, as]) => ({ kind, to, ...(as ? { as } : {}) })),
  };
}

function inherit(records: Linked[], isActive: (process: string) => boolean = () => true) {
  return buildInheritance(records, buildVigency(records), isActive);
}

const [e1, e2, e3] = [id('p', 1), id('p', 2), id('p', 3)];
const [u1, u2, u3] = [id('p', 11), id('p', 12), id('p', 13)];

describe('NO_INHERITANCE', () => {
  it('should inherit nothing in any direction', () => {
    expect(NO_INHERITANCE.into(u1)).toEqual([]);
    expect(NO_INHERITANCE.outOf(e1)).toEqual([]);
    expect(NO_INHERITANCE.has('supports', e1, u1)).toBe(false);
  });
});

describe('buildInheritance', () => {
  describe('with a supports relation', () => {
    it('should reach the current version with a support given to a superseded unit', () => {
      const edge = { kind: 'supports', from: e1, to: u2, origin: { from: e1, to: u1 } };

      const inheritance = inherit([rec(e1, ['supports', u1]), rec(u2, ['supersedes', u1])]);

      expect(inheritance.into(u2)).toEqual([edge]);
      expect(inheritance.outOf(e1)).toEqual([edge]);
      expect(inheritance.has('supports', e1, u2)).toBe(true);
      expect(inheritance.into(u1)).toEqual([]);
    });

    it('should reach the third version with a support recorded for the first of three', () => {
      const inheritance = inherit([
        rec(e1, ['supports', u1]),
        rec(u2, ['supersedes', u1]),
        rec(u3, ['supersedes', u2]),
      ]);

      expect(inheritance.into(u3)).toEqual([
        { kind: 'supports', from: e1, to: u3, origin: { from: e1, to: u1 } },
      ]);
      expect(inheritance.into(u2)).toEqual([]);
    });

    it('should keep the relation name through the inheritance', () => {
      const inheritance = inherit([
        rec(e1, ['supports', u1, 'based-on']),
        rec(u2, ['supersedes', u1]),
      ]);

      expect(inheritance.into(u2)).toEqual([
        { kind: 'supports', as: 'based-on', from: e1, to: u2, origin: { from: e1, to: u1 } },
      ]);
    });

    it('should not raise a support from a superseded source: the old approval dies with it', () => {
      const records = [rec(e1, ['supports', u1]), rec(e2, ['supersedes', e1])];

      expect(inherit(records).outOf(e2)).toEqual([]);
      expect(inherit([...records, rec(u2, ['supersedes', u1])]).into(u2)).toEqual([]);
    });
  });

  describe('with an answers, derivesFrom, complements or reopens relation', () => {
    const kinds: Kind[] = ['answers', 'derivesFrom', 'complements', 'reopens'];

    it.each(kinds)('should carry the %s of a superseded record on its current version', (kind) => {
      const edge = { kind, from: e2, to: u1, origin: { from: e1, to: u1 } };

      const inheritance = inherit([rec(e1, [kind, u1]), rec(e2, ['supersedes', e1])]);

      expect(inheritance.outOf(e2)).toEqual([edge]);
      expect(inheritance.into(u1)).toEqual([edge]);
      expect(inheritance.has(kind, e2, u1)).toBe(true);
    });

    it.each(kinds)(
      'should keep the destination as recorded for %s when it was superseded',
      (kind) => {
        const inheritance = inherit([
          rec(e1, [kind, u1]),
          rec(e2, ['supersedes', e1]),
          rec(u2, ['supersedes', u1]),
        ]);

        expect(inheritance.into(u2)).toEqual([]);
        expect(inheritance.into(u1)).toEqual([
          { kind, from: e2, to: u1, origin: { from: e1, to: u1 } },
        ]);
      },
    );

    it.each(kinds)('should not inherit the %s of a current record', (kind) => {
      const inheritance = inherit([rec(e1, [kind, u1]), rec(u2, ['supersedes', u1])]);

      expect(inheritance.outOf(e1)).toEqual([]);
      expect(inheritance.into(u2)).toEqual([]);
    });
  });

  describe('with a contradicts, supersedes or revokes relation', () => {
    it('should keep each of them where it was recorded', () => {
      const inheritance = inherit([
        rec(e1, ['contradicts', u1]),
        rec(e2, ['supersedes', e1]),
        rec(u2, ['supersedes', u1]),
        rec(e3, ['revokes', id('p', 21)]),
        rec(id('p', 22), ['supersedes', e3]),
      ]);

      expect(inheritance.outOf(e2)).toEqual([]);
      expect(inheritance.into(u2)).toEqual([]);
      expect(inheritance.outOf(id('p', 22))).toEqual([]);
    });

    it('should not carry the supersedes of a superseded record to its successor', () => {
      const inheritance = inherit([
        rec(e1, ['supersedes', id('p', 30)]),
        rec(e2, ['supersedes', e1]),
      ]);

      expect(inheritance.outOf(e2)).toEqual([]);
    });
  });

  describe('with a direct edge', () => {
    it('should prefer an identical direct edge over the inherited one', () => {
      const inheritance = inherit([
        rec(e1, ['supports', u1], ['supports', u2]),
        rec(u2, ['supersedes', u1]),
      ]);

      expect(inheritance.into(u2)).toEqual([]);
      expect(inheritance.has('supports', e1, u2)).toBe(false);
    });

    it('should keep the inherited edge when the direct edge has another relation name', () => {
      const inheritance = inherit([
        rec(e1, ['supports', u1, 'based-on'], ['supports', u2]),
        rec(u2, ['supersedes', u1]),
      ]);

      expect(inheritance.into(u2)).toHaveLength(1);
    });
  });

  describe('with a revoked lineage', () => {
    it('should inherit nothing when the destination lineage was revoked', () => {
      const inheritance = inherit([
        rec(e1, ['supports', u1]),
        rec(u2, ['supersedes', u1]),
        rec(id('p', 40), ['revokes', u2]),
      ]);

      expect(inheritance.into(u2)).toEqual([]);
      expect(inheritance.outOf(e1)).toEqual([]);
    });

    it('should inherit nothing when the source lineage was revoked', () => {
      const inheritance = inherit([
        rec(e1, ['derivesFrom', u1]),
        rec(e2, ['supersedes', e1]),
        rec(id('p', 40), ['revokes', e2]),
      ]);

      expect(inheritance.outOf(e2)).toEqual([]);
      expect(inheritance.into(u1)).toEqual([]);
    });
  });

  describe('with activation per process', () => {
    const [ea, ub1, ub2] = [id('a', 1), id('b', 1), id('b', 2)];

    it('should follow the process of the lineage that rises for supports', () => {
      const records = [rec(ea, ['supports', ub1]), rec(ub2, ['supersedes', ub1])];

      expect(inherit(records, (process) => process === 'b').into(ub2)).toHaveLength(1);
      expect(inherit(records, (process) => process === 'a').into(ub2)).toEqual([]);
    });

    it('should follow the process of the record that rises for the origin kinds', () => {
      const [ra1, ra2, tb] = [id('a', 11), id('a', 12), id('b', 11)];
      const records = [rec(ra1, ['derivesFrom', tb]), rec(ra2, ['supersedes', ra1])];

      expect(inherit(records, (process) => process === 'a').outOf(ra2)).toHaveLength(1);
      expect(inherit(records, (process) => process === 'b').outOf(ra2)).toEqual([]);
    });

    it('should inherit nothing in either end for an inactive process', () => {
      const inheritance = inherit(
        [
          rec(e1, ['supports', u1], ['derivesFrom', u1]),
          rec(e2, ['supersedes', e1]),
          rec(u2, ['supersedes', u1]),
        ],
        () => false,
      );

      expect(
        [e1, e2, u1, u2].flatMap((x) => [...inheritance.into(x), ...inheritance.outOf(x)]),
      ).toEqual([]);
      expect(inheritance.has('supports', e1, u2)).toBe(false);
    });
  });

  describe('with a contradicts as explicit cut', () => {
    const base = [rec(e1, ['supports', u1]), rec(u2, ['supersedes', u1])];

    it('should inherit the support without a contradicts, as the control', () => {
      expect(inherit(base).into(u2)).toHaveLength(1);
    });

    it('should cut when the current unit contradicts the evidence', () => {
      expect(inherit([...base, rec(u2, ['contradicts', e1])]).into(u2)).toEqual([]);
    });

    it('should not cut when a superseded version of the unit holds the contradicts', () => {
      expect(inherit([...base, rec(u1, ['contradicts', e1])]).into(u2)).toHaveLength(1);
    });

    it('should cut when the evidence contradicts any version of the unit', () => {
      expect(inherit([...base, rec(e1, ['contradicts', u2])]).into(u2)).toEqual([]);
    });

    it('should cut the support a newer version of the evidence repeats when it contradicts', () => {
      const records = [...base, rec(e2, ['supersedes', e1], ['supports', u1], ['contradicts', u2])];

      expect(inherit(records).into(u2)).toEqual([]);
    });

    it('should not cut when the contradicts is between other lineages', () => {
      const other = [rec(id('p', 50)), rec(id('p', 51), ['contradicts', id('p', 50)])];

      expect(inherit([...base, ...other]).into(u2)).toHaveLength(1);
      expect(inherit([...base, rec(id('p', 52), ['contradicts', u2])]).into(u2)).toHaveLength(1);
    });

    it('should reconnect the inheritance when the record holding the cutting contradicts is superseded', () => {
      const cut = [rec(e1, ['supports', u1]), rec(u2, ['supersedes', u1], ['contradicts', e1])];

      expect(inherit(cut).into(u2)).toEqual([]);

      const next = inherit([...cut, rec(u3, ['supersedes', u2])]);

      expect(next.into(u2)).toEqual([]);
      expect(next.into(u3)).toEqual([
        { kind: 'supports', from: e1, to: u3, origin: { from: e1, to: u1 } },
      ]);
    });

    it('should reconnect the inheritance when the record holding the cutting contradicts is revoked', () => {
      const records = [
        rec(e1, ['derivesFrom', u1]),
        rec(e2, ['supersedes', e1]),
        rec(u1, ['contradicts', e1]),
      ];

      expect(inherit(records).outOf(e2)).toEqual([]);

      expect(inherit([...records, rec(id('p', 61), ['revokes', u1])]).outOf(e2)).toHaveLength(1);
    });

    it('should keep the cut when a version repeats the superseded cutting contradicts', () => {
      const records = [
        rec(e1, ['supports', u1]),
        rec(u2, ['supersedes', u1], ['contradicts', e1]),
        rec(u3, ['supersedes', u2], ['contradicts', e1]),
      ];

      expect(inherit(records).into(u3)).toEqual([]);
    });

    it('should also stop the inherited edges of the origin kinds', () => {
      const inheritance = inherit([
        rec(e1, ['derivesFrom', u1]),
        rec(e2, ['supersedes', e1]),
        rec(u2, ['supersedes', u1], ['contradicts', e1]),
      ]);

      expect(inheritance.outOf(e2)).toEqual([]);
    });
  });

  describe('with a log without lineage', () => {
    it('should return the empty inheritance when no record supersedes another', () => {
      expect(inherit([rec(e1, ['supports', u1]), rec(u2, ['contradicts', e1])])).toBe(
        NO_INHERITANCE,
      );
    });
  });

  describe('with more than one inherited edge', () => {
    it('should keep the smallest origin source when two physical edges lead to the same inherited one', () => {
      const records = [
        rec(e1, ['derivesFrom', u1]),
        rec(e2, ['supersedes', e1], ['derivesFrom', u1]),
        rec(e3, ['supersedes', e2]),
      ];
      const expected = [{ kind: 'derivesFrom', from: e3, to: u1, origin: { from: e1, to: u1 } }];

      expect(inherit(records).outOf(e3)).toEqual(expected);
      expect(inherit([...records].reverse()).outOf(e3)).toEqual(expected);
    });

    it('should go to the smallest origin destination on a tie of the origin source', () => {
      const records = [
        rec(e1, ['supports', u1], ['supports', u2]),
        rec(u2, ['supersedes', u1]),
        rec(u3, ['supersedes', u2]),
      ];
      const expected = [{ kind: 'supports', from: e1, to: u3, origin: { from: e1, to: u1 } }];

      expect(inherit(records).into(u3)).toEqual(expected);
      expect(inherit([...records].reverse()).into(u3)).toEqual(expected);
    });

    it('should sort the output by from, to, kind and name', () => {
      const records = [
        rec(e2, ['supports', u1]),
        rec(e1, ['supports', u1, 'b-name'], ['supports', u1, 'a-name']),
        rec(u2, ['supersedes', u1]),
      ];

      const into = inherit(records).into(u2);

      expect(into.map(({ from, as }) => [from, as])).toEqual([
        [e1, 'a-name'],
        [e1, 'b-name'],
        [e2, undefined],
      ]);
    });
  });
});
