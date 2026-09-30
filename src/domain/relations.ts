import { processOf } from './ids.ts';
import type { Name, RecordId } from './ids.ts';
import { RelationKind } from './record.ts';
import type { HexRecord, Relation, RelationInput } from './record.ts';

export { RelationKind };

/** O que a vigência e a prova vencida leem de um registro: o id e as relações gravadas. */
export type Linked = Pick<HexRecord, 'id' | 'relations'>;

function compareIds(a: RecordId, b: RecordId): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

export function pushTo<K, V>(map: Map<K, V[]>, key: K, value: V): void {
  const list = map.get(key);
  if (list) list.push(value);
  else map.set(key, [value]);
}

/** D-08: vigência e versão atual de cada registro lido. */
export type Vigency = {
  /** Registro sem relação de entrada `supersedes`/`revokes`; id desconhecido conta como vigente. */
  isCurrent(id: RecordId): boolean;
  /** Único vigente da linhagem de `id`, ou `null` se a linhagem foi revogada. */
  currentOf(id: RecordId): RecordId | null;
};

/**
 * Só enxerga as relações dos registros recebidos, e o resultado não depende da ordem deles.
 * `currentOf` com bifurcação (que a escrita recusa) escolhe o menor id, para seguir determinista.
 */
export function buildVigency(records: readonly Linked[]): Vigency {
  const successors = new Map<RecordId, RecordId[]>();
  const revoked = new Set<RecordId>();
  for (const { id, relations } of records) {
    for (const { kind, to } of relations) {
      if (kind === 'supersedes') pushTo(successors, to, id);
      if (kind === 'revokes') revoked.add(to);
    }
  }
  for (const list of successors.values()) list.sort(compareIds);

  const isCurrent = (id: RecordId) => !revoked.has(id) && !successors.has(id);

  // ponytail: busca por registro, O(n) na linhagem; memoizar por linhagem se a leitura pesar.
  const currentOf = (start: RecordId): RecordId | null => {
    const pending = [start];
    const seen = new Set<RecordId>();
    for (let id = pending.pop(); id !== undefined; id = pending.pop()) {
      if (seen.has(id) || revoked.has(id)) continue;
      seen.add(id);
      const next = successors.get(id);
      if (!next) return id;
      pending.push(...[...next].reverse());
    }
    return null;
  };

  return { isCurrent, currentOf };
}

/** D-08: linhagens, isto é, os conjuntos de registros ligados por `supersedes`. */
export function lineages(records: readonly Linked[]): RecordId[][] {
  const parent = new Map<RecordId, RecordId>(records.map(({ id }) => [id, id]));
  const rootOf = (id: RecordId): RecordId => {
    let root = id;
    while (parent.get(root) !== root) root = parent.get(root)!;
    for (let node = id; node !== root;) {
      const next = parent.get(node)!;
      parent.set(node, root);
      node = next;
    }
    return root;
  };
  for (const { id, relations } of records) {
    for (const { kind, to } of relations) {
      if (kind === 'supersedes' && parent.has(to)) parent.set(rootOf(id), rootOf(to));
    }
  }
  const groups = new Map<RecordId, RecordId[]>();
  for (const { id } of records) pushTo(groups, rootOf(id), id);
  return [...groups.values()];
}

/** Guarda contra ciclo de substituição (Kahn sobre as arestas `supersedes` entre registros lidos). */
export function hasCycle(records: readonly Linked[]): boolean {
  const known = new Set(records.map(({ id }) => id));
  const waiting = new Map<RecordId, number>([...known].map((id) => [id, 0]));
  const dependents = new Map<RecordId, RecordId[]>();
  for (const { id, relations } of records) {
    for (const { kind, to } of relations) {
      if (kind !== 'supersedes' || !known.has(to)) continue;
      waiting.set(id, waiting.get(id)! + 1);
      pushTo(dependents, to, id);
    }
  }
  const ready = [...waiting].filter(([, count]) => count === 0).map(([id]) => id);
  let removed = 0;
  for (let id = ready.pop(); id !== undefined; id = ready.pop()) {
    removed += 1;
    for (const dependent of dependents.get(id) ?? []) {
      const count = waiting.get(dependent)! - 1;
      waiting.set(dependent, count);
      if (count === 0) ready.push(dependent);
    }
  }
  return removed < known.size;
}

/** D-09: pontas não vigentes de apoio morto, por registro vigente marcado. */
export type NeedsReview = { staleIn: RecordId[]; staleOut: RecordId[] };

/**
 * D-09: um `supports` A → B está vivo enquanto a versão atual de A apoia a versão atual de B.
 * Só registro vigente é marcado, e só pelo apoio que tem (ou recebe) com uma ponta não vigente;
 * o aviso não bloqueia nada.
 */
