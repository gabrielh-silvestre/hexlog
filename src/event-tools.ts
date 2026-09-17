import type { McpServer } from '@modelcontextprotocol/server';
import canonicalize from 'canonicalize';
import { isNil, isNotNil, omit } from 'es-toolkit';
import { z } from 'zod';
import { search as runSearch, isCandidate, SEARCH_MAX_CHARS, type Filters } from './search.ts';
import { isValidLink, verifyChain, type Chain } from './chain.ts';
import { loadProcess, type LoadedProcess } from './definitions.ts';
import { issueDetails, HexlogError, type Detail } from './errors.ts';
import { parseId, Target, dataSchema, EventLine, normalizeData, Label } from './events.ts';
import {
  effectiveNow,
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
} from './gates.ts';
import { append, readText } from './log.ts';
import {
  Agent,
  Aviso as AvisoSchema,
  Cadeia as CadeiaSchema,
  type Contexto,
  executar,
  Instant,
  Name,
  Ref,
  Secao,
  TETO_ITENS_SECAO,
  TETO_PAGINA_CHARS,
} from './mcp.ts';

type AvisoSaida = z.infer<typeof AvisoSchema>;
type NomeSecao = z.infer<typeof Secao>;

/** Mapeamento de nome de seção (ainda pt-BR: `Secao`, mcp.ts, Fase 4) para o campo já
 *  traduzido de `State`/`Projection` (Fase 3). */
const SECTION_FIELDS = {
  vigentes: 'active',
  conflitos: 'conflicts',
  orfaos: 'orphans',
  aRevisar: 'toReview',
  referenciasInvalidas: 'invalidReferences',
  avisos: 'warnings',
} as const satisfies Record<
  string,
  'active' | 'conflicts' | 'orphans' | 'toReview' | 'invalidReferences' | 'warnings'
>;
const ALL_SECTIONS: NomeSecao[] = [...(Object.keys(SECTION_FIELDS) as NomeSecao[]), 'cadeia'];

