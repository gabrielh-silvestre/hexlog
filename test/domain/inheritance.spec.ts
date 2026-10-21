import { describe, test, expect } from '@jest/globals';
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
  test('inherits nothing in any direction', () => {
    expect(NO_INHERITANCE.into(u1)).toEqual([]);
    expect(NO_INHERITANCE.outOf(e1)).toEqual([]);
    expect(NO_INHERITANCE.has('supports', e1, u1)).toBe(false);
  });
});

describe('supports raises the destination', () => {
  test('support given to a superseded unit reaches its current version', () => {
    const inheritance = inherit([rec(e1, ['supports', u1]), rec(u2, ['supersedes', u1])]);
    const edge = { kind: 'supports', from: e1, to: u2, origin: { from: e1, to: u1 } };
    expect(inheritance.into(u2)).toEqual([edge]);
    expect(inheritance.outOf(e1)).toEqual([edge]);
    expect(inheritance.has('supports', e1, u2)).toBe(true);
    expect(inheritance.into(u1)).toEqual([]);
  });

  test('a support recorded for the first of three versions reaches the third', () => {
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

  test('the relation name survives the inheritance', () => {
    const inheritance = inherit([
      rec(e1, ['supports', u1, 'based-on']),
      rec(u2, ['supersedes', u1]),
    ]);
    expect(inheritance.into(u2)).toEqual([
      { kind: 'supports', as: 'based-on', from: e1, to: u2, origin: { from: e1, to: u1 } },
    ]);
  });

  test('a support from a superseded source does not rise: the old approval dies with it', () => {
    const records = [rec(e1, ['supports', u1]), rec(e2, ['supersedes', e1])];
    expect(inherit(records).outOf(e2)).toEqual([]);
    expect(inherit([...records, rec(u2, ['supersedes', u1])]).into(u2)).toEqual([]);
  });
});

describe('answers, derivesFrom, complements and reopens raise the source', () => {
  const kinds: Kind[] = ['answers', 'derivesFrom', 'complements', 'reopens'];

  test.each(kinds)('%s of a superseded record is carried by its current version', (kind) => {
    const inheritance = inherit([rec(e1, [kind, u1]), rec(e2, ['supersedes', e1])]);
    const edge = { kind, from: e2, to: u1, origin: { from: e1, to: u1 } };
    expect(inheritance.outOf(e2)).toEqual([edge]);
    expect(inheritance.into(u1)).toEqual([edge]);
    expect(inheritance.has(kind, e2, u1)).toBe(true);
  });

  test.each(kinds)('%s keeps the destination as recorded when it was superseded', (kind) => {
    const inheritance = inherit([
      rec(e1, [kind, u1]),
      rec(e2, ['supersedes', e1]),
      rec(u2, ['supersedes', u1]),
    ]);
    expect(inheritance.into(u2)).toEqual([]);
    expect(inheritance.into(u1)).toEqual([
      { kind, from: e2, to: u1, origin: { from: e1, to: u1 } },
    ]);
  });

  test.each(kinds)('%s of a current record is not inherited', (kind) => {
    const inheritance = inherit([rec(e1, [kind, u1]), rec(u2, ['supersedes', u1])]);
    expect(inheritance.outOf(e1)).toEqual([]);
    expect(inheritance.into(u2)).toEqual([]);
  });
});

describe('kinds that never inherit', () => {
  test('contradicts, supersedes and revokes stay where they were recorded', () => {
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

  test('the supersedes of a superseded record is not carried to its successor', () => {
    const inheritance = inherit([
      rec(e1, ['supersedes', id('p', 30)]),
      rec(e2, ['supersedes', e1]),
    ]);
    expect(inheritance.outOf(e2)).toEqual([]);
  });
});

describe('direct edges', () => {
  test('an identical direct edge wins over the inherited one', () => {
    const inheritance = inherit([
      rec(e1, ['supports', u1], ['supports', u2]),
      rec(u2, ['supersedes', u1]),
    ]);
    expect(inheritance.into(u2)).toEqual([]);
    expect(inheritance.has('supports', e1, u2)).toBe(false);
  });

  test('a direct edge with another relation name does not suppress the inherited one', () => {
    const inheritance = inherit([
      rec(e1, ['supports', u1, 'based-on'], ['supports', u2]),
      rec(u2, ['supersedes', u1]),
    ]);
    expect(inheritance.into(u2)).toHaveLength(1);
  });
});

describe('revoked lineages', () => {
  test('nothing is inherited when the destination lineage was revoked', () => {
    const inheritance = inherit([
      rec(e1, ['supports', u1]),
      rec(u2, ['supersedes', u1]),
      rec(id('p', 40), ['revokes', u2]),
    ]);
    expect(inheritance.into(u2)).toEqual([]);
    expect(inheritance.outOf(e1)).toEqual([]);
  });

  test('nothing is inherited when the source lineage was revoked', () => {
    const inheritance = inherit([
      rec(e1, ['derivesFrom', u1]),
      rec(e2, ['supersedes', e1]),
      rec(id('p', 40), ['revokes', e2]),
    ]);
    expect(inheritance.outOf(e2)).toEqual([]);
    expect(inheritance.into(u1)).toEqual([]);
  });
});

describe('activation per process', () => {
  const [ea, ub1, ub2] = [id('a', 1), id('b', 1), id('b', 2)];

  test('supports follows the process of the lineage that rises', () => {
    const records = [rec(ea, ['supports', ub1]), rec(ub2, ['supersedes', ub1])];
    expect(inherit(records, (process) => process === 'b').into(ub2)).toHaveLength(1);
    expect(inherit(records, (process) => process === 'a').into(ub2)).toEqual([]);
  });

  test('the origin kinds follow the process of the record that rises', () => {
    const [ra1, ra2, tb] = [id('a', 11), id('a', 12), id('b', 11)];
    const records = [rec(ra1, ['derivesFrom', tb]), rec(ra2, ['supersedes', ra1])];
    expect(inherit(records, (process) => process === 'a').outOf(ra2)).toHaveLength(1);
    expect(inherit(records, (process) => process === 'b').outOf(ra2)).toEqual([]);
  });

  test('an inactive process inherits nothing in either end', () => {
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

describe('explicit cut by contradicts', () => {
  const base = [rec(e1, ['supports', u1]), rec(u2, ['supersedes', u1])];

  test('control: without contradicts the support is inherited', () => {
    expect(inherit(base).into(u2)).toHaveLength(1);
  });

  test('a contradicts from the current unit to the evidence cuts', () => {
    expect(inherit([...base, rec(u2, ['contradicts', e1])]).into(u2)).toEqual([]);
  });

  test('a contradicts recorded by a superseded version of the unit no longer cuts', () => {
    expect(inherit([...base, rec(u1, ['contradicts', e1])]).into(u2)).toHaveLength(1);
  });

  test('a contradicts from the evidence to any version of the unit cuts', () => {
    expect(inherit([...base, rec(e1, ['contradicts', u2])]).into(u2)).toEqual([]);
  });

  test('a contradicts from a newer version of the evidence cuts the support it repeats', () => {
    const records = [...base, rec(e2, ['supersedes', e1], ['supports', u1], ['contradicts', u2])];
    expect(inherit(records).into(u2)).toEqual([]);
  });

  test('a contradicts between other lineages does not cut', () => {
    const other = [rec(id('p', 50)), rec(id('p', 51), ['contradicts', id('p', 50)])];
    expect(inherit([...base, ...other]).into(u2)).toHaveLength(1);
    expect(inherit([...base, rec(id('p', 52), ['contradicts', u2])]).into(u2)).toHaveLength(1);
  });

  test('superseding the record that holds the cutting contradicts reconnects the inheritance', () => {
    const cut = [rec(e1, ['supports', u1]), rec(u2, ['supersedes', u1], ['contradicts', e1])];
    expect(inherit(cut).into(u2)).toEqual([]);
    const next = inherit([...cut, rec(u3, ['supersedes', u2])]);
    expect(next.into(u2)).toEqual([]);
    expect(next.into(u3)).toEqual([
      { kind: 'supports', from: e1, to: u3, origin: { from: e1, to: u1 } },
    ]);
  });

  test('revoking the record that holds the cutting contradicts reconnects the inheritance', () => {
    const records = [
      rec(e1, ['derivesFrom', u1]),
      rec(e2, ['supersedes', e1]),
      rec(u1, ['contradicts', e1]),
    ];
    expect(inherit(records).outOf(e2)).toEqual([]);
    expect(inherit([...records, rec(id('p', 61), ['revokes', u1])]).outOf(e2)).toHaveLength(1);
  });

  test('a cutting contradicts superseded by a version that repeats it keeps the cut', () => {
    const records = [
      rec(e1, ['supports', u1]),
      rec(u2, ['supersedes', u1], ['contradicts', e1]),
      rec(u3, ['supersedes', u2], ['contradicts', e1]),
    ];
    expect(inherit(records).into(u3)).toEqual([]);
  });

  test('the cut also stops the inherited edges of the origin kinds', () => {
    const inheritance = inherit([
      rec(e1, ['derivesFrom', u1]),
      rec(e2, ['supersedes', e1]),
      rec(u2, ['supersedes', u1], ['contradicts', e1]),
    ]);
    expect(inheritance.outOf(e2)).toEqual([]);
  });
});

describe('log without lineage', () => {
  test('returns the empty inheritance when no record supersedes another', () => {
    expect(inherit([rec(e1, ['supports', u1]), rec(u2, ['contradicts', e1])])).toBe(NO_INHERITANCE);
  });
});

describe('without isActive', () => {
  test('returns the empty inheritance even when the log has a lineage', () => {
    const records = [rec(e1, ['supports', u1]), rec(u2, ['supersedes', u1])];
    expect(buildInheritance(records, buildVigency(records))).toBe(NO_INHERITANCE);
  });
});

describe('deduplication and order', () => {
  test('two physical edges leading to the same inherited one keep the smallest origin source', () => {
    const records = [
      rec(e1, ['derivesFrom', u1]),
      rec(e2, ['supersedes', e1], ['derivesFrom', u1]),
      rec(e3, ['supersedes', e2]),
    ];
    const expected = [{ kind: 'derivesFrom', from: e3, to: u1, origin: { from: e1, to: u1 } }];
    expect(inherit(records).outOf(e3)).toEqual(expected);
    expect(inherit([...records].reverse()).outOf(e3)).toEqual(expected);
  });

  test('a tie on the origin source goes to the smallest origin destination', () => {
    const records = [
      rec(e1, ['supports', u1], ['supports', u2]),
      rec(u2, ['supersedes', u1]),
      rec(u3, ['supersedes', u2]),
    ];
    const expected = [{ kind: 'supports', from: e1, to: u3, origin: { from: e1, to: u1 } }];
    expect(inherit(records).into(u3)).toEqual(expected);
    expect(inherit([...records].reverse()).into(u3)).toEqual(expected);
  });

  test('the output comes sorted by from, to, kind and name', () => {
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
