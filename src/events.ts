import canonicalize from 'canonicalize';
import { isNil } from 'es-toolkit';
import { get } from 'es-toolkit/compat';
import { z } from 'zod';
import { issueDetails, HexlogError } from './errors.ts';

// §4.2: regex única de nome para project, process, type, gate e owner.
const NAME_SRC = '[a-z0-9][a-z0-9-]{0,62}';
const NAME_RE = new RegExp(`^${NAME_SRC}$`);
export const Name = z.string().regex(NAME_RE);

// §4.3: prefixo do id (sem uuid) × id completo (com uuid v7).
const UUID_V7_SRC = '[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}';
const ID_RE = new RegExp(`^(${NAME_SRC}):(${NAME_SRC}):(${NAME_SRC})(?::(${UUID_V7_SRC}))?$`);
export const FULL_ID_RE = new RegExp(
  `^(${NAME_SRC}):(${NAME_SRC}):(${NAME_SRC}):(${UUID_V7_SRC})$`,
);

export const Hash = z.string().regex(/^[0-9a-f]{64}$/);
export const Instant = z.iso.datetime();
export const Agent = z.string().min(1).max(100);
export const Label = z.string().min(1).max(200);
export const Text = z.string().min(1).max(4000);
const FullId = z.string().regex(FULL_ID_RE);

// Endereço de alvo: só o serviço 'target' (§4.3), sem espaço nem ':' no id.
export const Target = z
  .string()
  .max(200)
  .regex(/^hex:target:[^\s:]+$/);

/** Decompõe um id de evento em `{project, process, type, uuid?}`, ou `null` se não casar §4.3. */
export function parseId(
  id: string,
): { project: string; process: string; type: string; uuid?: string } | null {
  const match = ID_RE.exec(id);
  if (isNil(match)) return null;
  const [, project, process, type, uuid] = match;
  return isNil(uuid) ? { project, process, type } : { project, process, type, uuid };
}

export const EventLine = z.strictObject({
  seq: z.number().int().min(0),
  id: z.string(),
  type: Name,
  timestamp: Instant,
  agent: Agent,
  prevHash: Hash,
  data: z.record(z.string(), z.unknown()),
});
export type EventLine = z.infer<typeof EventLine>;

const MilestoneData = z.strictObject({
  milestoneType: Label,
  target: Target,
  count: z.strictObject({ field: Label, value: z.number() }).optional(),
  dueAt: z.iso.datetime({ offset: true }).optional(),
  decisions: z
    .array(z.strictObject({ item: Label, action: Label, text: Text }))
    .max(100)
    .optional(),
  // Mudança 4 (predecessores/liberado-bloqueado): última ocorrência que declara o campo vence.
  predecessors: z.array(Target).max(50).optional(),
  // P5: excluído do envelope de dedupe de `retryWithFullId` — não entra na comparação de retentativa.
  trace: Text.optional(),
});

const VerdictData = z.strictObject({
  claim: Text,
  source: Text,
  result: Label,
  evidence: z.union([Text, z.array(Text).min(1).max(20)]),
  target: Target,
  supersedes: z.array(FullId).min(1).max(100).optional(),
  // Mudança 5: mesmo tipo/teto de `supersedes` — premissa de que este Veredito depende.
  dependsOn: z.array(FullId).min(1).max(100).optional(),
  origin: Text,
  trace: Text,
});

// Mudança 2 (votos): rodada às cegas — `votersExpected` é fixado pelo 1º voto da rodada (D3-B), os
// seguintes têm de bater (`VOTE_ROUND_MISMATCH` em event-tools.ts); a redação de `position`/
// `confidence`/`changed`/`flipReason` até a rodada bater `votersExpected` é lógica de leitura
// (`resolveRawMode`/`resolveSearchMode`), não do schema. `trace` segue o mesmo motivo do Milestone
// (P5): metadado de diagnóstico, fora da comparação de retentativa idempotente (`comparableData`).
export const VoteData = z
  .strictObject({
    target: Target,
    round: z.string().min(1).max(50),
    votersExpected: z.number().int().min(1).max(100),
    position: Text,
    confidence: z.number().min(0).max(1).optional(),
    changed: z.boolean(),
    flipReason: Text.optional(),
    trace: Text.optional(),
  })
  .refine((data) => !data.changed || !isNil(data.flipReason), {
    path: ['flipReason'],
    message: 'flipReason is required when changed is true',
  });

export const GateMilestoneData = z.strictObject({
  milestoneType: z.literal('gate'),
  target: Target,
  gate: z.strictObject({
    name: Name,
    // Mudança 1 (gate de regra): 'rule' junto de 'builtin'/'custom' — mesma forma, um jeito a mais de avaliar.
    origin: z.enum(['builtin', 'custom', 'rule']),
    criteria: z.string().max(2000),
    passed: z.boolean(),
    evidence: z.array(z.unknown()).max(50),
    totalEvidenceItems: z.number().int().min(0),
    evaluatedThrough: z
      .strictObject({ id: z.string(), seq: z.number().int(), timestamp: Instant })
      .nullable(),
  }),
});

/** Teto de caracteres canônicos (JCS) para `data` de um evento (§4.4). */
const DATA_MAX_CHARS = 16_000;

/**
 * Escolhe o schema de `data` para `type`: nativos fixos (Milestone/Verdict/Vote, com o desvio
 * para `GateMilestoneData` quando `milestoneType === 'gate'`) ou o Zod já convertido do snapshot
 * do processo, recebido em `customSchemas` (já convertido de JSON Schema por `loadProcess`).
 */
export function dataSchema(
  type: string,
  data: unknown,
  customSchemas: Record<string, z.ZodType>,
): z.ZodType {
  if (type === 'milestone') {
    return get(data, 'milestoneType') === 'gate' ? GateMilestoneData : MilestoneData;
  }
  if (type === 'verdict') return VerdictData;
  if (type === 'vote') return VoteData;
  return customSchemas[type];
}

/**
 * Normaliza `data` de um evento: parse estrito (com `default` aplicado pelo próprio Zod)
 * e `dueAt` convertido para UTC `Z`. Usada tanto na escrita quanto na retentativa
 * por id completo (mesma função, para a comparação de idempotência de N2 bater).
 */
export function normalizeData(
  type: string,
  data: unknown,
  customSchemas: Record<string, z.ZodType> = {},
): Record<string, unknown> {
  const schema = dataSchema(type, data, customSchemas);
  const result = schema.safeParse(data);
  if (!result.success) {
    throw new HexlogError(
      'INVALID_EVENT',
      'event data failed validation',
      issueDetails(result.error.issues, '/data'),
    );
  }

  const normalized = applyUtcDueAt(result.data as Record<string, unknown>);
  // canonicalize só devolve undefined para entradas não serializáveis; `normalized` é
  // sempre um objeto simples pós-parse do Zod.
  const size = (canonicalize(normalized) ?? '').length;
  if (size > DATA_MAX_CHARS) {
    throw new HexlogError('INVALID_EVENT', `data exceeds ${DATA_MAX_CHARS} canonical characters`, [
      { path: '/data', code: 'too_big', message: `canonical size ${size}` },
    ]);
  }
  return normalized;
}

function applyUtcDueAt(data: Record<string, unknown>): Record<string, unknown> {
  if (isNil(data.dueAt)) return data;
  return { ...data, dueAt: new Date(data.dueAt as string).toISOString() };
}
