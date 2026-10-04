import { isUndefined, omitBy, pick } from 'es-toolkit';
import type { Link } from '../domain/chain.ts';
import { attachmentFields } from '../domain/definitions.ts';
import { evaluateGate, type GateResult } from '../domain/gate.ts';
import {
  Hash,
  processOf,
  type Marker,
  type Name,
  type RecordId,
  type Target,
} from '../domain/ids.ts';
import { needsReview, type NeedsReview } from '../domain/relations.ts';
import { HexlogError, invalidInput } from '../errors.ts';
import type {
  AttachmentReader,
  AttachmentStatus,
  DefinitionKind,
  DefinitionReader,
  Manifest,
  ProcessReader,
  SearchIndex,
} from '../ports.ts';
import { loadVerified, MAX_BREAKS, type Chain } from '../shared/loader.ts';
import { sliceChars } from '../shared/pages.ts';
import {
  decodeCursor,
  encodeCursor,
  filtersHash,
  invalidCursor,
  type CursorPayload,
} from './cursor.ts';
import { projectNotFound, readScope, type Reading, type ReadTarget } from './read.ts';
import {
  buildView,
  indexRef,
  inOutputOrder,
  leftReason,
  relationsOf,
  select,
  type Filters,
  type InRelation,
  type LeftReason,
  type OutRelation,
  type View,
} from './select.ts';

const DEFAULT_LIMIT = 50;
/**
 * Teto de `text` em caracteres: o custo da busca cresce com os termos distintos (AND mais o
 * fallback OR; 183 KB deram 2,4 s sobre 5.000 registros). Mesmo número do 0.x
 * (`SEARCH_MAX_CHARS`); a F5 reusa a constante no `.max()` do zod.
 */
export const QUERY_TEXT_MAX_CHARS = 200;
/** Padrão de `readAttachment` chamado sem `maxChars`; o kernel MCP sempre passa `PAGE_CHARS_CAP` (D-20). */
const ATTACHMENT_PAGE_CHARS = 24_000;

export type QueryInput = Filters & {
  project: Name;
  /** Obrigatório no alcance processo (o padrão). */
  process?: Name;
  scope?: 'process' | 'project';
  /** Registros por página (padrão 50); `maxChars` pode encurtar a página. */
  limit?: number;
  cursor?: string;
  /**
   * Marcador de uma consulta anterior: `changes` diz o que entrou e saiu do resultado desde então,
   * só na 1ª página. Entra no hash dos filtros que o cursor prende (`hashOf`): da página 2 em diante,
   * reenvie o mesmo `changesSince` com o `cursor`, senão `INVALID_CURSOR` (`filters-mismatch`).
   * O marcador vale só para o alcance em que foi emitido: no alcance projeto, o que ele não nomeia
   * é lido como vazio (o do `register` nomeia um processo só e acrescenta ids a `changes.entered`).
   */
  changesSince?: Marker;
  /** Teto de caracteres do JSON da página (D-20); o 1º registro sai inteiro mesmo acima dele. */
  maxChars?: number;
};

export type QueryRecord = Pick<Link, 'id' | 'type' | 'at' | 'target' | 'author' | 'data'> & {
  in: InRelation[];
  out: OutRelation[];
  /** D-09: só registro vigente com apoio morto. */
  needsReview?: NeedsReview;
  /** D-16: estado de cada anexo citado nos campos marcados do tipo. */
  attachmentStatus?: Record<Hash, AttachmentStatus>;
};

export type Changes = {
  entered: RecordId[];
  left: { id: RecordId; reason: LeftReason }[];
  marker: Marker;
};

export type QueryResult = {
  records: QueryRecord[];
  /** Ausente na última página. */
  cursor?: string;
  /** D-24: exatamente os processos lidos. */
  marker: Marker;
  /** Só na 1ª página e só com `changesSince`. */
  changes?: Changes;
};

export type EvaluateGateInput = {
  project: Name;
  /** Processo onde o gate está fixado; é o lido, salvo pergunta com `scope: "project"`. */
  process: Name;
  gate: Name;
  /** Herdado pelos seletores sem `targetPrefix`. */
  target?: Target;
  /** Marcador de uma leitura anterior: a avaliação se reproduz sobre o que existia então (SG3). */
  marker?: Marker;
};

