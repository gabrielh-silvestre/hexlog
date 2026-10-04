import { orderBy } from 'es-toolkit';
import type { Link } from '../domain/chain.ts';
import { matchesSelector, type Selector } from '../domain/gate.ts';
import { processOf, type Name, type RecordId } from '../domain/ids.ts';
import type { RelationKind } from '../domain/record.ts';
import { buildVigency, pushTo, type Vigency } from '../domain/relations.ts';
import { PROJECT_INDEX, type ProcessRef, type SearchIndex } from '../ports.ts';
import type { Reading, ReadTarget } from './read.ts';

/** Filtros de `query` que dependem só dos registros lidos (o alcance e o cursor ficam fora). */
export type Filters = Selector & {
  includeNonCurrent?: boolean;
  text?: string;
  ids?: readonly RecordId[];
  relatedTo?: RecordId;
};

type Incoming = { kind: RelationKind; as?: Name; from: RecordId };

/** Tudo que se deriva de uma leitura: registros na ordem de saída, vigência e relações de entrada. */
export type View = {
  /** D-24: ordem de saída. */
  records: readonly Link[];
  byId: ReadonlyMap<RecordId, Link>;
  vigency: Vigency;
  incoming: ReadonlyMap<RecordId, Incoming[]>;
};

/**
 * D-24: alcance processo por `seq` (a ordem do log, que o relógio não muda); alcance projeto por
 * (`at` como instante, processo por unidade de código, `seq`), a mesma ordem da timeline do 0.x.
 */
export function inOutputOrder(reading: Reading, scope: ReadTarget['scope']): Link[] {
  const [only] = reading.processes;
  if (scope === 'process' && only !== undefined) return only.verified.records;
  return orderBy(
    reading.processes.flatMap(({ verified }) => verified.records),
    [(link) => Date.parse(link.at), (link) => processOf(link.id), (link) => link.seq],
    ['asc', 'asc', 'asc'],
  );
}

const withAs = (as: Name | undefined) => (as === undefined ? {} : { as });

export function buildView(reading: Reading, scope: ReadTarget['scope']): View {
  const records = inOutputOrder(reading, scope);
  const incoming = new Map<RecordId, Incoming[]>();
  for (const { id, relations } of records) {
    for (const { kind, to, as } of relations) {
      pushTo(incoming, to, { kind, from: id, ...withAs(as) });
    }
  }
  return {
    records,
    byId: new Map(records.map((link) => [link.id, link])),
    vigency: buildVigency(records),
    incoming,
  };
}

/** Registros ligados a `id` por uma relação, de entrada ou de saída. */
function relatedTo(view: View, id: RecordId): Set<RecordId> {
  const from = view.incoming.get(id)?.map((relation) => relation.from) ?? [];
  const to = view.byId.get(id)?.relations.map((relation) => relation.to) ?? [];
  return new Set([...from, ...to]);
}

/**
 * Registros que passam nos filtros, na ordem de saída; com `text`, por relevância, e o empate da
 * busca já vem na ordem de saída porque o índice recebe `view.records`.
 */
export function select(
  view: View,
  filters: Filters,
  search: SearchIndex,
  indexOf: ProcessRef,
): Link[] {
  const { includeNonCurrent = false, text, ids, relatedTo: anchor } = filters;
  const wanted = ids === undefined ? undefined : new Set(ids);
  const related = anchor === undefined ? undefined : relatedTo(view, anchor);
  const matching = view.records.filter(
    (link) =>
      (includeNonCurrent || view.vigency.isCurrent(link.id)) &&
      matchesSelector(link, filters) &&
      (wanted?.has(link.id) ?? true) &&
      (related?.has(link.id) ?? true),
  );
  if (text === undefined) return matching;

  const allowed = new Set(matching.map(({ id }) => id));
  const rank = new Map(
    search.search(indexOf, view.records, text, allowed).map((id, at) => [id, at]),
  );
  return orderBy(
    matching.filter((link) => rank.has(link.id)),
    [(link) => rank.get(link.id)!],
    ['asc'],
  );
}

/** Ref do índice de busca: o do processo, ou o do projeto inteiro no alcance projeto. */
export function indexRef(target: ReadTarget): ProcessRef {
  return {
    project: target.project,
    process: target.scope === 'process' ? target.process : PROJECT_INDEX,
  };
}

export type LeftReason = 'superseded' | 'revoked' | 'no-longer-matches';

/** Por que `id` saiu do resultado: a relação de entrada que o tornou não vigente, ou o filtro. */
export function leftReason(view: View, id: RecordId): LeftReason {
  const kinds = view.incoming.get(id)?.map(({ kind }) => kind) ?? [];
  if (kinds.includes('revokes')) return 'revoked';
  return kinds.includes('supersedes') ? 'superseded' : 'no-longer-matches';
}

/** Relação de entrada de um registro; `current` diz se a outra ponta (`from`) é vigente. */
export type InRelation = { kind: RelationKind; as?: Name; from: RecordId; current: boolean };

/**
 * Relação gravada no registro; `current` diz se o destino é vigente e só sai quando o destino foi
 * lido (D-24: alcance processo não lê o processo de um destino de outro processo).
 */
export type OutRelation = { kind: RelationKind; as?: Name; to: RecordId; current?: boolean };

/** D-24: relações de entrada (de quem foi lido) e de saída (as gravadas) de `link`. */
export function relationsOf(view: View, link: Link): { in: InRelation[]; out: OutRelation[] } {
  return {
    in: (view.incoming.get(link.id) ?? []).map(({ kind, as, from }) => ({
      kind,
      ...withAs(as),
      from,
      current: view.vigency.isCurrent(from),
    })),
    out: link.relations.map(({ kind, as, to }) => ({
      kind,
      ...withAs(as),
      to,
      ...(view.byId.has(to) ? { current: view.vigency.isCurrent(to) } : {}),
    })),
  };
}
