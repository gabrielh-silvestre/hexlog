// Núcleo puro da reancoragem das decisões para uma geração nova de diretrizes (`directives-N`):
// classifica as âncoras `anchored-in` e `rests-on` que ainda apontam para uma geração antiga, monta
// as decisões a regravar, os lotes do `register` e a conferência relativa. Sem I/O: quem lê e grava
// o log é a borda, e o dado regravado vem do log, nunca de transcrição.
import { chunk, isEqual, isUndefined, sortBy } from 'es-toolkit';
import { fingerprint } from '../../src/domain/chain.ts';
import { BATCH_MAX, BatchItem } from '../../src/domain/record.ts';

const GENERATION = /^directives-(\d+)(?::|$)/;
const ANCHOR_NAMES = new Set(['anchored-in', 'rests-on']);
// Lista de `directives.fluxo-hexlog.rewrite-divergent-decision`: o resto manda a decisão ao dono.
const COPIED_NAMES = new Set([
  'anchored-in',
  'about-gap',
  'rests-on',
  'resolves-finding',
  'derivesFrom',
]);
const MAX_OWNER_LINES = 100;
const KEY_HASH_CHARS = 12;

type OutEdge = { kind: string; as?: string; to: string };
type InEdge = { kind: string; as?: string; from: string; current: boolean };
type Data = BatchItem['data'];

/** Decisão vigente de um processo de trabalho; `lineage` é o `lineageInheritance` do manifesto dele. */
export type DecisionRow = {
  process: string;
  id: string;
  target: string;
  data: Data;
  out: OutEdge[];
  in: InEdge[];
  lineage: boolean;
};

/** `directive` ou `premise` de uma geração; `text` é o `rule` ou o `statement`, ausente nos outros tipos. */
export type Source = { id: string; type: string; target: string; text?: string; current: boolean };

type AnchorState = 'same' | 'changed' | 'gone' | 'ambiguous' | 'stale';
type Anchor = {
  name: string;
  to: string;
  target?: string;
  state: AnchorState;
  /** Id de mesmo target em `directives-N`, só quando `state` é `same`. */
  mapped?: string;
};

type OwnerReason =
  | { code: 'anchor'; name: string; to: string; target?: string; state: AnchorState }
  | { code: 'other-relation'; name: string; to: string }
  | { code: 'supported' };

type OwnerItem = { process: string; id: string; target: string; reasons: OwnerReason[] };

/** Item no formato de entrada do `register`; `toBatches` o valida com `BatchItem`. */
export type PlannedItem = {
  type: 'decision';
  target: string;
  data: Data;
  relations: OutEdge[];
};

type Rewrite = { process: string; id: string; item: PlannedItem };

type Plan = { rewrites: Rewrite[]; owner: OwnerItem[] };

type PlanInput = {
  /** Geração nova, `directives-<N>`. */
  to: string;
  /** Decisões vigentes de cada processo de trabalho. */
  decisions: DecisionRow[];
  /** Registros de cada `directives-M`, inclusive os não vigentes. */
  older: Record<string, Source[]>;
  /** Registros vigentes de `directives-N`. */
  current: Source[];
};

type Batch = { process: string; key: string; records: BatchItem[] };

/** Registro lido do log, inclusive os não vigentes, para a conferência. */
export type LogRow = {
  id: string;
  target: string;
  data: Data;
  out: OutEdge[];
  in: InEdge[];
};

type Divergence = {
  id: string;
  problem:
    | 'new-missing'
    | 'new-not-current'
    | 'data-differs'
    | 'relations-differ'
    | 'old-still-current'
    | 'current-count-changed';
};

const nameOf = ({ kind, as }: { kind: string; as?: string }): string => as ?? kind;

/** Número da geração de um id (`directives-<M>:<uuid>`) ou de um nome de processo (`directives-<M>`). */
export function generationOf(idOrName: string): number | undefined {
  const match = GENERATION.exec(idOrName);
  return isUndefined(match?.[1]) ? undefined : Number(match[1]);
}

/** `to` existe em `names` e nenhuma geração listada é maior que ele (comparação numérica). */
export function isLatestGeneration(to: string, names: readonly string[]): boolean {
  const generation = generationOf(to);
  if (isUndefined(generation) || !names.includes(to)) return false;
  return names.every((name) => (generationOf(name) ?? -Infinity) <= generation);
}

