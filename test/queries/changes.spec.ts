import { describe, expect, it, jest } from '@jest/globals';
import { createSearchIndex } from '../../src/adapters/search.ts';
import type { Marker, RecordId } from '../../src/domain/ids.ts';
import { createQueryService } from '../../src/queries/query-service.ts';
import type { QueryResult } from '../../src/queries/query-service.ts';
import { ghostId, note } from '../commands/register-fakes.ts';
import { at, captureError, cursorOf, idsOf } from '../helpers.ts';
import { diskStores, PROJECT, querySetup } from './query-setup.ts';

const supersedes = (to: RecordId) => ({ to, kind: 'supersedes' as const });
const revokes = (to: RecordId) => ({ to, kind: 'revokes' as const });

/** A foto anterior mais `entered` menos `left`, em ordem: tem de ser a lista de uma foto nova. */
function rebuiltIds(snapshot: QueryResult, changes: QueryResult['changes']): RecordId[] {
  const left = changes?.left.map(({ id }) => id) ?? [];
  return [
    ...idsOf(snapshot).filter((id) => !left.includes(id)),
    ...(changes?.entered ?? []),
  ].sort();
}

describe('QueryService.queryRecords', () => {
  describe('with changesSince', () => {
    it('should describe the difference from the previous snapshot with entered and left, with the reason', async () => {
      const { createProcess, register, registerOne, query } = querySetup();
      createProcess('run-1');
      const initial = await register('run-1', [note('a'), note('b'), note('c')], 1);
      const [replaced, revoked] = [at(initial, 1), at(initial, 2)];
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

      expect(page.changes).toEqual({
        entered: [added, successor, revoker],
        left: [
          { id: replaced, reason: 'superseded' },
          { id: revoked, reason: 'revoked' },
        ],
        marker: page.marker,
      });
    });

    it('should list every record as entered from a marker with a null entry', async () => {
      const { createProcess, register, query } = querySetup();
      createProcess('run-1');
      const initial = await register('run-1', [note('a'), note('b'), note('c')], 1);

      const page = query({ process: 'run-1', changesSince: { 'run-1': null } });

      expect(page.changes?.entered).toEqual(initial);
    });

    it('should give the same list as a fresh snapshot from the previous snapshot plus entered minus left, in the process scope', async () => {
      const { createProcess, register, registerOne, query } = querySetup();
      createProcess('run-1');
      const initial = await register('run-1', [note('a'), note('b'), note('c')], 1);
      const snapshot = query({ process: 'run-1' });
      await registerOne('run-1', note('d'), 2);
      await registerOne('run-1', note('b2', { relations: [supersedes(at(initial, 1))] }), 3);
      await registerOne('run-1', note('revoga', { relations: [revokes(at(initial, 2))] }), 4);
      const fresh = query({ process: 'run-1' });

      const changes = query({ process: 'run-1', changesSince: snapshot.marker }).changes;

      expect(rebuiltIds(snapshot, changes)).toEqual([...idsOf(fresh)].sort());
      expect(changes?.marker).toEqual(fresh.marker);
    });

    it('should give the same list as a fresh snapshot from the previous snapshot plus entered minus left, in the project scope', async () => {
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

      expect(rebuiltIds(snapshot, changes)).toEqual([...idsOf(fresh)].sort());
      expect(changes?.left).toEqual([
        { id: a, reason: 'revoked' },
        { id: b, reason: 'superseded' },
      ]);
    });

    it('should leave left empty with includeNonCurrent because nothing leaves the result', async () => {
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

    it('should drop a record that matched only by the OR fallback with no-longer-matches when another starts matching on AND', async () => {
      const { createProcess, registerOne, query } = querySetup();
      createProcess('run-1');
      const fallback = await registerOne('run-1', note('banana laranja'), 1);
      const snapshot = query({ process: 'run-1', text: 'banana uva' });
      const exact = await registerOne('run-1', note('banana uva'), 2);

      const page = query({ process: 'run-1', text: 'banana uva', changesSince: snapshot.marker });

      expect(idsOf(page)).toEqual([exact]);
      expect(page.changes).toMatchObject({
        entered: [exact],
        left: [{ id: fallback, reason: 'no-longer-matches' }],
      });
    });

    /** Três registros novos desde o marcador de `snapshot`; `input` pede páginas de 2 desde ele. */
    async function threeNewSince() {
      const setup = querySetup();
      setup.createProcess('run-1');
      const snapshot = setup.query({ process: 'run-1' });
      await setup.register('run-1', [note('a'), note('b'), note('c')], 1);
      const input = { process: 'run-1', limit: 2, changesSince: snapshot.marker };
      return { ...setup, input };
    }

    it('should return the changes only on the first page', async () => {
      const { query, input } = await threeNewSince();
      const first = query(input);

      const second = query({ ...input, cursor: cursorOf(first) });

      expect(first.changes?.entered).toHaveLength(3);
      expect(second.changes).toBeUndefined();
    });

    it('should lock the changesSince of the query into the cursor', async () => {
      const { query, input } = await threeNewSince();
      const first = query(input);

      const other = captureError(() =>
        query({ process: 'run-1', limit: 2, cursor: cursorOf(first) }),
      );

      expect(other.code).toBe('INVALID_CURSOR');
      expect(at(other.details, 0).code).toBe('filters-mismatch');
    });

    /** Serviço que conta as leituras do log, sobre o cenário de `threeNewSince`. */
    async function countingService() {
      const { dataDir, input } = await threeNewSince();
      const stores = diskStores(dataDir);
      const read = jest.spyOn(stores.store, 'read');
      const counted = createQueryService({ ...stores, search: createSearchIndex() });
      return { read, counted, input: { project: PROJECT, ...input } };
    }

    // Exceção estreita à regra de leitura única (ADR 0008, decisão 3): o log é lido duas vezes só na 1ª página com
    // `changesSince`, uma para o estado de agora e outra para o do marcador.
    it('should read the log twice on the first page', async () => {
      const { read, counted, input } = await countingService();

      counted.queryRecords(input);

      expect(read).toHaveBeenCalledTimes(2);
    });

    it('should read the log once on the pages after the first', async () => {
      const { read, counted, input } = await countingService();
      const first = counted.queryRecords(input);
      read.mockClear();

      counted.queryRecords({ ...input, cursor: cursorOf(first) });

      expect(read).toHaveBeenCalledTimes(1);
    });

    it('should refuse a marker without the entry of the read process with MARKER_NOT_FOUND at /changesSince in the process scope', async () => {
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

    it('should name the process whose marked id does not exist in MARKER_NOT_FOUND in the project scope', async () => {
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

    it.each(['constructor', 'run-2'])(
      'should count the process %s born after the marker as empty in the project scope',
      async (name) => {
        const { createProcess, registerOne, query } = querySetup();
        createProcess('run-1');
        await registerOne('run-1', note('a'), 1);
        const snapshot = query({ scope: 'project' });
        createProcess(name);
        const born = await registerOne(name, note('nasceu depois'), 2);

        const page = query({ scope: 'project', changesSince: snapshot.marker });

        expect(page.changes?.entered).toEqual([born]);
      },
    );

    it('should refuse a marker for a process that does not exist with MARKER_NOT_FOUND in the project scope', async () => {
      const { createProcess, registerOne, query } = querySetup();
      createProcess('run-1');
      const first = await registerOne('run-1', note('a'), 1);

      const unknown = captureError(() =>
        query({ scope: 'project', changesSince: { fantasma: first } }),
      );

      expect(unknown.code).toBe('MARKER_NOT_FOUND');
    });
  });
});
