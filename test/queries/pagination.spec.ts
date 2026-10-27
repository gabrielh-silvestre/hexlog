import { describe, expect, it } from '@jest/globals';
import fc from 'fast-check';
import { sha256hex } from '../../src/domain/chain.ts';
import { decodeCursor, encodeCursor } from '../../src/queries/cursor.ts';
import { PAGE_CHARS_CAP } from '../../src/queries/query-service.ts';
import { ghostId, note } from '../commands/register-fakes.ts';
import { at, captureError, cursorOf, idsOf, walkPages } from '../helpers.ts';
import { querySetup } from './query-setup.ts';

type Cursors = { cursor: string; projectCursor: string };

async function fiveNotes() {
  const setup = querySetup();
  setup.createProcess('run-1');
  const ids = await setup.register(
    'run-1',
    ['a', 'b', 'c', 'd', 'e'].map((text) => note(text)),
    1,
  );
  return { ...setup, ids };
}

/** `run-1` com `a` e `c`, `run-2` com `b` e `d`, em ordem de instante: a, b, c, d. */
async function twoProcesses() {
  const setup = querySetup();
  setup.createProcess('run-1');
  setup.createProcess('run-2');
  const a = await setup.registerOne('run-1', note('a'), 1);
  const b = await setup.registerOne('run-2', note('b'), 2);
  const c = await setup.registerOne('run-1', note('c'), 3);
  const d = await setup.registerOne('run-2', note('d'), 4);
  return { ...setup, a, b, c, d };
}

