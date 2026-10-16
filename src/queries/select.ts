import { isUndefined, orderBy } from 'es-toolkit';
import type { Link } from '../domain/chain.ts';
import { matchesSelector, matchesTargetPrefix, type Selector } from '../domain/gate.ts';
import { processOf, type Name, type RecordId, type Target } from '../domain/ids.ts';
import type { RelationKind } from '../domain/record.ts';
import { buildVigency, incomingOf, type Incoming, type Vigency } from '../domain/relations.ts';
import { PROJECT_INDEX, type ProcessRef, type SearchIndex } from '../ports.ts';
import type { Reading, ReadTarget } from './read.ts';

/** Filtros de `query` que dependem só dos registros lidos (o alcance e o cursor ficam fora). */
export type Filters = Selector & {
  includeNonCurrent?: boolean;
  text?: string;
  ids?: readonly RecordId[];
  relatedTo?: RecordId;
};

/** Tudo que se deriva de uma leitura: registros na ordem de saída, vigência e relações de entrada. */
export type View = {
  /** D-24: ordem de saída. */
  records: readonly Link[];
  byId: ReadonlyMap<RecordId, Link>;
  vigency: Vigency;
  incoming: ReadonlyMap<RecordId, Incoming<Link>[]>;
};

/**
 * D-24: alcance processo por `seq` (a ordem do log, que o relógio não muda); alcance projeto por
 * (`at` como instante, processo por unidade de código, `seq`), a mesma ordem da timeline do 0.x.
 */
export function inOutputOrder(reading: Reading, scope: ReadTarget['scope']): Link[] {
  const [only] = reading.processes;
  if (scope === 'process' && !isUndefined(only)) return only.verified.records;
  return orderBy(
    reading.processes.flatMap(({ verified }) => verified.records),
    [(link) => Date.parse(link.at), (link) => processOf(link.id), (link) => link.seq],
    ['asc', 'asc', 'asc'],
  );
}

const withAs = (as: Name | undefined) => (isUndefined(as) ? {} : { as });

export function buildView(reading: Reading, scope: ReadTarget['scope']): View {
  const records = inOutputOrder(reading, scope);
  return {
    records,
    byId: new Map(records.map((link) => [link.id, link])),
    vigency: buildVigency(records),
    incoming: incomingOf(records),
  };
}

/** Registros ligados a `id` por uma relação, de entrada ou de saída. */
function relatedTo(view: View, id: RecordId): Set<RecordId> {
  const from = view.incoming.get(id)?.map((relation) => relation.from.id) ?? [];
  const to = view.byId.get(id)?.relations.map((relation) => relation.to) ?? [];
  return new Set([...from, ...to]);
}

/** Ref do índice de busca: o do processo, ou o do projeto inteiro no alcance projeto. */
function indexRef(target: ReadTarget): ProcessRef {
  return {
    project: target.project,
    process: target.scope === 'process' ? target.process : PROJECT_INDEX,
  };
}

/**
 * Registros que passam nos filtros, na ordem de saída; com `text`, por relevância, e o empate da
 * busca já vem na ordem de saída porque o índice recebe `view.records`.
 */
export function select(
  view: View,
  filters: Filters,
  search: SearchIndex,
  target: ReadTarget,
): Link[] {
  const { includeNonCurrent = false, text, ids, relatedTo: anchor } = filters;
  const wanted = isUndefined(ids) ? undefined : new Set(ids);
  const related = isUndefined(anchor) ? undefined : relatedTo(view, anchor);
  const matching = view.records.filter(
    (link) =>
      (includeNonCurrent || view.vigency.isCurrent(link.id)) &&
      matchesSelector(link, filters) &&
      (wanted?.has(link.id) ?? true) &&
      (related?.has(link.id) ?? true),
  );
  if (isUndefined(text)) return matching;

  const allowed = new Set(matching.map(({ id }) => id));
  const rank = new Map(
    search.search(indexRef(target), view.records, text, allowed).map((id, at) => [id, at]),
  );
  return orderBy(
    matching.filter((link) => rank.has(link.id)),
    [(link) => rank.get(link.id)!],
    ['asc'],
  );
}

/**
 * Aviso para a seleção vazia com `targetPrefix`: o 1º target lido que começa pela string, mas não
 * casa por segmento (`a.b` não casa `a.b-2` nem `a.bc`). Sem aviso quando algum target lido casa:
 * o vazio vem dos outros filtros. Não muda o casamento, só aponta o quase-acerto.
 */
export function boundaryHint(view: View, prefix: Target): string | undefined {
  const targets = view.records.map(({ target }) => target);
  if (targets.some((target) => matchesTargetPrefix(target, prefix))) return undefined;
  const near = targets.find((target) => target.startsWith(prefix));
  if (isUndefined(near)) return undefined;
  return (
    `targetPrefix matches whole "."-separated segments: nothing matches "${prefix}", but ` +
    `"${near}" starts with it; use that target or a prefix that ends at a "." boundary.`
  );
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

/** Como `query` devolve as relações: arestas inteiras, contagem por nome ou nada. */
export const RELATION_MODES = ['counts', 'full', 'none'] as const;
export type RelationsMode = (typeof RELATION_MODES)[number];

/** Campos de relação de um registro; o modo decide quais existem (`counts` só inclui o mapa não vazio). */
export type RelationFields = {
  in?: InRelation[];
  out?: OutRelation[];
  inCounts?: Record<string, number>;
  outCounts?: Record<string, number>;
};

/**
 * Arestas por nome (`as ?? kind`), vigentes ou não; sem aresta devolve `undefined`. O `Map` evita
 * que um nome como `constructor` herde do protótipo.
 */
function countByName(
  edges: readonly { kind: RelationKind; as?: Name }[],
): Record<string, number> | undefined {
  const counts = new Map<string, number>();
  for (const { kind, as } of edges) {
    const name = as ?? kind;
    counts.set(name, (counts.get(name) ?? 0) + 1);
  }
  return counts.size === 0 ? undefined : Object.fromEntries(counts);
}

/** D-24: relações de entrada (de quem foi lido) e de saída (as gravadas) de `link`, no modo pedido. */
export function relationsOf(view: View, link: Link, mode: RelationsMode): RelationFields {
  if (mode === 'none') return {};
  if (mode === 'counts') {
    const inCounts = countByName(view.incoming.get(link.id) ?? []);
    const outCounts = countByName(link.relations);
    return {
      ...(isUndefined(inCounts) ? {} : { inCounts }),
      ...(isUndefined(outCounts) ? {} : { outCounts }),
    };
  }
  return {
    in: (view.incoming.get(link.id) ?? []).map(({ kind, as, from }) => ({
      kind,
      ...withAs(as),
      from: from.id,
      current: view.vigency.isCurrent(from.id),
    })),
    out: link.relations.map(({ kind, as, to }) => ({
      kind,
      ...withAs(as),
      to,
      ...(view.byId.has(to) ? { current: view.vigency.isCurrent(to) } : {}),
    })),
  };
}
