// Planejador de sync dos documentos de `docs/directives/` com o processo de diretrizes. Puro: sem
// I/O e sem dependência, para a skill executar o mesmo código que a spec ensaia. O que grava e o
// que lê do servidor é da skill; aqui só se decide quais registros entram, em que lotes.
//
// O documento `estrategia` (`STRATEGY_DOC`) carrega premissas, não regras técnicas: cada regra
// extraída vira um registro `premise` em vez de `directive`. O mapeamento é este:
// - `rule` é o `statement` da premissa; `data` é só `{ statement }`, sem `section` nem `source`;
// - `section` e `closes` são ignorados (o tema `##` não vai ao registro e a premissa nunca grava
//   `closes-gap`);
// - a igualdade com a vigente compara só o `statement`, e a relação do registro é só o `supersedes`
//   da vigente;
// - o `doc` do documento segue como nos demais, com `source` e `revokes` das premissas sumidas.
// Quem consulta o vigente de `estrategia` lê `premise` e devolve `data.statement` como `rule`.
import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';

const BATCH_MAX = 50;
// Um registro leva até 100 relações; o `doc` carrega um `supersedes` e um `revokes` por regra sumida.
const REVOKES_MAX = 99;
const CLOSES_GAP = 'closes-gap';
export const STRATEGY_DOC = 'estrategia';
const DOC_PATH = /^docs\/directives\/[a-z0-9-]+\.md$/;
const PREMISE_LINE = /^- `([a-z0-9][a-z0-9-]{0,62})`: (.+)$/;
const VER_SEPARATOR = ' Ver: ';
// Tetos dos tipos `directive` e `premise` de `.hexlog/types/`; `test/sync.spec.ts` confere a igualdade.
export const RULE_MAX_CODE_POINTS = 400;
export const SECTION_MAX_CODE_POINTS = 120;
export const STATEMENT_MAX_CODE_POINTS = 255;
const SLUG_FORMAT = /^[a-z0-9][a-z0-9-]{0,62}$/;
const SLUG_MAX = 63;

/** Relação de saída de um registro vigente, como o `query` a devolve. */
type OutRelation = { as?: string; kind: string; to: string };

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

type PlannedRelation = { to: string; kind?: string; as?: string };

/** Registro no formato de entrada do `register`. */
export type PlannedRecord = {
  type: 'directive' | 'premise' | 'doc';
  target: string;
  data: Record<string, string | boolean>;
  relations: PlannedRelation[];
};

type SyncBatch = { key: string; records: PlannedRecord[] };

/** Regra revogada que fechava lacunas: as lacunas voltam a pendente e o gate `gaps` falha. */
type SyncWarning = { code: 'reopens-gap'; rule: string; gaps: string[] };

export type SyncPlan = {
  upToDate: boolean;
  batches: SyncBatch[];
  warnings: SyncWarning[];
  error?: 'too-many-relations' | 'invalid-path';
};

export const sha256 = (data: string | Uint8Array): string =>
  createHash('sha256').update(data).digest('hex');

/** Premissa lida de uma linha do documento, com o tema `##` em que está e o trecho `Ver:` final. */
export type ScannedPremise = {
  theme: string;
  slug: string;
  statement: string;
  ver: string | undefined;
};

/** Blocos de código cercados (```) trazem exemplos de sintaxe, não premissas. */
const withoutFencedCodeBlocks = (text: string): string => text.replace(/```[\s\S]*?```/g, '');

/** Cada `##` abre um tema e cada linha `- ` dele é uma premissa ou uma linha malformada. */
export function scanPremises(text: string): { premises: ScannedPremise[]; malformed: string[] } {
  const premises: ScannedPremise[] = [];
  const malformed: string[] = [];
  let theme = '';
  for (const line of withoutFencedCodeBlocks(text).split('\n')) {
    const heading = /^##\s+(.+?)\s*$/.exec(line);
    if (heading?.[1] !== undefined) {
      theme = heading[1];
      continue;
    }
    if (!line.startsWith('- ')) continue;
    const match = PREMISE_LINE.exec(line);
    if (match?.[1] === undefined || match[2] === undefined) {
      malformed.push(line);
      continue;
    }
    const rest = match[2];
    // O statement pode conter `: `; o `Ver:` é sempre o último trecho da linha.
    const verAt = rest.lastIndexOf(VER_SEPARATOR);
    premises.push({
      theme,
      slug: match[1],
      statement: verAt === -1 ? rest : rest.slice(0, verAt),
      ver: verAt === -1 ? undefined : rest.slice(verAt + VER_SEPARATOR.length),
    });
  }
  return { premises, malformed };
}

/**
 * Extrai as premissas de `estrategia.md` como regras do `planSync` (`section` sempre vazia). Linha
 * malformada, slug repetido e statement fora de 1 a 255 code points entram em `malformed` e nunca
 * em `rules`.
 */
