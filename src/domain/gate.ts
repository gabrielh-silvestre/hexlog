import { isUndefined, memoize, uniq } from 'es-toolkit';
import { z } from 'zod';
import { Name, Target, TypeNames } from './ids.ts';
import type { RecordId } from './ids.ts';
import { buildInheritance } from './inheritance.ts';
import type { Inheritance } from './inheritance.ts';
import { RelationKind } from './record.ts';
import type { HexRecord } from './record.ts';
import { buildVigency, incomingOf } from './relations.ts';
import type { Incoming, Vigency } from './relations.ts';

/** Valor de `where`: só escalar, para que operadores entrem numa minor sem colidir com objeto. */
const Scalar = z.union([z.string(), z.number(), z.boolean()]);

/** Igualdade sobre campos de primeiro nível de `data`: `campo: valor`, sem operadores. */
export const Where = z.record(z.string(), Scalar);
export type Where = z.infer<typeof Where>;

/** Filtro de registros; `targetPrefix` omitido herda o `target` passado à avaliação. */
export const Selector = z.strictObject({
  type: Name.optional(),
  targetPrefix: Target.optional(),
  where: Where.optional(),
});
export type Selector = z.infer<typeof Selector>;

/** Alcance da leitura (D-24): `process` é o padrão. */
export const GateScope = z.enum(['process', 'project']);
export type GateScope = z.infer<typeof GateScope>;

const scope = GateScope.optional();

/** Herança pela linhagem de `supersedes` (ADR 0007, item 10); só vale em processo com ela ligada. */
const inherit = z.literal(true).optional();

export const GateQuestion = z.discriminatedUnion('kind', [
  z.strictObject({
    kind: z.literal('approved'),
    of: Selector,
    by: Selector.optional(),
    scope,
    inherit,
  }),
  z.strictObject({
    kind: z.literal('occurred'),
    select: Selector,
    min: z.int().positive().optional(),
    scope,
  }),
  z.strictObject({
    kind: z.literal('no_pending'),
    pending: Selector,
    resolvedBy: z.strictObject({ kind: RelationKind, from: TypeNames.optional() }),
    scope,
    inherit,
  }),
  z.strictObject({ kind: z.literal('no_open_contradiction'), of: Selector.optional(), scope }),
]);
export type GateQuestion = z.infer<typeof GateQuestion>;

/** Fronteira em `.`: `a.b` casa `a.b` e `a.b.c`, não `a.bc` (D-07). */
export function matchesTargetPrefix(target: Target, prefix: Target): boolean {
  return target === prefix || target.startsWith(`${prefix}.`);
}

/** O `target` da avaliação só entra quando o seletor não traz `targetPrefix` próprio. */
export function matchesSelector(
  record: Pick<HexRecord, 'type' | 'target' | 'data'>,
  selector: Selector,
  inheritedTarget?: Target,
): boolean {
  const prefix = selector.targetPrefix ?? inheritedTarget;
  if (!isUndefined(selector.type) && record.type !== selector.type) return false;
  if (!isUndefined(prefix) && !matchesTargetPrefix(record.target, prefix)) return false;
  return Object.entries(selector.where ?? {}).every(
    ([field, value]) => record.data[field] === value,
  );
}

/**
 * Resultado de uma pergunta: `kind` amarra a forma de `evidence`, e toda evidência é uma lista de
 * ids de registros vigentes.
 *
 * - `approved`: `of` são os registros vigentes avaliados; `supports` e `contradictions`, as origens
 *   vigentes de apoio (que casam `by`) e de contradição; `unsupported`, os de `of` sem nenhum apoio.
 *   `unsupported` separa os dois motivos de reprovar: recusado (`contradictions` não vazio) e
 *   pendente (`of` vazio ou `unsupported` não vazio, isto é, falta apoio).
 *   `inherited` (só com `inherit: true`) lista os apoiadores que contam apenas por herança.
 * - `occurred`: `found` são os registros vigentes que casam o seletor.
 * - `no_pending`: `unresolved` são os pendentes vigentes sem resolução vigente; `inherited` (só com
 *   `inherit: true`), os resolvedores que contam apenas por herança.
 * - `no_open_contradiction`: `conflicting` são os vigentes com contradição vigente.
 */
export type QuestionResult = { index: number; passed: boolean } & (
  | {
      kind: 'approved';
      evidence: {
        of: RecordId[];
        supports: RecordId[];
        contradictions: RecordId[];
        unsupported: RecordId[];
        inherited?: RecordId[];
      };
    }
  | { kind: 'occurred'; evidence: { found: RecordId[] } }
  | { kind: 'no_pending'; evidence: { unresolved: RecordId[]; inherited?: RecordId[] } }
  | { kind: 'no_open_contradiction'; evidence: { conflicting: RecordId[] } }
);

export type GateResult = { passed: boolean; questions: QuestionResult[] };

