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

const BATCH_MAX = 50;
// Um registro leva até 100 relações; o `doc` carrega um `supersedes` e um `revokes` por regra sumida.
const REVOKES_MAX = 99;
const CLOSES_GAP = 'closes-gap';
export const STRATEGY_DOC = 'estrategia';
const DOC_PATH = /^docs\/directives\/[a-z0-9-]+\.md$/;
const PREMISE_LINE = /^- `([a-z0-9][a-z0-9-]{0,62})`: (.+)$/;
const VER_SEPARATOR = ' Ver: ';
const STATEMENT_MAX_CODE_POINTS = 255;

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
  type: 'directive' | 'premise' | 'doc';
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
