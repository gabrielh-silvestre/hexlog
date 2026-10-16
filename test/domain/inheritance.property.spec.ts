import { describe, test, expect } from '@jest/globals';
import fc from 'fast-check';
import { buildInheritance } from '../../src/domain/inheritance.ts';
import type { Inheritance, InheritedEdge } from '../../src/domain/inheritance.ts';
import { buildVigency } from '../../src/domain/relations.ts';
import type { Linked } from '../../src/domain/relations.ts';
import type { RelationKind } from '../../src/domain/record.ts';

type Pick = { kind: RelationKind; pick: number; as: boolean };
type Op = { process: 'a' | 'b'; relations: Pick[] };
type Active = { a: boolean; b: boolean };

// Viés para `supersedes` e para as espécies que herdam, senão a linhagem e a herança quase nunca
// aparecem. O destino é `pick` módulo o número de registros já gravados.
const relation = fc.record<Pick>({
  kind: fc.constantFrom(
    'supersedes',
    'supersedes',
    'supersedes',
    'supports',
    'supports',
    'derivesFrom',
    'answers',
    'complements',
    'reopens',
    'contradicts',
    'revokes',
  ),
  pick: fc.nat(),
  as: fc.boolean(),
});
const op = fc.record<Op>({
  process: fc.constantFrom('a', 'a', 'b'),
  relations: fc.array(relation, { maxLength: 3 }),
});
const graph = fc.array(op, { maxLength: 12 });
const active = fc.record<Active>({ a: fc.boolean(), b: fc.boolean() });

/** `supersedes` e `revokes` só alcançam registro do mesmo processo, como na escrita. */
function recordsOf(ops: Op[]): Linked[] {
  const written: Linked[] = [];
  ops.forEach(({ process, relations }, index) => {
    const self = `${process}:${index}`;
    const resolved = relations.flatMap(({ kind, pick, as }) => {
      const sameProcess = kind === 'supersedes' || kind === 'revokes';
      const pool = written.filter(({ id }) => !sameProcess || id.startsWith(`${process}:`));
      const target = pool[pick % Math.max(pool.length, 1)];
      return target ? [{ kind, to: target.id, ...(as ? { as: 'named' } : {}) }] : [];
    });
    written.push({ id: self, relations: resolved });
  });
  return written;
}

function resolve(records: Linked[], flags: Active) {
  return buildInheritance(records, buildVigency(records), (process) =>
    process === 'a' ? flags.a : flags.b,
  );
}

const edgesOf = (inheritance: Inheritance, records: Linked[]): InheritedEdge[] =>
  records.flatMap(({ id }) => [...inheritance.outOf(id)]);

const ORIGIN_KINDS: RelationKind[] = ['answers', 'derivesFrom', 'complements', 'reopens'];
const sameEdge = (x: InheritedEdge, y: InheritedEdge) =>
  x.kind === y.kind && x.as === y.as && x.from === y.from && x.to === y.to;

/** Oráculo do corte: a raiz de cada linhagem, unida pelas arestas `supersedes`. */
function rootOf(records: Linked[]): (id: string) => string {
  const parent = new Map<string, string>();
  const find = (id: string): string => {
    const next = parent.get(id);
    return next === undefined ? id : find(next);
  };
  for (const { id, relations } of records) {
    for (const { kind, to } of relations) {
      if (kind === 'supersedes' && find(id) !== find(to)) parent.set(find(id), find(to));
    }
  }
  return find;
}

