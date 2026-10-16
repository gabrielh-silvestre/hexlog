import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, test } from '@jest/globals';
import { omit } from 'es-toolkit';
import type { BatchItem } from '../../src/domain/record.ts';
import { QUERY_TEXT_MAX_CHARS } from '../../src/queries/query-service.ts';
import { ghostId, note } from '../commands/register-fakes.ts';
import { at, captureError } from '../helpers.ts';
import { cursorOf, idsOf, PROJECT, querySetup, seeded } from './query-setup.ts';

const doc = (data: BatchItem['data'], extra: Partial<BatchItem> = {}): BatchItem => ({
  type: 'doc',
  target: 'run.doc',
  data,
  ...extra,
});

describe('queryRecords: filters and embedded data', () => {
  test('only current records come out by default, and `includeNonCurrent` brings the superseded ones', async () => {
    const { query, v1, v2, task, other } = await seeded();

    expect(idsOf(query({ process: 'run-1' }))).toEqual([task, other, v2]);
    expect(idsOf(query({ process: 'run-1', includeNonCurrent: true }))).toEqual([
      v1,
      task,
      other,
      v2,
    ]);
  });

  test('`type` and scalar `where` filter by equality', async () => {
    const { query, other, task } = await seeded();

    expect(idsOf(query({ process: 'run-1', type: 'doc' }))).toEqual([other]);
    expect(idsOf(query({ process: 'run-1', where: { text: 'tarefa' } }))).toEqual([task]);
  });

  test('`targetPrefix` respects the dot boundary', async () => {
    const { query, v2, task } = await seeded();

    expect(idsOf(query({ process: 'run-1', targetPrefix: 'run.step' }))).toEqual([task, v2]);
  });

  test('filters combine with AND', async () => {
    const { query, task } = await seeded();

    const page = query({
      process: 'run-1',
      type: 'note',
      targetPrefix: 'run.step',
      text: 'tarefa',
    });

    expect(idsOf(page)).toEqual([task]);
  });

  test('`text` with 2+ terms and `type`: the OR fallback decides over the records that pass the filters', async () => {
    const { createProcess, registerOne, query } = querySetup();
    createProcess('run-1');
    await registerOne('run-1', doc({ note: 'banana uva' }), 1);
    const banana = await registerOne('run-1', note('banana'), 2);
    const uva = await registerOne('run-1', note('uva'), 3);

    const page = query({ process: 'run-1', type: 'note', text: 'banana uva' });

    expect(idsOf(page)).toEqual([banana, uva]);
  });

  test('`text` with 2+ terms: the OR fallback also decides over currency', async () => {
    const { createProcess, registerOne, query } = querySetup();
    createProcess('run-1');
    const old = await registerOne('run-1', note('banana uva'), 1);
    const banana = await registerOne('run-1', note('banana'), 2);
    const uva = await registerOne('run-1', note('uva'), 3);
    await registerOne(
      'run-1',
      note('laranja', { relations: [{ to: old, kind: 'supersedes' }] }),
      4,
    );

    expect(idsOf(query({ process: 'run-1', text: 'banana uva' }))).toEqual([banana, uva]);
    expect(idsOf(query({ process: 'run-1', text: 'banana uva', includeNonCurrent: true }))).toEqual(
      [old],
    );
  });

  test('`text` above the cap is INVALID_FILTER `too-long`, and at the cap it passes', () => {
    const { createProcess, query } = querySetup();
    createProcess('run-1');

    const error = captureError(() =>
      query({ process: 'run-1', text: 'a'.repeat(QUERY_TEXT_MAX_CHARS + 1) }),
    );

    expect(error.code).toBe('INVALID_FILTER');
    expect(error.details).toEqual([expect.objectContaining({ path: '/text', code: 'too-long' })]);
    expect(query({ process: 'run-1', text: 'a'.repeat(QUERY_TEXT_MAX_CHARS) }).records).toEqual([]);
  });

  test.each([0, -1, 1.5, NaN, Infinity])('`limit` %p is INVALID_FILTER at /limit', (limit) => {
    const { createProcess, query } = querySetup();
    createProcess('run-1');

    const error = captureError(() => query({ process: 'run-1', limit }));

    expect(error.code).toBe('INVALID_FILTER');
    expect(at(error.details, 0)).toMatchObject({ path: '/limit', code: 'out-of-range' });
  });

  test.each(['', '  ', '!!!', '&&', '::', '§', '́', ' '])(
    '`text` %j without a searchable term is INVALID_FILTER `no-terms` at /text',
    (text) => {
      const { createProcess, query } = querySetup();
      createProcess('run-1');

      const error = captureError(() => query({ process: 'run-1', text }));

      expect(error.code).toBe('INVALID_FILTER');
      expect(at(error.details, 0)).toMatchObject({ path: '/text', code: 'no-terms' });
      expect(at(error.details, 0).message).toContain('spaces and punctuation are not terms');
    },
  );

  test.each(['=>', '+++', '$$$', 'C++', '😀'])(
    '`text` %j has a term: returns empty, no error',
    (text) => {
      const { createProcess, query } = querySetup();
      createProcess('run-1');

      expect(query({ process: 'run-1', text }).records).toEqual([]);
    },
  );

  test('`ids` with an unknown or repeated id returns each record once, in output order', async () => {
    const { query, task, other } = await seeded();

    const page = query({ process: 'run-1', ids: [other, ghostId('run-1'), task, other] });

    expect(idsOf(page)).toEqual([task, other]);
  });

  test('`relatedTo` with an anchor from another process finds who cites it; an anchor that does not exist finds nothing', async () => {
    const { createProcess, registerOne, query } = querySetup();
    createProcess('run-1');
    createProcess('run-2');
    const anchor = await registerOne('run-2', note('âncora'), 1);
    const citing = await registerOne(
      'run-1',
      note('cita', { relations: [{ to: anchor, kind: 'supports' }] }),
      2,
    );

    expect(idsOf(query({ process: 'run-1', relatedTo: anchor }))).toEqual([citing]);
    expect(idsOf(query({ process: 'run-1', relatedTo: ghostId('run-1') }))).toEqual([]);
  });
});

