import { afterEach, describe, expect, jest, test } from '@jest/globals';
import { sumBy } from 'es-toolkit';
import { spawn, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import fs from 'node:fs';
import * as path from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { LOCK_DIR, LOG_FILE, MANIFEST_FILE } from '../../src/adapters/fs/data-format.ts';
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

afterEach(() => {
  jest.restoreAllMocks();
  killChildren();
});

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

describe('exclusão do lock por pid (D-12, P2)', () => {
  describe('entre processos reais', () => {
    test('8 filhos x 25 rodadas de aquisição e liberação nunca têm dois donos nem deixam resto', async () => {
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

    test('dono vivo além do orçamento dá lock-busy com o pid dele e não é roubado', async () => {
      const { dir, lockDir, holderFile } = workspace();
      const { pid } = await startHolder(lockDir);
      const tokenBefore = tokenIn(holderFile);
      const { records, log } = captureLog();

      // IMPORTANT: o orçamento de 100 ms inclui o primeiro `tryCreate` (mkdtemp, fsync e rename).
      // Com pouca CPU ou disco livre na máquina, ele pode estourar antes do `lock-wait` e o teste
      // falhar de forma intermitente na asserção dos eventos, sem bug no código.
      const error = createLockManager({ log, budgetMs: 100 }).acquire(lockDir);

      expect(await timeoutOf(error, dir)).toEqual(timeout('lock-busy', pid));
      expect(tokenIn(holderFile)).toBe(tokenBefore);
      expect(eventsOf(records)).toEqual(['lock-wait', 'lock-timeout']);
    });

    test('órfão: dono morto por kill -9 é roubado em menos de 1 s e o roubo é logado com o pid dele', async () => {
      const { dir, lockDir, holderFile } = workspace();
      const { child, pid } = await startHolder(lockDir);
      child.kill('SIGKILL');
      await once(child, 'exit');
      const { records, log } = captureLog();
      const manager = createLockManager({ log });

      const started = performance.now();
      const lock = await manager.acquire(lockDir);

      expect(performance.now() - started).toBeLessThan(1000);
      expect(tokenIn(holderFile)).toBe(lock.token);
      expect(records).toContainEqual({ level: 'warn', event: 'lock-orphan-removed', pid });
      await manager.release(lock);
      expect(fs.readdirSync(dir)).toEqual([]);
    });

    test('órfão: store.write depois do kill -9 do dono entra em menos de 1 s e a cadeia fecha (TF3)', async () => {
      const { store, ref, lockDir } = createProcess();
      const { child } = await startHolder(lockDir);
      child.kill('SIGKILL');
      await once(child, 'exit');

      const started = performance.now();
      await store.write(ref, (raw) => ({
        line: chainLine(ref.process, verifyProcess(raw).end, 1, {
          agent: 'lock-spec',
          text: () => 'depois do kill',
        }),
        result: undefined,
      }));

      expect(performance.now() - started).toBeLessThan(1000);
      expect(verifyProcess(store.read(ref)).chain).toMatchObject({ ok: true, totalRecords: 1 });
    });

    test('pid que o kernel nega sinalizar (EPERM) conta como vivo', async () => {
      const { dir, lockDir } = workspace();
      const pid = await liveForeignPid();
      plantLock(lockDir, { pid, token: 'foreign', bootId: BOOT });
      jest.spyOn(process, 'kill').mockImplementation(() => {
        throw errno('EPERM');
      });
      const manager = createLockManager({ log: captureLog().log, budgetMs: 50, bootId: BOOT });

      expect(await timeoutOf(manager.acquire(lockDir), dir)).toEqual(timeout('lock-busy', pid));
    });

    test('estresse: 8 filhos x 25 gravações no mesmo processo, com lock de dono morto pré-plantado, sem falha crua e com a cadeia íntegra', async () => {
      const { store, ref, dir, results } = await runWriteStress();

      expect(results.map(({ status, stderr }) => ({ status, stderr }))).toEqual(
        Array.from({ length: 8 }, () => ({ status: 0, stderr: '' })),
      );
      const counts = results.map(
        ({ stdout }) => JSON.parse(stdout) as { rounds: number; retries: number },
      );
      expect(counts.map(({ rounds }) => rounds)).toEqual(Array(8).fill(25));
      // só o órfão pré-plantado gera roubo com leitura velha, e cada um dos outros 7 filhos o lê
      // no máximo uma vez
      expect(sumBy(counts, ({ retries }) => retries)).toBeLessThanOrEqual(7);
      expect(verifyProcess(store.read(ref)).chain).toMatchObject({ ok: true, totalRecords: 200 });
      expect(fs.readdirSync(dir).sort()).toEqual([MANIFEST_FILE, LOG_FILE]);
    }, 120_000);

    test('SIGSTOP: dono pausado por 20 s não perde o lock, os outros recebem lock-busy e ele termina íntegro', async () => {
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
      try {
        // orçamento padrão (15 s): estoura dentro dos 20 s da pausa
        const waiters = Array.from({ length: 3 }, () =>
          timeoutOf(createLockManager({ log: captureLog().log }).acquire(lockDir), dataDir),
        );
        expect(await Promise.all(waiters)).toEqual(Array(3).fill(timeout('lock-busy', pid)));
        expect(tokenIn(holderFile)).toBe(tokenBefore);

        await sleep(PAUSE_MS - (performance.now() - pausedAt));
        const late = createLockManager({ log: captureLog().log, budgetMs: 50 });
        expect(await timeoutOf(late.acquire(lockDir), dataDir)).toEqual(timeout('lock-busy', pid));
        expect(tokenIn(holderFile)).toBe(tokenBefore);
      } finally {
        child.kill('SIGCONT');
      }
      fs.writeFileSync(goFile, '');

      expect((await exited)[0]).toBe(0);
      expect(verifyProcess(store.read(ref)).chain).toMatchObject({ ok: true, totalRecords: 1 });
      expect(fs.readdirSync(dir).sort()).toEqual([MANIFEST_FILE, LOG_FILE]);
    }, 60_000);
  });

  describe('aquisição', () => {
    test('grava o holder com pid, token e bootId, com um fsync, sem deixar temporário', async () => {
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

    test('sem a opção, o bootId vem de /proc/sys/kernel/random/boot_id (ou é null sem /proc)', async () => {
      const { lockDir, holderFile } = workspace();
      const bootIdFile = '/proc/sys/kernel/random/boot_id';
      const expected = fs.existsSync(bootIdFile)
        ? fs.readFileSync(bootIdFile, 'utf8').trim()
        : null;

      await createLockManager({ log: captureLog().log }).acquire(lockDir);

      expect(JSON.parse(fs.readFileSync(holderFile, 'utf8'))).toMatchObject({ bootId: expected });
    });

    test('segunda aquisição no mesmo processo espera a liberação e loga lock-wait uma vez', async () => {
      const { dir, lockDir, holderFile } = workspace();
      const { records, log } = captureLog();
      const manager = createLockManager({ log, bootId: BOOT });
      const first = await manager.acquire(lockDir);
      let secondAcquired = false;
      const second = manager.acquire(lockDir).then((lock) => {
        secondAcquired = true;
        return lock;
      });

      await sleep(60);
      expect(secondAcquired).toBe(false);
      await manager.release(first);
      const lock = await second;

      expect(tokenIn(holderFile)).toBe(lock.token);
      expect(eventsOf(records).filter((event) => event === 'lock-wait')).toHaveLength(1);
      await manager.release(lock);
      expect(fs.readdirSync(dir)).toEqual([]);
    });

    test.each([
      ['vazio', ''],
      ['não-JSON', '{not json'],
      ['sem pid', '{"token":"t","bootId":null}'],
      ['sem token', '{"pid":4242,"bootId":null}'],
      ['pid acima do pid_max do Linux (2^22)', '{"pid":4194305,"token":"t","bootId":null}'],
    ])('holder %s dá holder-unreadable na hora, sem espera e sem roubo', async (_name, content) => {
      const { dir, lockDir, holderFile } = workspace();
      plantLock(lockDir, content);
      const { records, log } = captureLog();
      // com o orçamento de 60 s, esperar estouraria o timeout do teste: a resposta é na hora
      const manager = createLockManager({ log, budgetMs: 60_000, bootId: BOOT });

      const error = manager.acquire(lockDir);

      expect(await timeoutOf(error, dir)).toEqual(timeout('holder-unreadable'));
      expect(fs.readFileSync(holderFile, 'utf8')).toBe(content);
      expect(records).toEqual([]);
    });
  });

  describe('erros de I/O e lock sem holder (M20)', () => {
    test('lock sem holder (só um arquivo estranho dentro) espera o orçamento e dá lock-busy sem pid', async () => {
      const { dir, lockDir } = workspace();
      // `rename` sobre diretório vazio vence, então o lock sem holder só pesa se não estiver vazio
      fs.mkdirSync(lockDir);
      fs.writeFileSync(path.join(lockDir, 'stray'), '');
      const { records, log } = captureLog();
      const manager = createLockManager({ log, budgetMs: 50, bootId: BOOT });

      expect(await timeoutOf(manager.acquire(lockDir), dir)).toEqual(timeout('lock-busy'));
      expect(eventsOf(records)).toEqual(['lock-timeout']);
    });

    test('holder que não dá para ler por outro motivo que ENOENT sai cru, sem roubo', async () => {
      const { lockDir } = workspace();
      fs.mkdirSync(path.join(lockDir, 'holder'), { recursive: true });
      const manager = createLockManager({ log: captureLog().log, bootId: BOOT });

      await expect(manager.acquire(lockDir)).rejects.toMatchObject({ code: 'EISDIR' });
      expect(fs.existsSync(lockDir)).toBe(true);
    });

    test('publicação do lock que falha por outro motivo que "ocupado" sai crua e não deixa .tmp-', async () => {
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
  });

  describe('conferência antes do write', () => {
    test('token trocado entre a aquisição e o write dá lock-lost', async () => {
      const { dir, lockDir, holderFile } = workspace();
      const manager = createLockManager({ log: captureLog().log, bootId: BOOT });
      const lock = await manager.acquire(lockDir);
      fs.writeFileSync(
        holderFile,
        JSON.stringify({ pid: process.pid, token: 'other', bootId: BOOT }),
      );

      expect(await timeoutOf(manager.confirm(lock), dir)).toEqual(timeout('lock-lost'));
    });

    test('ENOENT no holder com o lock devolvido antes dos 10 ms segue', async () => {
      const { lockDir } = workspace();
      const manager = createLockManager({ log: captureLog().log, bootId: BOOT });
      const lock = await manager.acquire(lockDir);
      const away = `${lockDir}.away`;
      fs.renameSync(lockDir, away);
      setTimeout(() => fs.renameSync(away, lockDir), 2);

      await expect(manager.confirm(lock)).resolves.toBeUndefined();
    });

    test('ENOENT no holder que persiste dá lock-lost', async () => {
      const { dir, lockDir } = workspace();
      const manager = createLockManager({ log: captureLog().log, bootId: BOOT });
      const lock = await manager.acquire(lockDir);
      fs.renameSync(lockDir, `${lockDir}.away`);

      expect(await timeoutOf(manager.confirm(lock), dir)).toEqual(timeout('lock-lost'));
    });
  });

  describe('órfão', () => {
    test('lock do próprio processo com token que ele não segura é roubado na próxima aquisição', async () => {
      const { dir, lockDir, holderFile } = workspace();
      plantLock(lockDir, { pid: process.pid, token: 'given-up', bootId: BOOT });
      const { records, log } = captureLog();
      const manager = createLockManager({ log, bootId: BOOT });

      const lock = await manager.acquire(lockDir);

      expect(tokenIn(holderFile)).toBe(lock.token);
      expect(records).toEqual([{ level: 'warn', event: 'lock-orphan-removed', pid: process.pid }]);
      expect(fs.readdirSync(dir)).toEqual([LOCK_DIR]);
    });

    test('zumbi (morto que o pai ainda não colheu) conta como dono morto e o lock é roubado', async () => {
      const { lockDir, holderFile } = workspace();
      const { pid, parent } = await zombieChild();
      try {
        expect(isPidAlive(pid)).toBe(false);
        plantLock(lockDir, { pid, token: 'zombie', bootId: BOOT });
        const { records, log } = captureLog();

        const lock = await createLockManager({ log, bootId: BOOT }).acquire(lockDir);

        expect(tokenIn(holderFile)).toBe(lock.token);
        expect(records).toContainEqual({ level: 'warn', event: 'lock-orphan-removed', pid });
      } finally {
        parent.kill('SIGKILL');
      }
    });

    test('holder com bootId diferente é roubado mesmo com pid vivo e token segurado', async () => {
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

    test('bootId null (sem /proc) só casa com null', async () => {
      const { dir, lockDir, holderFile } = workspace();
      const pid = await liveForeignPid();
      plantLock(lockDir, { pid, token: 'foreign', bootId: null });

      const sameBoot = createLockManager({ log: captureLog().log, budgetMs: 50, bootId: null });
      expect(await timeoutOf(sameBoot.acquire(lockDir), dir)).toEqual(timeout('lock-busy', pid));

      const otherBoot = createLockManager({ log: captureLog().log, bootId: BOOT });
      const lock = await otherBoot.acquire(lockDir);
      expect(tokenIn(holderFile)).toBe(lock.token);
    });
  });

  describe('moveAside', () => {
    test('com o token esperado apaga o lock movido e não deixa resto', () => {
      const { dir, lockDir } = workspace();
      plantLock(lockDir, { pid: 4242, token: 'owner', bootId: BOOT });
      const { records, log } = captureLog();

      expect(moveAside(lockDir, '.dead-', 'owner', log)).toBe('removed');

      expect(fs.readdirSync(dir)).toEqual([]);
      expect(records).toEqual([]);
    });

    test('com token velho devolve o lock ao dono e loga lock-lost com os dois pids', () => {
      const { dir, lockDir, holderFile } = workspace();
      const holder = { pid: 4242, token: 'owner', bootId: BOOT };
      plantLock(lockDir, holder);
      const { records, log } = captureLog();

      expect(moveAside(lockDir, '.dead-', 'stale', log)).toBe('restored');

      expect(JSON.parse(fs.readFileSync(holderFile, 'utf8'))).toEqual(holder);
      expect(fs.readdirSync(dir)).toEqual([LOCK_DIR]);
      expect(records).toEqual([
        { level: 'error', event: 'lock-lost', pid: process.pid, holderPid: 4242, restored: true },
      ]);
    });

    test('devolução que falha por já existir lock novo deixa o novo intacto e apaga o renomeado', () => {
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

      expect(moveAside(lockDir, '.dead-', 'stale', log)).toBe('discarded');

      expect(JSON.parse(fs.readFileSync(holderFile, 'utf8'))).toEqual(newer);
      expect(fs.readdirSync(dir)).toEqual([LOCK_DIR]);
      expect(records).toEqual([
        { level: 'error', event: 'lock-lost', pid: process.pid, holderPid: 4242, restored: false },
      ]);
    });

    test('rename que falha por outro motivo que ENOENT sai cru e o lock fica onde está', () => {
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

    test('devolução que falha por outro motivo que "já existe lock novo" sai crua e o movido fica', () => {
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

    test('sem lock devolve gone e não loga', () => {
      const { lockDir } = workspace();
      const { records, log } = captureLog();

      expect(moveAside(lockDir, '.dead-', 'owner', log)).toBe('gone');

      expect(records).toEqual([]);
    });
  });

  describe('liberação', () => {
    test('libera o lock e não deixa resto', async () => {
      const { dir, lockDir } = workspace();
      const manager = createLockManager({ log: captureLog().log, bootId: BOOT });
      const lock = await manager.acquire(lockDir);

      await manager.release(lock);

      expect(fs.readdirSync(dir)).toEqual([]);
    });

    test('com o lock já trocado por outro dono não mexe nele', async () => {
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

    test('se um ladrão troca o lock entre a conferência e o rename, devolve o lock do outro dono', async () => {
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
});
