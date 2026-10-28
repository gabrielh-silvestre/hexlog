import { differenceBy, isUndefined, omitBy, once, pick, uniq, union } from 'es-toolkit';
import { hashOfJcs, type Link } from '../domain/chain.ts';
import { attachmentFields } from '../domain/definitions.ts';
import {
  prepareGate,
  summarizeQuestion,
  type EvidenceMode,
  type GateScope,
  type QuestionResult,
  type QuestionSummary,
} from '../domain/gate.ts';
import {
  Hash,
  processOf,
  type Marker,
  type Name,
  type RecordId,
  type Target,
} from '../domain/ids.ts';
import { needsReview, type NeedsReview } from '../domain/relations.ts';
import { gateNotFound, invalidCursor, invalidFilter, invalidInput } from '../errors.ts';
import type { Manifest } from '../domain/manifest.ts';
import type {
  AttachmentReader,
  AttachmentStatus,
  DefinitionReader,
  ProcessReader,
  SearchIndex,
} from '../ports.ts';
import { checkExpectedHead, loadVerified, MAX_BREAKS, type Chain } from '../shared/loader.ts';
import { decodeCursor, encodeCursor, type CursorPayload } from './cursor.ts';
import {
  createDescribeType,
  type DescribeTypeInput,
  type DescribeTypeResult,
} from './describe-type.ts';
import { createList, type ListInput, type ListResult } from './list.ts';
import {
  createReadAttachment,
  type AttachmentPage,
  type ReadAttachmentInput,
} from './read-attachment.ts';
import { readScope, type Reading, type ReadTarget } from './read.ts';
import {
  boundaryHint,
  buildView,
  inheritanceActivation,
  inOutputOrder,
  leftReason,
  RELATION_MODES,
  relationsOf,
  select,
  type Filters,
  type LeftReason,
  type RelationFields,
  type RelationsMode,
  type View,
} from './select.ts';

export { PAGE_CHARS_CAP } from './read-attachment.ts';
export { RELATION_MODES };
export type { AttachmentPage, DescribeTypeResult, ListResult };

const DEFAULT_LIMIT = 50;
/**
 * Teto de `text` em caracteres: o custo da busca cresce com os termos distintos (AND mais o
 * fallback OR; 183 KB deram 2,4 s sobre 5.000 registros). A tool `query` usa a constante no `.max()` do zod.
 */
export const QUERY_TEXT_MAX_CHARS = 200;
export type QueryInput = Filters & {
  project: Name;
  /** Obrigatório no alcance processo (o padrão). */
  process?: Name;
  scope?: 'process' | 'project';
  /**
   * Registros por página (padrão 50); `maxChars` pode encurtar a página. `0` só vale com
   * `changesSince` e sem `cursor`: devolve `records: []` e as `changes`, sem cursor.
   */
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
  /**
   * Nomes de topo de `data` que saem em cada registro; `[]` omite `data`. Recorta só a saída: os
   * filtros veem o `data` inteiro, o teto de página (`maxChars`) conta o registro já recortado e
   * `fields` fica fora do hash do cursor, então cada página pode pedir outros.
   */
  fields?: readonly string[];
  /**
   * Relações de cada registro: `full` (padrão do serviço) traz `in` e `out`; `counts`, `inCounts` e
   * `outCounts` (arestas por nome `as ?? kind` com a outra ponta vigente) e `nonCurrentInCounts` e
   * `nonCurrentOutCounts` (as demais), cada mapa vazio omitido; `none`, nenhum deles.
   * Recorta só a saída, como `fields`: fica fora do hash do cursor, e `relatedTo` e `needsReview`
   * não mudam.
   */
  relations?: RelationsMode;
};

export type QueryRecord = Pick<Link, 'id' | 'type' | 'at' | 'target' | 'author'> &
  RelationFields & {
    /** Inteiro, ou só os `fields` pedidos; ausente com `fields: []`. */
    data?: Link['data'];
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
  /**
   * Só na 1ª página, com `targetPrefix` e seleção vazia em que nenhum target lido o casa, mas algum
   * começa pela string sem a fronteira de `.`. O casamento do `targetPrefix` não muda (D-07).
   */
  hint?: string;
};

