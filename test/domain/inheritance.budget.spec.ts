import { describe, expect, it } from '@jest/globals';
import { median } from 'es-toolkit';
import { buildInheritance } from '../../src/domain/inheritance.ts';
import { buildVigency } from '../../src/domain/relations.ts';
import type { Linked } from '../../src/domain/relations.ts';

const VERSIONS = 8000;
const ROUNDS = 3;
// Sem memoizar o caminho todo em `currentOf`, 8.000 versões levavam ~8 s (O(L²)); com ele, dezenas
// de ms. O teto deixa folga de máquina lenta e ainda reprova a volta do custo quadrático.
const CEILING_MS = 1000;

const id = (n: number) => `p:${String(n).padStart(8, '0')}`;

// Cadeia de `supersedes` com um `supports` herdável para cada versão (evidência -> versão). Com
// `contradicts`, cada apoio ganha um registro vigente que o contradiz: o pior caso do corte, uma
// entrada em `cuts` por apoio, sem cortar nenhuma aresta herdável (o par é outro).
function longLineage({ contradicts = false } = {}): Linked[] {
  const versions = Array.from({ length: VERSIONS }, (_, index) => ({
    id: id(index + 1),
    relations: index === 0 ? [] : [{ kind: 'supersedes' as const, to: id(index) }],
  }));
  const support = versions.map(({ id: version }, index) => ({
    id: id(VERSIONS + index + 1),
    relations: [{ kind: 'supports' as const, to: version }],
  }));
  const contradiction = contradicts
    ? support.map(({ id: supporter }, index) => ({
        id: id(2 * VERSIONS + index + 1),
        relations: [{ kind: 'contradicts' as const, to: supporter }],
      }))
    : [];
  return [...versions, ...support, ...contradiction];
}

function timeInheritance(records: Linked[]) {
  const start = performance.now();
  const inheritance = buildInheritance(records, buildVigency(records), () => true);
  return { ms: performance.now() - start, inheritance };
}

describe('buildInheritance', () => {
  it.each([
    ['ascending', (records: Linked[]) => records],
    ['descending', (records: Linked[]) => [...records].reverse()],
  ])(
    `should stay linear on a %s lineage of ${VERSIONS} versions, median of ${ROUNDS} rounds within ${CEILING_MS} ms`,
    (_label, order) => {
      const records = order(longLineage());

      const runs = Array.from({ length: ROUNDS }, () => timeInheritance(records));

      expect(median(runs.map(({ ms }) => ms))).toBeLessThanOrEqual(CEILING_MS);
      // A versão atual herda o apoio de todas as outras; o da própria versão atual é direto.
      expect(runs[0]!.inheritance.into(id(VERSIONS))).toHaveLength(VERSIONS - 1);
    },
    60_000,
  );

  it('should stay linear with a current contradicts on every support of a descending lineage', () => {
    const records = [...longLineage({ contradicts: true })].reverse();
    const runs = Array.from({ length: ROUNDS }, () => timeInheritance(records));

    // Mínimo das medições, como em `adapters/load.budget.spec.ts`.
    expect(Math.min(...runs.map(({ ms }) => ms))).toBeLessThanOrEqual(CEILING_MS);
    expect(runs[0]!.inheritance.into(id(VERSIONS))).toHaveLength(VERSIONS - 1);
  }, 60_000);
});
