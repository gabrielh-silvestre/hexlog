import type { McpServer } from '@modelcontextprotocol/server';
import { isString, isUndefined, mapValues, pickBy } from 'es-toolkit';
import { z } from 'zod';
import {
  type CountedQuestion,
  EvidenceMode,
  type QuestionResult,
  type QuestionSummary,
  Selector,
  Where,
} from '../../domain/gate.ts';
import { Hash, Name, RecordId, Target } from '../../domain/ids.ts';
import { WELL_FORMED } from '../../domain/record.ts';
import {
  type Changes,
  type GateBatchEvaluation,
  type GateEvaluation,
  PAGE_CHARS_CAP,
  QUERY_TEXT_MAX_CHARS,
  type QueryInput as QueryServiceInput,
  type QueryResult,
  type QueryService,
} from '../../queries/query-service.ts';
import { RELATION_MODES } from '../../queries/select.ts';
import { defineTool, MarkerRecord, READ_ANNOTATIONS, type ToolDeps } from '../kernel.ts';

/**
 * Teto de `limit` no zod da tool; o serviço exige inteiro >= 1 (ou 0 com `changesSince`, sem
 * `cursor`).
 */
const LIMIT_MAX = 200;

/** Itens de `changes.entered` e de `changes.left` que cabem no envelope da tool (M4 da herança do PR-5). */
export const CHANGES_ITEMS_CAP = 100;

/** Ids por lista de `evidence` de uma pergunta de `evaluate_gate`; corte igual ao de `changes`, também palpite. */
export const EVIDENCE_ITEMS_CAP = 100;

// Tetos de entrada da query (docs/tetos-dominio-v1.md): palpites de CPU e de tamanho de mensagem.
const IDS_MAX = 200;
const WHERE_KEYS_MAX = 50;
const FIELDS_MAX = 50;
// Alinhado a `BATCH_MAX`: o lote de targets do `evaluate_gate` (palpite, docs/tetos-dominio-v1.md).
const TARGETS_MAX = 50;
// O marcador tem uma chave por processo lido e é devolvido pelo servidor. Só com nomes de ~42 caracteres
// ou mais o teto fica acima do que o cursor suporta; com nomes menores o cursor pagina além de 200 e o zod recusa antes.
const MARKER_KEYS_MAX = 200;
const TOO_MANY_KEYS = 'has too many keys';

/** Limita as chaves do registro e exige boa formação nas chaves e nos valores string. */
const boundedWellFormed = <V>(schema: z.ZodType<Record<string, V>>, max: number) =>
  schema
    .refine((record) => Object.keys(record).length <= max, TOO_MANY_KEYS)
    .refine(
      (record) =>
        Object.entries(record)
          .flat()
          .every((value) => !isString(value) || value.isWellFormed()),
      WELL_FORMED,
    );

// Marcador, cursor e `changesSince` inválidos chegam do serviço como MARKER_NOT_FOUND/INVALID_CURSOR
// com o path do campo; o zod garante a forma e a boa formação das chaves e valores.
const MarkerInput = boundedWellFormed(MarkerRecord, MARKER_KEYS_MAX);

const WhereInput = boundedWellFormed(Where, WHERE_KEYS_MAX);

// `since` é o palpite comum para "o que mudou": a mensagem aponta `changesSince`, que aceita um
// marcador (qualquer id de registro do processo), não um instante.
const unrecognizedKeysMessage: z.core.$ZodErrorMap = (issue) => {
  if (issue.code !== 'unrecognized_keys' || !issue.keys.includes('since')) return undefined;
  const keys = issue.keys.map((key) => JSON.stringify(key)).join(', ');
  return `Unrecognized keys: ${keys}; there is no time filter, use changesSince (a marker from an earlier query) to read what changed`;
};

const QueryInput = z.strictObject(
  {
    project: Name,
    process: Name.optional(),
    scope: z.enum(['process', 'project']).optional(),
    includeNonCurrent: z.boolean().optional(),
    ...Selector.shape,
    where: WhereInput.optional(),
    text: z
      .string()
      .max(QUERY_TEXT_MAX_CHARS)
      .refine((text) => text.isWellFormed(), WELL_FORMED)
      .optional(),
    ids: z.array(RecordId).max(IDS_MAX).optional(),
    fields: z.array(z.string().min(1)).max(FIELDS_MAX).optional(),
    relatedTo: RecordId.optional(),
    relations: z.enum(RELATION_MODES).optional(),
    // 0 só com `changesSince` e sem `cursor`: quem confere é o serviço, com o path de `/limit`.
    limit: z.number().int().min(0).max(LIMIT_MAX).optional(),
    cursor: z.string().optional(),
    changesSince: MarkerInput.optional(),
  },
  { error: unrecognizedKeysMessage },
);

