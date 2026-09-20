import { groupBy, isNil, keyBy, pick, uniq, uniqBy } from 'es-toolkit';
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

export type VocabularyField = 'milestoneType' | 'result' | 'decisions.action' | 'position';

export type StatusEntry =
  | { target: string; claim: string; status: 'active'; active: string; result: string }
  // `result: null` quando os candidatos em disputa não convergem no mesmo `result` — evita eleger
  // um vencedor arbitrário entre eles (`result` é o campo que os gates de regra devem casar).
  | {
      target: string;
      claim: string;
      status: 'conflict';
      candidates: string[];
      result: string | null;
    };

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
  // P1 (no-forks): Verdict com 2+ sucessores vivos (sucessor = Verdict que o cita em `supersedes`
  // e não está ele mesmo superado).
  forks: { verdict: string; successors: string[] }[];
  // P4: todos os targets de Verdict já usados no log, inclusive os sem vigente, ordenados.
  targets: string[];
  // Mudança 4 (predecessores): target com `predecessors` declarado e ao menos 1 sem Verdict ativo.
  blocked: { target: string; blockedBy: string[] }[];
  // Mudança 4: target com `predecessors` declarado e todos já com Verdict ativo.
  released: string[];
  // Mudança 3 (fases): fase atual (última `milestoneType` não-gate) de cada target com Milestone.
  phases: { target: string; current: string }[];
  // Mudança 2 (votos): status sem conteúdo por rodada (target+round) — sempre visível, mesmo com a
  // rodada ainda aberta (mitigação do pre-mortem #2: sem isso, uma rodada emperrada passa despercebida).
  voteRounds: VoteRoundStatus[];
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
  'forks',
  'blocked',
  'released',
  'voteRounds',
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
  predecessors?: string[];
};
type VerdictFields = {
  target: string;
  claim: string;
  result: string;
  supersedes?: string[];
  dependsOn?: string[];
};
type VoteFields = { target: string; round: string; votersExpected: number };

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
  forks: Projection['forks'];
};

/**
 * P1 (no-forks): agrupa, por Verdict citado, os sucessores vivos (que o citam em `supersedes` e não
 * estão eles mesmos superados). 2+ sucessores vivos para o mesmo citado é um fork. Referência a id
 * que não é Verdict do log já foi registrada em `invalidReferences` por quem monta `supersededIds`.
 */
function calculateForks(
  verdicts: EventLine[],
  verdictById: Record<string, EventLine>,
  supersededIds: Set<string>,
): Projection['forks'] {
  const successorsByCited = new Map<string, string[]>();
  for (const v of verdicts) {
    if (supersededIds.has(v.id)) continue; // só sucessor vivo conta
    for (const refId of (v.data as VerdictFields).supersedes ?? []) {
      if (isNil(verdictById[refId])) continue;
      const successors = successorsByCited.get(refId);
      if (isNil(successors)) successorsByCited.set(refId, [v.id]);
      else successors.push(v.id);
    }
  }
  return [...successorsByCited.entries()]
    .filter(([, successors]) => successors.length >= 2)
    .map(([verdict, successors]) => ({ verdict, successors }));
}

/** Referências (`supersedes`/`dependsOn`) de `v` para ids que não são Verdict do log. */
function invalidRefs(
  v: EventLine,
  refs: string[] | undefined,
  verdictById: Record<string, EventLine>,
): Projection['invalidReferences'] {
  return (refs ?? [])
    .filter((refId) => isNil(verdictById[refId]))
    .map((reference) => ({ citedBy: v.id, reference }));
}

/** Active/conflicts/invalidReferences por (target, claim); `supersedes` marca superados sem fundir grupos. */
function computeSupersession(verdicts: EventLine[]): SupersessionResult {
  const verdictById = keyBy(verdicts, (v) => v.id);
  const supersededIds = new Set<string>();
  const invalidReferences: Projection['invalidReferences'] = [];

  for (const v of verdicts) {
    const data = v.data as VerdictFields;
    invalidReferences.push(...invalidRefs(v, data.supersedes, verdictById));
    // Mudança 5: `dependsOn` só é checado quanto a referência válida — não supera nada.
    invalidReferences.push(...invalidRefs(v, data.dependsOn, verdictById));
    for (const refId of data.supersedes ?? []) {
      if (!isNil(verdictById[refId])) supersededIds.add(refId);
    }
  }

  const forks = calculateForks(verdicts, verdictById, supersededIds);
  const byKey = groupBy(verdicts, (v) => groupingKey(v.data as VerdictFields));

  const active: StatusEntry[] = [];
  const conflicts: Projection['conflicts'] = [];
  for (const [key, members] of Object.entries(byKey)) {
    const candidates = members.filter((v) => !supersededIds.has(v.id)).map((v) => v.id);
    if (candidates.length === 0) continue; // grupo inteiro superado por verdicts de outra chave: sem active

    const [target, claim] = JSON.parse(key) as [string, string];
    if (candidates.length === 1) {
      const result = (verdictById[candidates[0]].data as VerdictFields).result;
      active.push({ target, claim, status: 'active', active: candidates[0], result });
      continue;
    }
    const results = uniq(candidates.map((id) => (verdictById[id].data as VerdictFields).result));
    active.push({
      target,
      claim,
      status: 'conflict',
      candidates,
      result: results.length === 1 ? results[0] : null,
    });
    conflicts.push({ target, claim, candidates });
  }

  const superseded = verdicts.filter((v) => supersededIds.has(v.id));
  return { active, conflicts, invalidReferences, superseded, forks };
}

