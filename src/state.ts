import { groupBy, isNil, keyBy, pick, uniqBy } from 'es-toolkit';
import { z } from 'zod';
import type { Chain } from './chain.ts';
import { Name } from './events.ts';
import type { EventLine } from './events.ts';

// §4.9: cada lista do vocabulário tem até 100 valores de até 100 caracteres.
const VocabValue = z.string().min(1).max(100);
const VocabList = z.array(VocabValue).max(100);

export const VocabSchema = z.strictObject({
  milestoneType: VocabList,
  result: VocabList,
  action: VocabList,
});
export type Vocab = z.infer<typeof VocabSchema>;

export const VocabularySchema = z.strictObject({
  core: VocabSchema,
  byOwner: z.record(Name, VocabSchema),
});
export type Vocabulary = z.infer<typeof VocabularySchema>;

export type VocabularyField = 'milestoneType' | 'result' | 'decisions.action';

export type StatusEntry =
  | { target: string; claim: string; status: 'active'; active: string }
  | { target: string; claim: string; status: 'conflict'; candidates: string[] };

export type Projection = {
  logThrough: { id: string; seq: number; timestamp: string } | null;
  active: StatusEntry[]; // ordem de 1ª aparição
  conflicts: { target: string; claim: string; candidates: string[] }[];
  orphans: { milestone: string; target: string; dueAt: string }[];
  toReview: string[];
  invalidReferences: { citedBy: string; reference: string }[];
  warnings: {
    event: string;
    field: VocabularyField;
    value: string;
    kind: 'extension' | 'unknown-warning' | 'error';
    owner: string | null;
  }[];
};

export type State = Projection & { chain: Chain };

/** Seções que a tool `state` pode filtrar (§4.12): schema Zod é a fonte única, mcp.ts só reexporta. */
export const Section = z.enum([
  'active',
  'conflicts',
  'orphans',
  'toReview',
  'invalidReferences',
  'warnings',
  'chain',
]);

/** `now` efetivo da projeção (Q10): o mais recente entre o relógio injetado e o último elo do log. */
export function effectiveNow(clockTime: string, lines: EventLine[]): string {
  const last = lines.at(-1);
  if (isNil(last)) return clockTime;
  // Instant (ISO 8601 UTC "Z") ordena igual por comparação lexicográfica; es-toolkit.maxBy
  // compara numericamente e erraria aqui, por isso o ternário em vez do helper.
  return clockTime > last.timestamp ? clockTime : last.timestamp;
}

// Forma de leitura de `data` já validado (normalizeData): cobre Milestone e a variante gate
// (que não tem `dueAt`/`decisions`), e Verdict. Sem revalidação — só acesso a campo.
type MilestoneFields = {
  milestoneType: string;
  target: string;
  dueAt?: string;
  decisions?: { item: string; action: string; text: string }[];
};
type VerdictFields = {
  target: string;
  claim: string;
  result: string;
  supersedes?: string[];
};

function targetOf(line: EventLine): string | undefined {
  if (line.type === 'milestone') return (line.data as MilestoneFields).target;
  if (line.type === 'verdict') return (line.data as VerdictFields).target;
  return undefined; // tipos custom não têm target e são inertes (S3)
}

function isMilestoneGate(line: EventLine): boolean {
  return line.type === 'milestone' && (line.data as MilestoneFields).milestoneType === 'gate';
}

function groupingKey(data: VerdictFields): string {
  return JSON.stringify([data.target, data.claim]);
}

type SupersessionResult = {
  active: StatusEntry[];
  conflicts: Projection['conflicts'];
  invalidReferences: Projection['invalidReferences'];
  superseded: EventLine[];
};

/** Active/conflicts/invalidReferences por (target, claim); `supersedes` marca superados sem fundir grupos. */
function computeSupersession(verdicts: EventLine[]): SupersessionResult {
  const verdictById = keyBy(verdicts, (v) => v.id);
  const supersededIds = new Set<string>();
  const invalidReferences: Projection['invalidReferences'] = [];

  for (const v of verdicts) {
    const data = v.data as VerdictFields;
    for (const refId of data.supersedes ?? []) {
      if (isNil(verdictById[refId])) {
        invalidReferences.push({ citedBy: v.id, reference: refId });
        continue;
      }
      supersededIds.add(refId);
    }
  }

  const byKey = groupBy(verdicts, (v) => groupingKey(v.data as VerdictFields));

  const active: StatusEntry[] = [];
  const conflicts: Projection['conflicts'] = [];
  for (const [key, members] of Object.entries(byKey)) {
    const candidates = members.filter((v) => !supersededIds.has(v.id)).map((v) => v.id);
    if (candidates.length === 0) continue; // grupo inteiro superado por verdicts de outra chave: sem active

    const [target, claim] = JSON.parse(key) as [string, string];
    if (candidates.length === 1) {
      active.push({ target, claim, status: 'active', active: candidates[0] });
      continue;
    }
    active.push({ target, claim, status: 'conflict', candidates });
    conflicts.push({ target, claim, candidates });
  }

  const superseded = verdicts.filter((v) => supersededIds.has(v.id));
  return { active, conflicts, invalidReferences, superseded };
}

/** Ciclo do Milestone por target (§4.8, pseudocódigo do plano): reduce puro, gate nunca abre nem fecha (R-3). */
function deriveCycle(
  eventsForTarget: EventLine[],
): { opening: EventLine; closed: boolean } | undefined {
  type Acc = { opening?: EventLine; closed: boolean };
  const final = eventsForTarget.reduce<Acc>(
    (acc, e) => {
      if (isMilestoneGate(e)) return acc;
      const dueAt = e.type === 'milestone' ? (e.data as MilestoneFields).dueAt : undefined;
      if (!isNil(dueAt)) return { opening: e, closed: false }; // nova abertura reinicia
      return isNil(acc.opening) ? acc : { ...acc, closed: true }; // qualquer evento posterior fecha
    },
    { closed: false },
  );

  return isNil(final.opening) ? undefined : { opening: final.opening, closed: final.closed };
}

