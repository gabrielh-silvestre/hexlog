import { describe, expect, it } from '@jest/globals';
import { isUndefined } from 'es-toolkit';
import { anchor, hashLink, type Expected, type Link } from '../../src/domain/chain.ts';
import type { GateQuestion } from '../../src/domain/gate.ts';
import type { Hash, Name, RecordId } from '../../src/domain/ids.ts';
import type { Manifest } from '../../src/domain/manifest.ts';
import { HexlogError } from '../../src/errors.ts';
import type {
  AttachmentReader,
  AttachmentStatus,
  ProcessReader,
  ProcessRef,
  RawProcess,
  SearchIndex,
} from '../../src/ports.ts';
import { decodeCursor, encodeCursor } from '../../src/queries/cursor.ts';
import {
  createQueryService,
  QUERY_TEXT_MAX_CHARS,
  type QueryInput,
  type QueryResult,
  type QueryService,
} from '../../src/queries/query-service.ts';
import { formatLine, MAX_BREAKS } from '../../src/shared/loader.ts';
import { emptyManifest, idAt, linkAt } from '../fixtures/chain-line.ts';
import { captureError, cursorOf, idsOf, walkPages } from '../helpers.ts';

const PROJECT = 'alpha';
const HASH_A = 'a'.repeat(64);
const HASH_B = 'b'.repeat(64);
const HASH_C = 'c'.repeat(64);

/** Tipo com campos de anexo marcados (direto e em `items`) e um campo livre que um hash pode vazar para ele. */
const DOC = {
  type: 'object',
  properties: {
    body: { type: 'string', format: 'attachment' },
    files: { type: 'array', items: { type: 'string', format: 'attachment' } },
    note: { type: 'string' },
  },
};

const MAIN_QUERY = { project: PROJECT, process: 'main' } satisfies QueryInput;
const GATE_QUERY = { project: PROJECT, process: 'main', gate: 'gate' };

const LIMIT_REFUSAL = {
  code: 'INVALID_FILTER',
  message: expect.stringContaining('filter'),
  details: [{ path: '/limit', code: 'out-of-range', message: expect.stringContaining('limit') }],
};

const unused = (): never => {
  throw new Error('unused');
};

const search: SearchIndex = {
  search: () => [],
  terms: (text) => text.toLowerCase().match(/[a-z0-9]+/g) ?? [],
};

type Entry = Partial<Pick<Link, 'type' | 'target' | 'at' | 'data' | 'relations'>>;

const idsAt = (...seqs: number[]): RecordId[] => seqs.map((seq) => idAt('main', seq));

const notes = (count: number, label = 'note'): Entry[] =>
  Array.from({ length: count }, (_, at) => ({ data: { text: `${label} ${at}` } }));

/** Log de um processo com um elo por linha, encadeados a partir da âncora do manifesto. */
function rawProcess(
  name: Name,
  entries: readonly Entry[],
  fixed: Partial<Manifest['fixed']> = {},
): RawProcess {
  const manifest: Manifest = {
    ...emptyManifest({ project: PROJECT, process: name }),
    fixed: { types: {}, relations: {}, gates: {}, ...fixed },
  };
  let expected: Expected = { seq: 0, prevHash: anchor(manifest) };
  const text = entries
    .map((entry) => {
      const link = linkAt(expected, { id: idAt(name, expected.seq), ...entry });
      expected = { seq: link.seq + 1, prevHash: hashLink(link) };
      return formatLine([link]);
    })
    .join('');
  return { manifest, text, endsWithNewline: true };
}

const fixedGate = (...questions: GateQuestion[]): Partial<Manifest['fixed']> => ({
  gates: { gate: { name: 'gate', questions } },
});

function readerOf(processes: Record<Name, RawProcess>): ProcessReader {
  const rawOf = ({ process }: ProcessRef): RawProcess => {
    const raw = processes[process];
    if (isUndefined(raw)) {
      const message = 'process not found';
      throw new HexlogError('PROCESS_NOT_FOUND', message, [
        { path: '/process', code: 'not-found', message, process },
      ]);
    }
    return raw;
  };
  return {
    read: rawOf,
    readManifest: (ref) => rawOf(ref).manifest,
    list: () => Object.keys(processes).sort(),
    listProjects: () => [PROJECT],
  };
}

