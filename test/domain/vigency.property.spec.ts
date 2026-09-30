import { describe, test, expect } from '@jest/globals';
import fc from 'fast-check';
import {
  buildVigency,
  checkRelation,
  hasCycle,
  lineages,
  needsReview,
} from '../../src/domain/relations.ts';
import type { Linked } from '../../src/domain/relations.ts';
import type { RelationKind } from '../../src/domain/record.ts';

type Rel = { kind: RelationKind; pick: number };
type Op = { process: 'a' | 'b'; type: 'x' | 'y'; relations: Rel[] };

// Viés para o mesmo processo e tipo e para `supersedes`, senão a substituição encadeada quase nunca
// é tentada. O destino é `pick` módulo o número de registros gravados, então alcança todos eles.
const rel = fc.record<Rel>({
  kind: fc.constantFrom('supersedes', 'supersedes', 'revokes', 'supports', 'contradicts'),
  pick: fc.nat(),
});
const op = fc.record<Op>({
  process: fc.constantFrom('a', 'a', 'a', 'b'),
  type: fc.constantFrom('x', 'x', 'x', 'y'),
  relations: fc.array(rel, { maxLength: 2 }),
});

type Written = Linked & { type: string };

/**
 * Grava como o serviço: cada relação do registro passa por `checkRelation` contra os registros já
 * aceitos, com as irmãs como `siblings` e a vigência do lote de um item (`supports` lê o lote
 * inteiro, as demais os registros anteriores). A relação recusada não é gravada.
 */
function simulate(ops: Op[]): Written[] {
  const written: Written[] = [];
  ops.forEach(({ process, type, relations }, index) => {
    const self = `${process}:${index}`;
    const resolved = relations.flatMap(({ kind, pick }) => {
      const target = written[pick % written.length];
      return target ? [{ kind, to: target.id, toType: target.type }] : [];
    });
    const before = buildVigency(written);
    const whole = buildVigency([
      ...written,
      { id: self, relations: resolved.map(({ kind, to }) => ({ kind, to })) },
    ]);
    const accepted = resolved.filter(({ kind, to, toType }, i) => {
      const siblings = resolved.filter((_, other) => other !== i);
      const check = checkRelation(
        { kind },
        {
          from: { id: self, type },
          to: { id: to, type: toType },
          siblings,
          names: new Map(),
          vigencyFor: (relationKind) => (relationKind === 'supports' ? whole : before),
        },
      );
      return 'kind' in check;
    });
    written.push({
      id: self,
      type,
      relations: accepted.map(({ kind, to }) => ({ kind, to })),
    });
  });
  return written;
}

const ops = fc.array(op, { maxLength: 15 });

describe('vigência (P4)', () => {
  test('toda linhagem tem no máximo um vigente', () => {
    fc.assert(
      fc.property(ops, (sequence) => {
        const written = simulate(sequence);
        const vigency = buildVigency(written);
        for (const group of lineages(written)) {
          expect(group.filter((id) => vigency.isCurrent(id)).length).toBeLessThanOrEqual(1);
        }
      }),
    );
  });

  test('a versão atual é nula exatamente quando a linhagem não tem vigente', () => {
    fc.assert(
      fc.property(ops, (sequence) => {
        const written = simulate(sequence);
        const vigency = buildVigency(written);
        const groups = lineages(written);
        for (const { id } of written) {
          const group = groups.find((members) => members.includes(id)) ?? [];
          const current = vigency.currentOf(id);
          expect(current === null).toBe(!group.some((member) => vigency.isCurrent(member)));
          expect(current === null || vigency.isCurrent(current)).toBe(true);
        }
      }),
    );
  });

  test('nenhum registro gravado substitui e revoga o mesmo destino', () => {
    fc.assert(
      fc.property(ops, (sequence) => {
        for (const { relations } of simulate(sequence)) {
          const superseded = new Set(
            relations.filter(({ kind }) => kind === 'supersedes').map(({ to }) => to),
          );
          expect(relations.some(({ kind, to }) => kind === 'revokes' && superseded.has(to))).toBe(
            false,
          );
        }
      }),
    );
  });

  test('vigência, versão atual e prova vencida independem da ordem de leitura', () => {
    const writtenAndShuffled = ops.chain((sequence) => {
      const written = simulate(sequence);
      return fc.tuple(
        fc.constant(written),
        fc.shuffledSubarray(written, { minLength: written.length }),
      );
    });
    fc.assert(
      fc.property(writtenAndShuffled, ([written, shuffled]) => {
        const [first, second] = [buildVigency(written), buildVigency(shuffled)];
        for (const { id } of written) {
          expect(second.isCurrent(id)).toBe(first.isCurrent(id));
          expect(second.currentOf(id)).toBe(first.currentOf(id));
        }
        expect(needsReview(shuffled)).toEqual(needsReview(written));
      }),
    );
  });

  test('cadeia longa de substituição: só o último é vigente e todos apontam para ele', () => {
    const chain: Linked[] = Array.from({ length: 8 }, (_, i) => ({
      id: `p:${i}`,
      relations: i === 0 ? [] : [{ kind: 'supersedes', to: `p:${i - 1}` }],
    }));
    const vigency = buildVigency(chain);
    expect(chain.filter(({ id }) => vigency.isCurrent(id)).map(({ id }) => id)).toEqual(['p:7']);
    expect(chain.map(({ id }) => vigency.currentOf(id))).toEqual(chain.map(() => 'p:7'));
    expect(lineages(chain)).toHaveLength(1);
  });
});

describe('ciclo (P4)', () => {
  type Graph = { n: number; extra: [number, number][]; order: number[] };

  const graph = fc.integer({ min: 2, max: 8 }).chain((n) =>
    fc.record<Graph>({
      n: fc.constant(n),
      extra: fc.array(fc.tuple(fc.nat(n - 1), fc.nat(n - 1)), { maxLength: 12 }),
      order: fc.shuffledSubarray([...Array(n).keys()], { minLength: n }),
    }),
  );

  /** Arestas `supersedes` em qualquer ordem de leitura; `closeRing` fecha um anel por todos. */
  function recordsOf({ n, extra, order }: Graph, closeRing: boolean): Linked[] {
    const targets = new Map<number, Set<number>>(order.map((i) => [i, new Set()]));
    // Do maior para o menor índice, toda aresta extra é acíclica.
    for (const [a, b] of extra) if (a !== b) targets.get(Math.max(a, b))?.add(Math.min(a, b));
    if (closeRing) {
      for (let i = 1; i < n; i++) targets.get(i)?.add(i - 1);
      targets.get(0)?.add(n - 1);
    }
    return order.map((i) => ({
      id: `p:${i}`,
      relations: [...(targets.get(i) ?? [])].map((to) => ({ kind: 'supersedes', to: `p:${to}` })),
    }));
  }

  test('arestas do maior para o menor índice nunca formam ciclo, em qualquer ordem', () => {
    fc.assert(fc.property(graph, (g) => expect(hasCycle(recordsOf(g, false))).toBe(false)));
  });

  test('o anel fechado por todos os registros é ciclo, em qualquer ordem', () => {
    fc.assert(fc.property(graph, (g) => expect(hasCycle(recordsOf(g, true))).toBe(true)));
  });
});
