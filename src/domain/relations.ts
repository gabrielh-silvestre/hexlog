import type { RelationName } from './definitions.ts';
import { processOf } from './ids.ts';
import type { Name, RecordId } from './ids.ts';
import type { HexRecord, KindOrAs, Relation, RelationKind } from './record.ts';

/** O que a vigência e a prova vencida leem de um registro: o id e as relações gravadas. */
export type Linked = Pick<HexRecord, 'id' | 'relations'>;

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
  for (const list of successors.values()) list.sort();

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
 * o aviso não bloqueia nada. Apoio cujo destino não está em `records` é ignorado: a vigência dele
 * é desconhecida.
 *
 * Alcance (D-24): com `scope: "process"`, `records` são só os do processo, então o alerta que cruza
 * processos não é emitido (a vigência da outra ponta é desconhecida; emitir seria falso alerta,
 * D-09). Com `scope: "project"`, `records` são os de todos os processos do projeto e o alerta que
 * cruza processos sai.
 */
export function needsReview(
  records: readonly Linked[],
  vigency: Vigency = buildVigency(records),
): Map<RecordId, NeedsReview> {
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
      if (!supported.has(to)) continue;
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
      { staleIn: [...staleIn].sort(), staleOut: [...staleOut].sort() },
    ]),
  );
}

/** D-10: `details[].code` de cada regra estrutural (`not-current` é o de `FORK_REJECTED`, D-26). */
export type RuleCode =
  | 'self-relation'
  | 'unknown-relation-name'
  | 'kind-mismatch'
  | 'cross-process-currency'
  | 'type-mismatch'
  | 'endpoint-type'
  | 'supports-and-contradicts'
  | 'supersedes-and-revokes'
  | 'not-current'
  | 'stale-destination';

/** `current` só sai em `not-current` e `stale-destination`: versão atual da linhagem ou `null`. */
export type Violation = { code: RuleCode; current?: RecordId | null };

type RelationCheck = { kind: RelationKind } | { violation: Violation };

/** Nome de relação fixado no processo; `from`/`to` são listas de tipos, quando declaradas. */
export type NamedRelation = Pick<RelationName, 'kind' | 'from' | 'to'>;

export type RelationEnd = { id: RecordId; type: Name };

export type RuleContext = {
  /** Registro que grava a relação. */
  from: RelationEnd;
  /** Destino já resolvido (alias virou id, existência já conferida). */
  to: RelationEnd;
  /** Demais relações do mesmo registro, já resolvidas. */
  siblings: readonly Pick<Relation, 'kind' | 'to'>[];
  names: ReadonlyMap<Name, NamedRelation>;
  /**
   * D-10: a vigência contra a qual cada tipo de relação confere o destino. `supersedes` e `revokes`
   * leem os itens anteriores do lote; `supports`, o lote inteiro. Nenhum valor único serve às duas:
   * o lote `[supersedes → E, supports → E]` exige as duas leituras. Para destino de outro processo,
   * a vigência vem dos registros do processo do destino, não dos do registro que grava
   * (`commands/register/state.ts#loadDestination`).
   */
  vigencyFor(kind: RelationKind): Vigency;
};

/**
 * D-10: `kind` da relação a partir de `kind` e/ou `as`, ou `unknown-relation-name` e `kind-mismatch`.
 * Só depende do manifesto, então o serviço a roda antes do lock (`commands/register/static.ts`).
 */
export function resolveKind(input: KindOrAs, names: RuleContext['names']): RelationCheck {
  if (input.as === undefined) return { kind: input.kind };
  const named = names.get(input.as);
  if (!named) return { violation: { code: 'unknown-relation-name' } };
  if (input.kind !== undefined && input.kind !== named.kind) {
    return { violation: { code: 'kind-mismatch' } };
  }
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

// Pares que um mesmo registro não pode gravar para o mesmo destino, e o código de cada recusa.
const CONFLICTS: Partial<Record<RelationKind, { opposite: RelationKind; code: RuleCode }>> = {
  supports: { opposite: 'contradicts', code: 'supports-and-contradicts' },
  contradicts: { opposite: 'supports', code: 'supports-and-contradicts' },
  supersedes: { opposite: 'revokes', code: 'supersedes-and-revokes' },
  revokes: { opposite: 'supersedes', code: 'supersedes-and-revokes' },
};

function checkConflict(kind: RelationKind, { to, siblings }: RuleContext): Violation | undefined {
  const conflict = CONFLICTS[kind];
  if (!conflict) return undefined;
  const clashes = siblings.some((other) => other.kind === conflict.opposite && other.to === to.id);
  return clashes ? { code: conflict.code } : undefined;
}

function checkVigency(kind: RelationKind, context: RuleContext): Violation | undefined {
  const { to } = context;
  const vigency = context.vigencyFor(kind);
  if (vigency.isCurrent(to.id)) return undefined;
  const current = vigency.currentOf(to.id);
  if (kind === 'supersedes' || kind === 'revokes') return { code: 'not-current', current };
  if (kind === 'supports') return { code: 'stale-destination', current };
  return undefined;
}

/**
 * D-10: resolve o `kind` da relação e devolve a primeira regra estrutural violada, na ordem fixa
 * autorrelação, nome, sucessão, pontas por tipo, conflito entre relações do registro (apoio e
 * contradição, substituição e revogação), vigência do destino.
 * Existência do destino e ciclo ficam com o serviço (`RELATION_NOT_FOUND`, `hasCycle`).
 */
export function checkRelation(input: KindOrAs, context: RuleContext): RelationCheck {
  if (context.from.id === context.to.id) return { violation: { code: 'self-relation' } };
  const resolved = resolveKind(input, context.names);
  if ('violation' in resolved) return resolved;
  const { kind } = resolved;
  const violation =
    checkSuccession(kind, context) ??
    checkEndpointTypes(input.as, context) ??
    checkConflict(kind, context) ??
    checkVigency(kind, context);
  return violation ? { violation } : { kind };
}