describe('queryRecords: attachmentStatus', () => {
  test('each cited attachment comes out with the blob state and a record without attachments carries no field', async () => {
    const { createProcess, registerOne, attachments, dataDir, query } = querySetup();
    createProcess('run-1');
    const kept = attachments.putText(PROJECT, 'guardado').hash;
    const gone = attachments.putText(PROJECT, 'apagado').hash;
    const broken = attachments.putText(PROJECT, 'adulterado').hash;
    await registerOne('run-1', doc({ body: kept, files: [gone, broken] }));
    await registerOne('run-1', note('sem anexo'));
    const blob = (hash: string) => path.join(dataDir, '.v1', PROJECT, 'attachments', hash);
    fs.rmSync(blob(gone));
    fs.writeFileSync(blob(broken), 'outro conteúdo');

    const page = query({ process: 'run-1' });

    expect(at(page.records, 0).attachmentStatus).toEqual({
      [kept]: 'ok',
      [gone]: 'missing',
      [broken]: 'corrupted',
    });
    expect(at(page.records, 1)).not.toHaveProperty('attachmentStatus');
  });
});

describe('queryRecords: fields', () => {
  test('without `fields` the page is unchanged, with `data` right after the envelope', async () => {
    const { query } = await seeded();

    const page = query({ process: 'run-1' });

    expect(JSON.stringify(query({ process: 'run-1', fields: undefined }))).toBe(
      JSON.stringify(page),
    );
    expect(Object.keys(at(page.records, 0)).slice(0, 6)).toEqual([
      'id',
      'type',
      'at',
      'target',
      'author',
      'data',
    ]);
  });

  test('only `data` is trimmed: envelope, relations and `attachmentStatus` come out whole', async () => {
    const { createProcess, registerOne, attachments, query } = querySetup();
    createProcess('run-1');
    const kept = attachments.putText(PROJECT, 'guardado').hash;
    const first = await registerOne('run-1', doc({ body: kept, note: 'anotação' }), 1);
    await registerOne('run-1', note('apoio', { relations: [{ to: first, kind: 'supports' }] }), 2);
    const full = query({ process: 'run-1' });

    const page = query({ process: 'run-1', fields: ['note'] });

    expect(at(page.records, 0)).toEqual({
      ...omit(at(full.records, 0), ['data']),
      data: { note: 'anotação' },
    });
    expect(at(page.records, 0).attachmentStatus).toEqual({ [kept]: 'ok' });
    expect(at(page.records, 0).in).toHaveLength(1);
    expect(at(page.records, 1)).toEqual({ ...at(full.records, 1), data: {} });
  });

  test('`needsReview` comes out whole even with trimmed `data`', async () => {
    const { createProcess, registerOne, query } = querySetup();
    createProcess('run-1');
    createProcess('run-2');
    const evidence = await registerOne('run-1', note('evidência'), 1);
    const verdict = await registerOne(
      'run-2',
      note('veredito', { relations: [{ to: evidence, kind: 'supports' }] }),
      2,
    );
    await registerOne(
      'run-1',
      note('evidência 2', { relations: [{ to: evidence, kind: 'supersedes' }] }),
      3,
    );

    const page = query({ scope: 'project', ids: [verdict], fields: [] });

    expect(at(page.records, 0).needsReview).toEqual({ staleIn: [], staleOut: [evidence] });
  });

  test('`fields: []` omits the `data` key and keeps the rest of the record', async () => {
    const { query, task } = await seeded();

    const page = query({ process: 'run-1', ids: [task], fields: [] });

    expect(at(page.records, 0)).not.toHaveProperty('data');
    expect(at(page.records, 0)).toMatchObject({ id: task, type: 'note', target: 'run.step.sub' });
    expect(at(page.records, 0)).toHaveProperty('in');
    expect(at(page.records, 0)).toHaveProperty('out');
  });

  test('`where` and `text` filter by the whole `data`, even with the field outside `fields`', async () => {
    const { query, task } = await seeded();

    const byWhere = query({ process: 'run-1', where: { text: 'tarefa' }, fields: [] });
    const byText = query({ process: 'run-1', text: 'tarefa', fields: ['inexistente'] });

    expect(idsOf(byWhere)).toEqual([task]);
    expect(idsOf(byText)).toEqual([task]);
  });

  test('a requested field the record lacks disappears: `data` is `{}` when none exists (project scope)', async () => {
    const { query, task, other } = await seeded();

    const page = query({ scope: 'project', ids: [task, other], fields: ['text'] });

    expect(at(page.records, 0).data).toEqual({ text: 'tarefa' });
    expect(at(page.records, 1).data).toEqual({});
  });

  test.each(['__proto__', 'constructor', 'toString'])(
    '`fields` with `%s` brings nothing from the prototype',
    async (name) => {
      const { query, task } = await seeded();

      const page = query({ process: 'run-1', ids: [task], fields: [name, 'text', 'text'] });

      expect(at(page.records, 0).data).toEqual({ text: 'tarefa' });
      expect(Object.keys(at(page.records, 0).data ?? {})).toEqual(['text']);
    },
  );
});

