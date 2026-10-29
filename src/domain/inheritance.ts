import { isUndefined, sortBy } from 'es-toolkit';
import { processOf } from './ids.ts';
import type { Name, RecordId } from './ids.ts';
import type { RelationKind } from './record.ts';
import type { Linked, Vigency } from './relations.ts';

/**
 * Herança de relações pela linhagem de `supersedes`, só na leitura (nada é regravado). Uma relação
 * gravada `W --k--> T` vira uma relação herdada quando uma das pontas foi superada, conforme a
 * espécie. Citação histórica continua histórica, e a aprovação de uma revisão superada continua
 * morrendo com ela (ADR 0007, item 10).
 */

/** Apoio recebido: a ponta destino sobe para a versão atual; a origem tem de ser vigente. */
const RAISES_DESTINATION: ReadonlySet<RelationKind> = new Set(['supports']);

/** Cascata de citações: a ponta origem sobe para a versão atual; o destino fica como gravado. */
const RAISES_ORIGIN: ReadonlySet<RelationKind> = new Set([
  'answers',
  'derivesFrom',
  'complements',
  'reopens',
]);

// Fora das duas tabelas, `contradicts`, `supersedes` e `revokes` nunca herdam.

/** Relação herdada; `origin` é a aresta física gravada de onde ela vem. */
export type InheritedEdge = {
  kind: RelationKind;
  as?: Name;
  from: RecordId;
  to: RecordId;
  origin: { from: RecordId; to: RecordId };
};

export type Inheritance = {
  /** Relações herdadas que chegam a `id`, ordenadas por `from`, `to`, `kind` e `as`. */
  into(id: RecordId): readonly InheritedEdge[];
  /** Relações herdadas que saem de `id`, na mesma ordem. */
  outOf(id: RecordId): readonly InheritedEdge[];
  /** Existe relação herdada dessa espécie entre as duas pontas (qualquer nome). */
  has(kind: RelationKind, from: RecordId, to: RecordId): boolean;
};

export const NO_INHERITANCE: Inheritance = {
  into: () => [],
  outOf: () => [],
  has: () => false,
};

const edgeKey = (kind: RelationKind, as: Name | undefined, from: RecordId, to: RecordId) =>
  `${kind}|${as ?? ''}|${from}|${to}`;

const pairKey = (a: RecordId, b: RecordId) => (a < b ? `${a}|${b}` : `${b}|${a}`);

/** Raiz da linhagem de cada registro (união pelas arestas `supersedes`), inclusive a revogada. */
function lineageRootOf(records: readonly Linked[]): (id: RecordId) => RecordId {
  const parent = new Map<RecordId, RecordId>();
  const find = (id: RecordId): RecordId => {
    let root = id;
    for (let next = parent.get(root); !isUndefined(next); next = parent.get(root)) root = next;
    // Compressão de caminho: sem ela, registros em ordem decrescente formam uma cadeia e cada `find`
    // a percorre inteira (O(L²)).
    for (
      let node = id, next = parent.get(node);
      !isUndefined(next);
      node = next, next = parent.get(node)
    )
      parent.set(node, root);
    return root;
  };
  for (const { id, relations } of records) {
    for (const { kind, to } of relations) {
      if (kind !== 'supersedes') continue;
      const [a, b] = [find(id), find(to)];
      if (a !== b) parent.set(a, b);
    }
  }
  return find;
}

/**
 * Resolve a herança de `records` pela vigência dada. `isActive` diz se o processo cuja linhagem sobe
 * tem a herança ligada; processo inativo não herda nada, e sem `isActive` a resposta é
 * `NO_INHERITANCE`. Qualquer `contradicts` vigente (o registro que o grava não foi superado nem
 * revogado) entre a linhagem de uma ponta e a da outra, em qualquer direção, corta a herança do
 * par; superar ou revogar esse registro religa a herança, como a contradição no gate. A aresta
 * direta nunca é cortada, e a direta idêntica (mesma espécie, nome, origem e destino) vence a
 * herdada. Sem nenhum `supersedes` no log não há linhagem, e a resposta é `NO_INHERITANCE`. Só
 * enxerga os registros recebidos, e o resultado não depende da ordem deles.
 *
 * ponytail: o corte vale para o par de linhagens inteiro e sem ordem de versão; para cortar só o
 * que veio antes do `contradicts`, exigir sucessor mais novo que a aresta e cortar por aresta.
 */
export function buildInheritance(
  records: readonly Linked[],
  vigency: Vigency,
  isActive?: (process: Name) => boolean,
): Inheritance {
  if (
    isUndefined(isActive) ||
    !records.some(({ relations }) => relations.some(({ kind }) => kind === 'supersedes'))
  )
    return NO_INHERITANCE;

  const lineageRoot = lineageRootOf(records);
  const direct = new Set<string>();
  const cuts = new Set<string>();
  for (const { id, relations } of records) {
    for (const { kind, to, as } of relations) {
      direct.add(edgeKey(kind, as, id, to));
      if (kind === 'contradicts' && vigency.isCurrent(id))
        cuts.add(pairKey(lineageRoot(id), lineageRoot(to)));
    }
  }

  // Duas arestas físicas podem levar à mesma herdada: fica a de menor origem, para a saída seguir
  // determinista.
  const originOf = ({ origin }: InheritedEdge) => `${origin.from}\n${origin.to}`;
  const found = new Map<string, InheritedEdge>();
  const consider = (edge: InheritedEdge) => {
    const { kind, as, from, to } = edge;
    if (from === to || direct.has(edgeKey(kind, as, from, to))) return;
    if (cuts.has(pairKey(lineageRoot(from), lineageRoot(to)))) return;
    const key = edgeKey(kind, as, from, to);
    const known = found.get(key);
    if (isUndefined(known) || originOf(edge) < originOf(known)) found.set(key, edge);
  };

  for (const { id, relations } of records) {
    for (const { kind, to, as } of relations) {
      if (RAISES_DESTINATION.has(kind)) {
        const current = vigency.currentOf(to);
        if (!vigency.isCurrent(id) || current === null || current === to) continue;
        if (isActive(processOf(to)))
          consider({ kind, as, from: id, to: current, origin: { from: id, to } });
      } else if (RAISES_ORIGIN.has(kind)) {
        const current = vigency.currentOf(id);
        if (current === null || current === id) continue;
        if (isActive(processOf(id)))
          consider({ kind, as, from: current, to, origin: { from: id, to } });
      }
    }
  }

  const edges = sortBy(
    [...found.values()],
    [({ from }) => from, ({ to }) => to, ({ kind }) => kind, ({ as }) => as ?? ''],
  );
  const into = Map.groupBy(edges, ({ to }) => to);
  const outOf = Map.groupBy(edges, ({ from }) => from);
  const triples = new Set(edges.map(({ kind, from, to }) => `${kind}|${from}|${to}`));

  return {
    into: (id) => into.get(id) ?? [],
    outOf: (id) => outOf.get(id) ?? [],
    has: (kind, from, to) => triples.has(`${kind}|${from}|${to}`),
  };
}