/** Registra as 5 tools de eventos (`registrar`, `avaliar_gate`, `estado`, `eventos`, `cadeia`). */
export function registrarFerramentasEventos(servidor: McpServer, ctx: Contexto): void {
  servidor.registerTool(
    'registrar',
    {
      title: 'Registrar evento',
      description:
        'Registra um evento (Milestone, Verdict ou tipo custom fixado) no processo. `id` pode ser um **prefixo** ' +
        '`{project}:{process}:{type}` (o servidor gera um uuid v7 novo e faz append) ou um **id completo** ' +
        '`{project}:{process}:{type}:{uuid}` devolvido por uma chamada anterior: retentativa idempotente, mesmo ' +
        '`type`/`agent`/`data` normalizados devolve a linha existente com `deduplicated: true`; conteúdo diferente ' +
        'é `CONFLICTING_ID`. Milestone aceita `milestoneType`, `target` (`hex:target:<id>`), `count`, `dueAt` e ' +
        '`decisions[]`; Verdict aceita `claim`, `source`, `result`, `evidence`, `target` (`hex:target:<id>`), ' +
        '`supersedes[]`, `origin` e `trace`. `milestoneType: "gate"` e a chave `gate` são reservados ao Milestone ' +
        'gerado por `avaliar_gate`.',
      inputSchema: {
        project: Name,
        process: Name,
        id: z.string().min(1).max(260),
        agent: Agent,
        data: z.record(z.string(), z.unknown()),
      },
      outputSchema: { event: EventLine, deduplicated: z.boolean(), warnings: z.array(AvisoSchema) },
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: false,
      },
    },
    async ({ project, process, id, agent, data }) =>
      executar(ctx, 'registrar', { projeto: project, processo: process }, () =>
        registrar(ctx, { project, process, id, agent, data }),
      ),
  );

  servidor.registerTool(
    'avaliar_gate',
    {
      title: 'Avaliar gate',
      description:
        'Avalia um gate contra `target` e grava o resultado como um Milestone de gate. Gate embutido (`no-orphans`, ' +
        '`no-conflicts`, `chain-intact`, `no-invalid-references`) não aceita `result`: é calculado a partir do ' +
        'State atual do processo. Gate custom, fixado no processo, exige `result: {passed, evidence}`. O Milestone ' +
        'de gate registrado nunca abre nem fecha o ciclo do target: avaliar `no-orphans` sobre um Milestone vencido ' +
        'não faz esse Milestone deixar de aparecer em `state.orphans`.',
      inputSchema: {
        project: Name,
        process: Name,
        gate: Name,
        agent: Agent,
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
      },
      outputSchema: {
        event: EventLine,
        passed: z.boolean(),
        evidence: z.array(z.unknown()),
        totalEvidenceItems: z.number().int(),
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: false,
      },
    },
    async ({ project, process, gate, agent, target, result }) =>
      executar(ctx, 'avaliar_gate', { projeto: project, processo: process }, () =>
        avaliarGate(ctx, { project, process, gate, agent, target, result }),
      ),
  );

  servidor.registerTool(
    'estado',
    {
      title: 'Estado',
      description:
        'Projeta o State atual do processo: vigentes/conflitos de Verdict, Milestones órfãos, eventos a revisar, ' +
        'referências inválidas, avisos de vocabulário e a cadeia de hash. `sections` filtra o que volta na resposta; ' +
        'sem informar, todas voltam. Cada lista é cortada em 100 itens e `totais` traz o tamanho real de cada uma.',
      inputSchema: { project: Name, process: Name, sections: z.array(Secao).min(1).optional() },
      outputSchema: {
        logAte: Ref.nullable(),
        agora: Instant,
        totais: z.record(z.string(), z.number().int()),
        vigentes: z
          .array(
            z.object({
              target: z.string(),
              claim: z.string(),
              status: z.enum(['active', 'conflict']),
              active: z.string().optional(),
              candidates: z.array(z.string()).optional(),
            }),
          )
          .optional(),
        conflitos: z
          .array(
            z.object({
              target: z.string(),
              claim: z.string(),
              candidates: z.array(z.string()),
            }),
          )
          .optional(),
        orfaos: z
          .array(z.object({ milestone: z.string(), target: z.string(), dueAt: Instant }))
          .optional(),
        aRevisar: z.array(z.string()).optional(),
        referenciasInvalidas: z
          .array(z.object({ citedBy: z.string(), reference: z.string() }))
          .optional(),
        avisos: z
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
        cadeia: CadeiaSchema.optional(),
      },
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async ({ project, process, sections }) =>
      executar(ctx, 'estado', { projeto: project, processo: process }, () =>
        resolverEstado(ctx, { project, process, sections }),
      ),
  );

  servidor.registerTool(
    'eventos',
    {
      title: 'Eventos',
      description:
        'Lista os eventos do log de um processo. Sem `search`: ordem física, a partir do índice físico `since` ' +
        '(modo raw). Com `search` (2 a 200 caracteres): índice de texto construído nesta chamada só sobre os ' +
        'candidatos, ordenado por relevância decrescente (modo search); `combination` informa se a consulta casou ' +
        'em `AND` ou caiu no fallback `OR`. Filtros por igualdade exata, combináveis com `search` ou sozinhos: ' +
        '`type`, `target` (`data.target`), `milestoneType`, `result` e o intervalo `[after, before)` de ' +
        '`timestamp`. A busca textual **não encontra** endereços `hex:target:<id>` nem ids de evento; para ' +
        'endereço, use o filtro `target` (não há filtro por id de evento). Uma página cabe em `limit` eventos e no ' +
        'teto de 24 000 caracteres, exceto o primeiro evento da página, que sempre entra mesmo sozinho acima do ' +
        'teto. `until` congela o prefixo do arquivo considerado (linhas físicas de índice < `until`); sem informar, ' +
        'a chamada usa todas as linhas do momento e devolve esse número em `until`. Para páginas seguintes ' +
        'estáveis, reenvie o mesmo `until` recebido e use `nextCursor` como `since`: sem `until`, um `registrar` ' +
        'entre páginas pode repetir ou omitir itens na fronteira. `nextCursor` é `null` no fim (índice físico no ' +
        'modo raw; posição no ranking no modo search). `invalidLines` lista os índices físicos que não são um elo ' +
        'válido: só desta página no modo raw, do arquivo inteiro (até 100) no modo search.',
      inputSchema: {
        project: Name,
        process: Name,
        since: z.number().int().min(0).default(0),
        limit: z.number().int().min(1).max(200).default(50),
        type: Name.optional(),
        search: z.string().trim().min(2).max(SEARCH_MAX_CHARS).optional(),
        target: Target.optional(),
        milestoneType: Label.optional(),
        result: Label.optional(),
        after: Instant.optional(),
        before: Instant.optional(),
        until: z.number().int().min(0).optional(),
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
      milestoneType,
      result,
      after,
      before,
      until,
    }) => {
      let logExtra: Record<string, unknown> = {};
      return executar(
        ctx,
        'eventos',
        { projeto: project, processo: process },
        () => {
          const { saida, extra } = resolverEventos(ctx, {
            project,
            process,
            since,
            limit,
            type,
            search,
            target,
            milestoneType,
            result,
            after,
            before,
            until,
          });
          logExtra = extra;
          return saida;
        },
        () => logExtra,
      );
    },
  );

  servidor.registerTool(
    'cadeia',
    {
      title: 'Cadeia',
      description:
        'Verifica a cadeia de hash do log do processo: sequência, encadeamento a partir da âncora de ' +
        '`process.json` e a validade de `data` contra o schema fixado de cada tipo. `quebras` e ' +
        '`linhasReparadas` vêm cortadas em 100 itens, com os totais reais.',
      inputSchema: { project: Name, process: Name },
      outputSchema: CadeiaSchema.shape,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async ({ project, process }) =>
      executar(ctx, 'cadeia', { projeto: project, processo: process }, () =>
        resolverCadeia(ctx, { project, process }),
      ),
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

/** Projeta o State completo do processo (§4.8) a partir do texto atual do log. */
function montarEstado(
  process: LoadedProcess,
  text: string,
  clock: () => Date,
): State & { now: string } {
  const lines = readLines(text, process.customSchemas);
  const now = effectiveNow(clock().toISOString(), lines);
  const projection = projectState(lines, process.manifest.fixed.vocabulary, now);
  const chain = verifyChain(text, process.manifest, validateProcessData(process.customSchemas));
  return { ...projection, chain, now };
}

// ---- registrar ----

async function registrar(
  ctx: Contexto,
  args: {
    project: string;
    process: string;
    id: string;
    agent: string;
    data: Record<string, unknown>;
  },
): Promise<{ event: EventLine; deduplicated: boolean; warnings: AvisoSaida[] }> {
  const { project, process, id, agent, data } = args;
  const loaded = loadProcess(ctx.dirDados, project, process);
  const { type, uuid } = validarIdDoEvento(id, project, process);

  if (type !== 'milestone' && type !== 'verdict' && isNil(loaded.customSchemas[type])) {
    throw new HexlogError('TYPE_NOT_PINNED', `type '${type}' is not fixed in the process`);
  }
  if (type === 'milestone' && temCampoReservado(data)) {
    throw new HexlogError(
      'RESERVED_FIELD',
      'milestoneType "gate" and the "gate" key are reserved for the gate Milestone of avaliar_gate',
    );
  }

  const normalized = normalizeData(type, data, loaded.customSchemas);
  const warnings = aplicarVocabulario(type, normalized, loaded.manifest.fixed.vocabulary);

  if (isNotNil(uuid)) {
    return { ...retentarComIdCompleto(loaded, id, type, agent, normalized), warnings };
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
    { log: ctx.log, clock: ctx.relogio },
  );
  return { event: line, deduplicated: false, warnings };
}

function validarIdDoEvento(
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

function temCampoReservado(data: Record<string, unknown>): boolean {
  return data.milestoneType === 'gate' || 'gate' in data;
}

/** Retentativa por id completo (§4.3): sem lock, compara `{type, agent, data}` já normalizado. */
function retentarComIdCompleto(
  loaded: LoadedProcess,
  id: string,
  type: string,
  agent: string,
  normalized: Record<string, unknown>,
): { event: EventLine; deduplicated: true } {
  const lines = readLines(readText(loaded.eventsFile), loaded.customSchemas);
  const existing = lines.find((line) => line.id === id);
  if (isNil(existing)) {
    throw new HexlogError('UNKNOWN_ID', `id '${id}' not found`);
  }

  const sent = canonicalize({ type, agent, data: normalized }) ?? '';
  const stored =
    canonicalize({ type: existing.type, agent: existing.agent, data: existing.data }) ?? '';
  if (sent !== stored) {
    throw new HexlogError('CONFLICTING_ID', `id '${id}' already used with different content`);
  }

  return { event: existing, deduplicated: true };
}

/** Vocabulário na escrita (§4.9): `milestoneType`/`decisions[].action` fechados (erro); `result` aberto (aviso). */
function aplicarVocabulario(
  type: string,
  data: Record<string, unknown>,
  vocabulary: Vocabulary,
): AvisoSaida[] {
  if (type === 'verdict') return avisoResultadoDesconhecido(data, vocabulary);
  if (type === 'milestone' && (data as { milestoneType: string }).milestoneType !== 'gate') {
    validarVocabularioMarco(data, vocabulary);
  }
  return [];
}

function validarVocabularioMarco(data: Record<string, unknown>, vocabulary: Vocabulary): void {
  const milestone = data as { milestoneType: string; decisions?: { action: string }[] };
  garantirVocabulario('milestoneType', milestone.milestoneType, vocabulary, '/data/milestoneType');
  milestone.decisions?.forEach((decision, index) =>
    garantirVocabulario(
      'decisions.action',
      decision.action,
      vocabulary,
      `/data/decisions/${index}/action`,
    ),
  );
}

function garantirVocabulario(
  field: VocabularyField,
  value: string,
  vocabulary: Vocabulary,
  path: string,
): void {
  if (validateField(vocabulary, field, value)?.kind === 'error') {
    throw new HexlogError(
      'VOCABULARY_VIOLATED',
      `${field} '${value}' is outside the fixed vocabulary`,
      [
        {
          path,
          code: 'vocabulary_violated',
          message: `value '${value}' is outside the fixed vocabulary`,
        },
      ],
    );
  }
}

function avisoResultadoDesconhecido(
  data: Record<string, unknown>,
  vocabulary: Vocabulary,
): AvisoSaida[] {
  const result = (data as { result: string }).result;
  if (validateField(vocabulary, 'result', result)?.kind !== 'unknown-warning') return [];
  return [
    {
      codigo: 'UNKNOWN_VOCABULARY',
      mensagem: `result '${result}' is outside the known vocabulary`,
      detalhes: { field: 'result', value: result },
    },
  ];
}

// ---- avaliar_gate ----

type ResolucaoGate =
  | { origin: 'builtin'; name: BuiltinGateName }
  | {
      origin: 'custom';
      criteria: string;
      result: { passed: boolean; evidence: string | string[] };
    };

async function avaliarGate(
  ctx: Contexto,
  args: {
    project: string;
    process: string;
    gate: string;
    agent: string;
    target: string;
    result?: { passed: boolean; evidence: string | string[] };
  },
): Promise<{ event: EventLine; passed: boolean; evidence: unknown[]; totalEvidenceItems: number }> {
  const { project, process, gate, agent, target, result } = args;
  const loaded = loadProcess(ctx.dirDados, project, process);
  const resolution = resolverGate(gate, result, loaded.manifest.fixed.gates);
  const state = montarEstado(loaded, readText(loaded.eventsFile), ctx.relogio);

  const { evaluationResult, criteria } =
    resolution.origin === 'builtin'
      ? {
          evaluationResult: evaluateBuiltin(resolution.name, state),
          criteria: BUILTIN_GATES[resolution.name].criteria,
        }
      : {
          evaluationResult: avaliarGateCustom(resolution.result, state.logThrough),
          criteria: resolution.criteria,
        };

  const data = buildGateMilestoneData({
    name: gate,
    origin: resolution.origin,
    criteria,
    target,
    result: evaluationResult,
  });
  const line = await append(
    loaded.eventsFile,
    loaded.manifest,
    (base) => ({
      seq: base.seq,
      id: `${project}:${process}:milestone:${base.uuid}`,
      type: 'milestone',
      timestamp: base.timestamp,
      agent,
      prevHash: base.prevHash,
      data,
    }),
    { log: ctx.log, clock: ctx.relogio },
  );

  return { event: line, ...omit(evaluationResult, ['evaluatedThrough']) };
}

/** §4.11: decide builtin × custom e valida a presença/ausência de `result`, antes de avaliar. */
function resolverGate(
  gate: string,
  result: { passed: boolean; evidence: string | string[] } | undefined,
  gates: Record<string, { criteria: string }>,
): ResolucaoGate {
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

function avaliarGateCustom(
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

// ---- estado ----

function resolverEstado(
  ctx: Contexto,
  { project, process, sections }: { project: string; process: string; sections?: NomeSecao[] },
) {
  const loaded = loadProcess(ctx.dirDados, project, process);
  const state = montarEstado(loaded, readText(loaded.eventsFile), ctx.relogio);
  const included = new Set(sections ?? ALL_SECTIONS);

  const totais = Object.fromEntries(
    Object.entries(SECTION_FIELDS).map(([secao, campo]) => [secao, state[campo].length]),
  );
  const listas = Object.fromEntries(
    Object.entries(SECTION_FIELDS)
      .filter(([secao]) => included.has(secao as NomeSecao))
      .map(([secao, campo]) => [secao, state[campo].slice(0, TETO_ITENS_SECAO)]),
  );

  return {
    logAte: state.logThrough,
    agora: state.now,
    totais,
    ...listas,
    ...(included.has('cadeia') ? { cadeia: state.chain } : {}),
  };
}

// ---- eventos ----

type LinhaResultado = EventLine & { relevance?: number };

type SaidaEventos = {
  mode: 'raw' | 'search';
  events: LinhaResultado[];
  combination?: 'AND' | 'OR';
  until: number;
  invalidLines: number[];
  nextCursor: number | null;
};

type ArgsEventos = {
  project: string;
  process: string;
  since: number;
  limit: number;
  type?: string;
  search?: string;
  target?: string;
  milestoneType?: string;
  result?: string;
  after?: string;
  before?: string;
  until?: number;
};

function resolverEventos(
  ctx: Contexto,
  args: ArgsEventos,
): { saida: SaidaEventos; extra: Record<string, unknown> } {
  const { project, process, since, limit, type, search, target, milestoneType, result, until } =
    args;
  const loaded = loadProcess(ctx.dirDados, project, process);

  validarMarcoTipoDoFiltro(milestoneType, loaded.manifest.fixed.vocabulary);
  const after = normalizarInstante(args.after);
  const before = normalizarInstante(args.before);
  validarIntervalo(after, before);

  const linhasFisicas = readText(loaded.eventsFile).split('\n').slice(0, -1);
  validarUntil(until, linhasFisicas.length);
  const untilLimit = until ?? linhasFisicas.length;

  const filters: Filters = { type, target, milestoneType, result, after, before };

  return isNil(search)
    ? resolverModoCru(linhasFisicas, untilLimit, since, limit, filters)
    : resolverModoBusca(linhasFisicas, untilLimit, since, limit, filters, search);
}

/** `milestoneType` fora de core ∪ extensões e ≠ `"gate"` (sempre aceito) → `INVALID_FILTER` (§4.12 item 9). */
function validarMarcoTipoDoFiltro(milestoneType: string | undefined, vocabulary: Vocabulary): void {
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
function normalizarInstante(v: string | undefined): string | undefined {
  return isNil(v) ? undefined : new Date(v).toISOString();
}

function validarIntervalo(after: string | undefined, before: string | undefined): void {
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
function validarUntil(until: number | undefined, totalLinhasFisicas: number): void {
  if (isNil(until) || until <= totalLinhasFisicas) return;
  throw new HexlogError(
    'INVALID_FILTER',
    `until (${until}) is greater than the number of lines in the file`,
    [
      {
        path: '/until',
        code: 'until_past_end_of_file',
        message: `until (${until}) is greater than ${totalLinhasFisicas} physical lines`,
      },
    ],
  );
}

/**
 * Modo raw: ordem física a partir de `since`, streaming (sem escanear além de onde a página para).
 * `candidates` do log conta só os elos vistos durante essa varredura, não o total no arquivo inteiro
 * (decisão de projeto: evitar forçar leitura completa do arquivo numa chamada sem `search`).
 */
function resolverModoCru(
  linhasFisicas: string[],
  untilLimit: number,
  since: number,
  limit: number,
  filters: Filters,
): { saida: SaidaEventos; extra: Record<string, unknown> } {
  const events: EventLine[] = [];
  const invalidLines: number[] = [];
  let candidates = 0;
  let nextCursor: number | null = null;
  let size = 2; // '[]'

  for (let index = since; index < untilLimit; index++) {
    const line = isValidLink(linhasFisicas[index]);
    if (isNil(line)) {
      invalidLines.push(index);
      continue;
    }
    if (!isCandidate(line, filters)) continue;
    candidates++;

    const increment = JSON.stringify(line).length + (events.length > 0 ? 1 : 0);
    if (events.length > 0 && size + increment > TETO_PAGINA_CHARS) {
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
    saida: {
      mode: 'raw',
      events,
      until: untilLimit,
      invalidLines: invalidLines.slice(0, 100),
      nextCursor,
    },
    extra: { modo: 'raw', candidatos: candidates },
  };
}

/** Candidatos e linhas inválidas do **arquivo inteiro** (§4.17): base do índice de texto do modo search. */
function candidatosDoArquivo(
  linhasFisicas: string[],
  untilLimit: number,
  filters: Filters,
): { candidates: { index: number; line: EventLine }[]; invalidLines: number[] } {
  const candidates: { index: number; line: EventLine }[] = [];
  const invalidLines: number[] = [];

  linhasFisicas.forEach((lineText, index) => {
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
function resolverModoBusca(
  linhasFisicas: string[],
  untilLimit: number,
  since: number,
  limit: number,
  filters: Filters,
  query: string,
): { saida: SaidaEventos; extra: Record<string, unknown> } {
  const indexStart = Date.now();
  const { candidates, invalidLines } = candidatosDoArquivo(linhasFisicas, untilLimit, filters);
  const { results, combination } = runSearch(candidates, query);
  const indexMs = Date.now() - indexStart;

  const lineByIndex = new Map(candidates.map((c) => [c.index, c.line]));
  const page = results.slice(since);

  const events: LinhaResultado[] = [];
  let nextCursor: number | null = null;
  let size = 2; // '[]'

  for (let position = 0; position < page.length; position++) {
    const item = page[position];
    const event: LinhaResultado = {
      ...lineByIndex.get(item.index)!,
      relevance: item.relevance,
    };
    const increment = JSON.stringify(event).length + (events.length > 0 ? 1 : 0);

    if (events.length > 0 && size + increment > TETO_PAGINA_CHARS) {
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
    saida: {
      mode: 'search',
      events,
      combination,
      until: untilLimit,
      invalidLines: invalidLines.slice(0, 100),
      nextCursor,
    },
    extra: {
      modo: 'search',
      candidatos: candidates.length,
      msIndice: indexMs,
      combinacao: combination,
    },
  };
}

// ---- cadeia ----

function resolverCadeia(
  ctx: Contexto,
  { project, process }: { project: string; process: string },
): Chain {
  const loaded = loadProcess(ctx.dirDados, project, process);
  const text = readText(loaded.eventsFile);
  return verifyChain(text, loaded.manifest, validateProcessData(loaded.customSchemas));
}