/** `status` só responde pelos hashes combinados: consultar outro é falha do caso. */
function attachmentsOf(statuses: Record<Hash, AttachmentStatus>): AttachmentReader {
  return {
    status: (_project, hash) => {
      const status = statuses[hash];
      if (isUndefined(status)) throw new Error(`unexpected attachment ${hash}`);
      return status;
    },
    read: unused,
  };
}

function serviceOf(
  processes: Record<Name, RawProcess>,
  attachments: AttachmentReader = { status: unused, read: unused },
): QueryService {
  return createQueryService({
    store: readerOf(processes),
    definitions: { names: () => [], versions: () => [], read: unused },
    attachments,
    search,
  });
}

/** Serviço sobre o único processo `main`, com os elos de `entries`. */
const mainService = (
  entries: readonly Entry[],
  fixed?: Partial<Manifest['fixed']>,
  attachments?: AttachmentReader,
): QueryService => serviceOf({ main: rawProcess('main', entries, fixed) }, attachments);

function refusalOf(run: () => unknown) {
  const { code, message, details } = captureError(run);
  return { code, message, details };
}

/** Soma dos caracteres do JSON dos `count` primeiros registros: a conta de `maxChars`. */
const sizeOf = (page: QueryResult, count: number): number =>
  page.records.slice(0, count).reduce((sum, record) => sum + JSON.stringify(record).length, 0);

/** Todas as páginas de `input` no projeto de `service`, pelo cursor. */
const walk = (service: QueryService, input: Omit<QueryInput, 'project'>): QueryResult[] =>
  walkPages((page) => service.queryRecords({ project: PROJECT, ...page }), input);