const EvaluateGateInput = z.strictObject({
  project: Name,
  process: Name,
  gate: Name,
  target: Target.optional(),
  // 1 a 50 targets numa só leitura; exclusivo com `target` e sem `evidence: "full"` (o serviço recusa).
  targets: z.array(Target).min(1).max(TARGETS_MAX).optional(),
  marker: MarkerInput.optional(),
  evidence: EvidenceMode.optional(),
});

const VerifyChainInput = z.strictObject({
  project: Name,
  process: Name,
  expectedHead: Hash.optional(),
});

const ListInput = z.strictObject({ project: Name.optional(), process: Name.optional() });

// `process` e `version` juntos são recusados pelo serviço, com o path do campo.
const DescribeTypeInput = z.strictObject({
  project: Name,
  type: Name,
  process: Name.optional(),
  version: z.string().optional(),
});

// Saídas enxutas (TM7): só a forma que o cliente precisa checar; o miolo variável fica solto.
const QueryOutput = z.object({
  records: z.array(
    z.looseObject({
      id: z.string(),
      type: z.string(),
      at: z.string(),
      target: z.string(),
      inCounts: z.record(z.string(), z.number()).optional(),
      outCounts: z.record(z.string(), z.number()).optional(),
      in: z.array(z.unknown()).optional(),
      out: z.array(z.unknown()).optional(),
    }),
  ),
  cursor: z.string().optional(),
  marker: MarkerRecord,
  hint: z.string().optional(),
  changes: z
    .looseObject({
      entered: z.array(z.string()),
      left: z.array(z.looseObject({ id: z.string(), reason: z.string() })),
      marker: MarkerRecord,
      omitted: z.object({ entered: z.number(), left: z.number() }).optional(),
    })
    .optional(),
});

const GateQuestionOutput = z.looseObject({
  index: z.number(),
  kind: z.string(),
  passed: z.boolean(),
  counts: z.record(z.string(), z.number()).optional(),
  evidence: z.unknown().optional(),
  omitted: z.record(z.string(), z.number()).optional(),
});

// `questions` sai com `target` ou sem alvo; `results`, com `targets`.
const EvaluateGateOutput = z.object({
  passed: z.boolean(),
  questions: z.array(GateQuestionOutput).optional(),
  results: z
    .array(
      z.looseObject({
        target: z.string(),
        passed: z.boolean(),
        questions: z.array(GateQuestionOutput),
      }),
    )
    .optional(),
  marker: MarkerRecord,
});

// N10: schema congelado; `ok` exige `breaks` e `attachmentBreaks` vazias.
const VerifyChainOutput = z.object({
  ok: z.boolean(),
  totalRecords: z.number(),
  head: z.string(),
  breaks: z.array(z.looseObject({ index: z.number(), reason: z.string() })),
  totalBreaks: z.number(),
  attachmentBreaks: z.array(z.object({ id: z.string(), hash: Hash, reason: z.string() })),
  totalAttachmentBreaks: z.number(),
  repairedLines: z.array(z.number()),
});

const ListOutput = z.object({
  projects: z.array(z.looseObject({ name: z.string(), processes: z.number() })).optional(),
  project: z.looseObject({ name: z.string() }).optional(),
  process: z.looseObject({ name: z.string() }).optional(),
});

const DescribeTypeOutput = z.object({
  name: z.string(),
  version: z.string().optional(),
  schema: z.record(z.string(), z.unknown()),
});

const QUERY_DESCRIPTION =
  'Read the current records of a process (scope "process", the default, needs process) or of the ' +
  'project (scope "project"). Filters: type, targetPrefix, where (equality on top-level scalar ' +
  'data fields), text (full-text, at most 200 characters, by relevance), ids, relatedTo ' +
  '(records linked to an id) and includeNonCurrent (also superseded or revoked). ' +
  'targetPrefix matches whole "."-separated segments (unit-1 does not match unit-10); a near miss ' +
  'in an empty answer carries a hint. ' +
  'Records carry needsReview (dead support) and attachmentStatus (cited attachments). ' +
  'relations: counts (default) gives inCounts and outCounts ({name: n}, empty maps ' +
  'omitted); full gives in and out; none gives neither. With lineage inheritance, relations to or ' +
  'from a superseded version also hold for the current one: inheritedIn and inheritedOut (full), ' +
  'inheritedInCounts and inheritedOutCounts (counts); origin {from, to} is the stored edge; a ' +
  'contradicts between the lineages cuts it. Process scope sees only its own relations; use ' +
  'project for cross-process ones. fields (at most ' +
  `${FIELDS_MAX}) keeps only those top-level names of data; an empty list omits data, relations and ` +
  'annotations stay, filters see the whole data and the size cap counts the projected page. ' +
  'A page holds at most limit records (default 50, max 200) and stops at a size cap, ' +
  'keeping at least one record; the returned cursor continues. marker is the head of every ' +
  'process read, and any record id of the process works as its entry: pass it back as changesSince ' +
  'to get changes (entered, left with reason) since then, on the first page only; add limit 0 to ' +
  'get only the changes. Resend it with the cursor. ' +
  `changes lists at most ${CHANGES_ITEMS_CAP} ids in entered and left; changes.omitted means they ` +
  'are partial, omitted ids never reappear and that marker must not be reused as changesSince: ' +
  'reread everything (cursor; left with includeNonCurrent). A marker covers only the ' +
  'processes it names; in project scope others are read as empty. A mismatched ' +
  'changesSince or cursor fails with MARKER_NOT_FOUND or INVALID_CURSOR.';