export function needsReview(records: readonly Linked[]): Map<RecordId, NeedsReview> {
  const vigency = buildVigency(records);
  const supported = new Map<RecordId, Set<RecordId>>();
  for (const { id, relations } of records) {
    supported.set(
      id,
      new Set(relations.filter(({ kind }) => kind === 'supports').map(({ to }) => to)),
    );
  }

  const isAlive = (from: RecordId, to: RecordId): boolean => {
    const currentFrom = vigency.currentOf(from);
    const currentTo = vigency.currentOf(to);
    if (currentFrom === null || currentTo === null) return false;
    return supported.get(currentFrom)?.has(currentTo) ?? false;
  };

  const marks = new Map<RecordId, { staleIn: Set<RecordId>; staleOut: Set<RecordId> }>();
  const mark = (id: RecordId, side: 'staleIn' | 'staleOut', stale: RecordId) => {
    const entry = marks.get(id) ?? { staleIn: new Set(), staleOut: new Set() };
    entry[side].add(stale);
    marks.set(id, entry);
  };

  for (const [from, targets] of supported) {
    for (const to of targets) {
      const fromCurrent = vigency.isCurrent(from);
      const toCurrent = vigency.isCurrent(to);
      if (fromCurrent === toCurrent || isAlive(from, to)) continue;
      if (fromCurrent) mark(from, 'staleOut', to);
      else mark(to, 'staleIn', from);
    }
  }

  return new Map(
    [...marks].map(([id, { staleIn, staleOut }]) => [
      id,
      { staleIn: [...staleIn].sort(compareIds), staleOut: [...staleOut].sort(compareIds) },
    ]),
  );
}

/** D-10: `details[].code` de cada regra estrutural (`not-current` é o de `FORK_REJECTED`, D-26). */
export type RuleCode =
  | 'self-relation'
  | 'unknown-relation-name'
  | 'kind-mismatch'
  | 'missing-kind'
  | 'cross-process-currency'
  | 'type-mismatch'
  | 'endpoint-type'
  | 'supports-and-contradicts'
  | 'not-current'
  | 'stale-destination';

/** `current` só sai em `not-current` e `stale-destination`: versão atual da linhagem ou `null`. */
export type Violation = { code: RuleCode; current?: RecordId | null };

export type RelationCheck = { kind: RelationKind } | { violation: Violation };

/** Nome de relação fixado no processo; `from`/`to` são listas de tipos, quando declaradas. */
export type NamedRelation = {
  kind: RelationKind;
  from?: readonly Name[];
  to?: readonly Name[];
};

export type RelationEnd = { id: RecordId; type: Name };

export type RuleContext = {
  /** Registro que grava a relação. */
  from: RelationEnd;
  /** Destino já resolvido (alias virou id, existência já conferida). */
  to: RelationEnd;
  /** Demais relações do mesmo registro, já resolvidas. */
  siblings: readonly Pick<Relation, 'kind' | 'to'>[];
  names: ReadonlyMap<Name, NamedRelation>;
  /** Vigência depois dos itens anteriores do lote (e do lote inteiro, em `stale-destination`). */
  vigency: Vigency;
};

function resolveKind(
  input: Pick<RelationInput, 'kind' | 'as'>,
  names: RuleContext['names'],
): RelationCheck {
  const { kind, as } = input;
  if (as === undefined) {
    return kind === undefined ? { violation: { code: 'missing-kind' } } : { kind };
  }
  const named = names.get(as);
  if (!named) return { violation: { code: 'unknown-relation-name' } };
  if (kind !== undefined && kind !== named.kind) return { violation: { code: 'kind-mismatch' } };
  return { kind: named.kind };
}

function checkSuccession(kind: RelationKind, { from, to }: RuleContext): Violation | undefined {
  if (kind !== 'supersedes' && kind !== 'revokes') return undefined;
  if (processOf(from.id) !== processOf(to.id)) return { code: 'cross-process-currency' };
  if (kind === 'supersedes' && from.type !== to.type) return { code: 'type-mismatch' };
  return undefined;
}

function checkEndpointTypes(
  as: Name | undefined,
  { from, to, names }: RuleContext,
): Violation | undefined {
  const named = as === undefined ? undefined : names.get(as);
  if (named?.from && !named.from.includes(from.type)) return { code: 'endpoint-type' };
  if (named?.to && !named.to.includes(to.type)) return { code: 'endpoint-type' };
  return undefined;
}

function checkContradiction(
  kind: RelationKind,
  { to, siblings }: RuleContext,
): Violation | undefined {
  const opposite =
    kind === 'supports' ? 'contradicts' : kind === 'contradicts' ? 'supports' : undefined;
  if (opposite && siblings.some((other) => other.kind === opposite && other.to === to.id)) {
    return { code: 'supports-and-contradicts' };
  }
  return undefined;
}

function checkVigency(kind: RelationKind, { to, vigency }: RuleContext): Violation | undefined {
  if (vigency.isCurrent(to.id)) return undefined;
  const current = vigency.currentOf(to.id);
  if (kind === 'supersedes' || kind === 'revokes') return { code: 'not-current', current };
  if (kind === 'supports') return { code: 'stale-destination', current };
  return undefined;
}

/**
 * D-10: resolve o `kind` da relação e devolve a primeira regra estrutural violada, na ordem fixa
 * autorrelação, nome, sucessão, pontas por tipo, apoio e contradição, vigência do destino.
 * Existência do destino e ciclo ficam com o serviço (`RELATION_NOT_FOUND`, `hasCycle`).
 */
export function checkRelation(
  input: Pick<RelationInput, 'kind' | 'as'>,
  context: RuleContext,
): RelationCheck {
  if (context.from.id === context.to.id) return { violation: { code: 'self-relation' } };
  const resolved = resolveKind(input, context.names);
  if ('violation' in resolved) return resolved;
  const { kind } = resolved;
  const violation =
    checkSuccession(kind, context) ??
    checkEndpointTypes(input.as, context) ??
    checkContradiction(kind, context) ??
    checkVigency(kind, context);
  return violation ? { violation } : { kind };
}