/** `passed` e a evidência de cada pergunta, mais o marcador dos processos lidos (D-24). */
export type GateEvaluation = GateResult & { marker: Marker };

export type VerifyChainInput = { project: Name; process: Name };

/** D-16: anexo citado por um registro que não está inteiro no projeto. */
export type AttachmentBreak = {
  id: RecordId;
  hash: Hash;
  reason: 'attachment-missing' | 'attachment-corrupted';
};

/**
 * `breaks` e `totalBreaks` são só da cadeia do log; os anexos vão em `attachmentBreaks` e
 * `totalAttachmentBreaks`, cada lista cortada em `MAX_BREAKS`. `ok` exige as duas vazias.
 */
export type VerifyChainResult = Chain & {
  attachmentBreaks: AttachmentBreak[];
  totalAttachmentBreaks: number;
};

export type ListInput = { project?: Name; process?: Name };

/** Definição do projeto: `version` é a mais nova, `versions` todas em ordem crescente. */
export type DefinitionSummary = { name: Name; version: string; versions: string[] };

export type ListResult = {
  /** Sem `project`: um item por projeto. */
  projects?: { name: Name; processes: number }[];
  /** Só `project`: os processos e as definições vigentes dele. */
  project?: {
    name: Name;
    processes: { name: Name; createdAt: string }[];
  } & Record<DefinitionKind, DefinitionSummary[]>;
  /** `project` e `process`: o que o manifesto do processo fixou. */
  process?: {
    name: Name;
    createdAt: string;
    pinned: Record<DefinitionKind, Name[]>;
    hashes: Manifest['hashes'];
  };
};

export type ReadAttachmentInput = {
  project: Name;
  hash: Hash;
  /** Posição em caracteres; o `next` da página anterior. */
  offset?: number;
  maxChars?: number;
};

export type AttachmentPage = {
  text: string;
  /** Offset da próxima página; ausente na última. */
  next?: number;
  /** Sempre `ok`: anexo ausente ou corrompido não devolve página, lança. */
  status: 'ok';
};

export type QueryService = {
  /**
   * D-24: lê o alcance pedido pelo carregador único e devolve os registros vigentes que passam nos
   * filtros (todos, com `includeNonCurrent`), com relações de entrada e saída, `needsReview` e
   * `attachmentStatus`. Ordem de saída: alcance processo por `seq`, alcance projeto por (`at`,
   * processo, `seq`), com `text` por relevância e o mesmo desempate. Página com resultado leva ao
   * menos um registro (o 1º sai inteiro mesmo acima de `maxChars`); consulta sem resultado devolve
   * `records: []`. O cursor (D-20) fixa o marcador: as páginas seguintes recomeçam depois de
   * `lastId` sobre a leitura da página 1.
   *
   * `INVALID_FILTER` (`/process`, `/limit`, `/text`: acima de `QUERY_TEXT_MAX_CHARS` ou sem termo
   * pesquisável, `no-terms`, como `''`, `'  '` e `'!!!'`),
   * `INVALID_CURSOR`, `MARKER_NOT_FOUND`, `PROJECT_NOT_FOUND` (alcance projeto), `PROCESS_NOT_FOUND`,
   * `PROCESS_CORRUPTED` (com `details[0].process`), `PROCESS_TOO_LARGE` e `IO_ERROR`.
   */
  queryRecords(input: QueryInput): QueryResult;
  /**
   * D-24: só calcula, nunca grava. Lê o processo do gate e, se alguma pergunta declara
   * `scope: "project"`, o projeto inteiro, pelo mesmo carregador de `queryRecords`; o marcador
   * devolvido cobre exatamente o que foi lido. A cadeia é verificada até onde a leitura vai: com
   * `marker`, só o prefixo até o id marcado: quebra depois dele não é vista.
   *
   * `PROCESS_NOT_FOUND`, `GATE_NOT_FOUND` (`unknown-name` em `/gate`: o gate não está fixado no
   * processo), `MARKER_NOT_FOUND`, `PROCESS_CORRUPTED` (com `details[0].process`),
   * `PROCESS_TOO_LARGE` e `IO_ERROR`.
   */
  evaluateGate(input: EvaluateGateInput): GateEvaluation;
  /**
   * Diagnóstico sem gravar: a cadeia do processo e os anexos que os registros citam (D-16). Quebra
   * não lança, vira `ok: false` com `breaks` (cadeia); anexo ausente ou corrompido entra em
   * `attachmentBreaks` como `attachment-missing`/`attachment-corrupted`. `PROCESS_NOT_FOUND` e
   * `PROCESS_CORRUPTED` (`unreadable-manifest`) vêm da leitura do manifesto; `PROCESS_TOO_LARGE` e
   * `IO_ERROR`, da leitura do log.
   */
  verifyChain(input: VerifyChainInput): VerifyChainResult;
  /**
   * Sem `project`, os projetos; com `project`, os processos e as definições dele; com `project` e
   * `process`, o que o manifesto fixou. `PROJECT_NOT_FOUND`, `PROCESS_NOT_FOUND`, `INVALID_INPUT`
   * (`/project`, `/process` sem `project`), `PROCESS_CORRUPTED` (`unreadable-manifest`) e `IO_ERROR`.
   */
  list(input: ListInput): ListResult;
  /**
   * Uma página do texto do anexo, já conferido contra o sha256 dos bytes pela porta.
   * `ATTACHMENT_NOT_FOUND`, `ATTACHMENT_CORRUPTED`, `INVALID_INPUT` (`/offset` além do fim) e
   * `IO_ERROR`.
   */
  readAttachment(input: ReadAttachmentInput): AttachmentPage;
};