export type EvaluateGateInput = {
  project: Name;
  /** Processo onde o gate está fixado; é o lido, salvo pergunta com `scope: "project"`. */
  process: Name;
  gate: Name;
  /** Herdado pelos seletores sem `targetPrefix`. Exclusivo com `targets`. */
  target?: Target;
  /**
   * Lote de targets avaliados numa só leitura, com um só `marker`. Exclusivo com `target` e
   * incompatível com `evidence: "full"` (o padrão do serviço): o lote pede `counts` ou `failing`.
   */
  targets?: readonly Target[];
  /** Marcador de uma leitura anterior: a avaliação se reproduz sobre o que existia então. */
  marker?: Marker;
  /** O quanto de `evidence` cada pergunta traz; o serviço assume `full`, a forma completa. */
  evidence?: EvidenceMode;
};

/** `passed` e a evidência de cada pergunta, mais o marcador dos processos lidos (D-24). */
export type GateEvaluation<Question = QuestionResult> = {
  passed: boolean;
  questions: Question[];
  marker: Marker;
};

/** Lote de `targets`: um resultado por entrada, na ordem recebida; `passed` exige todos. */
export type GateBatchEvaluation = {
  passed: boolean;
  results: { target: Target; passed: boolean; questions: QuestionSummary[] }[];
  marker: Marker;
};

type VerifyChainInput = { project: Name; process: Name; expectedHead?: Hash };