function classify(
  name: string,
  to: string,
  olderById: Map<string, Source>,
  currentByTarget: Map<string, Source[]>,
): Anchor {
  const old = olderById.get(to);
  if (isUndefined(old) || !old.current) return { name, to, target: old?.target, state: 'stale' };
  const { target } = old;
  const candidates = currentByTarget.get(target) ?? [];
  if (candidates.length > 1) return { name, to, target, state: 'ambiguous' };
  const [only] = candidates;
  if (isUndefined(only)) return { name, to, target, state: 'gone' };
  if (only.type !== old.type || isUndefined(old.text) || old.text !== only.text) {
    return { name, to, target, state: 'changed' };
  }
  return { name, to, target, state: 'same', mapped: only.id };
}

function ownerReasons(row: DecisionRow, anchors: Anchor[]): OwnerReason[] {
  const anchorReasons: OwnerReason[] = anchors.some(({ state }) => state !== 'same')
    ? anchors.map(({ name, to, target, state }) => ({ code: 'anchor', name, to, target, state }))
    : [];
  const otherRelations: OwnerReason[] = row.out
    .filter((edge) => !COPIED_NAMES.has(nameOf(edge)) && nameOf(edge) !== 'supersedes')
    .map((edge) => ({ code: 'other-relation', name: nameOf(edge), to: edge.to }));
  const supported =
    !row.lineage && row.in.some((edge) => nameOf(edge) === 'supports' && edge.current);
  return [
    ...anchorReasons,
    ...otherRelations,
    ...(supported ? [{ code: 'supported' as const }] : []),
  ];
}

/**
 * Classifica as decisões vigentes: as de âncoras todas `same`, sem relação fora da lista e sem
 * apoio que se perderia, viram regravação (`supersedes` da vigente, `data` igual, âncoras no id de
 * mesmo target em `directives-N`); as demais vão ao dono. Decisão sem âncora numa geração antiga
 * fica fora.
 */
export function planReanchor({ to, decisions, older, current }: PlanInput): Plan {
  const latest = generationOf(to);
  if (isUndefined(latest)) throw new Error(`invalid generation "${to}"`);
  const olderById = new Map(
    Object.values(older)
      .flat()
      .map((source) => [source.id, source]),
  );
  const currentByTarget = Map.groupBy(current, ({ target }) => target);
  const isOldAnchor = (edge: OutEdge): boolean => {
    const generation = generationOf(edge.to);
    return ANCHOR_NAMES.has(nameOf(edge)) && !isUndefined(generation) && generation < latest;
  };

  const plan: Plan = { rewrites: [], owner: [] };
  for (const row of sortBy(decisions, ['process', 'target', 'id'])) {
    const anchors = row.out
      .filter(isOldAnchor)
      .map((edge) => classify(nameOf(edge), edge.to, olderById, currentByTarget));
    if (anchors.length === 0) continue;

    const reasons = ownerReasons(row, anchors);
    if (reasons.length > 0) {
      plan.owner.push({ process: row.process, id: row.id, target: row.target, reasons });
      continue;
    }
    const mappedTo = new Map(anchors.map((anchor) => [anchor.to, anchor.mapped]));
    const copied = row.out
      .filter((edge) => COPIED_NAMES.has(nameOf(edge)))
      .map(({ kind, as, to: target }): OutEdge => {
        const remapped = isOldAnchor({ kind, as, to: target }) ? mappedTo.get(target) : undefined;
        return { kind, ...(isUndefined(as) ? {} : { as }), to: remapped ?? target };
      });
    plan.rewrites.push({
      process: row.process,
      id: row.id,
      item: {
        type: 'decision',
        target: row.target,
        data: row.data,
        relations: [{ kind: 'supersedes', to: row.id }, ...copied],
      },
    });
  }
  return plan;
}

/**
 * Valida só a forma de cada item (`BatchItem`; tipo fixado, schema e regras de relação são do
 * `register`), fatia em `BATCH_MAX` e dá a cada lote uma `key` que depende do conteúdo: o mesmo
 * lote repetido é replay, e um lote diferente nunca colide.
 */
export function toBatches(process: string, to: string, items: readonly PlannedItem[]): Batch[] {
  return chunk(
    items.map((item) => BatchItem.parse(item)),
    BATCH_MAX,
  ).map((records) => ({
    process,
    key: `reanchor-${to}-${process}-${fingerprint(records).slice(0, KEY_HASH_CHARS)}`,
    records,
  }));
}