function invalidFilter(path: string, code: string, message: string): HexlogError {
  return new HexlogError('INVALID_FILTER', 'Invalid filter', [{ path, code, message }]);
}

function gateNotFound(): HexlogError {
  const message = 'gate is not pinned in the process';
  return new HexlogError('GATE_NOT_FOUND', message, [
    { path: '/gate', code: 'unknown-name', message },
  ]);
}

function targetOf({ project, scope = 'process', process }: QueryInput): ReadTarget {
  if (scope === 'project') return { project, scope };
  if (process === undefined) {
    throw invalidFilter('/process', 'required', 'process is required with scope "process"');
  }
  return { project, scope, process };
}

/** `no-terms` vem depois de `too-long` para nunca tokenizar um texto acima do teto. */
function assertValid({ limit, text }: QueryInput, search: SearchIndex): void {
  if (limit !== undefined && !(Number.isInteger(limit) && limit >= 1)) {
    throw invalidFilter('/limit', 'out-of-range', 'limit must be a positive integer');
  }
  if (text === undefined) return;
  if (text.length > QUERY_TEXT_MAX_CHARS) {
    throw invalidFilter(
      '/text',
      'too-long',
      `text must have at most ${QUERY_TEXT_MAX_CHARS} characters`,
    );
  }
  if (search.terms(text).length === 0) {
    throw invalidFilter(
      '/text',
      'no-terms',
      'text must have at least one searchable term; spaces and punctuation alone match nothing',
    );
  }
}

const FILTER_KEYS = [
  'includeNonCurrent',
  'type',
  'targetPrefix',
  'where',
  'text',
  'ids',
  'relatedTo',
] as const;

/**
 * D-20: o hash prende os filtros e `changesSince`, não a página (`limit`, `maxChars`). O JCS descarta
 * chave `undefined`, então filtro ou `changesSince` ausente não entra no hash.
 */
function hashOf(filters: Filters, changesSince: Marker | undefined): Hash {
  return filtersHash({
    ...filters,
    includeNonCurrent: filters.includeNonCurrent ?? false,
    changesSince,
  });
}

/** D-20: alcance, projeto, processo e filtros da página têm de ser os do cursor. */
function assertSameQuery(
  cursor: CursorPayload,
  target: ReadTarget,
  process: Name | undefined,
  hash: Hash,
): void {
  const mismatch = [
    { differs: cursor.scope !== target.scope, code: 'scope-mismatch' },
    { differs: cursor.project !== target.project, code: 'project-mismatch' },
    { differs: cursor.process !== process, code: 'process-mismatch' },
    { differs: cursor.filtersHash !== hash, code: 'filters-mismatch' },
  ].find(({ differs }) => differs);
  if (mismatch !== undefined) {
    throw invalidCursor(mismatch.code, 'Cursor was issued for a different query');
  }
}

