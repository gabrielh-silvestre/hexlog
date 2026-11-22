import { createHash } from 'node:crypto';
import { describe, expect, it } from '@jest/globals';
import { verifyProcess } from '../../src/shared/loader.ts';
import { decodeCursor } from '../../src/queries/cursor.ts';
import { Name } from '../../src/domain/ids.ts';
import { note } from '../commands/fakes.ts';
import { chainLine } from '../fixtures/chain-line.ts';
import { at, captureError, cursorOf, idsOf } from '../helpers.ts';
import { PROJECT, diskStores, querySetup } from './query-setup.ts';

/**
 * `run-1` com três notas vigentes: uma `agent`, uma `human` e uma gravada como o 1.2.3 gravava, sem a
 * chave `decidedBy` (a linha crua entra pela porta do store, com a cadeia coerente).
 */
async function withThreeRoles() {
  const setup = querySetup();
  setup.createProcess('run-1');
  await setup.registerOne('run-1', note('by agent'), 1);
  await setup.registerOne('run-1', note('by human', { decidedBy: 'human' }), 2);
  const { store } = diskStores(setup.dataDir);
  const ref = { project: PROJECT, process: Name.parse('run-1') };
  await store.write(ref, (raw) => ({
    line: chainLine('run-1', verifyProcess(raw).end, 1, { agent: 'old', text: () => 'by old' }),
    result: undefined,
  }));
  const [agent, human, old] = idsOf(setup.query({ process: 'run-1' }));
  return { ...setup, agent: agent!, human: human!, old: old! };
}

describe('QueryService.queryRecords', () => {
  describe('with the decidedBy filter', () => {
    it('should list only agent records, including a record written without the field', async () => {
      const { query, agent, old } = await withThreeRoles();

      const page = query({ process: 'run-1', decidedBy: 'agent' });

      expect(idsOf(page)).toEqual([agent, old]);
    });

    it('should list only human records', async () => {
      const { query, human } = await withThreeRoles();

      const page = query({ process: 'run-1', decidedBy: 'human' });

      expect(idsOf(page)).toEqual([human]);
    });

    it('should list nothing for a role no record has', async () => {
      const { query } = await withThreeRoles();

      const page = query({ process: 'run-1', decidedBy: 'third-party' });

      expect(idsOf(page)).toEqual([]);
    });

    it('should give the same record shape with and without the filter', async () => {
      const { query, human } = await withThreeRoles();

      const filtered = query({ process: 'run-1', decidedBy: 'human' });
      const whole = query({ process: 'run-1' });

      expect(filtered.records).toEqual(whole.records.filter(({ id }) => id === human));
    });

    it('should reject a cursor made under another decidedBy filter', async () => {
      const { query } = await withThreeRoles();
      const cursor = cursorOf(query({ process: 'run-1', decidedBy: 'agent', limit: 1 }));

      const error = captureError(() => query({ process: 'run-1', decidedBy: 'human', cursor }));

      expect(error.code).toBe('INVALID_CURSOR');
      expect(at(error.details, 0).code).toBe('filters-mismatch');
    });

    it('should continue a cursor made under the same decidedBy filter', async () => {
      const { query, agent, old } = await withThreeRoles();
      const first = query({ process: 'run-1', decidedBy: 'agent', limit: 1 });

      const second = query({
        process: 'run-1',
        decidedBy: 'agent',
        limit: 1,
        cursor: cursorOf(first),
      });

      expect(idsOf(first)).toEqual([agent]);
      expect(idsOf(second)).toEqual([old]);
    });
  });

  describe('with no decidedBy filter', () => {
    it('should keep the filters hash of the cursor of a query with no filter', async () => {
      const { query } = await withThreeRoles();

      const cursor = cursorOf(query({ process: 'run-1', limit: 1 }));

      // hash do JCS `{"includeNonCurrent":false}`, o mesmo de antes do filtro existir
      expect(decodeCursor(cursor).filtersHash).toBe(
        createHash('sha256').update('{"includeNonCurrent":false}').digest('hex'),
      );
    });

    it('should accept a cursor made by a query with no filter', async () => {
      const { query, agent, human, old } = await withThreeRoles();
      const first = query({ process: 'run-1', limit: 1 });

      const second = query({ process: 'run-1', limit: 2, cursor: cursorOf(first) });

      expect(idsOf(first)).toEqual([agent]);
      expect(idsOf(second)).toEqual([human, old]);
    });
  });
});
