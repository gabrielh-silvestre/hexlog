import type { McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod';
import { Selector, Where } from '../../domain/gate.ts';
import { Hash, Name, RecordId, Target } from '../../domain/ids.ts';
import { QUERY_TEXT_MAX_CHARS } from '../../queries/query-service.ts';
import {
  advertise,
  execute,
  gatePage,
  queryPage,
  type ToolDeps,
  WELL_FORMED,
  wellFormed,
} from '../kernel.ts';

/** Teto de `limit` no zod da tool; o serviço só exige inteiro >= 1. */
const LIMIT_MAX = 200;

// Tetos de entrada da query (docs/tetos-dominio-v1.md): palpites de CPU e de tamanho de mensagem.
const IDS_MAX = 200;
const WHERE_KEYS_MAX = 50;
// O marcador tem uma chave por processo lido e é devolvido pelo servidor. Só com nomes de ~42 caracteres
// ou mais o teto fica acima do que o cursor suporta; com nomes menores o cursor pagina além de 200 e o zod recusa antes.
const MARKER_KEYS_MAX = 200;
const TOO_MANY_KEYS = 'has too many keys';

// Marcador, cursor e `changesSince` inválidos chegam do serviço como MARKER_NOT_FOUND/INVALID_CURSOR
// com o path do campo; o zod garante a forma e a boa formação das chaves e valores.
const MarkerInput = z
  .record(z.string(), z.string().nullable())
  .refine((marker) => Object.keys(marker).length <= MARKER_KEYS_MAX, TOO_MANY_KEYS)
  .refine(
    (marker) =>
      wellFormed(
        Object.entries(marker)
          .flat()
          .filter((v) => v !== null),
      ),
    WELL_FORMED,
  );

const WhereInput = Where.refine(
  (where) => Object.keys(where).length <= WHERE_KEYS_MAX,
  TOO_MANY_KEYS,
).refine(
  (where) =>
    wellFormed(
      Object.entries(where)
        .flat()
        .filter((v): v is string => typeof v === 'string'),
    ),
  WELL_FORMED,
);

const QueryInput = z.strictObject({
  project: Name,
  process: Name.optional(),
  scope: z.enum(['process', 'project']).optional(),
  includeNonCurrent: z.boolean().optional(),
  ...Selector.shape,
  where: WhereInput.optional(),
  text: z
    .string()
    .max(QUERY_TEXT_MAX_CHARS)
    .refine((text) => wellFormed([text]), WELL_FORMED)
    .optional(),
  ids: z.array(RecordId).max(IDS_MAX).optional(),
  relatedTo: RecordId.optional(),
  limit: z.number().int().min(1).max(LIMIT_MAX).optional(),
  cursor: z.string().optional(),
  changesSince: MarkerInput.optional(),
});

const EvaluateGateInput = z.strictObject({
  project: Name,
  process: Name,
  gate: Name,
  target: Target.optional(),
  marker: MarkerInput.optional(),
});

const VerifyChainInput = z.strictObject({ project: Name, process: Name });

const ListInput = z.strictObject({ project: Name.optional(), process: Name.optional() });

// Saídas enxutas (TM7): só a forma que o cliente precisa checar; o miolo variável fica solto.
const MarkerOutput = z.record(z.string(), z.string().nullable());

const QueryOutput = z.object({
  records: z.array(
    z.looseObject({ id: z.string(), type: z.string(), at: z.string(), target: z.string() }),
  ),
  cursor: z.string().optional(),
  marker: MarkerOutput,
  changes: z
    .looseObject({
      entered: z.array(z.string()),
      left: z.array(z.looseObject({ id: z.string(), reason: z.string() })),
      marker: MarkerOutput,
      omitted: z.object({ entered: z.number(), left: z.number() }).optional(),
    })
    .optional(),
});

const EvaluateGateOutput = z.object({
  passed: z.boolean(),
  questions: z.array(
    z.looseObject({
      index: z.number(),
      kind: z.string(),
      passed: z.boolean(),
      evidence: z.unknown(),
      omitted: z.record(z.string(), z.number()).optional(),
    }),
  ),
  marker: MarkerOutput,
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

const QUERY_DESCRIPTION =
  'Read the current records of a process (scope "process", the default, needs process) or of the ' +
  'whole project (scope "project"). Filters: type, targetPrefix, where (equality on top-level data ' +
  'fields, scalar values only), text (full-text search, at most 200 characters, ordered by relevance), ' +
  'ids, relatedTo (records linked to an id) and includeNonCurrent (also superseded or revoked ones). ' +
  'Each record carries its in and out relations, needsReview when its support is dead and ' +
  'attachmentStatus for the attachments it cites. A page holds at most limit records (default 50, ' +
  'max 200) and also stops at a size cap, always with at least one record; pass the returned cursor ' +
  'to continue. marker is the head of every process read: pass it back as changesSince to get ' +
  'changes (entered, left with reason) since then, on the first page only; resend the same ' +
  'changesSince with the cursor on later pages, or INVALID_CURSOR. changes lists at most 100 ' +
  'ids in entered and in left; when omitted (the count left out per list) comes back, the lists are ' +
  'partial and that marker must not be reused as changesSince, because the omitted ids never show ' +
  'again: reread everything instead (records by cursor, left with includeNonCurrent). A marker ' +
  'covers exactly the processes it names; in project scope, any process it does not name is read ' +
  'as empty. Fails with MARKER_NOT_FOUND or INVALID_CURSOR when marker, changesSince or cursor do ' +
  'not match the data read.';

const EVALUATE_GATE_DESCRIPTION =
  'Evaluate a gate pinned in a process, without writing anything. Returns passed and one result per ' +
  'question (index, kind, passed, evidence: the record ids behind the answer) plus the marker of ' +
  'what was read. target is inherited by selectors without targetPrefix. Pass a marker from an ' +
  'earlier read to replay the evaluation over the records that existed then; a marker covers ' +
  'exactly the processes it names, and in project scope any process it does not name is read as ' +
  'empty. Each evidence list holds at most 100 ids and omitted counts the rest per list; a ' +
  'narrower select or where reaches them.';

const VERIFY_CHAIN_DESCRIPTION =
  'Check the integrity of a process: the hash chain of its log and the attachments its records cite. ' +
  'Returns ok (true only when breaks and attachmentBreaks are both empty), totalRecords, head, ' +
  'breaks and totalBreaks for the chain, attachmentBreaks and totalAttachmentBreaks for missing or ' +
  'corrupted attachments, and repairedLines. A broken chain is a result, not an error.';

const LIST_DESCRIPTION =
  'Discover what exists. Without project: the projects and their process counts. With project: its ' +
  'processes and the current types, relation names and gates, each with its versions. With project ' +
  'and process: what the process pinned and the definition hashes.';

/** Registra as quatro tools de leitura (`readOnlyHint`); cada uma só repassa a entrada ao serviço. */
export function registerQueryTools(server: McpServer, deps: ToolDeps): void {
  const readOnly = { readOnlyHint: true };

  server.registerTool(
    'query',
    {
      description: QUERY_DESCRIPTION,
      inputSchema: advertise(QueryInput),
      outputSchema: QueryOutput,
      annotations: readOnly,
    },
    (args, ctx) =>
      execute(deps, { name: 'query', schema: QueryInput, args, ctx }, (input) =>
        queryPage(deps.services.query, input),
      ),
  );

  server.registerTool(
    'evaluate_gate',
    {
      description: EVALUATE_GATE_DESCRIPTION,
      inputSchema: advertise(EvaluateGateInput),
      outputSchema: EvaluateGateOutput,
      annotations: readOnly,
    },
    (args, ctx) =>
      execute(deps, { name: 'evaluate_gate', schema: EvaluateGateInput, args, ctx }, (input) =>
        gatePage(deps.services.query.evaluateGate(input)),
      ),
  );

  server.registerTool(
    'verify_chain',
    {
      description: VERIFY_CHAIN_DESCRIPTION,
      inputSchema: advertise(VerifyChainInput),
      outputSchema: VerifyChainOutput,
      annotations: readOnly,
    },
    (args, ctx) =>
      execute(deps, { name: 'verify_chain', schema: VerifyChainInput, args, ctx }, (input) =>
        deps.services.query.verifyChain(input),
      ),
  );

  server.registerTool(
    'list',
    {
      description: LIST_DESCRIPTION,
      inputSchema: advertise(ListInput),
      outputSchema: ListOutput,
      annotations: readOnly,
    },
    (args, ctx) =>
      execute(deps, { name: 'list', schema: ListInput, args, ctx }, (input) =>
        deps.services.query.list(input),
      ),
  );
}
