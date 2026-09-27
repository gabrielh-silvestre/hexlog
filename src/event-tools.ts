import type { McpServer } from '@modelcontextprotocol/server';
import canonicalize from 'canonicalize';
import { isNil, isNotNil, keyBy, omit } from 'es-toolkit';
import { z } from 'zod';
import {
  search as runSearch,
  isCandidate,
  hasTargetFilter,
  SEARCH_MAX_CHARS,
  type Filters,
} from './search.ts';
import { isValidLink, verifyChain, type Chain } from './chain.ts';
import { loadProcess, type LoadedProcess } from './definitions.ts';
import { issueDetails, HexlogError, type Detail } from './errors.ts';
import {
  parseId,
  Target,
  dataSchema,
  EventLine,
  normalizeData,
  Label,
  matchesTargetPrefix,
} from './events.ts';
import {
  allowedTerms,
  effectiveNow,
  isMilestoneGate,
  projectState,
  validateField,
  type VocabularyField,
  type State,
  type Vocabulary,
} from './state.ts';
import {
  evaluateBuiltin,
  isBuiltinGate,
  BUILTIN_GATES,
  buildGateMilestoneData,
  normalizeCustomEvidence,
  EVIDENCE_ITEM_MAX_CHARS,
  CUSTOM_EVIDENCE_MAX,
  type BuiltinGateName,
  type EvaluationResult,
  type GateMilestoneData,
} from './gates.ts';
import { append, appendBatch, readText, type Base } from './log.ts';
import {
  Agent,
  Hash,
  Warning,
  // Alias: `type Chain` (chain.ts, acima) já ocupa esse nome neste arquivo; o schema Zod de
  // `Chain` (mesmo nome, reexportado de mcp.ts) precisa de um nome local diferente.
  Chain as ChainSchema,
  type Context,
  execute,
  Instant,
  Name,
  Ref,
  Section,
  SECTION_ITEMS_CAP,
  PAGE_CHARS_CAP,
} from './mcp.ts';

type WarningOutput = z.infer<typeof Warning>;
type SectionName = z.infer<typeof Section>;

/** Seções cujo total/lista vêm de um campo homônimo de `State`/`Projection`; `chain` é tratada à parte. */
const LIST_SECTIONS = [
  'active',
  'conflicts',
  'orphans',
  'toReview',
  'invalidReferences',
  'warnings',
  'forks',
  'targets',
] as const;
const ALL_SECTIONS: SectionName[] = [...LIST_SECTIONS, 'chain'];

