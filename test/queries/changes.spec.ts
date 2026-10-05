import { describe, expect, jest, test } from '@jest/globals';
import { createSearchIndex } from '../../src/adapters/search.ts';
import type { Marker, RecordId } from '../../src/domain/ids.ts';
import { createQueryService } from '../../src/queries/query-service.ts';
import { ghostId, note } from '../commands/register-fakes.ts';
import { at, captureError } from '../helpers.ts';
import { cursorOf, diskStores, idsOf, PROJECT, querySetup } from './query-setup.ts';

const supersedes = (to: RecordId) => ({ to, kind: 'supersedes' as const });
const revokes = (to: RecordId) => ({ to, kind: 'revokes' as const });

describe('queryRecords: changesSince (SL7)', () => {
  test('entered e left descrevem a diferença para a foto anterior, com o motivo', async () => {
    const { createProcess, register, registerOne, query } = querySetup();
    createProcess('run-1');
    const initial = await register('run-1', [note('a'), note('b'), note('c')], 1);
    const [kept, replaced, revoked] = [at(initial, 0), at(initial, 1), at(initial, 2)];
    const before = query({ process: 'run-1', changesSince: { 'run-1': null } });
    const snapshot = query({ process: 'run-1' });
    const added = await registerOne('run-1', note('d'), 2);
    const successor = await registerOne(
      'run-1',
      note('b2', { relations: [supersedes(replaced)] }),
      3,
    );
    const revoker = await registerOne(
      'run-1',
      note('revoga', { relations: [revokes(revoked)] }),
      4,
    );

    const page = query({ process: 'run-1', changesSince: snapshot.marker });

    expect(before.changes?.entered).toEqual([kept, replaced, revoked]);
    expect(page.changes).toEqual({
      entered: [added, successor, revoker],
      left: [
        { id: replaced, reason: 'superseded' },
        { id: revoked, reason: 'revoked' },
      ],
      marker: page.marker,
    });
  });

  test('SL7: o entered é a diferença entre a lista de agora e a da foto anterior', async () => {
    const { createProcess, registerOne, query } = querySetup();
    createProcess('run-1');
    await registerOne('run-1', note('a'), 1);
    const snapshot = query({ process: 'run-1' });
    await registerOne('run-1', note('b'), 2);
    await registerOne('run-1', note('c'), 3);

    const now = query({ process: 'run-1' });
    const changes = query({ process: 'run-1', changesSince: snapshot.marker }).changes;

    expect(changes?.entered).toEqual(idsOf(now).filter((id) => !idsOf(snapshot).includes(id)));
    expect(changes?.left).toEqual([]);
  });

  test('SL7: a foto anterior mais entered, menos left, dá a mesma lista de uma foto nova (alcance processo)', async () => {
    const { createProcess, register, registerOne, query } = querySetup();
    createProcess('run-1');
    const initial = await register('run-1', [note('a'), note('b'), note('c')], 1);
    const snapshot = query({ process: 'run-1' });
    await registerOne('run-1', note('d'), 2);
    await registerOne('run-1', note('b2', { relations: [supersedes(at(initial, 1))] }), 3);
    await registerOne('run-1', note('revoga', { relations: [revokes(at(initial, 2))] }), 4);

    const fresh = query({ process: 'run-1' });
    const changes = query({ process: 'run-1', changesSince: snapshot.marker }).changes;
    const left = changes?.left.map(({ id }) => id) ?? [];
    const rebuilt = [
      ...idsOf(snapshot).filter((id) => !left.includes(id)),
      ...(changes?.entered ?? []),
    ];

    expect([...rebuilt].sort()).toEqual([...idsOf(fresh)].sort());
    expect(changes?.marker).toEqual(fresh.marker);
  });

  test('SL7: a foto anterior mais entered, menos left, dá a mesma lista de uma foto nova (alcance projeto)', async () => {
    const { createProcess, registerOne, query } = querySetup();
    createProcess('run-1');
    createProcess('run-2');
    const a = await registerOne('run-1', note('a'), 1);
    const b = await registerOne('run-2', note('b'), 2);
    const snapshot = query({ scope: 'project' });
    createProcess('run-3');
    await registerOne('run-3', note('c'), 3);
    await registerOne('run-2', note('b2', { relations: [supersedes(b)] }), 4);
    await registerOne('run-1', note('revoga a', { relations: [revokes(a)] }), 5);

    const fresh = query({ scope: 'project' });
    const changes = query({ scope: 'project', changesSince: snapshot.marker }).changes;
    const left = changes?.left.map(({ id }) => id) ?? [];
    const rebuilt = [
      ...idsOf(snapshot).filter((id) => !left.includes(id)),
      ...(changes?.entered ?? []),
    ];

    expect([...rebuilt].sort()).toEqual([...idsOf(fresh)].sort());
    expect(changes?.left).toEqual([
      { id: a, reason: 'revoked' },
      { id: b, reason: 'superseded' },
    ]);
  });

  test('com `includeNonCurrent` nada sai do resultado, então `left` vem vazio', async () => {
    const { createProcess, registerOne, query } = querySetup();
    createProcess('run-1');
    const old = await registerOne('run-1', note('a'), 1);
    const snapshot = query({ process: 'run-1', includeNonCurrent: true });
    const next = await registerOne('run-1', note('a2', { relations: [supersedes(old)] }), 2);

    const page = query({
      process: 'run-1',
      includeNonCurrent: true,
      changesSince: snapshot.marker,
    });

    expect(page.changes).toMatchObject({ entered: [next], left: [] });
  });

  test('o registro que só casava pelo fallback OR sai com `no-longer-matches` quando outro passa a casar no AND', async () => {
    const { createProcess, registerOne, query } = querySetup();
    createProcess('run-1');
    const fallback = await registerOne('run-1', note('banana laranja'), 1);
    const snapshot = query({ process: 'run-1', text: 'banana uva' });
    expect(idsOf(snapshot)).toEqual([fallback]);
    const exact = await registerOne('run-1', note('banana uva'), 2);

    const page = query({ process: 'run-1', text: 'banana uva', changesSince: snapshot.marker });

    expect(idsOf(page)).toEqual([exact]);
    expect(page.changes).toMatchObject({
      entered: [exact],
      left: [{ id: fallback, reason: 'no-longer-matches' }],
    });
  });

  test('as mudanças vêm só na página 1 e o cursor trava o `changesSince` da consulta', async () => {
    const { createProcess, register, query } = querySetup();
    createProcess('run-1');
    const snapshot = query({ process: 'run-1' });
    await register('run-1', [note('a'), note('b'), note('c')], 1);

    const first = query({ process: 'run-1', limit: 2, changesSince: snapshot.marker });
    const second = query({
      process: 'run-1',
      limit: 2,
      changesSince: snapshot.marker,
      cursor: cursorOf(first),
    });
    const other = captureError(() =>
      query({ process: 'run-1', limit: 2, cursor: cursorOf(first) }),
    );

    expect(first.changes?.entered).toHaveLength(3);
    expect(second.changes).toBeUndefined();
    expect(other.code).toBe('INVALID_CURSOR');
    expect(at(other.details, 0).code).toBe('filters-mismatch');
  });

  // Exceção estreita à SL2 (ADR 0008, decisão 3): o log é lido duas vezes só na 1ª página com
  // `changesSince`, uma para o estado de agora e outra para o do marcador.
  test('a 1ª página com `changesSince` lê o log duas vezes e as demais, uma', async () => {
    const { dataDir, createProcess, register, query } = querySetup();
    createProcess('run-1');
    const snapshot = query({ process: 'run-1' });
    await register('run-1', [note('a'), note('b'), note('c')], 1);
    const stores = diskStores(dataDir);
    const read = jest.spyOn(stores.store, 'read');
    const counted = createQueryService({ ...stores, search: createSearchIndex() });
    const input = { project: PROJECT, process: 'run-1', limit: 2, changesSince: snapshot.marker };

    const first = counted.queryRecords(input);
    expect(read).toHaveBeenCalledTimes(2);
    read.mockClear();
    counted.queryRecords({ ...input, cursor: cursorOf(first) });

    expect(read).toHaveBeenCalledTimes(1);
  });

  test('alcance processo: marcador sem a entrada do processo lido é MARKER_NOT_FOUND em /changesSince', async () => {
    const { createProcess, registerOne, query } = querySetup();
    createProcess('run-1');
    const head = await registerOne('run-1', note('a'), 1);

    const malformed: Marker[] = [{}, { 'run-9': head }, { 'run-1': head, 'run-9': head }];
    for (const changesSince of malformed) {
      const error = captureError(() => query({ process: 'run-1', changesSince }));
      expect(error.code).toBe('MARKER_NOT_FOUND');
      expect(error.details).toEqual([
        expect.objectContaining({ path: '/changesSince', code: 'process-not-found' }),
      ]);
    }
  });

  test('alcance projeto: id marcado inexistente é MARKER_NOT_FOUND em /changesSince', async () => {
    const { createProcess, registerOne, query } = querySetup();
    createProcess('run-1');
    await registerOne('run-1', note('a'), 1);

    const error = captureError(() =>
      query({ scope: 'project', changesSince: { 'run-1': ghostId('run-1') } }),
    );

    expect(error.code).toBe('MARKER_NOT_FOUND');
    expect(error.details).toEqual([expect.objectContaining({ path: '/changesSince' })]);
  });

  test('alcance projeto: o MARKER_NOT_FOUND nomeia o processo cujo id marcado não existe', async () => {
    const { createProcess, registerOne, query } = querySetup();
    createProcess('run-1');
    createProcess('run-2');
    const first = await registerOne('run-1', note('a'), 1);
    await registerOne('run-2', note('b'), 2);

    const error = captureError(() =>
      query({
        scope: 'project',
        changesSince: { 'run-1': first, 'run-2': ghostId('run-2') },
      }),
    );

    expect(error.code).toBe('MARKER_NOT_FOUND');
    expect(error.details).toEqual([
      expect.objectContaining({ path: '/changesSince', process: 'run-2' }),
    ]);
  });

  test('processo chamado `constructor` nascido depois do marcador conta como vazio', async () => {
    const { createProcess, registerOne, query } = querySetup();
    createProcess('run-1');
    await registerOne('run-1', note('a'), 1);
    const snapshot = query({ scope: 'project' });
    createProcess('constructor');
    const born = await registerOne('constructor', note('nasceu depois'), 2);

    const page = query({ scope: 'project', changesSince: snapshot.marker });

    expect(page.changes?.entered).toEqual([born]);
  });

  test('no alcance projeto, processo ausente do marcador conta como vazio e marcador de processo inexistente é recusado', async () => {
    const { createProcess, registerOne, query } = querySetup();
    createProcess('run-1');
    const first = await registerOne('run-1', note('a'), 1);
    const snapshot = query({ scope: 'project' });
    createProcess('run-2');
    const born = await registerOne('run-2', note('nasceu depois'), 2);

    const page = query({ scope: 'project', changesSince: snapshot.marker });
    const unknown = captureError(() =>
      query({ scope: 'project', changesSince: { fantasma: first } }),
    );

    expect(page.changes?.entered).toEqual([born]);
    expect(unknown.code).toBe('MARKER_NOT_FOUND');
  });
});