describe('relation inheritance (properties)', () => {
  test('with every process inactive nothing is inherited', () => {
    fc.assert(
      fc.property(graph, (ops) => {
        const records = recordsOf(ops);
        const inheritance = resolve(records, { a: false, b: false });
        expect(edgesOf(inheritance, records)).toEqual([]);
        for (const { id } of records) expect(inheritance.into(id)).toEqual([]);
      }),
    );
  });

  test('every inherited edge follows the kind table and raises only current ends', () => {
    fc.assert(
      fc.property(graph, active, (ops, flags) => {
        const records = recordsOf(ops);
        const vigency = buildVigency(records);
        const isValid = (edge: InheritedEdge) =>
          edge.kind === 'supports'
            ? vigency.isCurrent(edge.from) &&
              vigency.isCurrent(edge.to) &&
              edge.origin.from === edge.from &&
              vigency.currentOf(edge.origin.to) === edge.to
            : ORIGIN_KINDS.includes(edge.kind) &&
              vigency.isCurrent(edge.from) &&
              !vigency.isCurrent(edge.origin.from) &&
              vigency.currentOf(edge.origin.from) === edge.from &&
              edge.origin.to === edge.to;
        expect(edgesOf(resolve(records, flags), records).filter((edge) => !isValid(edge))).toEqual(
          [],
        );
      }),
    );
  });

  test('the output does not depend on the order of the records', () => {
    const shuffled = graph.chain((ops) => {
      const records = recordsOf(ops);
      return fc.tuple(
        fc.constant(records),
        fc.shuffledSubarray(records, { minLength: records.length }),
      );
    });
    fc.assert(
      fc.property(shuffled, active, ([records, reordered], flags) => {
        const [first, second] = [resolve(records, flags), resolve(reordered, flags)];
        for (const { id } of records) {
          expect(second.outOf(id)).toEqual(first.outOf(id));
          expect(second.into(id)).toEqual(first.into(id));
        }
      }),
    );
  });

  test('adding the identical direct edge removes the inherited one and leaves the others', () => {
    const picked = fc.tuple(graph, active, fc.nat());
    fc.assert(
      fc.property(picked, ([ops, flags, index]) => {
        const records = recordsOf(ops);
        const before = edgesOf(resolve(records, flags), records);
        fc.pre(before.length > 0);
        const edge = before[index % before.length]!;
        const withDirect = records.map((record) =>
          record.id === edge.from
            ? {
                ...record,
                relations: [
                  ...record.relations,
                  { kind: edge.kind, to: edge.to, ...(edge.as ? { as: edge.as } : {}) },
                ],
              }
            : record,
        );
        const after = edgesOf(resolve(withDirect, flags), withDirect);
        expect(after).toEqual(before.filter((other) => !sameEdge(other, edge)));
      }),
    );
  });

  test('a current contradicts between the two lineages removes the pair and leaves the others', () => {
    const picked = fc.tuple(graph, active, fc.nat());
    fc.assert(
      fc.property(picked, ([ops, flags, index]) => {
        const records = recordsOf(ops);
        const before = edgesOf(resolve(records, flags), records);
        fc.pre(before.length > 0);
        const edge = before[index % before.length]!;
        const cut = records.map((record) =>
          record.id === edge.from
            ? {
                ...record,
                relations: [...record.relations, { kind: 'contradicts' as const, to: edge.to }],
              }
            : record,
        );
        const after = edgesOf(resolve(cut, flags), cut);
        const root = rootOf(records);
        const pairOf = ({ from, to }: InheritedEdge) => [root(from), root(to)].sort().join('|');
        const samePair = (other: InheritedEdge) => pairOf(other) === pairOf(edge);
        expect(after).toEqual(before.filter((other) => !samePair(other)));
      }),
    );
  });

  test('a contradicts recorded by a non-current record cuts nothing', () => {
    const picked = fc.tuple(graph, active, fc.nat(), fc.nat());
    fc.assert(
      fc.property(picked, ([ops, flags, holderIndex, targetIndex]) => {
        const records = recordsOf(ops);
        const vigency = buildVigency(records);
        const holders = records.filter(({ id }) => !vigency.isCurrent(id));
        fc.pre(holders.length > 0);
        const holder = holders[holderIndex % holders.length]!;
        const target = records[targetIndex % records.length]!;
        const withContradicts = records.map((record) =>
          record.id === holder.id
            ? {
                ...record,
                relations: [...record.relations, { kind: 'contradicts' as const, to: target.id }],
              }
            : record,
        );
        expect(edgesOf(resolve(withContradicts, flags), withContradicts)).toEqual(
          edgesOf(resolve(records, flags), records),
        );
      }),
    );
  });
});