const EVALUATE_GATE_DESCRIPTION =
  'Evaluate a gate pinned in a process (GATE_NOT_FOUND otherwise), without writing anything. Returns ' +
  'passed and one result per question (index, kind, passed) plus the marker of what was read. ' +
  'evidence sets the detail: failing (default with target) gives counts (size of each evidence list) and, for a ' +
  'failed question, the ids that explain it; counts (default with targets) gives only counts; full gives every list of ids ' +
  '(approved has of, supports, contradictions and unsupported; occurred has found; no_pending has ' +
  'unresolved; no_open_contradiction has conflicting). A question of approved or no_pending with ' +
  'inherit: true also counts support or resolution that a superseded version carried, in a process ' +
  'with lineage inheritance, and adds the list inherited with those that count only that way. ' +
  'target is inherited by selectors without ' +
  'targetPrefix; targets (1 to 50, not with target or evidence full) evaluates several in one read ' +
  'and answers results: one {target, passed, questions} per target, in order, with a single marker; ' +
  'to see the ids behind a failed target, evaluate that target alone with the batch marker. ' +
  'Pass a marker from an earlier read to replay the evaluation over the records that existed then; a ' +
  'marker covers exactly the processes it names, and in project scope any process it does not name is ' +
  'read as empty. A gate without project-scope questions reads one process: the marker must name only ' +
  `it (else MARKER_NOT_FOUND). Each evidence list holds at most ${EVIDENCE_ITEMS_CAP} ids and omitted counts the ` +
  'rest per list; a narrower select or where reaches them.';

const VERIFY_CHAIN_DESCRIPTION =
  'Check the integrity of a process: the hash chain of its log and the attachments its records cite. ' +
  'Returns ok (true only when breaks and attachmentBreaks are both empty), totalRecords, head (the ' +
  'hash of the last link, or the process anchor when the log has no link), breaks and totalBreaks for the chain, attachmentBreaks and totalAttachmentBreaks for missing or ' +
  'corrupted attachments, and repairedLines. A broken chain is a result, not an error. Pass ' +
  'expectedHead (a head saved from an earlier check) to detect a deleted or rewritten tail: a hash ' +
  'that is no link of the log and not the process anchor adds a head-not-found break.';

const LIST_DESCRIPTION =
  'Discover what exists. Without project: the projects and their process counts. With project: its ' +
  'processes and the current types, relation names and gates, each with its versions. With project ' +
  'and process: what the process pinned and the definition hashes.';

const DESCRIBE_TYPE_DESCRIPTION =
  'Read the JSON Schema of a record type, without writing anything. With process: the type pinned ' +
  'in that process, returned as name and schema without version, because the process pins the ' +
  'schema and not its version (TYPE_NOT_PINNED when the process did not pin the type). Without ' +
  'process: the current version of the type in the project, or the one asked by version, returned ' +
  'as name, version and schema (PROJECT_NOT_FOUND when the project does not exist, TYPE_NOT_FOUND ' +
  'when it has no such type or version). The schema comes back without `pattern` and ' +
  '`patternProperties`: hexlog ignores them, a legacy type may still store them, and resending ' +
  'the schema read here needs `breaking: true`. ' +
  'process and version together, or a version that is not <major>.<minor>, are refused with ' +
  'INVALID_INPUT.';

type PagedChanges = Changes & { omitted?: { entered: number; left: number } };

/** M4: corta `entered` e `left` em `CHANGES_ITEMS_CAP` e conta o que ficou de fora em `omitted`. */
function capChanges(changes: Changes): PagedChanges {
  const entered = changes.entered.length - CHANGES_ITEMS_CAP;
  const left = changes.left.length - CHANGES_ITEMS_CAP;
  if (entered <= 0 && left <= 0) return changes;
  return {
    ...changes,
    entered: changes.entered.slice(0, CHANGES_ITEMS_CAP),
    left: changes.left.slice(0, CHANGES_ITEMS_CAP),
    omitted: { entered: Math.max(entered, 0), left: Math.max(left, 0) },
  };
}