describe('queryRecords: needsReview (D-09)', () => {
  const supports = (to: string) => ({ to, kind: 'supports' as const });
  const supersedes = (to: string) => ({ to, kind: 'supersedes' as const });

  test('dead support: process scope does not see support from another process and project scope does', async () => {
    const { createProcess, registerOne, query } = querySetup();
    createProcess('run-1');
    createProcess('run-2');
    const evidence = await registerOne('run-1', note('evidência'), 1);
    const verdict = await registerOne(
      'run-2',
      note('veredito', { relations: [supports(evidence)] }),
      2,
    );
    await registerOne('run-1', note('evidência 2', { relations: [supersedes(evidence)] }), 3);

    const own = query({ process: 'run-2' });
    const project = query({ scope: 'project', ids: [verdict] });

    expect(at(own.records, 0)).not.toHaveProperty('needsReview');
    expect(at(project.records, 0).needsReview).toEqual({ staleIn: [], staleOut: [evidence] });
  });
});

describe('queryRecords: targetPrefix hint without boundary', () => {
  test('an empty selection with a prefix that only matches without the dot boundary carries the hint', async () => {
    const { query } = await seeded();

    const page = query({ process: 'run-1', targetPrefix: 'run.ste' });

    expect(page.records).toEqual([]);
    expect(page.hint).toContain('"run.ste"');
    expect(page.hint).toContain('"run.step"');
  });

  test.each([
    ['prefix with no similar target', { targetPrefix: 'run.nothing' }],
    ['selection with results', { targetPrefix: 'run.step' }],
    [
      'empty because of another filter, with a target that matches the prefix',
      { targetPrefix: 'run.step', type: 'nope' },
    ],
    ['without targetPrefix', { type: 'nope' }],
  ])('no hint: %s', async (_title, filters) => {
    const { query } = await seeded();

    expect(query({ process: 'run-1', ...filters })).not.toHaveProperty('hint');
  });

  test('matching does not change: the prefix without boundary still returns no records', async () => {
    const { query } = await seeded();

    expect(idsOf(query({ process: 'run-1', targetPrefix: 'run.ste' }))).toEqual([]);
  });
});

