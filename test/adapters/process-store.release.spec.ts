import { afterEach, beforeAll, describe, expect, it, jest } from '@jest/globals';
import fs from 'node:fs';
import { LOCK_DIR, processPaths } from '../../src/adapters/fs/data-format.ts';
import { createProcessStore } from '../../src/adapters/fs/process-store.ts';
import { HexlogError } from '../../src/errors.ts';
import type { ProcessRef, ProcessStore } from '../../src/ports.ts';
import { emptyManifest } from '../fixtures/chain-line.ts';
import { captureLog, createTempDir, errno, expectNoLeak } from '../helpers.ts';
import { spyOnRename } from './fs-spies.ts';

const ref: ProcessRef = { project: 'demo', process: 'proc-1' };

function setup() {
  const dataDir = createTempDir('process-store-release');
  const { records, log } = captureLog();
  const store = createProcessStore({ dataDir, log });
  store.create(ref, emptyManifest(ref));
  const { dir, log: logFile } = processPaths(dataDir, ref);
  return { store, records, dir, logFile };
}

// Falha o `rename` da liberação uma única vez: a gravação seguinte também libera por ele.
function failReleaseOnce(): void {
  let failed = false;
  spyOnRename((_from, to) => {
    if (!failed && to.includes('.released-')) {
      failed = true;
      throw errno('EIO');
    }
  });
}

/** Grava com um `decide` que lança; devolve o erro lançado e o que `store.write` rejeitou. */
async function failingWrite(store: ProcessStore) {
  const primary = new HexlogError('INTERNAL', 'decide failed', []);
  const error = await store
    .write(ref, () => {
      throw primary;
    })
    .catch((reason: unknown) => reason);
  return { primary, error };
}

const line = '{"n":1}\n';
const nextLine = '{"n":2}\n';

describe('createProcessStore', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('should throw the primary error when only the try fails', async () => {
    const { store } = setup();

    const { primary, error } = await failingWrite(store);

    expect(error).toBe(primary);
  });

  it('should log nothing as release-failed when only the try fails', async () => {
    const { store, records } = setup();

    await failingWrite(store);

    expect(records).not.toContainEqual(expect.objectContaining({ event: 'release-failed' }));
  });

  describe('when only the release fails', () => {
    let env: ReturnType<typeof setup>;
    let error: unknown;

    beforeAll(async () => {
      env = setup();
      failReleaseOnce();
      error = await env.store
        .write(ref, () => ({ line, result: 'ok' }))
        .catch((reason: unknown) => reason);
    });

    it('should throw the release error', () => {
      expect(error).toBeInstanceOf(HexlogError);
      expect(error).toMatchObject({
        code: 'IO_ERROR',
        details: [expect.objectContaining({ code: 'eio' })],
      });
      expect(env.records).not.toContainEqual(expect.objectContaining({ event: 'release-failed' }));
    });

    it('should keep the line durable', () => {
      expect(fs.readFileSync(env.logFile, 'utf8')).toBe(line);
    });

    it('should leave the lock orphaned', () => {
      expect(fs.readdirSync(env.dir)).toContain(LOCK_DIR);
    });
  });

  it('should append on the next write after the release failed, removing the orphan lock', async () => {
    const { store, records, logFile } = setup();
    failReleaseOnce();
    await store.write(ref, () => ({ line, result: 'ok' })).catch((reason: unknown) => reason);

    await store.write(ref, () => ({ line: nextLine, result: 'ok' }));

    expect(fs.readFileSync(logFile, 'utf8')).toBe(line + nextLine);
    expect(records).toContainEqual(expect.objectContaining({ event: 'lock-orphan-removed' }));
  });

  describe('when the try and the release both fail', () => {
    let env: ReturnType<typeof setup>;
    let primary: HexlogError;
    let error: unknown;

    beforeAll(async () => {
      env = setup();
      failReleaseOnce();
      ({ primary, error } = await failingWrite(env.store));
    });

    it('should throw the primary error unchanged', () => {
      expect(error).toBe(primary);

      expectNoLeak(primary, 'EIO');
    });

    it('should write no line', () => {
      expect(fs.readFileSync(env.logFile, 'utf8')).toBe('');
    });

    it('should send the release error only to the log', () => {
      expect(env.records).toContainEqual({ level: 'error', event: 'release-failed', code: 'EIO' });
      expect(JSON.stringify(env.records)).not.toContain(env.dir);
    });
  });

  it('should write the next line after the release and the try both failed', async () => {
    const { store, logFile } = setup();
    failReleaseOnce();
    await failingWrite(store);

    await store.write(ref, () => ({ line, result: 'ok' }));

    expect(fs.readFileSync(logFile, 'utf8')).toBe(line);
  });
});