function calculateOrphans(lines: EventLine[], now: string): Projection['orphans'] {
  const withTarget = lines.filter((e) => e.type === 'milestone' || e.type === 'verdict');
  const byTarget = groupBy(withTarget, (e) => targetOf(e) as string);

  const orphans: Projection['orphans'] = [];
  for (const [target, eventsForTarget] of Object.entries(byTarget)) {
    const cycle = deriveCycle(eventsForTarget);
    if (isNil(cycle) || cycle.closed) continue;

    const dueAt = (cycle.opening.data as MilestoneFields).dueAt;
    if (!isNil(dueAt) && dueAt < now) {
      orphans.push({ milestone: cycle.opening.id, target, dueAt });
    }
  }
  return orphans;
}

/** BFS por target a partir dos Verdicts superados; Milestones de gate entram (só ficam fora do ciclo, R-3). */
function calculateToReview(lines: EventLine[], superseded: EventLine[]): string[] {
  const byId = keyBy(lines, (e) => e.id);
  const supersededIds = new Set(superseded.map((v) => v.id));
  const visitedTargets = new Set<string>();
  const queue: string[] = [];

  for (const verdict of superseded) {
    const target = targetOf(verdict);
    if (isNil(target) || visitedTargets.has(target)) continue;
    visitedTargets.add(target);
    queue.push(target);
  }

  const result: string[] = [];
  while (queue.length > 0) {
    const target = queue.shift();
    if (isNil(target)) continue;

    for (const line of lines) {
      if (targetOf(line) !== target || supersededIds.has(line.id)) continue;
      result.push(line.id);

      if (line.type !== 'verdict') continue;
      for (const refId of (line.data as VerdictFields).supersedes ?? []) {
        const referencedLine = byId[refId];
        if (isNil(referencedLine)) continue;
        const referencedTarget = targetOf(referencedLine);
        if (isNil(referencedTarget) || visitedTargets.has(referencedTarget)) continue;
        visitedTargets.add(referencedTarget);
        queue.push(referencedTarget);
      }
    }
  }
  return result;
}

type FieldPolicy = { key: keyof Vocab; open: boolean };

// open=true: fora de core ∪ extensões vira warning (campo aberto); open=false: vira error (campo fechado).
const FIELD_POLICY_BY_KEY: Record<VocabularyField, FieldPolicy> = {
  milestoneType: { key: 'milestoneType', open: false },
  result: { key: 'result', open: true },
  'decisions.action': { key: 'action', open: false },
};

/** Classifica `value` de `field` contra o vocabulário (§4.9). `null` = valor do core, sem warning. */
export function validateField(
  vocabulary: Vocabulary,
  field: VocabularyField,
  value: string,
): { kind: 'extension' | 'unknown-warning' | 'error'; owner: string | null } | null {
  const { key, open } = FIELD_POLICY_BY_KEY[field];

  if (vocabulary.core[key].includes(value)) return null;

  const owners = Object.entries(vocabulary.byOwner)
    .filter(([, vocab]) => vocab[key].includes(value))
    .map(([owner]) => owner);

  if (owners.length === 1) return { kind: 'extension', owner: owners[0] };
  if (owners.length > 1) return { kind: 'extension', owner: null }; // dois+ owners declaram o mesmo valor: ambíguo

  return { kind: open ? 'unknown-warning' : 'error', owner: null };
}

function collectWarnings(lines: EventLine[], vocabulary: Vocabulary): Projection['warnings'] {
  const warnings: Projection['warnings'] = [];

  const record = (event: string, field: VocabularyField, value: string): void => {
    const result = validateField(vocabulary, field, value);
    if (isNil(result)) return;
    warnings.push({ event, field, value, ...result });
  };

  for (const line of lines) {
    if (line.type === 'milestone') {
      if (isMilestoneGate(line)) continue; // §4.9: Milestones de gate são ignorados
      const data = line.data as MilestoneFields;
      record(line.id, 'milestoneType', data.milestoneType);
      for (const decision of data.decisions ?? [])
        record(line.id, 'decisions.action', decision.action);
    } else if (line.type === 'verdict') {
      record(line.id, 'result', (line.data as VerdictFields).result);
    }
  }
  return warnings;
}

/**
 * Projeta o State a partir das lines (§4.8), pura: full rebuild sempre a partir do array
 * completo, nunca incremental. Recebe só lines com `data` já validado (normalizeData) e
 * `now` já resolvido por `effectiveNow` (Q10).
 */
export function projectState(lines: EventLine[], vocabulary: Vocabulary, now: string): Projection {
  const deduplicated = uniqBy(lines, (e) => e.id); // primeira ocorrência vence
  const last = deduplicated.at(-1);

  const verdicts = deduplicated.filter((e) => e.type === 'verdict');
  const { active, conflicts, invalidReferences, superseded } = computeSupersession(verdicts);

  return {
    logThrough: isNil(last) ? null : pick(last, ['id', 'seq', 'timestamp']),
    active,
    conflicts,
    orphans: calculateOrphans(deduplicated, now),
    toReview: calculateToReview(deduplicated, superseded),
    invalidReferences,
    warnings: collectWarnings(deduplicated, vocabulary),
  };
}