export function parsePremises(text: string): { rules: ExtractedRule[]; malformed: string[] } {
  const scanned = scanPremises(text);
  const malformed = [...scanned.malformed];
  const rules: ExtractedRule[] = [];
  const seen = new Set<string>();
  for (const { slug, statement } of scanned.premises) {
    const length = [...statement].length;
    if (seen.has(slug)) {
      malformed.push(`duplicate slug "${slug}"`);
    } else if (length < 1 || length > STATEMENT_MAX_CODE_POINTS) {
      malformed.push(`statement of "${slug}" has ${length} code points (allowed 1 to 255)`);
    } else {
      rules.push({ slug, rule: statement, section: '' });
    }
    seen.add(slug);
  }
  return { rules, malformed };
}

/** O `path` do `doc` é sempre `docs/directives/<docSlug>.md`: vazio, absoluto e outro destino são inválidos. */
export const invalidDocPath = ({ docSlug, path }: Pick<SyncInput, 'docSlug' | 'path'>): boolean =>
  !DOC_PATH.test(path) || path !== `docs/directives/${docSlug}.md`;

function isUpToDate({ current, vigent, extracted, hash }: SyncInput): boolean {
  if (extracted === null) {
    return current === null ? vigent.length === 0 : current.removed === true;
  }
  return current !== null && current.removed !== true && current.source === hash;
}

const targetPrefix = (docSlug: string): string => `directives.${docSlug}.`;
const slugOf = (docSlug: string, { target }: VigentRule): string =>
  target.slice(targetPrefix(docSlug).length);

const closesGapRelations = ({ out }: VigentRule): OutRelation[] =>
  out.filter(({ as }) => as === CLOSES_GAP);

const closedGaps = (rule: VigentRule): string[] => closesGapRelations(rule).map(({ to }) => to);