describe('queryRecords: limit 0 with changesSince', () => {
  test('returns only the changes, with no records or cursor', async () => {
    const { createProcess, registerOne, query } = querySetup();
    createProcess('run-1');
    await registerOne('run-1', note('a'), 1);
    const { marker } = query({ process: 'run-1' });
    const added = await registerOne('run-1', note('b'), 2);

    const page = query({ process: 'run-1', changesSince: marker, limit: 0 });

    expect(page.records).toEqual([]);
    expect(page).not.toHaveProperty('cursor');
    expect(page.changes).toEqual({ entered: [added], left: [], marker: page.marker });
  });

  test('without changesSince is INVALID_FILTER at /limit', () => {
    const { createProcess, query } = querySetup();
    createProcess('run-1');

    const error = captureError(() => query({ process: 'run-1', limit: 0 }));

    expect(error.code).toBe('INVALID_FILTER');
    expect(at(error.details, 0)).toMatchObject({ path: '/limit', code: 'out-of-range' });
  });

  test('with a cursor is INVALID_FILTER at /limit, even with changesSince', async () => {
    const { createProcess, register, query } = querySetup();
    createProcess('run-1');
    await register('run-1', [note('a'), note('b')], 1);
    const first = query({ process: 'run-1', limit: 1 });

    const error = captureError(() =>
      query({
        process: 'run-1',
        limit: 0,
        changesSince: first.marker,
        cursor: cursorOf(first),
      }),
    );

    expect(error.code).toBe('INVALID_FILTER');
    expect(at(error.details, 0)).toMatchObject({ path: '/limit', code: 'out-of-range' });
  });
});

