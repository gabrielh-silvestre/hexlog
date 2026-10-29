import fc from 'fast-check';
import { pushTo } from '../../src/domain/relations.ts';
import type { Linked } from '../../src/domain/relations.ts';

/** Oráculo das propriedades: a raiz de cada linhagem, unida pelas arestas `supersedes`. */
export function rootOf(records: readonly Linked[]): (id: string) => string {
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

/** As linhagens, isto é, os conjuntos de registros ligados por `supersedes`. */
export function lineages(records: readonly Linked[]): string[][] {
  const root = rootOf(records);
  const groups = new Map<string, string[]>();
  for (const { id } of records) pushTo(groups, root(id), id);
  return [...groups.values()];
}

/** Os registros gerados junto com os mesmos registros em outra ordem de leitura. */
export const withShuffle = <T>(records: fc.Arbitrary<T[]>): fc.Arbitrary<[T[], T[]]> =>
  records.chain((written) =>
    fc.tuple(fc.constant(written), fc.shuffledSubarray(written, { minLength: written.length })),
  );

/** Os mesmos registros, com `relation` anexada ao de id `id`. */
export const withRelation = (
  records: Linked[],
  id: string,
  relation: Linked['relations'][number],
): Linked[] =>
  records.map((record) =>
    record.id === id ? { ...record, relations: [...record.relations, relation] } : record,
  );
