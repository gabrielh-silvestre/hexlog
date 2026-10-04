import { uniq } from 'es-toolkit';
import { z } from 'zod';
import { Name, Target, TypeNames } from './ids.ts';
import type { RecordId } from './ids.ts';
import { RelationKind } from './record.ts';
import type { HexRecord } from './record.ts';
import { buildVigency, pushTo } from './relations.ts';
import type { Vigency } from './relations.ts';

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

export const GateQuestion = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('approved'), of: Selector, by: Selector.optional(), scope }),
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
  if (selector.type !== undefined && record.type !== selector.type) return false;
  if (prefix !== undefined && !matchesTargetPrefix(record.target, prefix)) return false;
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
 * - `occurred`: `found` são os registros vigentes que casam o seletor.
 * - `no_pending`: `unresolved` são os pendentes vigentes sem resolução vigente.
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
      };
    }
  | { kind: 'occurred'; evidence: { found: RecordId[] } }
  | { kind: 'no_pending'; evidence: { unresolved: RecordId[] } }
  | { kind: 'no_open_contradiction'; evidence: { conflicting: RecordId[] } }
);

/** Ids que sustentam o veredito de cada pergunta; o formato de cada variante está em `QuestionResult`. */
export type Evidence = QuestionResult['evidence'];

export type GateResult = { passed: boolean; questions: QuestionResult[] };

export type GateInput = {
  /** `target` de `evaluate_gate`, herdado pelos seletores sem `targetPrefix`. */
  target?: Target;
  /** Registros lidos no alcance pedido; `project` só é chamado se uma pergunta o declara. */
  records: (scope: GateScope) => readonly HexRecord[];
};

type Incoming = { kind: RelationKind; from: HexRecord };

type View = {
  records: readonly HexRecord[];
  vigency: Vigency;
  incoming: ReadonlyMap<RecordId, Incoming[]>;
};

function buildView(records: readonly HexRecord[]): View {
  const incoming = new Map<RecordId, Incoming[]>();
  for (const from of records) {
    for (const { kind, to } of from.relations) {
      pushTo(incoming, to, { kind, from });
    }
  }
  return { records, vigency: buildVigency(records), incoming };
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
  for (const { id } of subjects) {
    const supporters = currentSources(context, id, 'supports').filter(
      (source) => approvers === undefined || matchesSelector(source, approvers, context.target),
    );
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
  { pending, resolvedBy }: Extract<GateQuestion, { kind: 'no_pending' }>,
): Outcome<'no_pending'> {
  const unresolved = currentMatching(context, pending).filter(
    ({ id }) =>
      !currentSources(context, id, resolvedBy.kind).some(
        (source) => resolvedBy.from === undefined || resolvedBy.from.includes(source.type),
      ),
  );
  return { passed: unresolved.length === 0, evidence: { unresolved: ids(unresolved) } };
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

/**
 * D-24 e 4.1: avalia cada pergunta sobre os registros do alcance dela, sem relógio e sem prazo.
 * Só registro vigente conta, inclusive como origem de apoio, contradição ou resolução.
 */
export function evaluateGate(questions: readonly GateQuestion[], input: GateInput): GateResult {
  const views = new Map<GateScope, View>();
  const viewOf = (questionScope: GateScope): View => {
    const cached = views.get(questionScope);
    if (cached) return cached;
    const view = buildView(input.records(questionScope));
    views.set(questionScope, view);
    return view;
  };

  const results = questions.map((question, index) =>
    answer({ view: viewOf(question.scope ?? 'process'), target: input.target }, question, index),
  );
  return { passed: results.every(({ passed }) => passed), questions: results };
}
