import { afterEach, describe, expect, it, jest } from '@jest/globals';
import * as inheritanceModule from '../../src/domain/inheritance.ts';
import { note } from '../commands/fakes.ts';
import { querySetup } from './query-setup.ts';

/** Processo com herança ligada, com duas versões de `run.unit` e um registro revogado. */
async function withRevokedRecord() {
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

describe('QueryService.queryRecords', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('should compute the inheritance once for a page with records', async () => {
    const { query } = await withRevokedRecord();
    const build = jest.spyOn(inheritanceModule, 'buildInheritance');

    query({ process: 'run-1', relations: 'full' });

    expect(build).toHaveBeenCalledTimes(1);
  });

  it('should not compute the inheritance for limit 0 with changesSince', async () => {
    const { query, u1 } = await withRevokedRecord();
    const build = jest.spyOn(inheritanceModule, 'buildInheritance');

    const page = query({ process: 'run-1', limit: 0, changesSince: { 'run-1': u1 } });

    expect(page.records).toEqual([]);
    expect(page.changes).toBeDefined();
    expect(build).not.toHaveBeenCalled();
  });

  it('should not add a second inheritance computation for the past view of changesSince', async () => {
    const { query, u1 } = await withRevokedRecord();
    const build = jest.spyOn(inheritanceModule, 'buildInheritance');

    query({ process: 'run-1', changesSince: { 'run-1': u1 } });

    expect(build).toHaveBeenCalledTimes(1);
  });

  it('should omit a revoked record from the ids lookup', async () => {
    const { query, gone } = await withRevokedRecord();

    const page = query({ process: 'run-1', ids: [gone] });

    expect(page.records).toEqual([]);
  });

  it.each([
    ['without includeNonCurrent', {}],
    ['with includeNonCurrent', { includeNonCurrent: true }],
  ])('should feed the hint with the target of a revoked record, %s', async (_title, extra) => {
    const { query } = await withRevokedRecord();

    const page = query({ process: 'run-1', targetPrefix: 'run.go', ...extra });

    expect(page.records).toEqual([]);
    expect(page.hint).toContain('"run.gone"');
  });
});
