import fs from 'node:fs';
import { describe, expect, it } from '@jest/globals';
import { MAX_LOG_BYTES } from '../../src/adapters/fs/process-store.ts';
import { note } from '../commands/fakes.ts';
import { at, captureError, detail, idsOf } from '../helpers.ts';
import { querySetup } from './query-setup.ts';

describe('QueryService.queryRecords', () => {
  it('should read only the requested process in the process scope, with a marker of one entry', async () => {
    const { createProcess, registerOne, query } = querySetup();
    createProcess('run-1');
    createProcess('run-2');
    const mine = await registerOne('run-1', note('a'));
    await registerOne('run-2', note('b'));

    const page = query({ process: 'run-1' });

    expect(idsOf(page)).toEqual([mine]);
    expect(page.marker).toEqual({ 'run-1': mine });
  });

  it('should not resolve relations with other processes in the process scope', async () => {
    const { createProcess, registerOne, query } = querySetup();
    createProcess('run-1');
    createProcess('run-2');
    const target = await registerOne('run-2', note('destino'), 1);
    const source = await registerOne(
      'run-1',
      note('origem', { relations: [{ to: target, kind: 'supports' }] }),
      2,
    );

    const origin = query({ process: 'run-1' });
    const destination = query({ process: 'run-2' });

    expect(at(origin.records, 0).out).toStrictEqual([{ kind: 'supports', to: target }]);
    expect(at(destination.records, 0).in).toEqual([]);
    expect(destination.marker).toEqual({ 'run-2': target });
    expect(origin.marker).toEqual({ 'run-1': source });
  });

  it('should resolve relations across processes in the project scope, with a marker that covers all of them', async () => {
    const { createProcess, registerOne, query } = querySetup();
    createProcess('run-1');
    createProcess('run-2');
    createProcess('vazio');
    const target = await registerOne('run-2', note('destino'), 1);
    const source = await registerOne(
      'run-1',
      note('origem', { relations: [{ to: target, as: 'approves' }] }),
      2,
    );

    const page = query({ scope: 'project' });

    expect(idsOf(page)).toEqual([target, source]);
    expect(at(page.records, 0).in).toEqual([
      { kind: 'supports', as: 'approves', from: source, current: true },
    ]);
    expect(at(page.records, 1).out).toEqual([
      { kind: 'supports', as: 'approves', to: target, current: true },
    ]);
    expect(page.marker).toEqual({ 'run-1': source, 'run-2': target, vazio: null });
  });

  it('should fail closed naming the process with a broken chain, only where it was read', async () => {
    const { createProcess, register, registerOne, tamper, query } = querySetup();
    createProcess('run-1');
    createProcess('run-2');
    await registerOne('run-1', note('ok'));
    await register('run-2', [note('vai quebrar'), note('e denuncia')]);
    tamper('run-2');

    const project = captureError(() => query({ scope: 'project' }));
    const own = captureError(() => query({ process: 'run-2' }));

    expect(project.code).toBe('PROCESS_CORRUPTED');
    expect(at(project.details, 0)).toMatchObject({ code: 'broken-chain', process: 'run-2' });
    expect(own.code).toBe('PROCESS_CORRUPTED');
    expect(query({ process: 'run-1' }).records).toHaveLength(1);
  });

  it('should refuse a missing project with PROJECT_NOT_FOUND in the project scope, as list does', () => {
    const { queries } = querySetup();

    const error = captureError(() => queries.queryRecords({ project: 'ghost', scope: 'project' }));

    expect(error.code).toBe('PROJECT_NOT_FOUND');
    expect(error.details).toEqual([detail('/project', 'unknown-project')]);
  });

  it('should name the process whose log passed the ceiling in the PROCESS_TOO_LARGE detail, without recommending to create another', async () => {
    const { createProcess, registerOne, logPath, query } = querySetup();
    createProcess('run-1');
    createProcess('run-2');
    await registerOne('run-1', note('a'), 1);
    fs.truncateSync(logPath('run-2'), MAX_LOG_BYTES + 1);

    const error = captureError(() => query({ scope: 'project' }));

    expect(error).toMatchObject({
      code: 'PROCESS_TOO_LARGE',
      message: "process 'run-2' log exceeds 64 MiB",
      details: [{ path: '/process', code: 'too-large', process: 'run-2' }],
    });
  });

  it('should return an empty page, not PROJECT_NOT_FOUND, for an existing project without processes', () => {
    const { query } = querySetup();

    expect(query({ scope: 'project' })).toEqual({ records: [], marker: {} });
  });

  it('should refuse the process scope without process with INVALID_FILTER at /process', () => {
    const { createProcess, query } = querySetup();
    createProcess('run-1');

    const missingName = captureError(() => query({}));

    expect(missingName.code).toBe('INVALID_FILTER');
    expect(at(missingName.details, 0).path).toBe('/process');
  });

  it('should refuse an unknown process with PROCESS_NOT_FOUND in the process scope', () => {
    const { createProcess, query } = querySetup();
    createProcess('run-1');

    const unknown = captureError(() => query({ process: 'nao-existe' }));

    expect(unknown.code).toBe('PROCESS_NOT_FOUND');
  });

  it('should list in the process scope only the origins of the own process, where the project scope lists all', async () => {
    const { createProcess, registerOne, query } = querySetup();
    createProcess('run-1');
    createProcess('run-2');
    const target = await registerOne('run-2', note('destino'), 1);
    await registerOne(
      'run-1',
      note('aprova', { relations: [{ to: target, kind: 'supports' }] }),
      2,
    );
    const own = await registerOne(
      'run-2',
      note('revisa', { relations: [{ to: target, kind: 'supports' }] }),
      3,
    );

    const destination = query({ process: 'run-2', ids: [target] });
    const project = query({ scope: 'project', ids: [target] });

    expect(at(destination.records, 0).in).toEqual([{ kind: 'supports', from: own, current: true }]);
    expect(at(project.records, 0).in).toHaveLength(2);
  });
});