/** D-16: anexo citado por um registro que não está inteiro no projeto. */
type AttachmentBreak = {
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

export type QueryService = {
  /**
   * D-24: lê o alcance pedido pelo carregador único e devolve os registros vigentes que passam nos
   * filtros (todos, com `includeNonCurrent`), com as relações de entrada e saída no modo de
   * `relations`, `needsReview` e `attachmentStatus`. Ordem de saída: alcance processo por `seq`, alcance projeto por (`at`,
   * processo, `seq`), com `text` por relevância e o mesmo desempate. Página com resultado leva ao
   * menos um registro (o 1º sai inteiro mesmo acima de `maxChars`); consulta sem resultado devolve
   * `records: []`, com `hint` quando o `targetPrefix` quase casou. Exceção a "ao menos um
   * registro": `limit: 0`, aceito só com `changesSince` e sem `cursor`, devolve `records: []` e as
   * `changes`, sem cursor. O cursor (D-20) fixa o marcador: as páginas seguintes recomeçam depois
   * de `lastId` sobre a leitura da página 1.
   *
   * `INVALID_FILTER` (`/process`; `/limit`, inteiro >= 1, ou 0 só com `changesSince` e sem
   * `cursor`; `/text`, acima de `QUERY_TEXT_MAX_CHARS` ou sem termo pesquisável, `no-terms`, como
   * `''`, `'  '` e `'!!!'`), `INVALID_CURSOR`, `MARKER_NOT_FOUND`, `PROJECT_NOT_FOUND` (alcance
   * projeto), `PROCESS_NOT_FOUND`, `PROCESS_CORRUPTED` (com `details[0].process`),
   * `PROCESS_TOO_LARGE` e `IO_ERROR`.
   */
  queryRecords(input: QueryInput): QueryResult;
  /**
   * D-24: só calcula, nunca grava. Lê o processo do gate e, se alguma pergunta declara
   * `scope: "project"`, o projeto inteiro, pelo mesmo carregador de `queryRecords`; o marcador
   * devolvido cobre exatamente o que foi lido. A cadeia é verificada até onde a leitura vai: com
   * `marker`, só o prefixo até o id marcado: quebra depois dele não é vista.
   *
   * Com `targets`, lê uma vez e devolve `results` (um por target, na ordem recebida) em vez de
   * `questions`. `evidence` reduz cada pergunta por `summarizeQuestion`; sem ele, sai a forma completa.
   *
   * `INVALID_INPUT` (conferido antes de qualquer I/O: `with-target` em `/targets`, `target` e
   * `targets` juntos; `empty` em `/targets`; `full-with-targets` em `/evidence`, lote com
   * `evidence` `full`, explícito ou assumido; pela tool, o schema recusa antes a lista vazia ou
   * acima de 50 em `/targets`, e esses códigos só valem com o serviço chamado direto),
   * `PROCESS_NOT_FOUND`, `GATE_NOT_FOUND` (`unknown-name` em `/gate`: o gate não está fixado no
   * processo), `MARKER_NOT_FOUND`, `PROCESS_CORRUPTED` (com `details[0].process`),
   * `PROCESS_TOO_LARGE` e `IO_ERROR`.
   */
  evaluateGate(input: EvaluateGateInput & { targets: readonly Target[] }): GateBatchEvaluation;
  evaluateGate(
    input: EvaluateGateInput & { targets?: undefined; evidence?: 'full' },
  ): GateEvaluation;
  evaluateGate(input: EvaluateGateInput & { targets?: undefined }): GateEvaluation<QuestionSummary>;
  evaluateGate(input: EvaluateGateInput): GateEvaluation<QuestionSummary> | GateBatchEvaluation;
  /**
   * Diagnóstico sem gravar: a cadeia do processo e os anexos que os registros citam (D-16). Quebra
   * não lança, vira `ok: false` com `breaks` (cadeia); anexo ausente ou corrompido entra em
   * `attachmentBreaks` como `attachment-missing`/`attachment-corrupted`. Com `expectedHead` (o `head` de uma
   * verificação anterior), um hash que não é de nenhum elo válido nem a âncora do processo entra em
   * `breaks` como `head-not-found` (cauda apagada ou reescrita); sem ele, apagar a cauda não é detectável.
   * `PROCESS_NOT_FOUND` e `PROCESS_CORRUPTED` (`unreadable-manifest`) vêm da leitura do manifesto; `PROCESS_TOO_LARGE` e
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
   * `ATTACHMENT_NOT_FOUND`, `ATTACHMENT_CORRUPTED`, `INVALID_INPUT` (`/offset` além do fim ou no meio de um par surrogate) e
   * `IO_ERROR`.
   */
  readAttachment(input: ReadAttachmentInput): AttachmentPage;
  /**
   * Schema de um tipo, sem gravar. Com `process`, o tipo fixado no manifesto (`{name, schema}`, sem
   * `version`: o manifesto não a guarda), mesmo que o projeto já tenha uma versão mais nova; sem
   * `process`, a vigente do projeto ou a `version` pedida (`{name, version, schema}`).
   * `INVALID_INPUT` (`process-with-version` em `/version`: `process` e `version` juntos, ou
   * `invalid-version`), `PROCESS_NOT_FOUND`, `TYPE_NOT_PINNED` (`not-pinned` em `/type`: tipo fora do
   * manifesto), `PROJECT_NOT_FOUND` (`unknown-project` em `/project`, sem `process`),
   * `TYPE_NOT_FOUND` (`unknown-name` em `/type`, `unknown-version` em `/version`),
   * `PROCESS_CORRUPTED` (`unreadable-manifest`), `INTERNAL` (`unreadable-definition`) e `IO_ERROR`.
   */
  describeType(input: DescribeTypeInput): DescribeTypeResult;
};

function targetOf({ project, scope = 'process', process }: QueryInput): ReadTarget {
  if (scope === 'project') return { project, scope };
  if (isUndefined(process)) {
    throw invalidFilter('/process', 'required', 'process is required with scope "process"');
  }
  return { project, scope, process };
}

/** `no-terms` vem depois de `too-long` para nunca tokenizar um texto acima do teto. */
function assertValid({ limit, text, changesSince, cursor }: QueryInput, search: SearchIndex): void {
  const min = !isUndefined(changesSince) && isUndefined(cursor) ? 0 : 1;
  if (!isUndefined(limit) && !(Number.isInteger(limit) && limit >= min)) {
    throw invalidFilter(
      '/limit',
      'out-of-range',
      'limit must be a positive integer, or 0 with changesSince and no cursor',
    );
  }
  if (isUndefined(text)) return;
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
      'text has no searchable terms (spaces and punctuation are not terms)',
    );
  }
}

/**
 * `Object.hasOwn` e `Object.fromEntries` impedem que `constructor` ou `__proto__` em `fields`
 * tragam algo do protótipo.
 */
function projectData(
  data: Link['data'],
  fields: readonly string[] | undefined,
): Link['data'] | undefined {
  if (isUndefined(fields)) return data;
  if (fields.length === 0) return undefined;
  return Object.fromEntries(
    fields.filter((field) => Object.hasOwn(data, field)).map((field) => [field, data[field]!]),
  );
}

// `fields` não entra aqui de propósito: recorta a saída e não muda o que a consulta seleciona.
// O `satisfies` obriga toda chave nova de `Filters` a entrar neste mapa.
const FILTER_FLAGS = {
  includeNonCurrent: 0,
  type: 0,
  targetPrefix: 0,
  where: 0,
  text: 0,
  ids: 0,
  relatedTo: 0,
} satisfies Record<keyof Filters, 0>;
const FILTER_KEYS = Object.keys(FILTER_FLAGS) as (keyof Filters)[];