describe('QueryService.queryRecords', () => {
  it('should return the current records with envelope, data and relations', () => {
    const service = mainService([{ data: { text: 'first' } }]);

    const page = service.queryRecords(MAIN_QUERY);

    expect(page).toEqual({
      records: [
        {
          id: idAt('main', 0),
          type: 'note',
          at: '2026-09-30T12:00:00.000Z',
          target: 'repo.feature',
          author: { agent: 'test', client: 'test' },
          data: { text: 'first' },
          in: [],
          out: [],
        },
      ],
      marker: { main: idAt('main', 0) },
    });
  });

  it('should refuse a process scope query without a process', () => {
    const service = serviceOf({});

    expect(refusalOf(() => service.queryRecords({ project: PROJECT }))).toEqual({
      code: 'INVALID_FILTER',
      message: expect.stringContaining('filter'),
      details: [
        { path: '/process', code: 'required', message: expect.stringContaining('process') },
      ],
    });
  });

  it('should flag a current record whose support was revoked as needing review', () => {
    const service = mainService([
      { target: 'doc.a' },
      { target: 'doc.b', relations: [{ kind: 'supports', to: idAt('main', 0) }] },
      { target: 'doc.c', relations: [{ kind: 'revokes', to: idAt('main', 1) }] },
    ]);

    const page = service.queryRecords(MAIN_QUERY);

    expect(page.records.at(0)?.needsReview).toEqual({ staleIn: idsAt(1), staleOut: [] });
  });

  it('should hint at a near target when targetPrefix matches no whole segment', () => {
    const service = mainService([{ target: 'plan.step-2' }]);

    const page = service.queryRecords({ ...MAIN_QUERY, targetPrefix: 'plan.step' });

    expect(page).toEqual({
      records: [],
      marker: { main: idAt('main', 0) },
      hint: expect.stringContaining('plan.step-2'),
    });
  });

  describe('with limit', () => {
    it.each([-1, 1.5, Number.NaN, Infinity, 0])(
      'should refuse limit %s when there is no changesSince',
      (limit) => {
        const service = mainService(notes(1));

        expect(refusalOf(() => service.queryRecords({ ...MAIN_QUERY, limit }))).toEqual(
          LIMIT_REFUSAL,
        );
      },
    );

    it('should refuse limit 0 when a cursor comes with changesSince', () => {
      const service = mainService(notes(2));
      const input = {
        ...MAIN_QUERY,
        limit: 0,
        changesSince: { main: idAt('main', 0) },
        cursor: 'any-cursor',
      };

      expect(refusalOf(() => service.queryRecords(input))).toEqual(LIMIT_REFUSAL);
    });

    it('should accept the smallest limit, 1', () => {
      const service = mainService(notes(3));

      const page = service.queryRecords({ ...MAIN_QUERY, limit: 1 });

      expect(idsOf(page)).toEqual(idsAt(0));
    });

    it('should accept limit 0 with changesSince and no cursor, giving only the changes', () => {
      const service = mainService(notes(2));

      const page = service.queryRecords({
        ...MAIN_QUERY,
        limit: 0,
        changesSince: { main: idAt('main', 0) },
      });

      expect(page).toEqual({
        records: [],
        marker: { main: idAt('main', 1) },
        changes: { entered: idsAt(1), left: [], marker: { main: idAt('main', 1) } },
      });
    });
  });

  describe('with text', () => {
    // A recusa `no-terms` repete `query.spec.ts` de propósito: aqui o serviço roda sobre portas em memória, sem disco.
    it.each(['', '  ', '!!!'])('should refuse text %j that has no searchable terms', (text) => {
      const service = mainService(notes(1));

      expect(refusalOf(() => service.queryRecords({ ...MAIN_QUERY, text }))).toEqual({
        code: 'INVALID_FILTER',
        message: expect.stringContaining('filter'),
        details: [{ path: '/text', code: 'no-terms', message: expect.stringContaining('text') }],
      });
    });

    it('should refuse text above QUERY_TEXT_MAX_CHARS as too long before looking for terms', () => {
      const service = mainService(notes(1));
      const text = '!'.repeat(QUERY_TEXT_MAX_CHARS + 1);

      expect(refusalOf(() => service.queryRecords({ ...MAIN_QUERY, text }))).toEqual({
        code: 'INVALID_FILTER',
        message: expect.stringContaining('filter'),
        details: [
          {
            path: '/text',
            code: 'too-long',
            message: expect.stringContaining(String(QUERY_TEXT_MAX_CHARS)),
          },
        ],
      });
    });

    it('should accept text of exactly QUERY_TEXT_MAX_CHARS', () => {
      const service = mainService(notes(1));
      const text = 'a'.repeat(QUERY_TEXT_MAX_CHARS);

      const page = service.queryRecords({ ...MAIN_QUERY, text });

      expect(page.records).toEqual([]);
    });
  });

  describe('with fields', () => {
    const entries = [{ data: { text: 'a', extra: 1 } }];

    it('should keep only the requested top-level fields of data', () => {
      const service = mainService(entries);

      const page = service.queryRecords({ ...MAIN_QUERY, fields: ['text'] });

      expect(page.records.at(0)?.data).toStrictEqual({ text: 'a' });
    });

    it('should omit data with an empty list of fields', () => {
      const service = mainService(entries);

      const page = service.queryRecords({ ...MAIN_QUERY, fields: [] });

      expect(page.records.at(0)).not.toHaveProperty('data');
    });

    it('should skip the fields the record does not own, inherited ones included', () => {
      const service = mainService(entries);

      const page = service.queryRecords({
        ...MAIN_QUERY,
        fields: ['constructor', 'missing', 'text'],
      });

      expect(page.records.at(0)?.data).toStrictEqual({ text: 'a' });
    });
  });

  describe('with attachment fields', () => {
    const fixed = { types: { doc: DOC } };

    it('should give the status of each attachment cited in the marked fields', () => {
      const entry = { type: 'doc', data: { body: HASH_A, files: [HASH_B, HASH_A], note: HASH_C } };
      const service = mainService(
        [entry],
        fixed,
        attachmentsOf({ [HASH_A]: 'ok', [HASH_B]: 'missing' }),
      );

      const page = service.queryRecords(MAIN_QUERY);

      expect(page.records.at(0)?.attachmentStatus).toEqual({ [HASH_A]: 'ok', [HASH_B]: 'missing' });
    });

    it('should leave attachmentStatus out when the record cites no attachment', () => {
      const service = mainService([{ type: 'doc', data: { note: 'plain' } }], fixed);

      const page = service.queryRecords(MAIN_QUERY);

      expect(page.records.at(0)).not.toHaveProperty('attachmentStatus');
    });
  });

  describe('with a cursor', () => {
    it('should walk the whole result in pages without repeating or skipping a record', () => {
      const service = mainService(notes(7));

      const pages = walk(service, { process: 'main', limit: 3 });

      expect(pages.map(idsOf)).toEqual([idsAt(0, 1, 2), idsAt(3, 4, 5), idsAt(6)]);
    });

    it('should give no cursor on a last page that ends exactly at the result', () => {
      const service = mainService(notes(6));
      const cursor = cursorOf(service.queryRecords({ ...MAIN_QUERY, limit: 3 }));

      const last = service.queryRecords({ ...MAIN_QUERY, limit: 3, cursor });

      expect(last).not.toHaveProperty('cursor');
    });

    it('should page through the records of every process with project scope', () => {
      const service = serviceOf({
        a: rawProcess('a', [
          { at: '2026-09-30T10:00:00.000Z' },
          { at: '2026-09-30T12:00:00.000Z' },
        ]),
        b: rawProcess('b', [
          { at: '2026-09-30T11:00:00.000Z' },
          { at: '2026-09-30T13:00:00.000Z' },
        ]),
      });

      const pages = walk(service, { scope: 'project', limit: 3 });

      expect(pages.map(idsOf)).toEqual([
        [idAt('a', 0), idAt('b', 0), idAt('a', 1)],
        [idAt('b', 1)],
      ]);
    });

    it('should keep a record that brings the page exactly to maxChars', () => {
      const service = mainService(notes(4));
      const maxChars = sizeOf(service.queryRecords(MAIN_QUERY), 2);

      const page = service.queryRecords({ ...MAIN_QUERY, maxChars });

      expect(idsOf(page)).toEqual(idsAt(0, 1));
    });

    it('should leave out the record that goes one character past maxChars', () => {
      const service = mainService(notes(4));
      const maxChars = sizeOf(service.queryRecords(MAIN_QUERY), 2) - 1;

      const page = service.queryRecords({ ...MAIN_QUERY, maxChars });

      expect(idsOf(page)).toEqual(idsAt(0));
    });

    it('should give the first record whole even when it alone is above maxChars', () => {
      const service = mainService(notes(3));

      const page = service.queryRecords({ ...MAIN_QUERY, maxChars: 1 });

      expect(idsOf(page)).toEqual(idsAt(0));
    });

    it('should accept the cursor when includeNonCurrent is spelled out as false', () => {
      const service = mainService(notes(7));
      const cursor = cursorOf(service.queryRecords({ ...MAIN_QUERY, limit: 3 }));

      const page = service.queryRecords({ ...MAIN_QUERY, includeNonCurrent: false, cursor });

      expect(idsOf(page)).toEqual(idsAt(3, 4, 5, 6));
    });

    it.each<{ name: string; change: Partial<QueryInput>; code: string }>([
      { name: 'scope', change: { scope: 'project' }, code: 'scope-mismatch' },
      { name: 'project', change: { project: 'beta' }, code: 'project-mismatch' },
      { name: 'process', change: { process: 'other' }, code: 'process-mismatch' },
      { name: 'type filter', change: { type: 'task' }, code: 'filters-mismatch' },
      { name: 'includeNonCurrent', change: { includeNonCurrent: true }, code: 'filters-mismatch' },
      {
        name: 'changesSince',
        change: { changesSince: { main: idAt('main', 0) } },
        code: 'filters-mismatch',
      },
    ])('should refuse a cursor reused with another $name', ({ change, code }) => {
      const service = mainService(notes(5));
      const cursor = cursorOf(service.queryRecords({ ...MAIN_QUERY, limit: 2 }));

      expect(refusalOf(() => service.queryRecords({ ...MAIN_QUERY, cursor, ...change }))).toEqual({
        code: 'INVALID_CURSOR',
        message: expect.stringContaining('cursor'),
        details: [{ path: '/cursor', code, message: expect.stringContaining('different query') }],
      });
    });

    it('should refuse a cursor when the log it saw now has other content', () => {
      const original = mainService(notes(5));
      const rewritten = mainService(notes(5, 'rewritten'));
      const cursor = cursorOf(original.queryRecords({ ...MAIN_QUERY, limit: 2 }));

      expect(refusalOf(() => rewritten.queryRecords({ ...MAIN_QUERY, cursor }))).toEqual({
        code: 'INVALID_CURSOR',
        message: expect.stringContaining('cursor'),
        details: [
          {
            path: '/cursor',
            code: 'marker-hash-mismatch',
            message: expect.stringContaining("'main'"),
          },
        ],
      });
    });

    it('should refuse a cursor whose last record is not in the result', () => {
      const service = mainService(notes(5));
      const cursor = cursorOf(service.queryRecords({ ...MAIN_QUERY, limit: 2 }));
      const forged = encodeCursor({ ...decodeCursor(cursor), lastId: idAt('main', 99) });

      expect(refusalOf(() => service.queryRecords({ ...MAIN_QUERY, cursor: forged }))).toEqual({
        code: 'INVALID_CURSOR',
        message: expect.stringContaining('cursor'),
        details: [
          {
            path: '/cursor',
            code: 'last-id-not-found',
            message: expect.stringContaining('result'),
          },
        ],
      });
    });

    it('should name /cursor when the marker of the cursor is not in the log', () => {
      const service = mainService(notes(5));
      const cursor = cursorOf(service.queryRecords({ ...MAIN_QUERY, limit: 2 }));
      const forged = encodeCursor({ ...decodeCursor(cursor), marker: { main: idAt('main', 99) } });

      expect(
        refusalOf(() => service.queryRecords({ ...MAIN_QUERY, cursor: forged })),
      ).toMatchObject({
        code: 'MARKER_NOT_FOUND',
        details: [{ path: '/cursor', process: 'main' }],
      });
    });
  });

  describe('with changesSince', () => {
    const entries: Entry[] = [
      { target: 'plan.a' },
      { target: 'plan.b' },
      { target: 'plan.c', relations: [{ kind: 'supersedes', to: idAt('main', 0) }] },
    ];
    const changesSince = { main: idAt('main', 0) };

    it('should report what entered and left the result since the marker', () => {
      const service = mainService(entries);

      const page = service.queryRecords({ ...MAIN_QUERY, changesSince });

      expect(page.changes).toEqual({
        entered: idsAt(1, 2),
        left: [{ id: idAt('main', 0), reason: 'superseded' }],
        marker: { main: idAt('main', 2) },
      });
    });

    it('should leave changes out when there is no changesSince', () => {
      const service = mainService(entries);

      const page = service.queryRecords(MAIN_QUERY);

      expect(page).not.toHaveProperty('changes');
    });

    it('should give changes only on the first page', () => {
      const service = mainService(entries);
      const cursor = cursorOf(service.queryRecords({ ...MAIN_QUERY, limit: 1, changesSince }));

      const second = service.queryRecords({ ...MAIN_QUERY, changesSince, cursor });

      expect(second).not.toHaveProperty('changes');
    });

    it('should name /changesSince when the marker record is not in the log', () => {
      const service = mainService(entries);
      const unknown = { main: idAt('main', 99) };

      expect(
        refusalOf(() => service.queryRecords({ ...MAIN_QUERY, changesSince: unknown })),
      ).toMatchObject({ code: 'MARKER_NOT_FOUND', details: [{ path: '/changesSince' }] });
    });
  });
});

