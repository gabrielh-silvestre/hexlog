import { afterEach, describe, expect, jest, test } from '@jest/globals';
import * as path from 'node:path';
import { dataRoot } from '../../src/adapters/fs/data-format.ts';
import { createProcessStore } from '../../src/adapters/fs/process-store.ts';
import { sha256hex } from '../../src/domain/chain.ts';
import { HexlogError } from '../../src/errors.ts';
import type { Manifest, ProcessRef } from '../../src/ports.ts';
import type { LogRecord } from '../../src/shared/logger.ts';
import { createTempDir } from '../helpers.ts';

// O `release` real roda sempre (o lock não pode sobrar no disco); o gancho só lança depois dele.
// `jest.mock` precisa do prefixo `mock` para enxergar a variável do escopo do módulo.
const mockRelease: { failWith?: Error } = {};

jest.mock('../../src/adapters/fs/lock.ts', () => {
  const actual = jest.requireActual<typeof import('../../src/adapters/fs/lock.ts')>(
    '../../src/adapters/fs/lock.ts',
  );
  return {
    ...actual,
    createLockManager: (...args: Parameters<typeof actual.createLockManager>) => {
      const manager = actual.createLockManager(...args);
      return {
        ...manager,
        release: async (...releaseArgs: Parameters<typeof manager.release>) => {
          await manager.release(...releaseArgs);
          if (mockRelease.failWith) throw mockRelease.failWith;
        },
      };
    },
  };
});

afterEach(() => {
  delete mockRelease.failWith;
});

const ref: ProcessRef = { project: 'demo', process: 'proc-1' };

const manifest: Manifest = {
  ...ref,
  createdAt: '2026-09-30T12:00:00.000Z',
  fixed: { types: {}, relations: {}, gates: {} },
  hashes: { types: sha256hex(''), relations: sha256hex(''), gates: sha256hex('') },
};

function setup() {
  const dataDir = createTempDir('process-store-release');
  const records: LogRecord[] = [];
  const store = createProcessStore({ dataDir, log: (record) => records.push(record) });
  store.create(ref, manifest);
  return { store, records, dir: path.join(dataRoot(dataDir), ref.project, ref.process) };
}

const errno = (code: string): Error =>
  Object.assign(new Error(`${code}: /abs/secret/path`), { code });

describe('ProcessStore.write: falha do release (M7)', () => {
  test('só o try falha: o erro principal sai e nada é logado como release-failed', async () => {
    const { store, records } = setup();
    const primary = new HexlogError('INTERNAL', 'decide failed', []);

    const error = await store
      .write(ref, () => {
        throw primary;
      })
      .catch((reason: unknown) => reason);

    expect(error).toBe(primary);
    expect(records).not.toContainEqual(expect.objectContaining({ event: 'release-failed' }));
  });

  test('só o release falha: o erro do release sai', async () => {
    const { store, records } = setup();
    mockRelease.failWith = errno('EIO');

    const error = await store
      .write(ref, () => ({ result: 'ok' }))
      .catch((reason: unknown) => reason);

    expect(error).toBeInstanceOf(HexlogError);
    expect(error).toMatchObject({
      code: 'IO_ERROR',
      details: [expect.objectContaining({ code: 'eio' })],
    });
    expect(records).not.toContainEqual(expect.objectContaining({ event: 'release-failed' }));
  });

  test('os dois falham: o erro principal sai inalterado e o do release vai só ao log', async () => {
    const { store, records, dir } = setup();
    const primary = new HexlogError('INTERNAL', 'decide failed', []);
    mockRelease.failWith = errno('EIO');

    const error = await store
      .write(ref, () => {
        throw primary;
      })
      .catch((reason: unknown) => reason);

    expect(error).toBe(primary);
    expect(JSON.stringify(error)).not.toContain('EIO');
    expect(records).toContainEqual({ level: 'error', event: 'release-failed', code: 'EIO' });
    expect(JSON.stringify(records)).not.toContain(dir);
  });
});