/**
 * D-20: o hash prende os filtros e `changesSince`, não a página (`limit`, `maxChars`). O JCS descarta
 * chave `undefined`, então filtro ou `changesSince` ausente não entra no hash.
 */
function hashOf(filters: Filters, changesSince: Marker | undefined): Hash {
  return hashOfJcs({
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
  if (!isUndefined(mismatch)) {
    throw invalidCursor(mismatch.code, 'Cursor was issued for a different query');
  }
}

/** D-20: o conteúdo lido até o marcador tem de ser o que o cursor viu (mesmo hash de cabeça). */
function assertSameContent(cursor: CursorPayload, reading: Reading): void {
  const names = union(Object.keys(cursor.markerHashes), Object.keys(reading.markerHashes));
  for (const name of names) {
    // Processo que nasceu depois da página 1 é lido como vazio e não está no cursor.
    const seen = Object.hasOwn(cursor.markerHashes, name) ? cursor.markerHashes[name] : null;
    const read = Object.hasOwn(reading.markerHashes, name) ? reading.markerHashes[name] : null;
    if (seen !== read) {
      throw invalidCursor(
        'marker-hash-mismatch',
        `Cursor marker does not match the log of process '${name}'`,
      );
    }
  }
}

function startAfter(selected: readonly Link[], lastId: RecordId): number {
  const at = selected.findIndex((link) => link.id === lastId);
  if (at === -1) {
    throw invalidCursor('last-id-not-found', 'Cursor record is not in the result');
  }
  return at + 1;
}

export function createQueryService(deps: {
  store: ProcessReader;
  definitions: DefinitionReader;
  attachments: AttachmentReader;
  search: SearchIndex;
}): QueryService {
  const { store, definitions, attachments, search } = deps;

  /** D-16: estado dos anexos que `link` cita nos campos marcados do tipo fixado no processo dele. */
  function attachmentStatusOf(
    project: Name,
    manifest: Manifest | undefined,
    link: Link,
  ): Record<Hash, AttachmentStatus> | undefined {
    const schema = manifest?.fixed.types[link.type];
    if (isUndefined(schema)) return undefined;
    const hashes = attachmentFields(schema)
      .flatMap((field) => [link.data[field]].flat())
      .filter((value): value is Hash => Hash.safeParse(value).success);
    if (hashes.length === 0) return undefined;
    return Object.fromEntries(
      uniq(hashes).map((hash) => [hash, attachments.status(project, hash)]),
    );
  }

  /** O que mudou no resultado entre o marcador de `changesSince` e a leitura de agora. */
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
    const before = select(past, filters, search, target);
    const byId = ({ id }: Link) => id;
    return {
      entered: differenceBy(now.selected, before, byId).map(byId),
      left: differenceBy(before, now.selected, byId).map(({ id }) => ({
        id,
        reason: leftReason(now.view, id),
      })),
      marker: now.marker,
    };
  }

  // As sobrecargas repetem as de `QueryService`: o corpo tem de casar com todas, sem cast.
  function evaluateGate(
    input: EvaluateGateInput & { targets: readonly Target[] },
  ): GateBatchEvaluation;
  function evaluateGate(
    input: EvaluateGateInput & { targets?: undefined; evidence?: 'full' },
  ): GateEvaluation;
  function evaluateGate(
    input: EvaluateGateInput & { targets?: undefined },
  ): GateEvaluation<QuestionSummary>;
  function evaluateGate(
    input: EvaluateGateInput,
  ): GateEvaluation<QuestionSummary> | GateBatchEvaluation;
  function evaluateGate({
    project,
    process,
    gate: name,
    target,
    targets,
    marker,
    evidence = 'full',
  }: EvaluateGateInput): GateEvaluation<QuestionSummary> | GateBatchEvaluation {
    if (!isUndefined(targets)) {
      if (!isUndefined(target)) {
        throw invalidInput('/targets', 'with-target', 'targets is not allowed with target');
      }
      if (targets.length === 0) {
        throw invalidInput('/targets', 'empty', 'targets must have at least one target');
      }
      if (evidence === 'full') {
        throw invalidInput('/evidence', 'full-with-targets', 'targets requires counts or failing');
      }
    }
    const { gates } = store.readManifest({ project, process }).fixed;
    if (!Object.hasOwn(gates, name)) throw gateNotFound();
    const gate = gates[name]!;
    const scope: ReadTarget = gate.questions.some((question) => question.scope === 'project')
      ? { project, scope: 'project' }
      : { project, scope: 'process', process };
    const reading = readScope(store, scope, marker);
    const records = (questionScope: GateScope) =>
      questionScope === 'project'
        ? inOutputOrder(reading, 'project')
        : reading.processes
            .filter(({ name: read }) => read === process)
            .flatMap(({ verified }) => verified.records);
    const run = prepareGate(gate.questions, {
      records,
      isInheritanceActive: inheritanceActivation(reading),
    });
    const evaluate = (forTarget: Target | undefined) => {
      const result = run(forTarget);
      return {
        passed: result.passed,
        questions: result.questions.map((question) => summarizeQuestion(question, evidence)),
      };
    };
    if (isUndefined(targets)) return { ...evaluate(target), marker: reading.marker };
    const results = targets.map((each) => ({ target: each, ...evaluate(each) }));
    return { passed: results.every(({ passed }) => passed), results, marker: reading.marker };
  }

  return {
    queryRecords(input) {
      assertValid(input, search);
      const target = targetOf(input);
      const filters: Filters = omitBy(pick(input, FILTER_KEYS), isUndefined);
      const hash = hashOf(filters, input.changesSince);
      const cursor = isUndefined(input.cursor) ? undefined : decodeCursor(input.cursor);
      if (!isUndefined(cursor)) assertSameQuery(cursor, target, input.process, hash);

      const reading = readScope(store, target, cursor?.marker, '/cursor');
      if (!isUndefined(cursor)) assertSameContent(cursor, reading);
      const view = buildView(reading, target.scope);
      const selected = select(view, filters, search, target);

      // Sob demanda: com `limit: 0` nenhum registro é renderizado e a herança não é calculada.
      const reviews = once(() => needsReview(view.records, view.vigency, view.inheritance));
      const manifests = new Map(
        reading.processes.map(({ name, verified }) => [name, verified.manifest]),
      );
      const render = (link: Link): QueryRecord => {
        const review = reviews().get(link.id);
        const status = attachmentStatusOf(target.project, manifests.get(processOf(link.id)), link);
        const data = projectData(link.data, input.fields);
        return {
          ...pick(link, ['id', 'type', 'at', 'target', 'author']),
          ...(isUndefined(data) ? {} : { data }),
          ...relationsOf(view, link, input.relations ?? 'full'),
          ...(isUndefined(review) ? {} : { needsReview: review }),
          ...(isUndefined(status) ? {} : { attachmentStatus: status }),
        };
      };

      const start = isUndefined(cursor) ? 0 : startAfter(selected, cursor.lastId);
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
      const more = !isUndefined(last) && start + records.length < selected.length;
      const next: CursorPayload | undefined = more
        ? {
            scope: target.scope,
            project: target.project,
            ...(isUndefined(input.process) ? {} : { process: input.process }),
            marker: reading.marker,
            markerHashes: reading.markerHashes,
            filtersHash: hash,
            lastId: last.id,
          }
        : undefined;
      const changes =
        isUndefined(cursor) && !isUndefined(input.changesSince)
          ? changesOf(input, target, filters, { view, selected, marker: reading.marker })
          : undefined;
      // Com cursor e seleção vazia, `startAfter` já lançou: seleção vazia aqui é sempre a página 1.
      const hint =
        selected.length === 0 && !isUndefined(input.targetPrefix)
          ? boundaryHint(view, input.targetPrefix)
          : undefined;
      return {
        records,
        ...(isUndefined(next) ? {} : { cursor: encodeCursor(next) }),
        marker: reading.marker,
        ...(isUndefined(changes) ? {} : { changes }),
        ...(isUndefined(hint) ? {} : { hint }),
      };
    },

    evaluateGate,

    verifyChain({ project, process, expectedHead }) {
      const verified = loadVerified(store, { project, process });
      const { manifest, records } = verified;
      const chain = isUndefined(expectedHead)
        ? verified.chain
        : checkExpectedHead(verified, expectedHead);
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

    list: createList({ store, definitions }),

    readAttachment: createReadAttachment({ attachments }),
    describeType: createDescribeType({ store, definitions }),
  };
}