describe('QueryService.evaluateGate', () => {
  const occurred = { kind: 'occurred', select: { type: 'note' } } satisfies GateQuestion;
  const occurredInProject = { ...occurred, scope: 'project' } satisfies GateQuestion;
  const planned: Entry[] = [{ target: 'plan.a' }, { target: 'plan.b' }];

  it.each([
    {
      name: 'target and targets together',
      input: { target: 'plan.a', targets: ['plan.a'], evidence: 'counts' },
      path: '/targets',
      code: 'with-target',
    },
    {
      name: 'an empty list of targets',
      input: { targets: [], evidence: 'counts' },
      path: '/targets',
      code: 'empty',
    },
    {
      name: 'targets with evidence full',
      input: { targets: ['plan.a'], evidence: 'full' },
      path: '/evidence',
      code: 'full-with-targets',
    },
    {
      name: 'targets with the default evidence',
      input: { targets: ['plan.a'] },
      path: '/evidence',
      code: 'full-with-targets',
    },
  ] as const)('should refuse $name before reading anything', ({ input, path, code }) => {
    const service = serviceOf({});

    expect(refusalOf(() => service.evaluateGate({ ...GATE_QUERY, ...input }))).toEqual({
      code: 'INVALID_INPUT',
      message: expect.stringContaining('targets'),
      details: [{ path, code, message: expect.stringContaining('targets') }],
    });
  });

  it.each(['missing', 'constructor'])(
    'should refuse the gate name %s that is not pinned in the process',
    (gate) => {
      const service = mainService(notes(1));

      expect(refusalOf(() => service.evaluateGate({ ...GATE_QUERY, gate }))).toEqual({
        code: 'GATE_NOT_FOUND',
        message: expect.stringContaining('gate'),
        details: [
          { path: '/gate', code: 'unknown-name', message: expect.stringContaining('gate') },
        ],
      });
    },
  );

  it('should evaluate the gate for the target and give the marker it read', () => {
    const service = mainService(planned, fixedGate(occurred));

    const result = service.evaluateGate({ ...GATE_QUERY, target: 'plan.a' });

    expect(result).toEqual({
      passed: true,
      questions: [{ index: 0, kind: 'occurred', passed: true, evidence: { found: idsAt(0) } }],
      marker: { main: idAt('main', 1) },
    });
  });

  it('should reduce each question to its counts with evidence counts', () => {
    const service = mainService(planned, fixedGate(occurred));

    const result = service.evaluateGate({ ...GATE_QUERY, evidence: 'counts' });

    expect(result.questions).toEqual([
      { index: 0, kind: 'occurred', passed: true, counts: { found: 2 } },
    ]);
  });

  it('should evaluate over the log as it was at the marker', () => {
    const service = mainService(notes(3), fixedGate(occurred));

    const result = service.evaluateGate({ ...GATE_QUERY, marker: { main: idAt('main', 1) } });

    expect(result).toEqual({
      passed: true,
      questions: [{ index: 0, kind: 'occurred', passed: true, evidence: { found: idsAt(0, 1) } }],
      marker: { main: idAt('main', 1) },
    });
  });

  it('should read only the gate process when no question has project scope', () => {
    const service = serviceOf({
      main: rawProcess('main', notes(1), fixedGate(occurred)),
      other: rawProcess('other', notes(1)),
    });

    const result = service.evaluateGate(GATE_QUERY);

    expect(result.marker).toEqual({ main: idAt('main', 0) });
  });

  it('should give each question the records of its own scope when the gate mixes scopes', () => {
    const service = serviceOf({
      main: rawProcess(
        'main',
        [{ at: '2026-09-30T10:00:00.000Z' }],
        fixedGate(occurred, occurredInProject),
      ),
      other: rawProcess('other', [{ at: '2026-09-30T11:00:00.000Z' }]),
    });

    const result = service.evaluateGate(GATE_QUERY);

    expect(result).toEqual({
      passed: true,
      questions: [
        { index: 0, kind: 'occurred', passed: true, evidence: { found: [idAt('main', 0)] } },
        {
          index: 1,
          kind: 'occurred',
          passed: true,
          evidence: { found: [idAt('main', 0), idAt('other', 0)] },
        },
      ],
      marker: { main: idAt('main', 0), other: idAt('other', 0) },
    });
  });

  describe('with targets', () => {
    it('should give one result per target in the order received, with a single marker', () => {
      const service = mainService(planned, fixedGate(occurred));

      const result = service.evaluateGate({
        ...GATE_QUERY,
        targets: ['plan.b', 'plan.a'],
        evidence: 'counts',
      });

      expect(result).toEqual({
        passed: true,
        results: [
          {
            target: 'plan.b',
            passed: true,
            questions: [{ index: 0, kind: 'occurred', passed: true, counts: { found: 1 } }],
          },
          {
            target: 'plan.a',
            passed: true,
            questions: [{ index: 0, kind: 'occurred', passed: true, counts: { found: 1 } }],
          },
        ],
        marker: { main: idAt('main', 1) },
      });
    });

    it('should fail the batch when any target fails, keeping the others as they are', () => {
      const service = mainService(planned, fixedGate(occurred));

      const result = service.evaluateGate({
        ...GATE_QUERY,
        targets: ['plan.a', 'plan.none'],
        evidence: 'counts',
      });

      expect(result.passed).toBe(false);
      expect(result.results.map(({ passed }) => passed)).toEqual([true, false]);
    });
  });
});