/** Quanto de `evidence` a resposta traz: só o que reprova, só contagens, ou tudo. */
export const EvidenceMode = z.enum(['failing', 'counts', 'full']);
export type EvidenceMode = z.infer<typeof EvidenceMode>;

/**
 * Pergunta enxuta: `counts` leva o tamanho de cada lista de `evidence`; `evidence` só aparece com
 * as listas de diagnóstico não vazias de uma pergunta reprovada (modo `failing`).
 */
export type CountedQuestion = {
  index: number;
  kind: QuestionResult['kind'];
  passed: boolean;
  counts: Record<string, number>;
  evidence?: Record<string, RecordId[]>;
};

/** `full` devolve o `QuestionResult` como está; os outros modos, o `CountedQuestion`. */
export type QuestionSummary = QuestionResult | CountedQuestion;

export type GateInput = {
  /** `target` de `evaluate_gate`, herdado pelos seletores sem `targetPrefix`. */
  target?: Target;
  /** Registros lidos no alcance pedido; `project` só é chamado se uma pergunta o declara. */
  records: (scope: GateScope) => readonly HexRecord[];
  /** O processo tem a herança ligada no manifesto; ausente = nenhum processo herda. */
  isInheritanceActive?: (process: Name) => boolean;
};

type View = {
  records: readonly HexRecord[];
  vigency: Vigency;
  incoming: ReadonlyMap<RecordId, Incoming<HexRecord>[]>;
  inheritance: Inheritance;
  byId: ReadonlyMap<RecordId, HexRecord>;
};

/** `isActive` só vem quando alguma pergunta do alcance pede `inherit`: sem pedido, a herança é vazia. */
function buildView(records: readonly HexRecord[], isActive?: (process: Name) => boolean): View {
  const vigency = buildVigency(records);
  return {
    records,
    vigency,
    incoming: incomingOf(records),
    inheritance: buildInheritance(records, vigency, isActive),
    byId: new Map(isUndefined(isActive) ? [] : records.map((record) => [record.id, record])),
  };
}

type Context = { view: View; target?: Target };

function currentMatching({ view, target }: Context, selector: Selector): HexRecord[] {
  return view.records.filter(
    (record) => view.vigency.isCurrent(record.id) && matchesSelector(record, selector, target),
  );
}

/** Registros vigentes que apontam para `id` com a relação `kind`. */
function currentSources({ view }: Context, id: RecordId, kind: RelationKind): HexRecord[] {
  return (view.incoming.get(id) ?? [])
    .filter((edge) => edge.kind === kind && view.vigency.isCurrent(edge.from.id))
    .map((edge) => edge.from);
}

/** Origens vigentes das relações herdadas de `kind` que chegam a `id`. */
function inheritedSources({ view }: Context, id: RecordId, kind: RelationKind): HexRecord[] {
  return view.inheritance
    .into(id)
    .filter((edge) => edge.kind === kind)
    .flatMap((edge) => view.byId.get(edge.from) ?? []);
}

/**
 * Origens de `kind` que chegam a `id` e passam em `accepted`: as diretas e, com `inherit`, as que só
 * contam por herança (a direta idêntica não se repete).
 */
function sourcesOf(
  context: Context,
  id: RecordId,
  kind: RelationKind,
  accepted: (source: HexRecord) => boolean,
  inherit: boolean | undefined,
): { direct: HexRecord[]; viaLineage: HexRecord[] } {
  const direct = currentSources(context, id, kind).filter(accepted);
  if (!inherit) return { direct, viaLineage: [] };
  const directIds = new Set(ids(direct));
  const viaLineage = inheritedSources(context, id, kind).filter(
    (source) => accepted(source) && !directIds.has(source.id),
  );
  return { direct, viaLineage };
}

const ids = (records: readonly HexRecord[]): RecordId[] => records.map((record) => record.id);

type Outcome<K extends QuestionResult['kind']> = Omit<
  Extract<QuestionResult, { kind: K }>,
  'index' | 'kind'
>;

function approved(
  context: Context,
  question: Extract<GateQuestion, { kind: 'approved' }>,
): Outcome<'approved'> {
  const approvers = question.by;
  const subjects = currentMatching(context, question.of);
  const supports: RecordId[] = [];
  const contradictions: RecordId[] = [];
  const unsupported: RecordId[] = [];
  const inherited: RecordId[] = [];
  const accepted = (source: HexRecord) =>
    isUndefined(approvers) || matchesSelector(source, approvers, context.target);
  for (const { id } of subjects) {
    const { direct, viaLineage } = sourcesOf(context, id, 'supports', accepted, question.inherit);
    const supporters = [...direct, ...viaLineage];
    inherited.push(...ids(viaLineage));
    supports.push(...ids(supporters));
    contradictions.push(...ids(currentSources(context, id, 'contradicts')));
    if (supporters.length === 0) unsupported.push(id);
  }
  return {
    passed: subjects.length > 0 && unsupported.length === 0 && contradictions.length === 0,
    evidence: {
      of: ids(subjects),
      supports: uniq(supports),
      contradictions: uniq(contradictions),
      unsupported,
      ...(question.inherit ? { inherited: uniq(inherited) } : {}),
    },
  };
}