/** Registra as 5 tools de eventos (`register`, `evaluate_gate`, `state`, `events`, `chain`). */
export function registerEventTools(server: McpServer, ctx: Context): void {
  server.registerTool(
    'register',
    {
      title: 'Register event',
      description:
        'Registers an event (Milestone, Verdict or a fixed custom type) in the process. Returns a receipt ' +
        '`{seq, id, prevHash, deduplicated, warnings}` by default; pass `echo: true` to also get the full ' +
        'registered `event`. `id` can be a **prefix** `{project}:{process}:{type}` (the server generates a new ' +
        'uuid v7 and appends) or a **full id** `{project}:{process}:{type}:{uuid}` returned by an earlier call: ' +
        'idempotent retry, the same normalized `type`/`agent`/`data` returns the existing line with ' +
        '`deduplicated: true`; different content is `CONFLICTING_ID`. Milestone accepts `milestoneType`, ' +
        '`target` (`hex:target:<id>`), `count`, `dueAt`, `decisions[]` and `trace` (optional; ignored when ' +
        'comparing an idempotent retry, so a Milestone re-sent with a different `trace` still dedupes); Verdict ' +
        'accepts `claim`, `source`, `result`, `evidence`, `target` (`hex:target:<id>`), `supersedes[]`, `origin` ' +
        'and `trace`. `milestoneType: "gate"` and the `gate` key are reserved for the gate Milestone generated ' +
        'by `evaluate_gate`.',
      inputSchema: {
        project: Name,
        process: Name,
        id: z.string().min(1).max(260),
        agent: Agent,
        data: z.record(z.string(), z.unknown()),
        echo: z.boolean().default(false),
      },
      outputSchema: {
        seq: z.number().int().min(0),
        id: z.string(),
        prevHash: Hash,
        deduplicated: z.boolean(),
        warnings: z.array(Warning),
        event: EventLine.optional(),
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: false,
      },
    },
    async ({ project, process, id, agent, data, echo }) =>
      execute(ctx, 'register', { project, process }, () =>
        registerEvent(ctx, { project, process, id, agent, data, echo }),
      ),
  );

  server.registerTool(
    'evaluate_gate',
    {
      title: 'Evaluate gate',
      description:
        'Evaluates up to 20 gates in one call and writes each result as a gate Milestone, all under a single ' +
        'lock acquisition: one `state` snapshot for the whole batch, so every builtin gate in it shares the same ' +
        '`evaluatedThrough`. A builtin gate (`no-orphans`, `no-conflicts`, `chain-intact`, `no-invalid-references`, ' +
        "`no-forks`) does not accept `result`: it is computed from the process's current State. A custom gate, " +
        'fixed in the process, requires `result: {passed, evidence}`. Every gate in `gates` is validated before ' +
        'anything is written: if any one of them fails validation, the whole call fails and nothing is recorded. ' +
        'Once writing starts, a genuine disk error or a stolen lock (`LOCK_LOST`) leaves the Milestones written so ' +
        'far persisted — the log is append-only, there is no rollback — and fails the call with a simple error; ' +
        'check `events`/`state` afterward to see what was actually recorded. Returns `results[]`, one receipt ' +
        '`{seq, id, prevHash, passed, evidence, totalEvidenceItems}` per gate, in the order given; pass ' +
        '`echo: true` to also get the full `event` in each item. The registered gate Milestone never opens nor ' +
        "closes the target's cycle: evaluating `no-orphans` over a due Milestone does not make that Milestone " +
        'stop appearing in `state.orphans`.',
      inputSchema: {
        project: Name,
        process: Name,
        gates: z
          .array(
            z.object({
              gate: Name,
              target: Target,
              result: z
                .object({
                  passed: z.boolean(),
                  evidence: z.union([
                    z.string().min(1).max(EVIDENCE_ITEM_MAX_CHARS),
                    z
                      .array(z.string().min(1).max(EVIDENCE_ITEM_MAX_CHARS))
                      .min(1)
                      .max(CUSTOM_EVIDENCE_MAX),
                  ]),
                })
                .optional(),
            }),
          )
          .min(1)
          .max(20),
        agent: Agent,
        echo: z.boolean().default(false),
      },
      outputSchema: {
        results: z
          .array(
            z.object({
              seq: z.number().int().min(0),
              id: z.string(),
              prevHash: Hash,
              passed: z.boolean(),
              evidence: z.array(z.unknown()),
              totalEvidenceItems: z.number().int(),
              event: EventLine.optional(),
            }),
          )
          .min(1)
          .max(20),
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: false,
      },
    },
    async ({ project, process, gates, agent, echo }) =>
      execute(ctx, 'evaluate_gate', { project, process }, () =>
        evaluateGate(ctx, { project, process, gates, agent, echo }),
      ),
  );

  server.registerTool(
    'state',
    {
      title: 'State',
      description:
        "Projects the process's current State: active/conflicting Verdicts, orphan Milestones, events to " +
        'review, invalid references, vocabulary warnings, forked Verdicts (2+ active successors of the same ' +
        'superseded Verdict), every target a Verdict has ever used (including ones fully superseded) and the ' +
        'hash chain. `sections` filters what comes back in the response; if omitted, all of them come back. ' +
        'Each list is capped at 100 items and `totals` carries the real size of each one. `targetPrefix` ' +
        'restricts `active`, `conflicts` and `targets` to the given `hex:target:...` address or its subtree ' +
        '(`hex:target:a.b` matches `hex:target:a.b` and `hex:target:a.b.c`, not `hex:target:a.bc`); when ' +
        'informed, `totals` for those three sections counts only the matching items, before the 100-item cap. ' +
        '`withData` (default `false`) adds the winning Verdict’s `data` to each `active`-status ' +
        'item in `active`; the 24,000-character cap is measured against the whole response (all sections, ' +
        'not just `active`), so items that would push it past the cap come back without `data` and with ' +
        '`truncated: true` instead, and items that do not even fit that marker are dropped from `active` ' +
        'entirely. `activeTruncatedByBudget: true` marks that this cap (not the 100-item ' +
        '`SECTION_ITEMS_CAP`) caused the cut; retry with `withData: false` to get the full list.',
      inputSchema: {
        project: Name,
        process: Name,
        sections: z.array(Section).min(1).optional(),
        withData: z.boolean().default(false),
        targetPrefix: Target.optional(),
      },
      outputSchema: {
        logThrough: Ref.nullable(),
        now: Instant,
        totals: z.record(z.string(), z.number().int()),
        targets: z.array(z.string()).optional(),
        active: z
          .array(
            z.object({
              target: z.string(),
              claim: z.string(),
              status: z.enum(['active', 'conflict']),
              active: z.string().optional(),
              candidates: z.array(z.string()).optional(),
              data: z.record(z.string(), z.unknown()).optional(),
              truncated: z.boolean().optional(),
            }),
          )
          .optional(),
        conflicts: z
          .array(
            z.object({
              target: z.string(),
              claim: z.string(),
              candidates: z.array(z.string()),
            }),
          )
          .optional(),
        orphans: z
          .array(z.object({ milestone: z.string(), target: z.string(), dueAt: Instant }))
          .optional(),
        toReview: z.array(z.string()).optional(),
        invalidReferences: z
          .array(z.object({ citedBy: z.string(), reference: z.string() }))
          .optional(),
        warnings: z
          .array(
            z.object({
              event: z.string(),
              field: z.enum(['milestoneType', 'result', 'decisions.action']),
              value: z.string(),
              kind: z.enum(['extension', 'unknown-warning', 'error']),
              owner: z.string().nullable(),
            }),
          )
          .optional(),
        forks: z
          .array(z.object({ verdict: z.string(), successors: z.array(z.string()) }))
          .optional(),
        chain: ChainSchema.optional(),
        activeTruncatedByBudget: z.boolean().optional(),
      },
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async ({ project, process, sections, withData, targetPrefix }) =>
      execute(ctx, 'state', { project, process }, () =>
        resolveState(ctx, { project, process, sections, withData, targetPrefix }),
      ),
  );

  server.registerTool(
    'events',
    {
      title: 'Events',
      description:
        'Lists the events in a process log. Without `search`: physical order, starting from the physical ' +
        'index `since` (raw mode). With `search` (2 to 200 characters): a text index built during this call, ' +
        'over the candidates only, ordered by decreasing relevance (search mode); `combination` reports ' +
        'whether the query matched in `AND` or fell back to `OR`. Exact-equality filters, combinable with ' +
        '`search` or alone: `type`, `target` (`data.target`), `targetPrefix` (`data.target` subtree, same ' +
        'dot-boundary semantics as `state`: `hex:target:a.b` matches `hex:target:a.b.c`, not ' +
        '`hex:target:a.bc`), `milestoneType`, `result` and the `[after, before)` range of `timestamp`. Text ' +
        'search **does not find** `hex:target:<id>` addresses nor event ids; for an address, use the `target` ' +
        'or `targetPrefix` filter (there is no filter by event id). When `target` or `targetPrefix` is given, ' +
        "gate Milestones (`data.milestoneType === 'gate'`) are left out by default, unless " +
        "`includeGateMilestones: true` is set or `milestoneType: 'gate'` is requested explicitly (which " +
        'always wins over the default exclusion); without `target`/`targetPrefix`, gate Milestones are never ' +
        'excluded. A gate Milestone included this way — via `includeGateMilestones` or an explicit ' +
        "`milestoneType: 'gate'` alongside `target`/`targetPrefix` — comes back with `data.gate.criteria` " +
        'dropped and `data.gate.evaluatedThrough` reduced to `{ seq }` (or `null`); the events file on disk is ' +
        'unaffected. A page fits ' +
        '`limit` events and the 24,000-character cap, except the first event of the page, which always gets ' +
        'in even alone above the cap. `until` freezes the prefix of the file considered (physical lines with ' +
        'index < `until`); if omitted, the call uses all lines as of that moment and returns that number in ' +
        '`until`. For stable subsequent pages, resend the same `until` received and use `nextCursor` as ' +
        '`since`: without `until`, a `register` call between pages may repeat or skip items at the boundary. ' +
        '`nextCursor` is `null` at the end (physical index in raw mode; ranking position in search mode). ' +
        '`invalidLines` lists the physical indexes that are not a valid link: only this page’s in raw mode, ' +
        'the whole file’s (up to 100) in search mode.',
      inputSchema: {
        project: Name,
        process: Name,
        since: z.number().int().min(0).default(0),
        limit: z.number().int().min(1).max(200).default(50),
        type: Name.optional(),
        search: z.string().trim().min(2).max(SEARCH_MAX_CHARS).optional(),
        target: Target.optional(),
        targetPrefix: Target.optional(),
        milestoneType: Label.optional(),
        result: Label.optional(),
        after: Instant.optional(),
        before: Instant.optional(),
        until: z.number().int().min(0).optional(),
        includeGateMilestones: z.boolean().optional(),
      },
      outputSchema: {
        mode: z.enum(['raw', 'search']),
        events: z.array(EventLine.extend({ relevance: z.number().optional() })),
        combination: z.enum(['AND', 'OR']).optional(),
        until: z.number().int(),
        invalidLines: z.array(z.number().int()).max(100),
        nextCursor: z.number().int().nullable(),
      },
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async ({
      project,
      process,
      since,
      limit,
      type,
      search,
      target,
      targetPrefix,
      milestoneType,
      result,
      after,
      before,
      until,
      includeGateMilestones,
    }) => {
      let logExtra: Record<string, unknown> = {};
      return execute(
        ctx,
        'events',
        { project, process },
        () => {
          const { output, extra } = resolveEvents(ctx, {
            project,
            process,
            since,
            limit,
            type,
            search,
            target,
            targetPrefix,
            milestoneType,
            result,
            after,
            before,
            until,
            includeGateMilestones,
          });
          logExtra = extra;
          return output;
        },
        () => logExtra,
      );
    },
  );

  server.registerTool(
    'chain',
    {
      title: 'Chain',
      description:
        "Verifies the process log's hash chain: sequence, linking from the `process.json` anchor, and the " +
        'validity of `data` against each type’s fixed schema. `breaks` and `repairedLines` come capped at 100 ' +
        'items, with the real totals.',
      inputSchema: { project: Name, process: Name },
      outputSchema: ChainSchema.shape,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async ({ project, process }) =>
      execute(ctx, 'chain', { project, process }, () => resolveChain(ctx, { project, process })),
  );
}

// ---- helpers puros (montagem de lines e State) ----

/**
 * Lines de um log (§4.6: cauda sem `\n` descartada): linha que passa no envelope e cujo `data`
 * bate o schema do seu `type` (nativo ou do snapshot). As demais linhas ficam de fora.
 */
function readLines(text: string, customSchemas: Record<string, z.ZodType>): EventLine[] {
  const lines: EventLine[] = [];
  for (const lineText of text.split('\n').slice(0, -1)) {
    const line = isValidLink(lineText);
    if (isNotNil(line) && hasValidData(line, customSchemas)) lines.push(line);
  }
  return lines;
}

function hasValidData(line: EventLine, customSchemas: Record<string, z.ZodType>): boolean {
  const schema = dataSchema(line.type, line.data, customSchemas) as z.ZodType | undefined;
  return isNotNil(schema) && schema.safeParse(line.data).success;
}

/** `validateData` de `verifyChain` (§4.6): reprova `data` fora do schema fixado do seu `type`. */
function validateProcessData(
  customSchemas: Record<string, z.ZodType>,
): (type: string, data: Record<string, unknown>) => Detail[] | null {
  return (type, data) => {
    const schema = dataSchema(type, data, customSchemas) as z.ZodType | undefined;
    if (isNil(schema)) {
      return [
        {
          path: '',
          code: 'unknown_type',
          message: `type '${type}' is not fixed in the process`,
        },
      ];
    }
    const result = schema.safeParse(data);
    return result.success ? null : issueDetails(result.error.issues, '');
  };
}

/**
 * Projeta o State completo do processo (§4.8) a partir do texto atual do log. `verdictById` (P4)
 * é montado aqui, sobre as `lines` já lidas — sem I/O extra — para `resolveState` anexar `data`
 * do Verdict vigente a cada item de `active` quando `withData` for pedido.
 */
function buildState(
  process: LoadedProcess,
  text: string,
  clock: () => Date,
): State & { now: string; verdictById: Record<string, EventLine> } {
  const lines = readLines(text, process.customSchemas);
  const now = effectiveNow(clock().toISOString(), lines);
  const projection = projectState(lines, process.manifest.fixed.vocabulary, now);
  const chain = verifyChain(text, process.manifest, validateProcessData(process.customSchemas));
  const verdictById = keyBy(
    lines.filter((line) => line.type === 'verdict'),
    (line) => line.id,
  );
  return { ...projection, chain, now, verdictById };
}

// ---- register ----

type RegisterReceipt = {
  seq: number;
  id: string;
  prevHash: string;
  deduplicated: boolean;
  warnings: WarningOutput[];
  event?: EventLine;
};

/** Recibo `{seq, id, prevHash, deduplicated}` de `line`; inclui `event` completo só quando `echo` é `true`. */
function toReceipt(
  line: EventLine,
  deduplicated: boolean,
  echo: boolean,
): Omit<RegisterReceipt, 'warnings'> {
  const receipt = { seq: line.seq, id: line.id, prevHash: line.prevHash, deduplicated };
  return echo ? { ...receipt, event: line } : receipt;
}

async function registerEvent(
  ctx: Context,
  args: {
    project: string;
    process: string;
    id: string;
    agent: string;
    data: Record<string, unknown>;
    echo: boolean;
  },
): Promise<RegisterReceipt> {
  const { project, process, id, agent, data, echo } = args;
  const loaded = loadProcess(ctx.dataDir, project, process);
  const { type, uuid } = validateEventId(id, project, process);

  if (type !== 'milestone' && type !== 'verdict' && isNil(loaded.customSchemas[type])) {
    throw new HexlogError('TYPE_NOT_PINNED', `type '${type}' is not fixed in the process`);
  }
  if (type === 'milestone' && hasReservedField(data)) {
    throw new HexlogError(
      'RESERVED_FIELD',
      'milestoneType "gate" and the "gate" key are reserved for the gate Milestone of evaluate_gate',
    );
  }

  const normalized = normalizeData(type, data, loaded.customSchemas);
  const warnings = applyVocabulary(type, normalized, loaded.manifest.fixed.vocabulary);

  if (isNotNil(uuid)) {
    const existing = retryWithFullId(loaded, id, type, agent, normalized);
    return { ...toReceipt(existing, true, echo), warnings };
  }

  const line = await append(
    loaded.eventsFile,
    loaded.manifest,
    (base) => ({
      seq: base.seq,
      id: `${id}:${base.uuid}`,
      type,
      timestamp: base.timestamp,
      agent,
      prevHash: base.prevHash,
      data: normalized,
    }),
    { log: ctx.log, clock: ctx.clock },
  );
  return { ...toReceipt(line, false, echo), warnings };
}

function validateEventId(
  id: string,
  project: string,
  process: string,
): { type: string; uuid?: string } {
  const parsed = parseId(id);
  if (isNil(parsed) || parsed.project !== project || parsed.process !== process) {
    throw new HexlogError('INVALID_ID', 'invalid id for this project/process', [
      {
        path: '/id',
        code: 'invalid_id',
        message: 'id does not match the expected grammar or diverges from project/process',
      },
    ]);
  }
  return parsed;
}

function hasReservedField(data: Record<string, unknown>): boolean {
  return data.milestoneType === 'gate' || 'gate' in data;
}

/** Retentativa por id completo (§4.3): sem lock, compara `{type, agent, data}` já normalizado. */
function retryWithFullId(
  loaded: LoadedProcess,
  id: string,
  type: string,
  agent: string,
  normalized: Record<string, unknown>,
): EventLine {
  const lines = readLines(readText(loaded.eventsFile), loaded.customSchemas);
  const existing = lines.find((line) => line.id === id);
  if (isNil(existing)) {
    throw new HexlogError('UNKNOWN_ID', `id '${id}' not found`);
  }

  const sent = canonicalize({ type, agent, data: comparableData(type, normalized) }) ?? '';
  const stored =
    canonicalize({
      type: existing.type,
      agent: existing.agent,
      data: comparableData(existing.type, existing.data),
    }) ?? '';
  if (sent !== stored) {
    throw new HexlogError('CONFLICTING_ID', `id '${id}' already used with different content`);
  }

  return existing;
}

/** P5: Milestone dedupe sem levar `trace` em conta — metadado de diagnóstico, não conteúdo do evento. */
function comparableData(type: string, data: Record<string, unknown>): Record<string, unknown> {
  return type === 'milestone' ? omit(data, ['trace']) : data;
}

/** Vocabulário na escrita (§4.9): `milestoneType`/`decisions[].action` fechados (erro); `result` aberto (aviso). */
function applyVocabulary(
  type: string,
  data: Record<string, unknown>,
  vocabulary: Vocabulary,
): WarningOutput[] {
  if (type === 'verdict') return unknownResultWarning(data, vocabulary);
  if (type === 'milestone' && (data as { milestoneType: string }).milestoneType !== 'gate') {
    validateMilestoneVocabulary(data, vocabulary);
  }
  return [];
}

function validateMilestoneVocabulary(data: Record<string, unknown>, vocabulary: Vocabulary): void {
  const milestone = data as { milestoneType: string; decisions?: { action: string }[] };
  ensureVocabulary('milestoneType', milestone.milestoneType, vocabulary, '/data/milestoneType');
  milestone.decisions?.forEach((decision, index) =>
    ensureVocabulary(
      'decisions.action',
      decision.action,
      vocabulary,
      `/data/decisions/${index}/action`,
    ),
  );
}

function ensureVocabulary(
  field: VocabularyField,
  value: string,
  vocabulary: Vocabulary,
  path: string,
): void {
  if (validateField(vocabulary, field, value)?.kind !== 'error') return;
  // P2: owners fixados no processo e os termos que o campo de fato aceita, pro agente corrigir
  // sem precisar de um `list({project, process})` à parte.
  throw new HexlogError(
    'VOCABULARY_VIOLATED',
    `${field} '${value}' is outside the fixed vocabulary`,
    [
      {
        path,
        code: 'vocabulary_violated',
        message: `value '${value}' is outside the fixed vocabulary`,
        owners: Object.keys(vocabulary.byOwner),
        allowed: allowedTerms(vocabulary, field),
      },
    ],
  );
}

function unknownResultWarning(
  data: Record<string, unknown>,
  vocabulary: Vocabulary,
): WarningOutput[] {
  const result = (data as { result: string }).result;
  if (validateField(vocabulary, 'result', result)?.kind !== 'unknown-warning') return [];
  return [
    {
      code: 'UNKNOWN_VOCABULARY',
      message: `result '${result}' is outside the known vocabulary`,
      details: { field: 'result', value: result },
    },
  ];
}

// ---- evaluate_gate ----

type GateResolution =
  | { origin: 'builtin'; name: BuiltinGateName }
  | {
      origin: 'custom';
      criteria: string;
      result: { passed: boolean; evidence: string | string[] };
    };

type GateBatchItem = {
  gate: string;
  target: string;
  result?: { passed: boolean; evidence: string | string[] };
};

type GateReceipt = {
  seq: number;
  id: string;
  prevHash: string;
  passed: boolean;
  evidence: unknown[];
  totalEvidenceItems: number;
  event?: EventLine;
};

/** Recibo `{seq, id, prevHash, passed, evidence, totalEvidenceItems}` de `line`; inclui `event` completo só quando `echo` é `true`. */
function toGateReceipt(
  line: EventLine,
  evaluationResult: EvaluationResult,
  echo: boolean,
): GateReceipt {
  const receipt = {
    seq: line.seq,
    id: line.id,
    prevHash: line.prevHash,
    ...omit(evaluationResult, ['evaluatedThrough']),
  };
  return echo ? { ...receipt, event: line } : receipt;
}

async function evaluateGate(
  ctx: Context,
  args: { project: string; process: string; gates: GateBatchItem[]; agent: string; echo: boolean },
): Promise<{ results: GateReceipt[] }> {
  const { project, process, gates, agent, echo } = args;
  const loaded = loadProcess(ctx.dataDir, project, process);
  // Um único snapshot de State pro lote inteiro: todo gate embutido da mesma chamada compartilha
  // o mesmo `evaluatedThrough` (§Leva 5).
  const state = buildState(loaded, readText(loaded.eventsFile), ctx.clock);

  // Resolve e avalia todos os N gates antes de gravar (sem efeito colateral): qualquer erro aqui
  // propaga sem que o lock chegue a ser adquirido — tudo-ou-nada na validação.
  const evaluations = gates.map(({ gate, target, result }) => {
    const resolution = resolveGate(gate, result, loaded.manifest.fixed.gates);
    const { evaluationResult, criteria } =
      resolution.origin === 'builtin'
        ? {
            evaluationResult: evaluateBuiltin(resolution.name, state),
            criteria: BUILTIN_GATES[resolution.name].criteria,
          }
        : {
            evaluationResult: evaluateCustomGate(resolution.result, state.logThrough),
            criteria: resolution.criteria,
          };
    const data = buildGateMilestoneData({
      name: gate,
      origin: resolution.origin,
      criteria,
      target,
      result: evaluationResult,
    });
    return { evaluationResult, data };
  });

  const lines = await appendBatch(
    loaded.eventsFile,
    loaded.manifest,
    evaluations.map(({ data }) => (base: Base): EventLine => ({
      seq: base.seq,
      id: `${project}:${process}:milestone:${base.uuid}`,
      type: 'milestone',
      timestamp: base.timestamp,
      agent,
      prevHash: base.prevHash,
      data,
    })),
    { log: ctx.log, clock: ctx.clock },
  );

  return {
    results: lines.map((line, index) =>
      toGateReceipt(line, evaluations[index].evaluationResult, echo),
    ),
  };
}

/** §4.11: decide builtin × custom e valida a presença/ausência de `result`, antes de avaliar. */
function resolveGate(
  gate: string,
  result: { passed: boolean; evidence: string | string[] } | undefined,
  gates: Record<string, { criteria: string }>,
): GateResolution {
  if (isBuiltinGate(gate)) {
    if (isNotNil(result)) {
      throw new HexlogError(
        'INVALID_EVALUATION',
        'builtin gate does not accept a result informed by the agent',
      );
    }
    return { origin: 'builtin', name: gate };
  }

  const definition = gates[gate];
  if (isNil(definition)) {
    throw new HexlogError(
      'GATE_NOT_REGISTERED',
      `gate '${gate}' is not fixed in the process nor is it builtin`,
    );
  }
  if (isNil(result)) {
    throw new HexlogError(
      'INVALID_EVALUATION',
      'custom gate requires a result informed by the agent',
    );
  }
  return { origin: 'custom', criteria: definition.criteria, result };
}

function evaluateCustomGate(
  result: { passed: boolean; evidence: string | string[] },
  logThrough: State['logThrough'],
): EvaluationResult {
  const evidence = normalizeCustomEvidence(result.evidence);
  return {
    passed: result.passed,
    evidence,
    totalEvidenceItems: evidence.length,
    evaluatedThrough: logThrough,
  };
}

// ---- state ----

/** #10/#14: restringe `active`/`conflicts`/`targets` à subárvore de `targetPrefix`; as demais seções não são afetadas por esse filtro. */
function scopeToTargetPrefix<S extends Pick<State, 'active' | 'conflicts' | 'targets'>>(
  state: S,
  targetPrefix: string,
): S {
  return {
    ...state,
    active: state.active.filter((item) => matchesTargetPrefix(item.target, targetPrefix)),
    conflicts: state.conflicts.filter((item) => matchesTargetPrefix(item.target, targetPrefix)),
    targets: state.targets.filter((target) => matchesTargetPrefix(target, targetPrefix)),
  };
}

function resolveState(
  ctx: Context,
  {
    project,
    process,
    sections,
    withData,
    targetPrefix,
  }: {
    project: string;
    process: string;
    sections?: SectionName[];
    withData: boolean;
    targetPrefix?: string;
  },
) {
  const loaded = loadProcess(ctx.dataDir, project, process);
  const built = buildState(loaded, readText(loaded.eventsFile), ctx.clock);
  const state = isNil(targetPrefix) ? built : scopeToTargetPrefix(built, targetPrefix);
  const included = new Set(sections ?? ALL_SECTIONS);

  // #10/#13: `targets` agora é uma seção comum de LIST_SECTIONS — totals já reflete o pós-filtro
  // de targetPrefix (feito acima, antes do cap) para as três seções que ele restringe.
  const totals = Object.fromEntries(
    LIST_SECTIONS.map((section) => [section, state[section].length]),
  );
  const activeItems = state.active.slice(0, SECTION_ITEMS_CAP);
  const lists = Object.fromEntries(
    LIST_SECTIONS.filter((section) => included.has(section)).map((section) => [
      section,
      section === 'active' ? activeItems : state[section].slice(0, SECTION_ITEMS_CAP),
    ]),
  );

  const response = {
    logThrough: state.logThrough,
    now: state.now,
    totals,
    ...lists,
    ...(included.has('chain') ? { chain: state.chain } : {}),
  };
  if (!withData || !included.has('active')) return response;

  // #11: o orçamento é medido contra o tamanho real da resposta inteira (targets, chain, totals
  // etc. inclusos), não só o array `active` isolado — ver attachVerdictData. `activeTruncatedByBudget`
  // entra no cálculo do próprio `baseSize` (com o placeholder `false`, o literal mais longo) porque
  // esse campo também soma bytes à resposta final e senão poderia empurrá-la além do teto sozinho.
  const baseSize = JSON.stringify({ ...response, activeTruncatedByBudget: false }).length;
  const { active, truncatedByBudget } = attachVerdictData(activeItems, state.verdictById, baseSize);
  return { ...response, active, activeTruncatedByBudget: truncatedByBudget };
}

/**
 * P4/#11: com `withData`, anexa a `data` do Verdict vigente a cada item de status `active` (itens
 * de `conflict`, sem vigente único, passam sem `data`). `baseSize` é o tamanho real da resposta
 * inteira antes desta função rodar (calculado por `resolveState`); cada item soma só o incremento
 * marginal de anexar `data` ou o marcador `truncated: true` contra o item puro já contado em
 * `baseSize` — nunca o tamanho do item inteiro, que dobraria a conta. Quando nem o incremento do
 * marcador cabe, esse item e os seguintes saem do array devolvido (o gap contra `totals.active`
 * sinaliza o corte).
 */
function attachVerdictData(
  items: State['active'],
  verdictById: Record<string, EventLine>,
  baseSize: number,
): {
  active: (State['active'][number] & { data?: unknown; truncated?: boolean })[];
  truncatedByBudget: boolean;
} {
  let size = baseSize;
  let truncatedByBudget = false;
  const active: (State['active'][number] & { data?: unknown; truncated?: boolean })[] = [];

  for (const item of items) {
    const pureLength = JSON.stringify(item).length;

    const withField =
      item.status === 'active' ? { ...item, data: verdictById[item.active]?.data } : item;
    const dataIncrement = JSON.stringify(withField).length - pureLength;
    if (size + dataIncrement <= PAGE_CHARS_CAP) {
      size += dataIncrement;
      active.push(withField);
      continue;
    }

    const truncatedItem = { ...item, truncated: true };
    const truncatedIncrement = JSON.stringify(truncatedItem).length - pureLength;
    if (size + truncatedIncrement <= PAGE_CHARS_CAP) {
      size += truncatedIncrement;
      active.push(truncatedItem);
      truncatedByBudget = true;
      continue;
    }

    truncatedByBudget = true;
    break;
  }

  return { active, truncatedByBudget };
}

// ---- events ----

type ResultLine = EventLine & { relevance?: number };

type EventsOutput = {
  mode: 'raw' | 'search';
  events: ResultLine[];
  combination?: 'AND' | 'OR';
  until: number;
  invalidLines: number[];
  nextCursor: number | null;
};

type EventsArgs = {
  project: string;
  process: string;
  since: number;
  limit: number;
  type?: string;
  search?: string;
  target?: string;
  targetPrefix?: string;
  milestoneType?: string;
  result?: string;
  after?: string;
  before?: string;
  until?: number;
  includeGateMilestones?: boolean;
};

function resolveEvents(
  ctx: Context,
  args: EventsArgs,
): { output: EventsOutput; extra: Record<string, unknown> } {
  const {
    project,
    process,
    since,
    limit,
    type,
    search,
    target,
    targetPrefix,
    milestoneType,
    result,
    until,
    includeGateMilestones,
  } = args;
  const loaded = loadProcess(ctx.dataDir, project, process);

  validateFilterMilestoneType(milestoneType, loaded.manifest.fixed.vocabulary);
  const after = normalizeInstant(args.after);
  const before = normalizeInstant(args.before);
  validateRange(after, before);

  const physicalLines = readText(loaded.eventsFile).split('\n').slice(0, -1);
  validateUntil(until, physicalLines.length);
  const untilLimit = until ?? physicalLines.length;

  const filters: Filters = {
    type,
    target,
    targetPrefix,
    milestoneType,
    result,
    after,
    before,
    includeGateMilestones,
  };

  return isNil(search)
    ? resolveRawMode(physicalLines, untilLimit, since, limit, filters)
    : resolveSearchMode(physicalLines, untilLimit, since, limit, filters, search);
}

/** `milestoneType` fora de core ∪ extensões e ≠ `"gate"` (sempre aceito) → `INVALID_FILTER` (§4.12 item 9). */
function validateFilterMilestoneType(
  milestoneType: string | undefined,
  vocabulary: Vocabulary,
): void {
  if (isNil(milestoneType) || milestoneType === 'gate') return;
  if (validateField(vocabulary, 'milestoneType', milestoneType)?.kind === 'error') {
    throw new HexlogError(
      'INVALID_FILTER',
      `milestoneType '${milestoneType}' is outside the fixed vocabulary`,
      [
        {
          path: '/milestoneType',
          code: 'outside_vocabulary',
          message: `value '${milestoneType}' is outside the fixed vocabulary`,
        },
      ],
    );
  }
}

/** `z.iso.datetime()` aceita entrada sem milissegundos; normaliza pra largura fixa antes de comparar. */
function normalizeInstant(v: string | undefined): string | undefined {
  return isNil(v) ? undefined : new Date(v).toISOString();
}

function validateRange(after: string | undefined, before: string | undefined): void {
  if (isNil(after) || isNil(before) || after < before) return;
  throw new HexlogError('INVALID_FILTER', 'after must be earlier than before', [
    {
      path: '/after',
      code: 'invalid_range',
      message: `after (${after}) is not earlier than before (${before})`,
    },
  ]);
}

/** `until` além do fim do arquivo: o log tem menos linhas do que a página anterior viu. */
function validateUntil(until: number | undefined, totalPhysicalLines: number): void {
  if (isNil(until) || until <= totalPhysicalLines) return;
  throw new HexlogError(
    'INVALID_FILTER',
    `until (${until}) is greater than the number of lines in the file`,
    [
      {
        path: '/until',
        code: 'until_past_end_of_file',
        message: `until (${until}) is greater than ${totalPhysicalLines} physical lines`,
      },
    ],
  );
}

/**
 * Corta `criteria` e reduz `evaluatedThrough` a `{ seq }` (ou `null`) no Milestone de gate devolvido
 * por `events` (achado #19, Leva 6): só na serialização da resposta, nunca no formato em disco.
 */
function compactGateMilestone(line: EventLine): EventLine {
  if (!isMilestoneGate(line)) return line;
  const data = line.data as GateMilestoneData;
  const { evaluatedThrough } = data.gate;
  return {
    ...line,
    data: {
      ...data,
      gate: {
        ...omit(data.gate, ['criteria']),
        evaluatedThrough: isNil(evaluatedThrough) ? null : { seq: evaluatedThrough.seq },
      },
    },
  };
}

/**
 * Modo raw: ordem física a partir de `since`, streaming (sem escanear além de onde a página para).
 * `candidates` do log conta só os elos vistos durante essa varredura, não o total no arquivo inteiro
 * (decisão de projeto: evitar forçar leitura completa do arquivo numa chamada sem `search`).
 */
function resolveRawMode(
  physicalLines: string[],
  untilLimit: number,
  since: number,
  limit: number,
  filters: Filters,
): { output: EventsOutput; extra: Record<string, unknown> } {
  const events: EventLine[] = [];
  const invalidLines: number[] = [];
  const compactGates = hasTargetFilter(filters);
  let candidates = 0;
  let nextCursor: number | null = null;
  let size = 2; // '[]'

  for (let index = since; index < untilLimit; index++) {
    const rawLine = isValidLink(physicalLines[index]);
    if (isNil(rawLine)) {
      invalidLines.push(index);
      continue;
    }
    if (!isCandidate(rawLine, filters)) continue;
    candidates++;
    const line = compactGates ? compactGateMilestone(rawLine) : rawLine;

    const increment = JSON.stringify(line).length + (events.length > 0 ? 1 : 0);
    if (events.length > 0 && size + increment > PAGE_CHARS_CAP) {
      nextCursor = index;
      break;
    }

    size += increment;
    events.push(line);
    if (events.length >= limit) {
      nextCursor = index + 1 < untilLimit ? index + 1 : null;
      break;
    }
  }

  return {
    output: {
      mode: 'raw',
      events,
      until: untilLimit,
      invalidLines: invalidLines.slice(0, 100),
      nextCursor,
    },
    extra: { mode: 'raw', candidates },
  };
}

/** Candidatos e linhas inválidas do **arquivo inteiro** (§4.17): base do índice de texto do modo search. */
function fileCandidates(
  physicalLines: string[],
  untilLimit: number,
  filters: Filters,
): { candidates: { index: number; line: EventLine }[]; invalidLines: number[] } {
  const candidates: { index: number; line: EventLine }[] = [];
  const invalidLines: number[] = [];

  physicalLines.forEach((lineText, index) => {
    const line = isValidLink(lineText);
    if (isNil(line)) {
      invalidLines.push(index);
      return;
    }
    if (index < untilLimit && isCandidate(line, filters)) {
      candidates.push({ index, line });
    }
  });

  return { candidates, invalidLines };
}

/** Modo search (§4.12 item 9 e §4.17): índice construído nesta chamada, `since`/`nextCursor` no ranking. */
function resolveSearchMode(
  physicalLines: string[],
  untilLimit: number,
  since: number,
  limit: number,
  filters: Filters,
  query: string,
): { output: EventsOutput; extra: Record<string, unknown> } {
  const indexStart = Date.now();
  const { candidates, invalidLines } = fileCandidates(physicalLines, untilLimit, filters);
  const { results, combination } = runSearch(candidates, query);
  const indexMs = Date.now() - indexStart;

  const lineByIndex = new Map(candidates.map((c) => [c.index, c.line]));
  const page = results.slice(since);
  const compactGates = hasTargetFilter(filters);

  const events: ResultLine[] = [];
  let nextCursor: number | null = null;
  let size = 2; // '[]'

  for (let position = 0; position < page.length; position++) {
    const item = page[position];
    const line = lineByIndex.get(item.index)!;
    const event: ResultLine = {
      ...(compactGates ? compactGateMilestone(line) : line),
      relevance: item.relevance,
    };
    const increment = JSON.stringify(event).length + (events.length > 0 ? 1 : 0);

    if (events.length > 0 && size + increment > PAGE_CHARS_CAP) {
      nextCursor = since + position;
      break;
    }

    size += increment;
    events.push(event);
    if (events.length >= limit) {
      nextCursor = since + position + 1 < results.length ? since + position + 1 : null;
      break;
    }
  }

  return {
    output: {
      mode: 'search',
      events,
      combination,
      until: untilLimit,
      invalidLines: invalidLines.slice(0, 100),
      nextCursor,
    },
    extra: {
      mode: 'search',
      candidates: candidates.length,
      indexMs,
      combination,
    },
  };
}

// ---- chain ----

function resolveChain(
  ctx: Context,
  { project, process }: { project: string; process: string },
): Chain {
  const loaded = loadProcess(ctx.dataDir, project, process);
  const text = readText(loaded.eventsFile);
  return verifyChain(text, loaded.manifest, validateProcessData(loaded.customSchemas));
}