/** `supersedes` do antigo, `closes-gap` copiadas dele e as lacunas novas de `closes` sem repetir as copiadas. */
function relationsOf(previous: VigentRule | undefined, closes: string[]): PlannedRelation[] {
  const copied = previous ? closesGapRelations(previous) : [];
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

  if (docSlug === STRATEGY_DOC) {
    return extracted.flatMap(({ slug, rule }): PlannedRecord[] => {
      const previous = bySlug.get(slug);
      if (previous?.rule === rule) return [];
      return [
        {
          type: 'premise',
          target: `${targetPrefix(docSlug)}${slug}`,
          data: { statement: rule },
          relations: previous ? [{ kind: 'supersedes', to: previous.id }] : [],
        },
      ];
    });
  }

  return extracted.flatMap(({ slug, rule, section, closes = [] }): PlannedRecord[] => {
    const previous = bySlug.get(slug);
    if (previous?.rule === rule && previous.section === section) {
      // `closes-gap` só se grava na criação do registro: lacuna nova exige registro novo.
      const closed = closedGaps(previous);
      if (closes.every((gap) => closed.includes(gap))) return [];
    }
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

const batchesOf = (docSlug: string, source: string, records: PlannedRecord[]): SyncBatch[] =>
  chunk(records, BATCH_MAX).map((batch) => ({
    key: `sync-${docSlug}-${source.slice(0, 12)}-${sha256(JSON.stringify(batch)).slice(0, 12)}`,
    records: batch,
  }));

/**
 * Planeja o sync de um documento. Antes de tudo, `path` fora de `docs/directives/<docSlug>.md`
 * devolve `error: 'invalid-path'` sem lote. A regra de `extracted` sem par em `vigent` vira registro novo; com
 * par e `rule` ou `section` diferentes, registro novo que supera o antigo e copia as relações
 * `closes-gap` dele; com dados iguais, nenhum registro (salvo `closes` com lacuna que a versão
 * vigente ainda não fecha). O `doc` novo supera o vigente, revoga as regras que sumiram e entra por
 * último, para que falha entre lotes deixe o hash desencontrado e a próxima abertura repita o sync.
 * Com o documento em dia, só a regra com lacuna nova em `closes` ganha registro, sem `doc` novo
 * (em `estrategia`, `closes` é ignorado e o documento em dia nunca gera registro).
 */
export function planSync(input: SyncInput): SyncPlan {
  const { docSlug, path, hash, current, vigent, extracted } = input;
  if (invalidDocPath(input)) {
    return { upToDate: false, batches: [], warnings: [], error: 'invalid-path' };
  }
  if (isUpToDate(input)) {
    const closing =
      docSlug === STRATEGY_DOC
        ? []
        : (extracted ?? []).filter(({ closes }) => (closes?.length ?? 0) > 0);
    const records = directiveRecords(input, closing);
    return {
      upToDate: records.length === 0,
      batches: batchesOf(docSlug, hash, records),
      warnings: [],
    };
  }

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
  return { upToDate: false, batches: batchesOf(docSlug, source, records), warnings };
}

/**
 * Campo fora do limite: `slug` (formato do segmento do target; `max` é o comprimento máximo),
 * `duplicate-slug` (`size` é quantas vezes repete e `max` é 1) ou o texto medido em code points.
 */
export type Excess = {
  slug: string;
  field: 'rule' | 'section' | 'statement' | 'slug' | 'duplicate-slug';
  size: number;
  max: number;
};

function measure(slug: string, field: Excess['field'], text: string, max: number): Excess[] {
  const size = [...text].length;
  return size >= 1 && size <= max ? [] : [{ slug, field, size, max }];
}

/**
 * Confere as regras extraídas contra os tetos dos tipos antes de qualquer gravação: `rule` de 1 a
 * 400 e `section` de 1 a 120 code points, `statement` de 1 a 255 em `estrategia` (que não tem
 * `section`), slug no formato do target e sem repetição. Devolve o tamanho medido de cada excesso.
 */
export function validateExtracted(docSlug: string, rules: readonly ExtractedRule[]): Excess[] {
  const strategy = docSlug === STRATEGY_DOC;
  const perRule = rules.flatMap(({ slug, rule, section }): Excess[] => [
    ...(SLUG_FORMAT.test(slug)
      ? []
      : [{ slug, field: 'slug' as const, size: [...slug].length, max: SLUG_MAX }]),
    ...(strategy
      ? measure(slug, 'statement', rule, STATEMENT_MAX_CODE_POINTS)
      : [
          ...measure(slug, 'rule', rule, RULE_MAX_CODE_POINTS),
          ...measure(slug, 'section', section, SECTION_MAX_CODE_POINTS),
        ]),
  ]);
  const repeated = [...Map.groupBy(rules, ({ slug }) => slug)]
    .filter(([, group]) => group.length > 1)
    .map(([slug, group]): Excess => ({
      slug,
      field: 'duplicate-slug',
      size: group.length,
      max: 1,
    }));
  return [...perRule, ...repeated];
}

/** Registro do log relido depois da gravação; de `in` só o `kind` importa, para a vigência. */
export type LogRow = {
  id: string;
  target: string;
  data: Record<string, unknown>;
  out: OutRelation[];
  in: { kind: string }[];
};

export type SyncProblem = {
  target: string;
  problem: 'missing' | 'source-differs' | 'data-differs' | 'relations-differ' | 'old-still-current';
};

const REPLACING_KINDS = ['supersedes', 'revokes'];

/** Vigência como o servidor a vê: sem `supersedes` nem `revokes` de entrada. */
export const isCurrent = ({ in: incoming }: { in: readonly { kind: string }[] }): boolean =>
  !incoming.some(({ kind }) => REPLACING_KINDS.includes(kind));

/** `as ?? kind` e o destino: a relação nomeada e a crua se comparam pelo nome que o servidor guarda. */
const edgeKeys = (edges: readonly { kind?: string; as?: string; to: string }[]): string[] =>
  edges.map(({ kind, as, to }) => `${as ?? kind}|${to}`).sort();

/**
 * Confere o log relido contra o plano gravado: o vigente em cada `target` planejado tem `data` e
 * relações de saída iguais às planejadas (no `doc`, o `source` igual ao hash do plano), e nenhum
 * registro que o plano supera ou revoga segue vigente.
 */
export function verifySync(plan: SyncPlan, rowsAfter: readonly LogRow[]): SyncProblem[] {
  const current = rowsAfter.filter(isCurrent);
  const records = plan.batches.flatMap(({ records: batch }) => batch);
  const problems: SyncProblem[] = [];
  for (const { type, target, data, relations } of records) {
    const row = current.find((candidate) => candidate.target === target);
    if (row === undefined) {
      problems.push({ target, problem: 'missing' });
      continue;
    }
    if (type === 'doc' && row.data.source !== data.source) {
      problems.push({ target, problem: 'source-differs' });
    } else if (!isDeepStrictEqual(row.data, data)) {
      problems.push({ target, problem: 'data-differs' });
    }
    if (!isDeepStrictEqual(edgeKeys(row.out), edgeKeys(relations))) {
      problems.push({ target, problem: 'relations-differ' });
    }
  }
  const replaced = new Set(
    records.flatMap(({ relations }) =>
      relations.filter(({ kind }) => REPLACING_KINDS.includes(kind ?? '')).map(({ to }) => to),
    ),
  );
  for (const row of current.filter(({ id }) => replaced.has(id))) {
    problems.push({ target: row.target, problem: 'old-still-current' });
  }
  return problems;
}