function occurred(
  context: Context,
  question: Extract<GateQuestion, { kind: 'occurred' }>,
): Outcome<'occurred'> {
  const found = ids(currentMatching(context, question.select));
  return { passed: found.length >= (question.min ?? 1), evidence: { found } };
}

function noPending(
  context: Context,
  { pending, resolvedBy, inherit }: Extract<GateQuestion, { kind: 'no_pending' }>,
): Outcome<'no_pending'> {
  const accepted = (source: HexRecord) =>
    isUndefined(resolvedBy.from) || resolvedBy.from.includes(source.type);
  const unresolved: HexRecord[] = [];
  const inherited: RecordId[] = [];
  for (const record of currentMatching(context, pending)) {
    const { direct, viaLineage } = sourcesOf(
      context,
      record.id,
      resolvedBy.kind,
      accepted,
      inherit,
    );
    inherited.push(...ids(viaLineage));
    if (direct.length === 0 && viaLineage.length === 0) unresolved.push(record);
  }
  return {
    passed: unresolved.length === 0,
    evidence: { unresolved: ids(unresolved), ...(inherit ? { inherited: uniq(inherited) } : {}) },
  };
}

function noOpenContradiction(
  context: Context,
  question: Extract<GateQuestion, { kind: 'no_open_contradiction' }>,
): Outcome<'no_open_contradiction'> {
  const conflicting = currentMatching(context, question.of ?? {}).filter(
    ({ id }) => currentSources(context, id, 'contradicts').length > 0,
  );
  return { passed: conflicting.length === 0, evidence: { conflicting: ids(conflicting) } };
}

function answer(context: Context, question: GateQuestion, index: number): QuestionResult {
  switch (question.kind) {
    case 'approved':
      return { index, kind: 'approved', ...approved(context, question) };
    case 'occurred':
      return { index, kind: 'occurred', ...occurred(context, question) };
    case 'no_pending':
      return { index, kind: 'no_pending', ...noPending(context, question) };
    case 'no_open_contradiction':
      return { index, kind: 'no_open_contradiction', ...noOpenContradiction(context, question) };
  }
}

/** Listas de `evidence` que explicam a reprovação de cada `kind`; as demais só confirmam. */
const DIAGNOSTIC_LISTS: {
  [K in QuestionResult['kind']]: readonly (keyof Extract<QuestionResult, { kind: K }>['evidence'] &
    string)[];
} = {
  approved: ['unsupported', 'contradictions'],
  occurred: ['found'],
  no_pending: ['unresolved'],
  no_open_contradiction: ['conflicting'],
};

/** Reduz a `evidence` de uma pergunta ao que o `mode` pede; pura, não muta o resultado. */
export function summarizeQuestion(result: QuestionResult, mode: EvidenceMode): QuestionSummary {
  if (mode === 'full') return result;
  const lists = Object.entries<RecordId[]>(result.evidence);
  const { index, kind, passed } = result;
  const counted: CountedQuestion = {
    index,
    kind,
    passed,
    counts: Object.fromEntries(lists.map(([name, list]) => [name, list.length])),
  };
  if (mode === 'counts' || passed) return counted;
  const diagnosticNames: readonly string[] = DIAGNOSTIC_LISTS[kind];
  const diagnostic = lists.filter(
    ([name, list]) => diagnosticNames.includes(name) && list.length > 0,
  );
  return diagnostic.length === 0
    ? counted
    : { ...counted, evidence: Object.fromEntries(diagnostic) };
}

/**
 * D-24 e 4.1: avalia cada pergunta sobre os registros do alcance dela, sem relógio e sem prazo.
 * Só registro vigente conta, inclusive como origem de apoio, contradição ou resolução.
 */
export function evaluateGate(questions: readonly GateQuestion[], input: GateInput): GateResult {
  return prepareGate(questions, input)(input.target);
}

/**
 * Lê e monta a `View` de cada alcance uma só vez e devolve a avaliação por `target`: o lote de
 * `targets` reaproveita a mesma leitura em vez de refazer a vigência a cada alvo.
 */
export function prepareGate(
  questions: readonly GateQuestion[],
  input: Omit<GateInput, 'target'>,
): (target?: Target) => GateResult {
  const asksInherit = (questionScope: GateScope) =>
    questions.some(
      (question) =>
        (question.scope ?? 'process') === questionScope &&
        (question.kind === 'approved' || question.kind === 'no_pending') &&
        question.inherit === true,
    );
  const viewOf = memoize((questionScope: GateScope): View =>
    buildView(
      input.records(questionScope),
      asksInherit(questionScope) ? input.isInheritanceActive : undefined,
    ),
  );

  return (target) => {
    const results = questions.map((question, index) =>
      answer({ view: viewOf(question.scope ?? 'process'), target }, question, index),
    );
    return { passed: results.every(({ passed }) => passed), questions: results };
  };
}