const processOf = (id: string): string => id.slice(0, Math.max(id.indexOf(':'), 0));

/** Vigência como o servidor a vê: sem `supersedes` nem `revokes` de entrada. */
export const isCurrent = ({ in: incoming }: LogRow): boolean =>
  !incoming.some(({ kind }) => kind === 'supersedes' || kind === 'revokes');

const edgeKeys = (edges: readonly OutEdge[]): string[] =>
  edges.map(({ kind, as, to }) => `${kind}|${as ?? ''}|${to}`).sort();

function currentCounts(rows: readonly LogRow[], rewrites: readonly Rewrite[]): Map<string, number> {
  const wanted = new Set(rewrites.map(({ process, item }) => `${process}\0${item.target}`));
  const counts = new Map<string, number>();
  for (const row of rows.filter(isCurrent)) {
    const key = `${processOf(row.id)}\0${row.target}`;
    if (wanted.has(key)) counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return counts;
}

/**
 * Confere o log relido contra o plano gravado: o registro novo (achado pelo `supersedes` para o id
 * antigo) é vigente, tem `data` e saídas iguais às planejadas, o antigo deixou de ser vigente, e a
 * contagem de vigentes por target não mudou. Relativa: não supõe um só vigente por target.
 */
export function verifyReanchor(
  rewrites: readonly Rewrite[],
  before: readonly LogRow[],
  after: readonly LogRow[],
): Divergence[] {
  const divergences: Divergence[] = [];
  const stillCurrent = new Set(after.filter(isCurrent).map(({ id }) => id));
  for (const { id, item } of rewrites) {
    const replacement = after.find(({ out }) =>
      out.some(({ kind, to }) => kind === 'supersedes' && to === id),
    );
    if (isUndefined(replacement)) {
      divergences.push({ id, problem: 'new-missing' });
    } else {
      if (!stillCurrent.has(replacement.id)) divergences.push({ id, problem: 'new-not-current' });
      if (!isEqual(replacement.data, item.data)) divergences.push({ id, problem: 'data-differs' });
      if (!isEqual(edgeKeys(replacement.out), edgeKeys(item.relations))) {
        divergences.push({ id, problem: 'relations-differ' });
      }
    }
    if (stillCurrent.has(id)) divergences.push({ id, problem: 'old-still-current' });
  }
  const countsBefore = currentCounts(before, rewrites);
  const countsAfter = currentCounts(after, rewrites);
  for (const { process, id, item } of rewrites) {
    const key = `${process}\0${item.target}`;
    if (countsBefore.get(key) !== countsAfter.get(key)) {
      divergences.push({ id, problem: 'current-count-changed' });
    }
  }
  return divergences;
}

function describeReason(reason: OwnerReason): string {
  if (reason.code === 'supported') return 'supported';
  if (reason.code === 'other-relation') return `other-relation ${reason.name}->${reason.to}`;
  const target = isUndefined(reason.target) ? '' : ` (${reason.target})`;
  return `${reason.name} ${reason.to}${target}: ${reason.state}`;
}

/** Texto do plano: regraváveis por processo e a lista ao dono, limitada a `MAX_OWNER_LINES` linhas. */
export function formatPlan(plan: Plan, { to, apply }: { to: string; apply: boolean }): string {
  if (plan.rewrites.length === 0 && plan.owner.length === 0) return 'nothing to reanchor';
  const perProcess = Map.groupBy(plan.rewrites, ({ process }) => process);
  const lines = [
    `reanchor to ${to} (${apply ? 'apply' : 'dry-run'})`,
    `rewritable: ${plan.rewrites.length}`,
    ...[...perProcess].map(([process, rewrites]) => `  ${process}: ${rewrites.length}`),
    `for the owner: ${plan.owner.length}`,
    ...plan.owner
      .slice(0, MAX_OWNER_LINES)
      .map(
        ({ process, target, id, reasons }) =>
          `  ${process}\t${target}\t${id}\t${reasons.map(describeReason).join('; ')}`,
      ),
  ];
  const omitted = plan.owner.length - MAX_OWNER_LINES;
  return (omitted > 0 ? [...lines, `... ${omitted} more omitted`] : lines).join('\n');
}
