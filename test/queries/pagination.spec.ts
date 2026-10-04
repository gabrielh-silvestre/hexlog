import { describe, expect, test } from '@jest/globals';
import fc from 'fast-check';
import { sha256hex } from '../../src/domain/chain.ts';
import { decodeCursor, encodeCursor } from '../../src/queries/cursor.ts';
import { ghostId, note } from '../commands/register-fakes.ts';
import { at, captureError } from '../helpers.ts';
import { cursorOf, idsOf, querySetup, walkPages } from './query-setup.ts';

describe('queryRecords: página e cursor (D-20)', () => {
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

  test('as páginas seguidas somam a lista inteira, sem repetir', async () => {
    const { query, ids } = await fiveNotes();

    const first = query({ process: 'run-1', limit: 2 });
    const second = query({ process: 'run-1', limit: 2, cursor: cursorOf(first) });
    const third = query({ process: 'run-1', limit: 2, cursor: cursorOf(second) });

    expect([...idsOf(first), ...idsOf(second), ...idsOf(third)]).toEqual(ids);
    expect(first.cursor).toBeDefined();
    expect(third.cursor).toBeUndefined();
  });

  test('para qualquer `limit`, as páginas somam a lista inteira, na mesma ordem e sem repetir', async () => {
    const { query, ids } = await fiveNotes();

    fc.assert(
      fc.property(fc.integer({ min: 1, max: 7 }), (limit) => {
        const walked = walkPages(query, { process: 'run-1', limit }).flatMap(idsOf);

        expect(walked).toEqual(ids);
      }),
      { numRuns: 20 },
    );
  });

  test('`limit` igual ao que resta fecha a lista sem cursor, e um a menos deixa o cursor', async () => {
    const { query, ids } = await fiveNotes();

    const exact = query({ process: 'run-1', limit: 5 });
    const short = query({ process: 'run-1', limit: 4 });

    expect(idsOf(exact)).toEqual(ids);
    expect(exact.cursor).toBeUndefined();
    expect(idsOf(short)).toEqual(ids.slice(0, 4));
    expect(short.cursor).toBeDefined();
  });

  test('o teto de caracteres na última página devolve o registro que resta e nenhum cursor', async () => {
    const { query, ids } = await fiveNotes();
    const first = query({ process: 'run-1', limit: 4 });

    const last = query({ process: 'run-1', maxChars: 1, cursor: cursorOf(first) });

    expect(idsOf(last)).toEqual([at(ids, 4)]);
    expect(last.cursor).toBeUndefined();
  });

  test('consulta sem resultado devolve `records` vazio, sem cursor e com o marcador do que leu', async () => {
    const { query } = await fiveNotes();

    const page = query({ process: 'run-1', type: 'doc' });

    expect(page.records).toEqual([]);
    expect(page.cursor).toBeUndefined();
    expect(Object.keys(page.marker)).toEqual(['run-1']);
  });

  test('as páginas do alcance projeto também somam a lista inteira, sem repetir', async () => {
    const { query, a, b, c, d } = await twoProcesses();

    const first = query({ scope: 'project', limit: 3 });
    const second = query({ scope: 'project', limit: 3, cursor: cursorOf(first) });

    expect([...idsOf(first), ...idsOf(second)]).toEqual([a, b, c, d]);
    expect(second.cursor).toBeUndefined();
  });

  test('SL6: uma substituição gravada entre as páginas não muda a lista da página 1 (alcance processo)', async () => {
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

  test('SL6: uma substituição gravada entre as páginas não muda a lista da página 1 (alcance projeto)', async () => {
    const { query, registerOne, a, b, c, d } = await twoProcesses();
    const first = query({ scope: 'project', limit: 2 });
    await registerOne('run-1', note('c2', { relations: [{ to: c, kind: 'supersedes' }] }), 5);
    await registerOne('run-2', note('e'), 6);

    const second = query({ scope: 'project', limit: 10, cursor: cursorOf(first) });

    expect(idsOf(first)).toEqual([a, b]);
    expect(idsOf(second)).toEqual([c, d]);
    expect(second.marker).toEqual(first.marker);
  });

  test('SL6: um processo que nasce depois da página 1 não entra nas páginas seguintes', async () => {
    const { createProcess, registerOne, query, a, b, c, d } = await twoProcesses();
    const first = query({ scope: 'project', limit: 2 });
    createProcess('run-3');
    await registerOne('run-3', note('nasceu depois'), 5);

    const second = query({ scope: 'project', limit: 10, cursor: cursorOf(first) });

    expect(idsOf(first)).toEqual([a, b]);
    expect(idsOf(second)).toEqual([c, d]);
  });

  test('SL6: processo chamado `constructor` nascido entre as páginas não derruba o cursor do projeto', async () => {
    const { createProcess, registerOne, query, a, b, c, d } = await twoProcesses();
    const first = query({ scope: 'project', limit: 2 });
    createProcess('constructor');
    await registerOne('constructor', note('nasceu depois'), 5);

    const second = query({ scope: 'project', limit: 10, cursor: cursorOf(first) });

    expect(idsOf(first)).toEqual([a, b]);
    expect(idsOf(second)).toEqual([c, d]);
  });

  test('cursor com `text` de 2+ termos e `type`: mesma ordem e `lastId` presente com append entre páginas', async () => {
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

  test('o cursor do alcance projeto cobre todos os processos lidos', async () => {
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

  test('registro maior que o teto sai sozinho e o cursor avança', async () => {
    const { query, ids } = await fiveNotes();

    const first = query({ process: 'run-1', maxChars: 1 });
    const second = query({ process: 'run-1', maxChars: 1, cursor: cursorOf(first) });

    expect(idsOf(first)).toEqual([at(ids, 0)]);
    expect(idsOf(second)).toEqual([at(ids, 1)]);
  });

  test('registro maior que o teto sai sozinho e o cursor avança até a última página (alcance projeto)', async () => {
    const { query, a, b, c, d } = await twoProcesses();

    const pages = walkPages(query, { scope: 'project', maxChars: 1 });

    expect(pages.map(idsOf)).toEqual([[a], [b], [c], [d]]);
  });

  test('o teto de caracteres corta a página antes do limite', async () => {
    const { query, ids } = await fiveNotes();
    const one = JSON.stringify(at(query({ process: 'run-1', limit: 1 }).records, 0)).length;

    const page = query({ process: 'run-1', maxChars: one * 2 + 1 });

    expect(idsOf(page)).toEqual(ids.slice(0, 2));
  });

  test('cursor de outro projeto dá INVALID_CURSOR `project-mismatch`', async () => {
    const { query, queries } = await fiveNotes();
    const cursor = cursorOf(query({ process: 'run-1', limit: 2 }));

    const error = captureError(() =>
      queries.queryRecords({ project: 'other', process: 'run-1', cursor }),
    );

    expect(error.code).toBe('INVALID_CURSOR');
    expect(at(error.details, 0).code).toBe('project-mismatch');
  });

  test('cursor mexido, de outro filtro, alcance ou processo dá INVALID_CURSOR', async () => {
    const { query, createProcess } = await fiveNotes();
    createProcess('run-2');
    const cursor = cursorOf(query({ process: 'run-1', limit: 2 }));
    const projectCursor = cursorOf(query({ scope: 'project', limit: 2 }));
    const codeOf = (input: Parameters<typeof query>[0]) => {
      const error = captureError(() => query(input));
      expect(error.code).toBe('INVALID_CURSOR');
      return at(error.details, 0).code;
    };

    expect(codeOf({ process: 'run-1', cursor: `${cursor.slice(0, -1)}0` })).toBe(
      'checksum-mismatch',
    );
    expect(codeOf({ process: 'run-1', cursor: 'nao-e-cursor' })).toBe('malformed');
    expect(codeOf({ process: 'run-1', cursor, type: 'doc' })).toBe('filters-mismatch');
    expect(codeOf({ process: 'run-1', cursor, text: 'a' })).toBe('filters-mismatch');
    expect(codeOf({ process: 'run-1', cursor, includeNonCurrent: true })).toBe('filters-mismatch');
    expect(codeOf({ process: 'run-1', cursor, scope: 'project' })).toBe('scope-mismatch');
    expect(codeOf({ process: 'run-1', cursor: projectCursor })).toBe('scope-mismatch');
    expect(codeOf({ process: 'run-2', cursor })).toBe('process-mismatch');
  });

  test('cursor com marcador de outro log, id marcado inexistente ou lastId fora do resultado é recusado', async () => {
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
});
