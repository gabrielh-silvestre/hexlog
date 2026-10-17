import { afterEach, describe, expect, it, jest } from '@jest/globals';
import fs from 'node:fs';
import { LOCK_DIR, processPaths } from '../../src/adapters/fs/data-format.ts';
import { createProcessStore } from '../../src/adapters/fs/process-store.ts';
import { HexlogError } from '../../src/errors.ts';
import type { ProcessRef } from '../../src/ports.ts';
import { emptyManifest } from '../fixtures/chain-line.ts';
import { captureLog, createTempDir, errno, expectNoLeak } from '../helpers.ts';

const ref: ProcessRef = { project: 'demo', process: 'proc-1' };

function setup() {
  const dataDir = createTempDir('process-store-release');
  const { records, log } = captureLog();
  const store = createProcessStore({ dataDir, log });
  store.create(ref, emptyManifest(ref));
  const { dir, log: logFile } = processPaths(dataDir, ref);
  return { store, records, dir, logFile };
}

const realRename = fs.renameSync;

// Falha o `rename` da liberação uma única vez: a gravação seguinte também libera por ele.
function failReleaseOnce(): void {
  let failed = false;
  jest.spyOn(fs, 'renameSync').mockImplementation((from, to) => {
    if (!failed && String(to).includes('.released-')) {
      failed = true;
      throw errno('EIO');
    }
    realRename(from, to);
  });
}

const line = '{"n":1}\n';
const nextLine = '{"n":2}\n';

describe('ProcessStore.write', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('should throw the primary error and log nothing as release-failed when only the try fails (M7)', async () => {
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

  it('should throw the release error, keep the line durable and leave the lock orphaned when only the release fails (M7)', async () => {
    const { store, records, dir, logFile } = setup();
    failReleaseOnce();

    const error = await store
      .write(ref, () => ({ line, result: 'ok' }))
      .catch((reason: unknown) => reason);

    expect(error).toBeInstanceOf(HexlogError);
    expect(error).toMatchObject({
      code: 'IO_ERROR',
      details: [expect.objectContaining({ code: 'eio' })],
    });
    expect(fs.readFileSync(logFile, 'utf8')).toBe(line);
    expect(records).not.toContainEqual(expect.objectContaining({ event: 'release-failed' }));
    expect(fs.readdirSync(dir)).toContain(LOCK_DIR);
  });

  it('should append on the next write after the release failed, removing the orphan lock (M7)', async () => {
    const { store, records, logFile } = setup();
    failReleaseOnce();
    await store.write(ref, () => ({ line, result: 'ok' })).catch((reason: unknown) => reason);

    await store.write(ref, () => ({ line: nextLine, result: 'ok' }));

    expect(fs.readFileSync(logFile, 'utf8')).toBe(line + nextLine);
    expect(records).toContainEqual(expect.objectContaining({ event: 'lock-orphan-removed' }));
  });

  it('should throw the primary error unchanged and send the release error only to the log when both fail (M7)', async () => {
    const { store, records, dir, logFile } = setup();
    const primary = new HexlogError('INTERNAL', 'decide failed', []);
    failReleaseOnce();

    const error = await store
      .write(ref, () => {
        throw primary;
      })
      .catch((reason: unknown) => reason);

    expect(error).toBe(primary);

    expectNoLeak(primary, 'EIO');

    expect(fs.readFileSync(logFile, 'utf8')).toBe('');
    expect(records).toContainEqual({ level: 'error', event: 'release-failed', code: 'EIO' });
    expect(JSON.stringify(records)).not.toContain(dir);
  });

  it('should write the next line after the release and the try both failed (M7)', async () => {
    const { store, logFile } = setup();
    const primary = new HexlogError('INTERNAL', 'decide failed', []);
    failReleaseOnce();
    await store
      .write(ref, () => {
        throw primary;
      })
      .catch((reason: unknown) => reason);

    await store.write(ref, () => ({ line, result: 'ok' }));

    expect(fs.readFileSync(logFile, 'utf8')).toBe(line);
  });
});