/** P4: targets de todo Verdict do log, inclusive os sem vigente, ordenados. */
function calculateTargets(verdicts: EventLine[]): string[] {
  return uniq(verdicts.map((v) => (v.data as VerdictFields).target)).sort();
}

/** Mudança 4: predecessores do Milestone mais recente daquele target que declarou o campo (última ocorrência vence). */
function latestPredecessors(eventsForTarget: EventLine[]): string[] | null {
  let result: string[] | null = null;
  for (const e of eventsForTarget) {
    const predecessors = (e.data as MilestoneFields).predecessors;
    if (!isNil(predecessors)) result = predecessors;
  }
  return result;
}

/**
 * Mudança 4 (D6): predecessor "resolvido" ⇔ aparece em `active` (status `active` ou `conflict` —
 * grupo (target, claim) inteiramente superado já não entra em `active`). Target sem `predecessors`
 * declarado não entra em nenhuma das duas listas.
 */
function calculateBlockedAndReleased(
  milestones: EventLine[],
  active: StatusEntry[],
): { blocked: Projection['blocked']; released: string[] } {
  const resolvedTargets = new Set(active.map((entry) => entry.target));
  const byTarget = groupBy(milestones, (e) => targetOf(e) as string);

  const blocked: Projection['blocked'] = [];
  const released: string[] = [];
  for (const [target, eventsForTarget] of Object.entries(byTarget)) {
    const predecessors = latestPredecessors(eventsForTarget);
    if (isNil(predecessors)) continue;

    const blockedBy = predecessors.filter((p) => !resolvedTargets.has(p));
    if (blockedBy.length > 0) blocked.push({ target, blockedBy });
    else released.push(target);
  }
  return { blocked, released };
}

/**
 * Mudança 3 (fases): fase atual de `target` — a `milestoneType` do Milestone não-gate mais recente
 * daquele target entre `lines` (última ocorrência vence), `null` se nenhum. Exportada porque
 * `event-tools.ts` reusa exatamente esta função para checar a ordem de transição na escrita, em vez
 * de duplicar a mesma passada por lines (DRY) — só `state.ts` pode fazer isso sem criar dependência
 * circular, já que `event-tools.ts` é quem importa de `state.ts`, nunca o contrário.
 */
export function currentPhase(lines: EventLine[], target: string): string | null {
  let result: string | null = null;
  for (const line of lines) {
    if (targetOf(line) !== target || line.type !== 'milestone' || isMilestoneGate(line)) continue;
    result = (line.data as MilestoneFields).milestoneType;
  }
  return result;
}

/** Mudança 3: fase atual de todo target que já teve ao menos um Milestone; sem fase (nunca teve um não-gate) fica de fora. */
function calculatePhases(lines: EventLine[], milestones: EventLine[]): Projection['phases'] {
  const targets = uniq(milestones.map((m) => targetOf(m) as string));
  return targets.flatMap((target) => {
    const current = currentPhase(lines, target);
    return isNil(current) ? [] : [{ target, current }];
  });
}

export type VoteRoundStatus = {
  target: string;
  round: string;
  votersExpected: number;
  votesReceived: number;
  revealed: boolean;
};

/** Chave de agrupamento de uma rodada de voto: um `target` pode ter várias rodadas concorrentes. */
export function voteRoundKey(target: string, round: string): string {
  return `${target}::${round}`;
}

/**
 * Mudança 2 (votos): status por rodada (`target`+`round`), 1 passada sobre `lines`. Exportada porque
 * `event-tools.ts` reusa exatamente esta função (validar `votersExpected` do próximo voto, redigir
 * `events`/`state` até a rodada revelar, excluir voto de rodada aberta do conjunto de `candidates` de
 * busca) sem duplicar a mesma passada por lines (DRY) — mesma razão de `currentPhase`. `revealed`:
 * "o N-ésimo voto revela todos" (D2/D3) — calculado a cada leitura, nunca gravado no evento.
 */
