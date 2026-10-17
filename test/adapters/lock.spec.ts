import { afterEach, describe, expect, it, jest } from '@jest/globals';
import { sumBy } from 'es-toolkit';
import { spawn, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import fs from 'node:fs';
import * as path from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import {
  LOCK_DIR,
  LOG_FILE,
  MANIFEST_FILE,
  processPaths,
} from '../../src/adapters/fs/data-format.ts';
import { createLockManager, isPidAlive, moveAside } from '../../src/adapters/fs/lock.ts';
import { verifyProcess } from '../../src/shared/loader.ts';
import type { LogRecord } from '../../src/shared/logger.ts';
import { chainLine } from '../fixtures/chain-line.ts';
import { captureLog, createTempDir, errno, rejectionOf } from '../helpers.ts';
import {
  createProcess,
  killChildren,
  liveForeignPid,
  runFixture,
  runWriteStress,
  startChild,
  startHolder,
} from './lock-helpers.ts';

const BOOT = 'boot-a';
const PAUSE_MS = 20_000;

const eventsOf = (records: LogRecord[]): string[] => records.map(({ event }) => event);

/** Diretório de trabalho com o caminho do lock, como o `process-store` o usaria ao lado do log. */
function workspace(): { dir: string; lockDir: string; holderFile: string } {
  const dir = createTempDir('lock');
  const lockDir = path.join(dir, LOCK_DIR);
  return { dir, lockDir, holderFile: path.join(lockDir, 'holder') };
}

/** Planta um lock como se outro dono o tivesse adquirido (`holder` como texto cru ou objeto). */
function plantLock(lockDir: string, holder: string | object): void {
  fs.mkdirSync(lockDir);
  fs.writeFileSync(
    path.join(lockDir, 'holder'),
    typeof holder === 'string' ? holder : JSON.stringify(holder),
  );
}

/**
 * Filho que já morreu e que o pai ainda não colheu (zumbi): o `sh` solta um `sleep` curto e vira
 * `sleep 30`, que nunca dá `wait`. Quem chama mata `parent` no fim.
 */
async function zombieChild(): Promise<{ pid: number; parent: ChildProcess }> {
  const parent = spawn('sh', ['-c', 'sleep 0.1 & echo $!; exec sleep 30']);
  const pid = await new Promise<number>((resolve, reject) => {
    parent.once('error', reject);
    parent.stdout.once('data', (chunk) => resolve(Number(String(chunk).trim())));
  });
  const deadline = performance.now() + 5000;
  while (!fs.readFileSync(`/proc/${pid}/stat`, 'utf8').includes(') Z ')) {
    if (performance.now() > deadline) throw new Error('child did not become a zombie');
    await sleep(20);
  }
  return { pid, parent };
}

const tokenIn = (holderFile: string): string =>
  (JSON.parse(fs.readFileSync(holderFile, 'utf8')) as { token: string }).token;

/** Espera a rejeição com `HexlogError`, sem `dir` (D-26), e devolve só `code` e `details`. */
async function timeoutOf(promise: Promise<unknown>, dir: string) {
  const { code, details } = await rejectionOf(promise, dir);
  return { code, details };
}

/** O `LOCK_TIMEOUT` esperado: `pid` só no `lock-busy`. */
const timeout = (code: string, pid?: number) => ({
  code: 'LOCK_TIMEOUT',
  details: [{ path: '/process', code, message: expect.any(String), ...(pid ? { pid } : {}) }],
});

describe('createLockManager', () => {
  afterEach(() => {
    jest.restoreAllMocks();
    killChildren();
  });

  describe('with real processes', () => {
    it('should never have two owners nor leave leftovers across 8 children x 25 acquire and release rounds (D-12, P2)', async () => {
      const { dir, lockDir } = workspace();
      const barrier = createTempDir('lock-barrier');
      const args = {
        lockDir,
        ownerFile: path.join(dir, 'owner'),
        rounds: 25,
        barrierDir: barrier,
        total: 8,
      };

      const results = await Promise.all(
        Array.from({ length: 8 }, () => runFixture('rounds', args)),
      );

      expect(results.map(({ status, stderr }) => ({ status, stderr }))).toEqual(
        Array.from({ length: 8 }, () => ({ status: 0, stderr: '' })),
      );
      expect(results.map(({ stdout }) => JSON.parse(stdout) as unknown)).toEqual(
        Array.from({ length: 8 }, () => ({ rounds: 25, collisions: 0 })),
      );
      expect(fs.readdirSync(dir)).toEqual([]);
    }, 60_000);

    it('should give lock-busy with the pid of a live owner past the budget, without stealing the lock (D-12, P2)', async () => {
      const { dir, lockDir, holderFile } = workspace();
      const { pid } = await startHolder(lockDir);
      const tokenBefore = tokenIn(holderFile);
      const { records, log } = captureLog();

      // IMPORTANT: o orçamento inclui o primeiro `tryCreate` (mkdtemp, fsync e rename). Com 100 ms,
      // pouca CPU ou disco lento estourava antes do `lock-wait` e o teste falhava sem bug no código.
      const error = createLockManager({ log, budgetMs: 1000 }).acquire(lockDir);

      expect(await timeoutOf(error, dir)).toEqual(timeout('lock-busy', pid));
      expect(tokenIn(holderFile)).toBe(tokenBefore);
      expect(eventsOf(records)).toEqual(['lock-wait', 'lock-timeout']);
    });

    it('should steal the lock of an owner killed with kill -9 and log the theft with its pid (D-12, P2)', async () => {
      const { lockDir, holderFile } = workspace();
      const { child, pid } = await startHolder(lockDir);
      child.kill('SIGKILL');
      await once(child, 'exit');
      const { records, log } = captureLog();
      const manager = createLockManager({ log });

      const lock = await manager.acquire(lockDir);

      expect(tokenIn(holderFile)).toBe(lock.token);
      expect(records).toContainEqual({ level: 'warn', event: 'lock-orphan-removed', pid });
    });

    it('should leave nothing behind after releasing a lock stolen from an owner killed with kill -9 (D-12, P2)', async () => {
      const { dir, lockDir } = workspace();
      const { child } = await startHolder(lockDir);
      child.kill('SIGKILL');
      await once(child, 'exit');
      const manager = createLockManager({ log: captureLog().log });
      const lock = await manager.acquire(lockDir);

      await manager.release(lock);

      expect(fs.readdirSync(dir)).toEqual([]);
    });

    it('should count as alive a pid the kernel denies signaling (EPERM) (D-12, P2)', async () => {
      const { dir, lockDir } = workspace();
      const pid = await liveForeignPid();
      plantLock(lockDir, { pid, token: 'foreign', bootId: BOOT });
      jest.spyOn(process, 'kill').mockImplementation(() => {
        throw errno('EPERM');
      });
      const manager = createLockManager({ log: captureLog().log, budgetMs: 50, bootId: BOOT });

      expect(await timeoutOf(manager.acquire(lockDir), dir)).toEqual(timeout('lock-busy', pid));
    });

    it('should keep the chain intact, with no raw failure, across 8 children x 25 writes on the same process with a pre-planted dead-owner lock (D-12, P2)', async () => {
      const { store, ref, dir, results } = await runWriteStress();
      const counts = results.map(
        ({ stdout }) => JSON.parse(stdout) as { rounds: number; retries: number },
      );

      expect(results.map(({ status, stderr }) => ({ status, stderr }))).toEqual(
        Array.from({ length: 8 }, () => ({ status: 0, stderr: '' })),
      );
      expect(counts.map(({ rounds }) => rounds)).toEqual(Array(8).fill(25));
      // só o órfão pré-plantado gera roubo com leitura velha, e cada um dos outros 7 filhos o lê
      // no máximo uma vez
      expect(sumBy(counts, ({ retries }) => retries)).toBeLessThanOrEqual(7);
      expect(verifyProcess(store.read(ref)).chain).toMatchObject({ ok: true, totalRecords: 200 });
      expect(fs.readdirSync(dir).sort()).toEqual([MANIFEST_FILE, LOG_FILE]);
    }, 120_000);

    it('should keep the lock of an owner paused for 20 s, give the others lock-busy and let it finish intact (D-12, P2)', async () => {
      const { dataDir, store, ref, dir, lockDir } = createProcess();
      const holderFile = path.join(lockDir, 'holder');
      const goFile = path.join(createTempDir('lock-go'), 'go');
      const { child, pid } = await startChild('write-gated', {
        dataDir,
        project: ref.project,
        process: ref.process,
        goFile,
      });
      const exited = once(child, 'exit');
      const tokenBefore = tokenIn(holderFile);
      const pausedAt = performance.now();
      child.kill('SIGSTOP');
      let waiters: unknown[];
      let tokenAfterWaiters: string;
      let late: unknown;
      let tokenAfterLate: string;

      try {
        // orçamento padrão (15 s): estoura dentro dos 20 s da pausa
        waiters = await Promise.all(
          Array.from({ length: 3 }, () =>
            timeoutOf(createLockManager({ log: captureLog().log }).acquire(lockDir), dataDir),
          ),
        );
        tokenAfterWaiters = tokenIn(holderFile);
        await sleep(PAUSE_MS - (performance.now() - pausedAt));
        const lateManager = createLockManager({ log: captureLog().log, budgetMs: 50 });
        late = await timeoutOf(lateManager.acquire(lockDir), dataDir);
        tokenAfterLate = tokenIn(holderFile);
      } finally {
        child.kill('SIGCONT');
      }
      fs.writeFileSync(goFile, '');
      const exitCode: unknown = (await exited)[0];

      expect(waiters).toEqual(Array(3).fill(timeout('lock-busy', pid)));
      expect(tokenAfterWaiters).toBe(tokenBefore);
      expect(late).toEqual(timeout('lock-busy', pid));
      expect(tokenAfterLate).toBe(tokenBefore);
      expect(exitCode).toBe(0);
      expect(verifyProcess(store.read(ref)).chain).toMatchObject({ ok: true, totalRecords: 1 });
      expect(fs.readdirSync(dir).sort()).toEqual([MANIFEST_FILE, LOG_FILE]);
    }, 60_000);
  });

  it('should write the holder with pid, token and bootId, with one fsync and no temporary file (D-12, P2)', async () => {
    const { dir, lockDir, holderFile } = workspace();
    const realFsync = fs.fsyncSync;
    const fsync = jest.spyOn(fs, 'fsyncSync').mockImplementation((fd) => realFsync(fd));
    const manager = createLockManager({ log: captureLog().log, bootId: BOOT });

    const lock = await manager.acquire(lockDir);

    expect(JSON.parse(fs.readFileSync(holderFile, 'utf8'))).toEqual({
      pid: process.pid,
      token: lock.token,
      bootId: BOOT,
    });
    expect(fsync).toHaveBeenCalledTimes(1);
    expect(fs.readdirSync(dir)).toEqual([LOCK_DIR]);
  });

  it('should take the bootId from /proc/sys/kernel/random/boot_id (or null without /proc) when the option is absent (D-12, P2)', async () => {
    const { lockDir, holderFile } = workspace();
    const bootIdFile = '/proc/sys/kernel/random/boot_id';
    const expected = fs.existsSync(bootIdFile) ? fs.readFileSync(bootIdFile, 'utf8').trim() : null;

    await createLockManager({ log: captureLog().log }).acquire(lockDir);

    expect(JSON.parse(fs.readFileSync(holderFile, 'utf8'))).toMatchObject({ bootId: expected });
  });

  it('should make a second acquisition in the same process wait for the release and log lock-wait once (D-12, P2)', async () => {
    const { lockDir, holderFile } = workspace();
    const { records, log } = captureLog();
    const manager = createLockManager({ log, bootId: BOOT });
    const first = await manager.acquire(lockDir);
    let secondAcquired = false;

    const second = manager.acquire(lockDir).then((lock) => {
      secondAcquired = true;
      return lock;
    });
    await sleep(60);
    const acquiredWhileHeld = secondAcquired;
    await manager.release(first);
    const lock = await second;

    expect(acquiredWhileHeld).toBe(false);
    expect(tokenIn(holderFile)).toBe(lock.token);
    expect(eventsOf(records).filter((event) => event === 'lock-wait')).toHaveLength(1);
  });

  it('should leave nothing behind after releasing the lock acquired after waiting (D-12, P2)', async () => {
    const { dir, lockDir } = workspace();
    const manager = createLockManager({ log: captureLog().log, bootId: BOOT });
    const first = await manager.acquire(lockDir);
    const second = manager.acquire(lockDir);
    await manager.release(first);
    const lock = await second;

    await manager.release(lock);

    expect(fs.readdirSync(dir)).toEqual([]);
  });

  it.each([
    ['empty', ''],
    ['that is not JSON', '{not json'],
    ['without pid', '{"token":"t","bootId":null}'],
    ['without token', '{"pid":4242,"bootId":null}'],
    ['with a pid above the Linux pid_max of 2^22', '{"pid":4194305,"token":"t","bootId":null}'],
  ])(
    'should give holder-unreadable at once, with no wait and no theft, for a holder %s (D-12, P2)',
    async (_name, content) => {
      const { dir, lockDir, holderFile } = workspace();
      plantLock(lockDir, content);
      const { records, log } = captureLog();
      // com o orçamento de 60 s, esperar estouraria o timeout do teste: a resposta é na hora
      const manager = createLockManager({ log, budgetMs: 60_000, bootId: BOOT });

      const error = manager.acquire(lockDir);
      const refusal = await timeoutOf(error, dir);
      const { message } = (await rejectionOf(error, dir)).details[0] ?? {};

      expect(refusal).toEqual(timeout('holder-unreadable'));
      expect(message).toContain('ask the user to remove the lock');
      const { lock } = processPaths('${XDG_DATA_HOME:-$HOME/.local/share}/hexlog', {
        project: '<project>',
        process: '<process>',
      });
      expect(message).toContain(`L="${lock}"`);
      expect(message).not.toContain('<D>');
      expect(message).toContain('rmdir');
      expect(message).toContain('never rm -r');
      expect(message).not.toContain('docs/dados.md');
      expect(fs.readFileSync(holderFile, 'utf8')).toBe(content);
      expect(records).toEqual([]);
    },
  );

  it('should wait for the budget and give lock-busy without a pid for a lock without a holder, with only a stray file inside (D-12, P2, M20)', async () => {
    const { dir, lockDir } = workspace();
    // `rename` sobre diretório vazio vence, então o lock sem holder só pesa se não estiver vazio
    fs.mkdirSync(lockDir);
    fs.writeFileSync(path.join(lockDir, 'stray'), '');
    const { records, log } = captureLog();
    const manager = createLockManager({ log, budgetMs: 50, bootId: BOOT });

    expect(await timeoutOf(manager.acquire(lockDir), dir)).toEqual(timeout('lock-busy'));
    expect(eventsOf(records)).toEqual(['lock-timeout']);
  });

  it('should surface raw, without theft, a holder that cannot be read for a reason other than ENOENT (D-12, P2, M20)', async () => {
    const { lockDir } = workspace();
    fs.mkdirSync(path.join(lockDir, 'holder'), { recursive: true });
    const manager = createLockManager({ log: captureLog().log, bootId: BOOT });

    await expect(manager.acquire(lockDir)).rejects.toMatchObject({ code: 'EISDIR' });
    expect(fs.existsSync(lockDir)).toBe(true);
  });

  it('should surface raw, leaving no .tmp-, a lock publication that fails for a reason other than "busy" (D-12, P2, M20)', async () => {
    const { dir, lockDir } = workspace();
    const renameSync = fs.renameSync;
    jest.spyOn(fs, 'renameSync').mockImplementation((from, to) => {
      if (to === lockDir) throw errno('EIO');
      renameSync(from, to);
    });
    const manager = createLockManager({ log: captureLog().log, bootId: BOOT });

    await expect(manager.acquire(lockDir)).rejects.toMatchObject({ code: 'EIO' });
    expect(fs.readdirSync(dir)).toEqual([]);
  });

  it('should give lock-lost when the token is swapped between the acquisition and the write (D-12, P2)', async () => {
    const { dir, lockDir, holderFile } = workspace();
    const manager = createLockManager({ log: captureLog().log, bootId: BOOT });
    const lock = await manager.acquire(lockDir);
    fs.writeFileSync(
      holderFile,
      JSON.stringify({ pid: process.pid, token: 'other', bootId: BOOT }),
    );

    expect(await timeoutOf(manager.confirm(lock), dir)).toEqual(timeout('lock-lost'));
  });

  it('should go on when the holder gives ENOENT but the lock is returned before 10 ms (D-12, P2)', async () => {
    const { lockDir } = workspace();
    const manager = createLockManager({ log: captureLog().log, bootId: BOOT });
    const lock = await manager.acquire(lockDir);
    const away = `${lockDir}.away`;
    fs.renameSync(lockDir, away);
    setTimeout(() => fs.renameSync(away, lockDir), 2);

    await expect(manager.confirm(lock)).resolves.toBeUndefined();
  });

  it('should give lock-lost when the holder keeps giving ENOENT (D-12, P2)', async () => {
    const { dir, lockDir } = workspace();
    const manager = createLockManager({ log: captureLog().log, bootId: BOOT });
    const lock = await manager.acquire(lockDir);
    fs.renameSync(lockDir, `${lockDir}.away`);

    expect(await timeoutOf(manager.confirm(lock), dir)).toEqual(timeout('lock-lost'));
  });

  it('should steal on the next acquisition a lock of the own process with a token it does not hold (D-12, P2)', async () => {
    const { dir, lockDir, holderFile } = workspace();
    plantLock(lockDir, { pid: process.pid, token: 'given-up', bootId: BOOT });
    const { records, log } = captureLog();
    const manager = createLockManager({ log, bootId: BOOT });

    const lock = await manager.acquire(lockDir);

    expect(tokenIn(holderFile)).toBe(lock.token);
    expect(records).toEqual([{ level: 'warn', event: 'lock-orphan-removed', pid: process.pid }]);
    expect(fs.readdirSync(dir)).toEqual([LOCK_DIR]);
  });

  it('should steal the lock of an owner that is a zombie, as it counts as a dead owner (D-12, P2)', async () => {
    const { lockDir, holderFile } = workspace();
    const { pid, parent } = await zombieChild();
    try {
      plantLock(lockDir, { pid, token: 'zombie', bootId: BOOT });
      const { records, log } = captureLog();

      const lock = await createLockManager({ log, bootId: BOOT }).acquire(lockDir);

      expect(tokenIn(holderFile)).toBe(lock.token);
      expect(records).toContainEqual({ level: 'warn', event: 'lock-orphan-removed', pid });
    } finally {
      parent.kill('SIGKILL');
    }
  });

  it('should steal a holder with a different bootId even with a live pid and a held token (D-12, P2)', async () => {
    const { dir, lockDir, holderFile } = workspace();
    const { records, log } = captureLog();
    const manager = createLockManager({ log, bootId: 'boot-new' });
    const first = await manager.acquire(lockDir);
    // mesmo pid e token ainda segurado: só o bootId justifica o roubo
    fs.writeFileSync(
      holderFile,
      JSON.stringify({ pid: process.pid, token: first.token, bootId: 'boot-old' }),
    );

    const second = await manager.acquire(lockDir);

    expect(tokenIn(holderFile)).toBe(second.token);
    expect(records).toContainEqual({
      level: 'warn',
      event: 'lock-orphan-removed',
      pid: process.pid,
    });
    expect(fs.readdirSync(dir)).toEqual([LOCK_DIR]);
  });

  it('should give lock-busy for a null bootId holder to a manager whose bootId is also null (D-12, P2)', async () => {
    const { dir, lockDir } = workspace();
    const pid = await liveForeignPid();
    plantLock(lockDir, { pid, token: 'foreign', bootId: null });
    const sameBoot = createLockManager({ log: captureLog().log, budgetMs: 50, bootId: null });

    expect(await timeoutOf(sameBoot.acquire(lockDir), dir)).toEqual(timeout('lock-busy', pid));
  });

  it('should steal a null bootId holder for a manager that has a bootId (D-12, P2)', async () => {
    const { lockDir, holderFile } = workspace();
    const pid = await liveForeignPid();
    plantLock(lockDir, { pid, token: 'foreign', bootId: null });
    const otherBoot = createLockManager({ log: captureLog().log, bootId: BOOT });

    const lock = await otherBoot.acquire(lockDir);

    expect(tokenIn(holderFile)).toBe(lock.token);
  });

  it('should release the lock and leave nothing behind (D-12, P2)', async () => {
    const { dir, lockDir } = workspace();
    const manager = createLockManager({ log: captureLog().log, bootId: BOOT });
    const lock = await manager.acquire(lockDir);

    await manager.release(lock);

    expect(fs.readdirSync(dir)).toEqual([]);
  });

  it('should leave the lock alone when it was already swapped for another owner (D-12, P2)', async () => {
    const { dir, lockDir, holderFile } = workspace();
    const { records, log } = captureLog();
    const manager = createLockManager({ log, bootId: BOOT });
    const lock = await manager.acquire(lockDir);
    const other = { pid: process.pid, token: 'other', bootId: BOOT };
    fs.writeFileSync(holderFile, JSON.stringify(other));
    const renameSync = jest.spyOn(fs, 'renameSync');

    await manager.release(lock);

    expect(renameSync).not.toHaveBeenCalled();
    expect(records).toEqual([]);
    expect(JSON.parse(fs.readFileSync(holderFile, 'utf8'))).toEqual(other);
    expect(fs.readdirSync(dir)).toEqual([LOCK_DIR]);
  });

  it('should give back the lock of the other owner when a thief swaps the lock between the check and the rename (D-12, P2)', async () => {
    const { dir, lockDir, holderFile } = workspace();
    const { records, log } = captureLog();
    const manager = createLockManager({ log, bootId: BOOT });
    const lock = await manager.acquire(lockDir);
    const newer = { pid: 5151, token: 'newer', bootId: BOOT };
    const renameSync = fs.renameSync;
    let swapped = false;
    // depois da conferência do dono e antes do rename da liberação, o lock dele é roubado e outro adquire
    jest.spyOn(fs, 'renameSync').mockImplementation((from, to) => {
      if (!swapped && String(to).includes('.released-')) {
        swapped = true;
        renameSync(lockDir, `${lockDir}.stolen`);
        plantLock(lockDir, newer);
      }
      renameSync(from, to);
    });

    await manager.release(lock);

    expect(JSON.parse(fs.readFileSync(holderFile, 'utf8'))).toEqual(newer);
    expect(fs.readdirSync(dir).sort()).toEqual([LOCK_DIR, `${LOCK_DIR}.stolen`]);
    expect(records).toEqual([
      { level: 'error', event: 'lock-lost', pid: process.pid, holderPid: 5151, restored: true },
    ]);
  });
});

describe('createProcessStore', () => {
  afterEach(() => {
    killChildren();
  });

  it('should let store.write enter and close the chain after the owner is killed with kill -9 (D-12, P2, TF3)', async () => {
    const { store, ref, lockDir } = createProcess();
    const { child } = await startHolder(lockDir);
    child.kill('SIGKILL');
    await once(child, 'exit');

    await store.write(ref, (raw) => ({
      line: chainLine(ref.process, verifyProcess(raw).end, 1, {
        agent: 'lock-spec',
        text: () => 'depois do kill',
      }),
      result: undefined,
    }));

    expect(verifyProcess(store.read(ref)).chain).toMatchObject({ ok: true, totalRecords: 1 });
  });
});

describe('moveAside', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('should delete the moved lock and leave nothing behind with the expected token (D-12, P2)', () => {
    const { dir, lockDir } = workspace();
    plantLock(lockDir, { pid: 4242, token: 'owner', bootId: BOOT });
    const { records, log } = captureLog();

    const result = moveAside(lockDir, '.dead-', 'owner', log);

    expect(result).toBe('removed');
    expect(fs.readdirSync(dir)).toEqual([]);
    expect(records).toEqual([]);
  });

  it('should give the lock back to the owner and log lock-lost with both pids for a stale token (D-12, P2)', () => {
    const { dir, lockDir, holderFile } = workspace();
    const holder = { pid: 4242, token: 'owner', bootId: BOOT };
    plantLock(lockDir, holder);
    const { records, log } = captureLog();

    const result = moveAside(lockDir, '.dead-', 'stale', log);

    expect(result).toBe('restored');
    expect(JSON.parse(fs.readFileSync(holderFile, 'utf8'))).toEqual(holder);
    expect(fs.readdirSync(dir)).toEqual([LOCK_DIR]);
    expect(records).toEqual([
      { level: 'error', event: 'lock-lost', pid: process.pid, holderPid: 4242, restored: true },
    ]);
  });

  it('should keep the newer lock intact and delete the renamed one when giving back fails because a new lock exists (D-12, P2)', () => {
    const { dir, lockDir, holderFile } = workspace();
    plantLock(lockDir, { pid: 4242, token: 'owner', bootId: BOOT });
    const newer = { pid: 5151, token: 'newer', bootId: BOOT };
    const readFileSync = fs.readFileSync;
    let planted = false;
    // ao reler o holder do movido, outro escritor já adquiriu o lugar do lock
    jest
      .spyOn(fs, 'readFileSync')
      .mockImplementation((...args: Parameters<typeof fs.readFileSync>) => {
        if (!planted && String(args[0]).includes('.dead-')) {
          planted = true;
          plantLock(lockDir, newer);
        }
        return readFileSync(...args);
      });
    const { records, log } = captureLog();

    const result = moveAside(lockDir, '.dead-', 'stale', log);

    expect(result).toBe('discarded');
    expect(JSON.parse(fs.readFileSync(holderFile, 'utf8'))).toEqual(newer);
    expect(fs.readdirSync(dir)).toEqual([LOCK_DIR]);
    expect(records).toEqual([
      { level: 'error', event: 'lock-lost', pid: process.pid, holderPid: 4242, restored: false },
    ]);
  });

  it('should surface raw a rename that fails for a reason other than ENOENT, leaving the lock where it is (D-12, P2)', () => {
    const { dir, lockDir } = workspace();
    plantLock(lockDir, { pid: 4242, token: 'owner', bootId: BOOT });
    const renameSync = fs.renameSync;
    jest.spyOn(fs, 'renameSync').mockImplementation((from, to) => {
      if (from === lockDir) throw errno('EIO');
      renameSync(from, to);
    });
    const { records, log } = captureLog();

    expect(() => moveAside(lockDir, '.dead-', 'owner', log)).toThrow(
      expect.objectContaining({ code: 'EIO' }),
    );

    expect(fs.readdirSync(dir)).toEqual([LOCK_DIR]);
    expect(records).toEqual([]);
  });

  it('should surface raw a giving back that fails for a reason other than "a new lock exists", leaving the moved lock (D-12, P2)', () => {
    const { dir, lockDir } = workspace();
    plantLock(lockDir, { pid: 4242, token: 'owner', bootId: BOOT });
    const renameSync = fs.renameSync;
    jest.spyOn(fs, 'renameSync').mockImplementation((from, to) => {
      if (to === lockDir) throw errno('EIO');
      renameSync(from, to);
    });
    const { records, log } = captureLog();

    expect(() => moveAside(lockDir, '.dead-', 'stale', log)).toThrow(
      expect.objectContaining({ code: 'EIO' }),
    );

    expect(fs.readdirSync(dir)).toEqual([expect.stringContaining(`${LOCK_DIR}.dead-`)]);
    expect(records).toEqual([]);
  });

  it('should return gone and log nothing without a lock (D-12, P2)', () => {
    const { lockDir } = workspace();
    const { records, log } = captureLog();

    const result = moveAside(lockDir, '.dead-', 'owner', log);

    expect(result).toBe('gone');
    expect(records).toEqual([]);
  });
});

describe('isPidAlive', () => {
  it('should treat a zombie (dead and not yet reaped by its parent) as not alive (D-12, P2)', async () => {
    const { pid, parent } = await zombieChild();
    try {
      expect(isPidAlive(pid)).toBe(false);
    } finally {
      parent.kill('SIGKILL');
    }
  });
});