/**
 * Única porta de `query` para as tools: passa `maxChars` (`PAGE_CHARS_CAP`) em toda chamada, porque o
 * serviço usa `Infinity` sem ele (D-20), assume `relations: counts` (o serviço assume `full`) e corta
 * `changes` no envelope, que fica fora do teto de página.
 */
export function queryPage(
  query: Pick<QueryService, 'queryRecords'>,
  input: Omit<QueryServiceInput, 'maxChars'>,
): Omit<QueryResult, 'changes'> & { changes?: PagedChanges } {
  const { changes, ...page } = query.queryRecords({
    ...input,
    relations: input.relations ?? 'counts',
    maxChars: PAGE_CHARS_CAP,
  });
  return isUndefined(changes) ? page : { ...page, changes: capChanges(changes) };
}

type PagedQuestion = (Omit<QuestionResult, 'evidence'> | Omit<CountedQuestion, 'evidence'>) & {
  evidence?: Record<string, string[]>;
  omitted?: Record<string, number>;
};

/** Corta cada lista de `evidence` em `EVIDENCE_ITEMS_CAP` ids; `omitted` conta o que ficou de fora por lista. */
function capEvidence({ evidence, ...question }: QuestionSummary): PagedQuestion {
  if (isUndefined(evidence)) return question;
  const lists: Record<string, string[]> = evidence;
  const omitted = pickBy(
    mapValues(lists, (ids) => ids.length - EVIDENCE_ITEMS_CAP),
    (count) => count > 0,
  ) as Record<string, number>;
  if (Object.keys(omitted).length === 0) return { ...question, evidence };
  return {
    ...question,
    evidence: mapValues(lists, (ids) => ids.slice(0, EVIDENCE_ITEMS_CAP)),
    omitted,
  };
}

/**
 * Única porta de `evaluateGate` para as tools: a evidência não tem teto no domínio, então o envelope
 * corta cada lista, por pergunta de cada target do lote. `passed` e `marker` seguem intactos; o gate
 * é sem estado, e o excedente sai com um `select`/`where` mais estreito.
 */
function gatePage(evaluation: GateEvaluation<QuestionSummary> | GateBatchEvaluation) {
  if ('results' in evaluation) {
    return {
      ...evaluation,
      results: evaluation.results.map((result) => ({
        ...result,
        questions: result.questions.map(capEvidence),
      })),
    };
  }
  return { ...evaluation, questions: evaluation.questions.map(capEvidence) };
}

/** Registra as cinco tools de leitura (`readOnlyHint`); cada uma só repassa a entrada ao serviço. */
export function registerQueryTools(server: McpServer, deps: ToolDeps): void {
  defineTool(
    server,
    deps,
    {
      name: 'query',
      schema: QueryInput,
      title: 'Query',
      description: QUERY_DESCRIPTION,
      outputSchema: QueryOutput,
      annotations: READ_ANNOTATIONS,
    },
    (input) => queryPage(deps.services.query, input),
  );

  defineTool(
    server,
    deps,
    {
      name: 'evaluate_gate',
      schema: EvaluateGateInput,
      title: 'Evaluate gate',
      description: EVALUATE_GATE_DESCRIPTION,
      outputSchema: EvaluateGateOutput,
      annotations: READ_ANNOTATIONS,
    },
    // O serviço assume `evidence: full`; o padrão enxuto é do envelope, como o `maxChars` de `queryPage`.
    // Lote em `counts`: os ids de 50 targets reprovando somavam ~27x o teto de página, e quem quer os
    // ids de um target reavalia só ele, com o `marker` do lote.
    (input) =>
      gatePage(
        deps.services.query.evaluateGate({
          ...input,
          evidence: input.evidence ?? (isUndefined(input.targets) ? 'failing' : 'counts'),
        }),
      ),
  );

  defineTool(
    server,
    deps,
    {
      name: 'verify_chain',
      schema: VerifyChainInput,
      title: 'Verify chain',
      description: VERIFY_CHAIN_DESCRIPTION,
      outputSchema: VerifyChainOutput,
      annotations: READ_ANNOTATIONS,
    },
    (input) => deps.services.query.verifyChain(input),
  );

  defineTool(
    server,
    deps,
    {
      name: 'list',
      schema: ListInput,
      title: 'List',
      description: LIST_DESCRIPTION,
      outputSchema: ListOutput,
      annotations: READ_ANNOTATIONS,
    },
    (input) => deps.services.query.list(input),
  );

  defineTool(
    server,
    deps,
    {
      name: 'describe_type',
      schema: DescribeTypeInput,
      title: 'Describe type',
      description: DESCRIBE_TYPE_DESCRIPTION,
      outputSchema: DescribeTypeOutput,
      annotations: READ_ANNOTATIONS,
    },
    (input) => deps.services.query.describeType(input),
  );
}