describe('QueryService.queryRecords', () => {
  it('should add up the pages to the whole list, in the same order and without repeats, for any `limit`', async () => {
    const { query, ids } = await fiveNotes();
    const limits = fc.integer({ min: 1, max: 7 });

    fc.assert(
      fc.property(limits, (limit) => {
        const walked = walkPages(query, { process: 'run-1', limit }).flatMap(idsOf);

        expect(walked).toEqual(ids);
      }),
      { numRuns: 20 },
    );
  });

  it('should close the list without a cursor when `limit` equals what remains', async () => {
    const { query, ids } = await fiveNotes();

    const exact = query({ process: 'run-1', limit: 5 });

    expect(idsOf(exact)).toEqual(ids);
    expect(exact.cursor).toBeUndefined();
  });

  it('should leave the cursor when `limit` is one less than what remains', async () => {
    const { query, ids } = await fiveNotes();

    const short = query({ process: 'run-1', limit: 4 });

    expect(idsOf(short)).toEqual(ids.slice(0, 4));
    expect(short.cursor).toBeDefined();
  });

  it('should return the remaining record and no cursor when the character cap hits the last page', async () => {
    const { query, ids } = await fiveNotes();
    const first = query({ process: 'run-1', limit: 4 });

    const last = query({ process: 'run-1', maxChars: 1, cursor: cursorOf(first) });

    expect(idsOf(last)).toEqual([at(ids, 4)]);
    expect(last.cursor).toBeUndefined();
  });

  it('should return empty `records`, no cursor and the marker of what it read for a query with no result', async () => {
    const { query } = await fiveNotes();

    const page = query({ process: 'run-1', type: 'doc' });

    expect(page.records).toEqual([]);
    expect(page.cursor).toBeUndefined();
    expect(Object.keys(page.marker)).toEqual(['run-1']);
  });

  it('should not change the page 1 list when a supersede is written between pages, in process scope', async () => {
    const { query, registerOne, ids } = await fiveNotes();
    const first = query({ process: 'run-1', limit: 2 });
    await registerOne(
      'run-1',
      note('a2', { relations: [{ to: at(ids, 2), kind: 'supersedes' }] }),
      2,
    );

    const second = query({ process: 'run-1', limit: 10, cursor: cursorOf(first) });

    expect(idsOf(second)).toEqual(ids.slice(2));
    expect(second.marker).toEqual(first.marker);
  });

  it('should not change the page 1 list when a supersede is written between pages, in project scope', async () => {
    const { query, registerOne, a, b, c, d } = await twoProcesses();
    const first = query({ scope: 'project', limit: 2 });
    await registerOne('run-1', note('c2', { relations: [{ to: c, kind: 'supersedes' }] }), 5);
    await registerOne('run-2', note('e'), 6);

    const second = query({ scope: 'project', limit: 10, cursor: cursorOf(first) });

    expect(idsOf(first)).toEqual([a, b]);
    expect(idsOf(second)).toEqual([c, d]);
    expect(second.marker).toEqual(first.marker);
  });

  it.each(['run-3', 'constructor'])(
    'should keep the process %s born after page 1 out of the following pages',
    async (name) => {
      const { createProcess, registerOne, query, a, b, c, d } = await twoProcesses();
      const first = query({ scope: 'project', limit: 2 });
      createProcess(name);
      await registerOne(name, note('nasceu depois'), 5);

      const second = query({ scope: 'project', limit: 10, cursor: cursorOf(first) });

      expect(idsOf(first)).toEqual([a, b]);
      expect(idsOf(second)).toEqual([c, d]);
    },
  );

  it('should keep the same order and `lastId` with `text` of 2+ terms and `type` and an append between pages', async () => {
    const { createProcess, registerOne, query } = querySetup();
    createProcess('run-1');
    await registerOne('run-1', { type: 'doc', target: 'run.doc', data: { note: 'banana uva' } }, 1);
    const ids = [];
    for (const [minute, text] of ['banana', 'uva', 'banana', 'uva'].entries()) {
      ids.push(await registerOne('run-1', note(text), 2 + minute));
    }
    const filters = { process: 'run-1', type: 'note', text: 'banana uva', limit: 2 } as const;
    const first = query(filters);
    await registerOne('run-1', note('banana uva'), 9);

    const second = query({ ...filters, cursor: cursorOf(first) });

    expect(idsOf(first)).toEqual(ids.slice(0, 2));
    expect(idsOf(second)).toEqual(ids.slice(2));
    expect(second.cursor).toBeUndefined();
  });

  it('should cover every process read in the project scope cursor', async () => {
    const { createProcess, registerOne, query } = querySetup();
    createProcess('run-1');
    createProcess('run-2');
    await registerOne('run-1', note('a'), 1);
    await registerOne('run-2', note('b'), 2);
    await registerOne('run-1', note('c'), 3);

    const first = query({ scope: 'project', limit: 1 });

    expect(decodeCursor(cursorOf(first)).marker).toEqual(first.marker);
    expect(Object.keys(first.marker)).toEqual(['run-1', 'run-2']);
  });

  it('should bring a record larger than the cap alone and advance the cursor', async () => {
    const { query, ids } = await fiveNotes();
    const first = query({ process: 'run-1', maxChars: 1 });

    const second = query({ process: 'run-1', maxChars: 1, cursor: cursorOf(first) });

    expect(idsOf(first)).toEqual([at(ids, 0)]);
    expect(idsOf(second)).toEqual([at(ids, 1)]);
  });

  it('should bring a record larger than the cap alone and advance the cursor to the last page, in project scope', async () => {
    const { query, a, b, c, d } = await twoProcesses();

    const pages = walkPages(query, { scope: 'project', maxChars: 1 });

    expect(pages.map(idsOf)).toEqual([[a], [b], [c], [d]]);
  });

  it('should keep two of the records when the character cap is one over the size of the first two', async () => {
    const { query, ids } = await fiveNotes();
    const two = query({ process: 'run-1', limit: 2 }).records;
    const exact = two.reduce((sum, record) => sum + JSON.stringify(record).length, 0);

    const page = query({ process: 'run-1', maxChars: exact + 1 });

    expect(idsOf(page)).toEqual(ids.slice(0, 2));
  });

  it('should bring 50 records without `limit` and lead the cursor to the 51st', async () => {
    const { createProcess, register, query } = querySetup();
    createProcess('run-1');
    const ids = [
      ...(await register(
        'run-1',
        Array.from({ length: 50 }, () => note('x')),
        1,
      )),
      ...(await register('run-1', [note('y')], 2)),
    ];
    const first = query({ process: 'run-1' });

    const second = query({ process: 'run-1', cursor: cursorOf(first) });

    expect(idsOf(first)).toEqual(ids.slice(0, 50));
    expect(idsOf(second)).toEqual(ids.slice(50));
    expect(second.cursor).toBeUndefined();
  });

  it('should count the page already trimmed by `fields` against the character cap', async () => {
    const { createProcess, register, query } = querySetup();
    createProcess('run-1');
    const ids = await register(
      'run-1',
      Array.from({ length: 41 }, () => ({
        type: 'doc',
        target: 'run.doc',
        data: { note: 'x'.repeat(700), notes: ['ref'] },
      })),
    );
    const input = { process: 'run-1', limit: 100, maxChars: PAGE_CHARS_CAP } as const;

    const full = query(input);
    const empty = query({ ...input, fields: [] });
    const some = query({ ...input, fields: ['notes'] });

    expect(full.records.length).toBeLessThan(41);
    expect(full.cursor).toBeDefined();
    expect(idsOf(empty)).toEqual(ids);
    expect(empty.cursor).toBeUndefined();
    expect(idsOf(some)).toEqual(ids);
    expect(some.cursor).toBeUndefined();
  });

  it('should keep `fields` out of the cursor hash: page 2 may ask for others, both ways', async () => {
    const { query, ids } = await fiveNotes();
    const withFields = query({ process: 'run-1', limit: 2, fields: ['text'] });
    const withoutFields = query({ process: 'run-1', limit: 2 });

    const second = query({ process: 'run-1', limit: 10, fields: [], cursor: cursorOf(withFields) });
    const other = query({
      process: 'run-1',
      limit: 10,
      fields: ['text'],
      cursor: cursorOf(withoutFields),
    });

    expect([...idsOf(withFields), ...idsOf(second)]).toEqual(ids);
    expect([...idsOf(withoutFields), ...idsOf(other)]).toEqual(ids);
    expect(at(second.records, 0)).not.toHaveProperty('data');
    expect(at(other.records, 0).data).toEqual({ text: 'c' });
  });

  it('should give INVALID_CURSOR `project-mismatch` for a cursor from another project', async () => {
    const { query, queries } = await fiveNotes();
    const cursor = cursorOf(query({ process: 'run-1', limit: 2 }));

    const error = captureError(() =>
      queries.queryRecords({ project: 'other', process: 'run-1', cursor }),
    );

    expect(error.code).toBe('INVALID_CURSOR');
    expect(at(error.details, 0).code).toBe('project-mismatch');
    expect(at(error.details, 0).message).toContain('rerun the query without cursor');
  });

  it.each([
    [
      'malformed',
      'truncated',
      ({ cursor }: Cursors) => ({ process: 'run-1', cursor: cursor.slice(0, -8) }),
    ],
    ['malformed', 'not a cursor', () => ({ process: 'run-1', cursor: 'nao-e-cursor' })],
    [
      'filters-mismatch',
      'issued without `text`',
      ({ cursor }: Cursors) => ({ process: 'run-1', cursor, text: 'a' }),
    ],
    [
      'scope-mismatch',
      'issued for the project scope, used in the process scope',
      ({ projectCursor }: Cursors) => ({ process: 'run-1', cursor: projectCursor }),
    ],
  ])('should give INVALID_CURSOR `%s` for a cursor %s', async (code, _case, inputOf) => {
    const { query } = await fiveNotes();
    const cursors = {
      cursor: cursorOf(query({ process: 'run-1', limit: 2 })),
      projectCursor: cursorOf(query({ scope: 'project', limit: 2 })),
    };

    const error = captureError(() => query(inputOf(cursors)));

    expect(error.code).toBe('INVALID_CURSOR');
    expect(at(error.details, 0).code).toBe(code);
  });

  it('should refuse a cursor with a marker from another log, a nonexistent marked id or a `lastId` outside the result', async () => {
    const { query } = await fiveNotes();
    const issued = decodeCursor(cursorOf(query({ process: 'run-1', limit: 2 })));
    const forged = (patch: Partial<typeof issued>) =>
      captureError(() =>
        query({ process: 'run-1', cursor: encodeCursor({ ...issued, ...patch }) }),
      );
    const ghost = ghostId('run-1', 0xffff);

    const hash = forged({ markerHashes: { 'run-1': sha256hex('outro') } });
    const marker = forged({ marker: { 'run-1': ghost } });
    const last = forged({ lastId: ghost });

    expect(hash.code).toBe('INVALID_CURSOR');
    expect(at(hash.details, 0).code).toBe('marker-hash-mismatch');
    expect(marker.code).toBe('MARKER_NOT_FOUND');
    expect(at(marker.details, 0).path).toBe('/cursor');
    expect(last.code).toBe('INVALID_CURSOR');
    expect(at(last.details, 0).code).toBe('last-id-not-found');
  });

  it('should accept a different `relations` mode on the next page', async () => {
    const { createProcess, register, query } = querySetup();
    createProcess('run-1');
    await register('run-1', [note('a'), note('b')], 1);
    const first = query({ process: 'run-1', limit: 1, relations: 'counts' });

    const second = query({
      process: 'run-1',
      limit: 1,
      relations: 'none',
      cursor: cursorOf(first),
    });

    expect(second.records).toHaveLength(1);
    expect(at(second.records, 0)).not.toHaveProperty('inCounts');
  });
});
