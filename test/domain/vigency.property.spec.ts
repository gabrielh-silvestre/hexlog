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

type Op = { kind: RelationKind | 'none'; process: 'a' | 'b'; type: 'x' | 'y'; pick: number };

// Viés para o mesmo processo e tipo e para poucos destinos, senão a bifurcação quase nunca é tentada.
const op = fc.record<Op>({
  kind: fc.constantFrom('none', 'supersedes', 'supersedes', 'revokes', 'supports', 'contradicts'),
  process: fc.constantFrom('a', 'a', 'a', 'b'),
  type: fc.constantFrom('x', 'x', 'x', 'y'),
  pick: fc.nat(3),
});

type Written = Linked & { type: string };

/** Grava como o serviço: cada relação passa por `checkRelation` contra os registros já aceitos. */
function simulate(ops: Op[]): Written[] {
  const written: Written[] = [];
  ops.forEach(({ kind, process, type, pick }, index) => {
    const self = `${process}:${index}`;
    const target = written.length > 0 ? written[pick % written.length] : undefined;
    if (kind === 'none' || !target) {
      written.push({ id: self, type, relations: [] });
      return;
    }
    const accepted = checkRelation(
      { kind },
      {
        from: { id: self, type },
        to: { id: target.id, type: target.type },
        siblings: [],
        names: new Map(),
        vigency: buildVigency(written),
      },
    );
    const relations = 'kind' in accepted ? [{ kind, to: target.id }] : [];
    written.push({ id: self, type, relations });
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

  test('a versão atual de toda linhagem é vigente ou a linhagem não tem vigente', () => {
    fc.assert(
      fc.property(ops, (sequence) => {
        const written = simulate(sequence);
        const vigency = buildVigency(written);
        for (const { id } of written) {
          const current = vigency.currentOf(id);
          expect(current === null || vigency.isCurrent(current)).toBe(true);
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

  test('substituição nunca gera ciclo', () => {
    fc.assert(
      fc.property(ops, (sequence) => {
        expect(hasCycle(simulate(sequence))).toBe(false);
      }),
    );
  });
});