describe('QueryService.verifyChain', () => {
  const fixed = { types: { doc: DOC } };

  it('should report ok with every record counted when the chain and the attachments are intact', () => {
    const entries: Entry[] = [
      { type: 'doc', data: { body: HASH_A } },
      { type: 'doc', data: { files: [HASH_A, HASH_B] } },
    ];
    const service = mainService(entries, fixed, attachmentsOf({ [HASH_A]: 'ok', [HASH_B]: 'ok' }));

    const result = service.verifyChain(MAIN_QUERY);

    expect(result).toMatchObject({
      ok: true,
      totalRecords: 2,
      breaks: [],
      attachmentBreaks: [],
      totalAttachmentBreaks: 0,
    });
  });

  it('should turn a missing or corrupted attachment into an attachment break and not ok', () => {
    const entries = [
      { type: 'doc', data: { body: HASH_A } },
      { type: 'doc', data: { body: HASH_B } },
      { type: 'doc', data: { body: HASH_C } },
    ];
    const service = mainService(
      entries,
      fixed,
      attachmentsOf({ [HASH_A]: 'ok', [HASH_B]: 'missing', [HASH_C]: 'corrupted' }),
    );

    const result = service.verifyChain(MAIN_QUERY);

    expect(result).toMatchObject({
      ok: false,
      breaks: [],
      attachmentBreaks: [
        { id: idAt('main', 1), hash: HASH_B, reason: 'attachment-missing' },
        { id: idAt('main', 2), hash: HASH_C, reason: 'attachment-corrupted' },
      ],
      totalAttachmentBreaks: 2,
    });
  });

  it('should not report ok when the chain is broken, even with no attachment break', () => {
    const raw = rawProcess('main', notes(2));
    const service = serviceOf({ main: { ...raw, text: `${raw.text}{"links":[{}]}\n` } });

    const result = service.verifyChain(MAIN_QUERY);

    expect(result).toMatchObject({ ok: false, attachmentBreaks: [], totalAttachmentBreaks: 0 });
  });

  it('should add head-not-found when expectedHead is no link of the chain', () => {
    const service = mainService(notes(2));

    const result = service.verifyChain({ ...MAIN_QUERY, expectedHead: 'f'.repeat(64) });

    expect(result).toMatchObject({
      ok: false,
      breaks: [{ index: 2, reason: 'head-not-found' }],
    });
  });

  it('should cut the attachment breaks at MAX_BREAKS and keep the total', () => {
    const entries = Array.from({ length: MAX_BREAKS + 1 }, () => ({
      type: 'doc',
      data: { body: HASH_A },
    }));
    const service = mainService(entries, fixed, attachmentsOf({ [HASH_A]: 'missing' }));

    const result = service.verifyChain(MAIN_QUERY);

    expect(result.attachmentBreaks).toHaveLength(MAX_BREAKS);
    expect(result.totalAttachmentBreaks).toBe(MAX_BREAKS + 1);
  });
});