describe('queryRecords: relations mode', () => {
  /** `evidence` com duas relações `approves`, uma `supports` sem nome e uma `supersedes` que a substitui. */
  async function wired() {
    const setup = querySetup();
    setup.createProcess('run-1');
    const { registerOne } = setup;
    const evidence = await registerOne('run-1', note('evidence'), 1);
    const approve = (text: string) => note(text, { relations: [{ to: evidence, as: 'approves' }] });
    await registerOne('run-1', approve('a'), 2);
    await registerOne('run-1', approve('b'), 3);
    await registerOne('run-1', note('c', { relations: [{ to: evidence, kind: 'supports' }] }), 4);
    const newer = await registerOne(
      'run-1',
      note('evidence 2', { relations: [{ to: evidence, kind: 'supersedes' }] }),
      5,
    );
    return { ...setup, evidence, newer };
  }

  test('counts replaces in and out with inCounts and outCounts keyed by relation name', async () => {
    const { query, evidence, newer } = await wired();

    const page = query({
      process: 'run-1',
      ids: [evidence, newer],
      includeNonCurrent: true,
      relations: 'counts',
    });

    expect(at(page.records, 0)).not.toHaveProperty('in');
    expect(at(page.records, 0)).not.toHaveProperty('out');
    expect(at(page.records, 0).inCounts).toEqual({ approves: 2, supports: 1, supersedes: 1 });
    expect(at(page.records, 1).outCounts).toEqual({ supersedes: 1 });
  });

  test('counts omits empty maps and zero kinds', async () => {
    const { query, evidence, newer } = await wired();

    const page = query({
      process: 'run-1',
      ids: [evidence, newer],
      includeNonCurrent: true,
      relations: 'counts',
    });

    expect(at(page.records, 0)).not.toHaveProperty('outCounts');
    expect(at(page.records, 1)).not.toHaveProperty('inCounts');
    expect(Object.keys(at(page.records, 0).inCounts ?? {})).toEqual([
      'approves',
      'supports',
      'supersedes',
    ]);
  });

  test('none omits in, out and both count maps', async () => {
    const { query, evidence } = await wired();

    const page = query({
      process: 'run-1',
      ids: [evidence],
      includeNonCurrent: true,
      relations: 'none',
    });

    for (const key of ['in', 'out', 'inCounts', 'outCounts']) {
      expect(at(page.records, 0)).not.toHaveProperty(key);
    }
  });

  test('full matches the default', async () => {
    const { query } = await wired();

    const withFull = query({ process: 'run-1', includeNonCurrent: true, relations: 'full' });
    const byDefault = query({ process: 'run-1', includeNonCurrent: true });

    expect(JSON.stringify(withFull)).toBe(JSON.stringify(byDefault));
    expect(at(byDefault.records, 0).in).toHaveLength(4);
  });

  test.each(['counts', 'none', 'full'] as const)(
    'keeps needsReview and attachmentStatus in %s mode',
    async (relations) => {
      const { createProcess, registerOne, attachments, query } = querySetup();
      createProcess('run-1');
      const kept = attachments.putText(PROJECT, 'guardado').hash;
      const evidence = await registerOne('run-1', note('evidência'), 1);
      const verdict = await registerOne(
        'run-1',
        doc({ body: kept }, { relations: [{ to: evidence, kind: 'supports' }] }),
        2,
      );
      await registerOne(
        'run-1',
        note('evidência 2', { relations: [{ to: evidence, kind: 'supersedes' }] }),
        3,
      );

      const page = query({ process: 'run-1', ids: [verdict], relations });

      expect(at(page.records, 0).needsReview).toEqual({ staleIn: [], staleOut: [evidence] });
      expect(at(page.records, 0).attachmentStatus).toEqual({ [kept]: 'ok' });
    },
  );

  test('counts counts non-current edges too', async () => {
    const { createProcess, registerOne, query } = querySetup();
    createProcess('run-1');
    const evidence = await registerOne('run-1', note('evidence'), 1);
    const support = await registerOne(
      'run-1',
      note('support', { relations: [{ to: evidence, kind: 'supports' }] }),
      2,
    );
    await registerOne(
      'run-1',
      note('support 2', { relations: [{ to: support, kind: 'supersedes' }] }),
      3,
    );

    const full = query({ process: 'run-1', ids: [evidence], relations: 'full' });
    const counts = query({ process: 'run-1', ids: [evidence], relations: 'counts' });

    expect(at(full.records, 0).in).toEqual([{ kind: 'supports', from: support, current: false }]);
    expect(at(counts.records, 0).inCounts).toEqual({ supports: 1 });
  });
});
