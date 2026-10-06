import { createHash } from 'node:crypto';

// Planejador de sync dos documentos de `docs/directives/` com o processo de diretrizes. Puro: sem
// I/O e sem dependência, para a skill executar o mesmo código que a spec ensaia. O que grava e o
// que lê do servidor é da skill; aqui só se decide quais registros entram, em que lotes.

const BATCH_MAX = 50;
// Um registro leva até 100 relações; o `doc` carrega um `supersedes` e um `revokes` por regra sumida.
const REVOKES_MAX = 99;
const CLOSES_GAP = 'closes-gap';

/** Relação de saída de um registro vigente, como o `query` a devolve. */
export type OutRelation = { as?: string; kind: string; to: string };

/** Regra (`directive`) vigente de um documento; `target` é `directives.<doc>.<slug>`. */
export type VigentRule = {
  id: string;
  target: string;
  rule: string;
  section: string;
  out: OutRelation[];
};

/**
 * Regra extraída do documento. `closes` são os ids das lacunas (`gap`) que a regra fecha: viram
 * relações `closes-gap` no registro planejado. `interpreted` só alimenta a revisão da carga e não
 * vai ao registro.
 */
export type ExtractedRule = {
  slug: string;
  rule: string;
  section: string;
  closes?: string[];
  interpreted?: boolean;
};

export type SyncInput = {
  docSlug: string;
  path: string;
  /** sha256 dos bytes do documento, igual ao hash que o `attach` devolveria. */
  hash: string;
  /** `doc` vigente do documento, ou `null` se ainda não houve sync. */
  current: { id: string; source: string; removed?: boolean } | null;
  vigent: VigentRule[];
  /** `null`: o documento foi apagado. */
  extracted: ExtractedRule[] | null;
};

export type PlannedRelation = { to: string; kind?: string; as?: string };

/** Registro no formato de entrada do `register`. */
export type PlannedRecord = {
  type: 'directive' | 'doc';
  target: string;
  data: Record<string, string | boolean>;
  relations: PlannedRelation[];
};

export type SyncBatch = { key: string; records: PlannedRecord[] };

/** Regra revogada que fechava lacunas: as lacunas voltam a pendente e o gate `gaps` falha. */
export type SyncWarning = { code: 'reopens-gap'; rule: string; gaps: string[] };

export type SyncPlan = {
  upToDate: boolean;
  batches: SyncBatch[];
  warnings: SyncWarning[];
  error?: 'too-many-relations';
};

const sha256 = (text: string): string => createHash('sha256').update(text).digest('hex');

function isUpToDate({ current, vigent, extracted, hash }: SyncInput): boolean {
  if (extracted === null) {
    return current === null ? vigent.length === 0 : current.removed === true;
  }
  return current !== null && current.removed !== true && current.source === hash;
}

const targetPrefix = (docSlug: string): string => `directives.${docSlug}.`;
const slugOf = (docSlug: string, { target }: VigentRule): string =>
  target.slice(targetPrefix(docSlug).length);

const closedGaps = ({ out }: VigentRule): string[] =>
  out.filter(({ as }) => as === CLOSES_GAP).map(({ to }) => to);

/** `supersedes` do antigo, `closes-gap` copiadas dele e as lacunas novas de `closes` sem repetir as copiadas. */
function relationsOf(previous: VigentRule | undefined, closes: string[]): PlannedRelation[] {
  const copied = previous?.out.filter(({ as }) => as === CLOSES_GAP) ?? [];
  const known = new Set(copied.map(({ to }) => to));
  const added = [...new Set(closes)].filter((gap) => !known.has(gap));
  return [
    ...(previous ? [{ kind: 'supersedes', to: previous.id }] : []),
    ...copied,
    ...added.map((to) => ({ to, as: CLOSES_GAP })),
  ];
}

function directiveRecords(input: SyncInput, extracted: ExtractedRule[]): PlannedRecord[] {
  const { docSlug, hash, vigent } = input;
  const bySlug = new Map(vigent.map((rule) => [slugOf(docSlug, rule), rule]));

  return extracted.flatMap(({ slug, rule, section, closes = [] }): PlannedRecord[] => {
    const previous = bySlug.get(slug);
    // `closes-gap` só se grava na criação do registro: lacuna nova numa regra igual exige registro novo.
    const unchanged =
      previous?.rule === rule &&
      previous.section === section &&
      closes.every((gap) => closedGaps(previous).includes(gap));
    if (unchanged) return [];
    return [
      {
        type: 'directive',
        target: `${targetPrefix(docSlug)}${slug}`,
        data: { rule, section, source: hash },
        relations: relationsOf(previous, closes),
      },
    ];
  });
}

function chunk<T>(items: T[], size: number): T[][] {
  return Array.from({ length: Math.ceil(items.length / size) }, (_, index) =>
    items.slice(index * size, (index + 1) * size),
  );
}

/**
 * Planeja o sync de um documento. A regra de `extracted` sem par em `vigent` vira registro novo; com
 * par e `rule` ou `section` diferentes, registro novo que supera o antigo e copia as relações
 * `closes-gap` dele; com dados iguais, nenhum registro (salvo `closes` com lacuna que a versão
 * vigente ainda não fecha). O `doc` novo supera o vigente, revoga as
 * regras que sumiram e entra por último, para que falha entre lotes deixe o hash desencontrado e a
 * próxima abertura repita o sync.
 */
export function planSync(input: SyncInput): SyncPlan {
  if (isUpToDate(input)) return { upToDate: true, batches: [], warnings: [] };

  const { docSlug, path, hash, current, vigent, extracted } = input;
  const kept = new Set((extracted ?? []).map(({ slug }) => slug));
  const revoked = vigent.filter((rule) => !kept.has(slugOf(docSlug, rule)));
  const warnings = revoked.flatMap((rule): SyncWarning[] => {
    const gaps = closedGaps(rule);
    return gaps.length === 0 ? [] : [{ code: 'reopens-gap', rule: slugOf(docSlug, rule), gaps }];
  });
  if (revoked.length > REVOKES_MAX) {
    return { upToDate: false, batches: [], warnings, error: 'too-many-relations' };
  }

  // A lápide guarda o hash da última versão: o arquivo já não existe para ser lido.
  const source = extracted === null ? (current?.source ?? hash) : hash;
  const doc: PlannedRecord = {
    type: 'doc',
    target: `directives.${docSlug}`,
    data: { path, source, ...(extracted === null && { removed: true }) },
    relations: [
      ...(current ? [{ kind: 'supersedes', to: current.id }] : []),
      ...revoked.map(({ id }) => ({ kind: 'revokes', to: id })),
    ],
  };
  const records = [...directiveRecords(input, extracted ?? []), doc];

  const batches = chunk(records, BATCH_MAX).map((batch) => ({
    key: `sync-${docSlug}-${source.slice(0, 12)}-${sha256(JSON.stringify(batch)).slice(0, 12)}`,
    records: batch,
  }));
  return { upToDate: false, batches, warnings };
}
