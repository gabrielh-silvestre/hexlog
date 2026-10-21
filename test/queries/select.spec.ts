import { afterEach, describe, expect, jest, test } from '@jest/globals';
import * as inheritanceModule from '../../src/domain/inheritance.ts';
import { note } from '../commands/register-fakes.ts';
import { at } from '../helpers.ts';
import { querySetup } from './query-setup.ts';

afterEach(() => {
  jest.restoreAllMocks();
});

/** Processo com herança ligada, com duas versões de `run.unit` e um registro revogado. */
async function seeded() {
  const base = querySetup();
  base.createProcess('run-1');
  const u1 = await base.registerOne('run-1', note('unidade', { target: 'run.unit' }), 1);
  await base.registerOne(
    'run-1',
    note('unidade', { target: 'run.unit', relations: [{ to: u1, kind: 'supersedes' }] }),
    2,
  );
  const gone = await base.registerOne('run-1', note('removida', { target: 'run.gone' }), 3);
  await base.registerOne(
    'run-1',
    note('revoga', { target: 'run.revoker', relations: [{ to: gone, kind: 'revokes' }] }),
    4,
  );
  return { ...base, u1, gone };
}

describe('buildView: lazy inheritance', () => {
  test('a page with records computes the inheritance once', async () => {
    const { query } = await seeded();
    const build = jest.spyOn(inheritanceModule, 'buildInheritance');

    const page = query({ process: 'run-1', relations: 'full' });

    expect(page.records.length).toBeGreaterThan(1);
    expect(build).toHaveBeenCalledTimes(1);
  });

  test('limit 0 with changesSince does not compute the inheritance', async () => {
    const { query, u1 } = await seeded();
    const build = jest.spyOn(inheritanceModule, 'buildInheritance');

    const page = query({ process: 'run-1', limit: 0, changesSince: { 'run-1': u1 } });

    expect(page.records).toEqual([]);
    expect(page.changes).toBeDefined();
    expect(build).not.toHaveBeenCalled();
  });

  test('the past view of changesSince does not add a second computation', async () => {
    const { query, u1 } = await seeded();
    const build = jest.spyOn(inheritanceModule, 'buildInheritance');

    query({ process: 'run-1', changesSince: { 'run-1': u1 } });

    expect(build).toHaveBeenCalledTimes(1);
  });
});

describe('boundaryHint: scans every read record', () => {
  test.each([
    ['without includeNonCurrent', {}],
    ['with includeNonCurrent', { includeNonCurrent: true }],
  ])('the target of a revoked record still feeds the hint, %s', async (_title, extra) => {
    const { query, gone } = await seeded();
    expect(query({ process: 'run-1', ids: [gone] }).records).toEqual([]);

    const page = query({ process: 'run-1', targetPrefix: 'run.go', ...extra });

    expect(page.records).toEqual([]);
    expect(at([page.hint], 0)).toContain('"run.gone"');
  });
});
