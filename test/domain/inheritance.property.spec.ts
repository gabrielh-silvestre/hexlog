import { describe, it, expect } from '@jest/globals';
import fc from 'fast-check';
import { buildInheritance } from '../../src/domain/inheritance.ts';
import type { Inheritance, InheritedEdge } from '../../src/domain/inheritance.ts';
import { buildVigency } from '../../src/domain/relations.ts';
import type { Linked } from '../../src/domain/relations.ts';
import type { RelationKind } from '../../src/domain/record.ts';
import { rootOf, withRelation, withShuffle } from './relation-graph.ts';

type Edge = { kind: RelationKind; pick: number; as: boolean };
type Op = { process: 'a' | 'b'; relations: Edge[] };
type Active = { a: boolean; b: boolean };

// Viés para `supersedes` e para as espécies que herdam, senão a linhagem e a herança quase nunca
// aparecem. O destino é `pick` módulo o número de registros já gravados.
const relation = fc.record<Edge>({
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

/** Uma aresta herdada, escolhida por `index` entre as que o grafo dá; descarta a rodada se não há. */
function pickInheritedEdge(ops: Op[], flags: Active, index: number) {
  const records = recordsOf(ops);
  const before = edgesOf(resolve(records, flags), records);
  fc.pre(before.length > 0);
  return { records, before, edge: before[index % before.length]! };
}

const ORIGIN_KINDS: RelationKind[] = ['answers', 'derivesFrom', 'complements', 'reopens'];
const sameEdge = (x: InheritedEdge, y: InheritedEdge) =>
  x.kind === y.kind && x.as === y.as && x.from === y.from && x.to === y.to;

describe('buildInheritance', () => {
  it('should inherit nothing with every process inactive', () => {
    fc.assert(
      fc.property(graph, (ops) => {
        const records = recordsOf(ops);

        const inheritance = resolve(records, { a: false, b: false });

        expect(edgesOf(inheritance, records)).toEqual([]);

        for (const { id } of records) expect(inheritance.into(id)).toEqual([]);
      }),
    );
  });

  it('should raise a supports only between current ends of its origin lineage', () => {
    fc.assert(
      fc.property(graph, active, (ops, flags) => {
        const records = recordsOf(ops);
        const vigency = buildVigency(records);
        const isValid = (edge: InheritedEdge) =>
          vigency.isCurrent(edge.from) &&
          vigency.isCurrent(edge.to) &&
          edge.origin.from === edge.from &&
          vigency.currentOf(edge.origin.to) === edge.to;
        const supports = edgesOf(resolve(records, flags), records).filter(
          ({ kind }) => kind === 'supports',
        );

        expect(supports.filter((edge) => !isValid(edge))).toEqual([]);
      }),
    );
  });

  it('should raise an origin-kind edge only from the current version of a superseded source', () => {
    fc.assert(
      fc.property(graph, active, (ops, flags) => {
        const records = recordsOf(ops);
        const vigency = buildVigency(records);
        const isValid = (edge: InheritedEdge) =>
          ORIGIN_KINDS.includes(edge.kind) &&
          vigency.isCurrent(edge.from) &&
          !vigency.isCurrent(edge.origin.from) &&
          vigency.currentOf(edge.origin.from) === edge.from &&
          edge.origin.to === edge.to;
        const others = edgesOf(resolve(records, flags), records).filter(
          ({ kind }) => kind !== 'supports',
        );

        expect(others.filter((edge) => !isValid(edge))).toEqual([]);
      }),
    );
  });

  it('should not depend on the order of the records', () => {
    fc.assert(
      fc.property(withShuffle(graph.map(recordsOf)), active, ([records, reordered], flags) => {
        const [first, second] = [resolve(records, flags), resolve(reordered, flags)];

        for (const { id } of records) {
          expect(second.outOf(id)).toEqual(first.outOf(id));
          expect(second.into(id)).toEqual(first.into(id));
        }
      }),
    );
  });

  it('should remove the inherited edge and leave the others when the identical direct edge is added', () => {
    fc.assert(
      fc.property(graph, active, fc.nat(), (ops, flags, index) => {
        const { records, before, edge } = pickInheritedEdge(ops, flags, index);
        const withDirect = withRelation(records, edge.from, {
          kind: edge.kind,
          to: edge.to,
          ...(edge.as ? { as: edge.as } : {}),
        });

        const after = edgesOf(resolve(withDirect, flags), withDirect);

        expect(after).toEqual(before.filter((other) => !sameEdge(other, edge)));
      }),
    );
  });

  it('should remove the pair and leave the others with a current contradicts between the two lineages', () => {
    fc.assert(
      fc.property(graph, active, fc.nat(), (ops, flags, index) => {
        const { records, before, edge } = pickInheritedEdge(ops, flags, index);
        const cut = withRelation(records, edge.from, { kind: 'contradicts', to: edge.to });
        const root = rootOf(records);
        const pairOf = ({ from, to }: InheritedEdge) => [root(from), root(to)].sort().join('|');
        const samePair = (other: InheritedEdge) => pairOf(other) === pairOf(edge);

        const after = edgesOf(resolve(cut, flags), cut);

        expect(after).toEqual(before.filter((other) => !samePair(other)));
      }),
    );
  });

  it('should cut nothing with a contradicts recorded by a non-current record', () => {
    fc.assert(
      fc.property(graph, active, fc.nat(), fc.nat(), (ops, flags, holderIndex, targetIndex) => {
        const records = recordsOf(ops);
        const vigency = buildVigency(records);
        const holders = records.filter(({ id }) => !vigency.isCurrent(id));
        fc.pre(holders.length > 0);
        const holder = holders[holderIndex % holders.length]!;
        const target = records[targetIndex % records.length]!;
        const withContradicts = withRelation(records, holder.id, {
          kind: 'contradicts',
          to: target.id,
        });

        expect(edgesOf(resolve(withContradicts, flags), withContradicts)).toEqual(
          edgesOf(resolve(records, flags), records),
        );
      }),
    );
  });

  // A escrita recusa o ciclo de `supersedes`; só um log forjado à mão o traz, e a leitura não pode
  // travar.
  it('should end a forged supersedes cycle and leave no current record to raise an edge to', () => {
    const records: Linked[] = [
      { id: 'a:1', relations: [{ kind: 'supersedes', to: 'a:2' }] },
      { id: 'a:2', relations: [{ kind: 'supersedes', to: 'a:3' }] },
      { id: 'a:3', relations: [{ kind: 'supersedes', to: 'a:1' }] },
      { id: 'a:4', relations: [{ kind: 'supports', to: 'a:1' }] },
    ];

    const inheritance = resolve(records, { a: true, b: true });

    expect(edgesOf(inheritance, records)).toEqual([]);
  });
});