export function voteRoundCounts(lines: EventLine[]): Map<string, VoteRoundStatus> {
  const counts = new Map<string, VoteRoundStatus>();
  for (const line of lines) {
    if (line.type !== 'vote') continue;
    const vote = line.data as VoteFields;
    const key = voteRoundKey(vote.target, vote.round);
    const status = counts.get(key);
    if (isNil(status)) {
      counts.set(key, {
        target: vote.target,
        round: vote.round,
        votersExpected: vote.votersExpected,
        votesReceived: 1,
        revealed: 1 >= vote.votersExpected,
      });
      continue;
    }
    status.votesReceived++;
    status.revealed = status.votesReceived >= status.votersExpected;
  }
  return counts;
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

/** Mudança 5: premissa (id de Verdict superado) → Verdicts que declaram depender dela (`dependsOn`). */
function dependentsByPremise(verdicts: EventLine[]): Map<string, EventLine[]> {
  const index = new Map<string, EventLine[]>();
  for (const v of verdicts) {
    for (const premiseId of (v.data as VerdictFields).dependsOn ?? []) {
      const dependents = index.get(premiseId);
      if (isNil(dependents)) index.set(premiseId, [v]);
      else dependents.push(v);
    }
  }
  return index;
}

/**
 * BFS por target a partir dos Verdicts superados; Milestones de gate entram (só ficam fora do ciclo,
 * R-3). Mudança 5: no laço de seed, cada Verdict superado também enfileira os targets dos Verdicts
 * que declaram depender dele (`dependsOn`) — mesmo `visitedTargets` do BFS por `supersedes`, o que
 * evita loop numa dependência circular (A depende de B, B depende de A).
 */
function calculateToReview(
  lines: EventLine[],
  verdicts: EventLine[],
  superseded: EventLine[],
): string[] {
  const byId = keyBy(lines, (e) => e.id);
  const supersededIds = new Set(superseded.map((v) => v.id));
  const dependentsById = dependentsByPremise(verdicts);
  const visitedTargets = new Set<string>();
  const queue: string[] = [];

  const enqueue = (target: string | undefined): void => {
    if (isNil(target) || visitedTargets.has(target)) return;
    visitedTargets.add(target);
    queue.push(target);
  };

  for (const verdict of superseded) {
    enqueue(targetOf(verdict));
    for (const dependent of dependentsById.get(verdict.id) ?? []) enqueue(targetOf(dependent));
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
        enqueue(targetOf(referencedLine));
      }
    }
  }
  return result;
}

type FieldPolicy = { key: keyof Vocab; open: boolean };

// open=true: fora de core ∪ extensões vira warning (campo aberto); open=false: vira error (campo fechado).
const FIELD_POLICY_BY_KEY: Record<VocabularyField, FieldPolicy> = {
  milestoneType: { key: 'milestoneType', open: false },
  // Fechado (era aberto até a wave de melhorias): `result` é o campo que os gates de regra casam
  // contra `acceptedResults` (evaluateRule, gates.ts), então deixá-lo aberto permitia ao agente
  // cunhar qualquer valor na escrita do Veredito e satisfazer o gate sem passar pelo vocabulário
  // fixado do processo.
  result: { key: 'result', open: false },
  'decisions.action': { key: 'action', open: false },
  // Mudança 2 (D4): reuso de Vocab.result para validar vote.position — ver RALPLAN. A checagem de
  // pertencimento é contra a mesma lista de `result`; só o `field` do warning muda para o nome real.
  // Continua aberto: `position` é a escolha de voto do agente, não um valor que um gate casa.
  position: { key: 'result', open: true },
};

/**
 * Chaves de `Vocab` fechadas (`open: false` em `FIELD_POLICY_BY_KEY`): remover um termo delas
 * é quebra de versionamento (`definitions.ts`). Subconjunto estreito, não o `Record` inteiro,
 * para não acoplar `definitions.ts` ao tipo `VocabularyField` nem ao literal `'decisions.action'`.
 */
export const CLOSED_VOCAB_KEYS: readonly (keyof Vocab)[] = Object.values(FIELD_POLICY_BY_KEY)
  .filter((policy) => !policy.open)
  .map((policy) => policy.key);

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

/** P2: termos permitidos (core ∪ extensões) de `field` — contexto de `VOCABULARY_VIOLATED`. */
export function allowedTerms(vocabulary: Vocabulary, field: VocabularyField): string[] {
  const { key } = FIELD_POLICY_BY_KEY[field];
  const extended = Object.values(vocabulary.byOwner).flatMap((vocab) => vocab[key]);
  return uniq([...vocabulary.core[key], ...extended]);
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
  const milestones = deduplicated.filter((e) => e.type === 'milestone');
  const { active, conflicts, invalidReferences, superseded, forks } = computeSupersession(verdicts);
  const { blocked, released } = calculateBlockedAndReleased(milestones, active);

  return {
    logThrough: isNil(last) ? null : pick(last, ['id', 'seq', 'timestamp']),
    active,
    conflicts,
    orphans: calculateOrphans(deduplicated, now),
    toReview: calculateToReview(deduplicated, verdicts, superseded),
    invalidReferences,
    warnings: collectWarnings(deduplicated, vocabulary),
    forks,
    targets: calculateTargets(verdicts),
    blocked,
    released,
    phases: calculatePhases(deduplicated, milestones),
    voteRounds: [...voteRoundCounts(deduplicated).values()],
  };
}