/** D-20: o conteúdo lido até o marcador tem de ser o que o cursor viu (mesmo hash de cabeça). */
function assertSameContent(cursor: CursorPayload, reading: Reading): void {
  const names = new Set([
    ...Object.keys(cursor.markerHashes),
    ...Object.keys(reading.markerHashes),
  ]);
  for (const name of names) {
    // Processo que nasceu depois da página 1 é lido como vazio e não está no cursor.
    const seen = Object.hasOwn(cursor.markerHashes, name) ? cursor.markerHashes[name] : null;
    const read = Object.hasOwn(reading.markerHashes, name) ? reading.markerHashes[name] : null;
    if (seen !== read) {
      throw invalidCursor('marker-hash-mismatch', 'Cursor marker does not match the process log');
    }
  }
}

function startAfter(selected: readonly Link[], lastId: RecordId): number {
  const at = selected.findIndex((link) => link.id === lastId);
  if (at === -1) throw invalidCursor('last-id-not-found', 'Cursor record is not in the result');
  return at + 1;
}

export function createQueryService(deps: {
  store: ProcessReader;
  definitions: DefinitionReader;
  attachments: AttachmentReader;
  search: SearchIndex;
}): QueryService {
  const { store, definitions, attachments, search } = deps;

  const summariesOf = (project: Name, kind: DefinitionKind): DefinitionSummary[] =>
    definitions.names(project, kind).flatMap((name) => {
      const versions = definitions.versions(project, kind, name);
      const version = versions.at(-1);
      return version === undefined ? [] : [{ name, version, versions }];
    });

  /** D-16: estado dos anexos que `link` cita nos campos marcados do tipo fixado no processo dele. */
  function attachmentStatusOf(
    project: Name,
    manifest: Manifest | undefined,
    link: Link,
  ): Record<Hash, AttachmentStatus> | undefined {
    const schema = manifest?.fixed.types[link.type];
    if (schema === undefined) return undefined;
    const hashes = attachmentFields(schema)
      .flatMap((field) => [link.data[field]].flat())
      .filter((value): value is Hash => Hash.safeParse(value).success);
    if (hashes.length === 0) return undefined;
    return Object.fromEntries(hashes.map((hash) => [hash, attachments.status(project, hash)]));
  }

  /** D-26: o que mudou no resultado entre o marcador de `changesSince` e a leitura de agora. */
  function changesOf(
    input: QueryInput,
    target: ReadTarget,
    filters: Filters,
    now: { view: View; selected: readonly Link[]; marker: Marker },
  ): Changes {
    const past = buildView(
      readScope(store, target, input.changesSince, '/changesSince'),
      target.scope,
    );
    const before = select(past, filters, search, indexRef(target));
    const beforeIds = new Set(before.map(({ id }) => id));
    const nowIds = new Set(now.selected.map(({ id }) => id));
    return {
      entered: now.selected.filter(({ id }) => !beforeIds.has(id)).map(({ id }) => id),
      left: before
        .filter(({ id }) => !nowIds.has(id))
        .map(({ id }) => ({ id, reason: leftReason(now.view, id) })),
      marker: now.marker,
    };
  }

  return {
    queryRecords(input) {
      assertValid(input, search);
      const target = targetOf(input);
      const filters: Filters = omitBy(pick(input, FILTER_KEYS), isUndefined);
      const hash = hashOf(filters, input.changesSince);
      const cursor = input.cursor === undefined ? undefined : decodeCursor(input.cursor);
      if (cursor !== undefined) assertSameQuery(cursor, target, input.process, hash);

      const reading = readScope(store, target, cursor?.marker, '/cursor');
      if (cursor !== undefined) assertSameContent(cursor, reading);
      const view = buildView(reading, target.scope);
      const selected = select(view, filters, search, indexRef(target));

      const reviews = needsReview(view.records);
      const manifests = new Map(
        reading.processes.map(({ name, verified }) => [name, verified.manifest]),
      );
      const render = (link: Link): QueryRecord => {
        const review = reviews.get(link.id);
        const status = attachmentStatusOf(target.project, manifests.get(processOf(link.id)), link);
        return {
          ...pick(link, ['id', 'type', 'at', 'target', 'author', 'data']),
          ...relationsOf(view, link),
          ...(review === undefined ? {} : { needsReview: review }),
          ...(status === undefined ? {} : { attachmentStatus: status }),
        };
      };

      const start = cursor === undefined ? 0 : startAfter(selected, cursor.lastId);
      const { limit = DEFAULT_LIMIT, maxChars = Infinity } = input;
      const records: QueryRecord[] = [];
      let chars = 0;
      for (const link of selected.slice(start, start + limit)) {
        const record = render(link);
        chars += JSON.stringify(record).length;
        if (records.length > 0 && chars > maxChars) break;
        records.push(record);
      }

      const last = records.at(-1);
      const more = last !== undefined && start + records.length < selected.length;
      const next: CursorPayload | undefined = more
        ? {
            scope: target.scope,
            project: target.project,
            ...(input.process === undefined ? {} : { process: input.process }),
            marker: reading.marker,
            markerHashes: reading.markerHashes,
            filtersHash: hash,
            lastId: last.id,
          }
        : undefined;
      const changes =
        cursor === undefined && input.changesSince !== undefined
          ? changesOf(input, target, filters, { view, selected, marker: reading.marker })
          : undefined;
      return {
        records,
        ...(next === undefined ? {} : { cursor: encodeCursor(next) }),
        marker: reading.marker,
        ...(changes === undefined ? {} : { changes }),
      };
    },

    evaluateGate({ project, process, gate: name, target, marker }) {
      const { gates } = store.readManifest({ project, process }).fixed;
      if (!Object.hasOwn(gates, name)) throw gateNotFound();
      const gate = gates[name]!;
      const scope: ReadTarget = gate.questions.some((question) => question.scope === 'project')
        ? { project, scope: 'project' }
        : { project, scope: 'process', process };
      const reading = readScope(store, scope, marker);
      const result = evaluateGate(gate.questions, {
        target,
        records: (questionScope) =>
          questionScope === 'project'
            ? inOutputOrder(reading, 'project')
            : reading.processes
                .filter(({ name: read }) => read === process)
                .flatMap(({ verified }) => verified.records),
      });
      return { ...result, marker: reading.marker };
    },

    verifyChain({ project, process }) {
      const { manifest, records, chain } = loadVerified(store, { project, process });
      const broken = records.flatMap((link): AttachmentBreak[] =>
        Object.entries(attachmentStatusOf(project, manifest, link) ?? {}).flatMap(
          ([hash, status]) =>
            status === 'ok' ? [] : [{ id: link.id, hash, reason: `attachment-${status}` }],
        ),
      );
      return {
        ...chain,
        ok: chain.ok && broken.length === 0,
        attachmentBreaks: broken.slice(0, MAX_BREAKS),
        totalAttachmentBreaks: broken.length,
      };
    },

    list({ project, process }) {
      if (project === undefined) {
        if (process !== undefined) {
          throw invalidInput('/project', 'required', 'project is required with process');
        }
        return {
          projects: store
            .listProjects()
            .map((name) => ({ name, processes: store.list(name).length })),
        };
      }
      if (!store.listProjects().includes(project)) throw projectNotFound();
      if (process !== undefined) {
        const { createdAt, fixed, hashes } = store.readManifest({ project, process });
        return {
          process: {
            name: process,
            createdAt,
            pinned: {
              types: Object.keys(fixed.types),
              relations: Object.keys(fixed.relations),
              gates: Object.keys(fixed.gates),
            },
            hashes,
          },
        };
      }
      return {
        project: {
          name: project,
          processes: store.list(project).map((name) => ({
            name,
            createdAt: store.readManifest({ project, process: name }).createdAt,
          })),
          types: summariesOf(project, 'types'),
          relations: summariesOf(project, 'relations'),
          gates: summariesOf(project, 'gates'),
        },
      };
    },

    readAttachment({ project, hash, offset = 0, maxChars = ATTACHMENT_PAGE_CHARS }) {
      const text = attachments.read(project, hash);
      if (offset > text.length) {
        throw invalidInput('/offset', 'out-of-range', 'offset is past the end of the attachment');
      }
      const page = sliceChars(text, offset, maxChars);
      return {
        text: page.text,
        ...(page.nextOffset === null ? {} : { next: page.nextOffset }),
        status: 'ok',
      };
    },
  };
}
