import { afterEach, describe, expect, it, jest } from '@jest/globals';
import { spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import * as path from 'node:path';
import {
  ATTACHMENTS_DIR,
  dataRoot,
  LOCK_DIR,
  LOG_FILE,
  MANIFEST_FILE,
  processPaths,
} from '../../src/adapters/fs/data-format.ts';
import { createProcessStore, MAX_LOG_BYTES } from '../../src/adapters/fs/process-store.ts';
import { anchor } from '../../src/domain/chain.ts';
import { HexlogError } from '../../src/errors.ts';
import type { Manifest } from '../../src/domain/manifest.ts';
import type { ProcessRef, ProcessStore, RawProcess } from '../../src/ports.ts';
import { parseLog, verifyProcess } from '../../src/shared/loader.ts';
import { chainLine, emptyManifest } from '../fixtures/chain-line.ts';
import type { CrashWriterArgs } from '../fixtures/fixture-args.ts';
import {
  captureError,
  captureLog,
  createTempDir,
  errno,
  expectNoLeak,
  rejectionOf,
  scriptWrites,
  spyOnWriteSync,
} from '../helpers.ts';
import { countFsyncs } from './fsync-spy.ts';
import { killChildren, liveForeignPid } from './lock-helpers.ts';

const CRASH_WRITER = path.join(__dirname, '..', 'fixtures', 'crash-writer.ts');
const BOOT = 'boot-a';

/** Processo vazio como o `create` o deixa: ponto de partida para montar linhas sem ler o disco. */
const emptyRaw = (manifest: Manifest): RawProcess => ({
  manifest,
  text: '',
  endsWithNewline: true,
});

const lineOptions = {
  agent: 'process-store-spec',
  text: (item: number) => `item ${item} ${'x'.repeat(130)}`,
};

/** Lote de `count` elos depois do fim do log lido em `raw`; com `key`, o primeiro leva `batch.key`. */
const batchLine = (raw: RawProcess, count: number, key?: string): string =>
  chainLine(raw.manifest.process, verifyProcess(raw).end, count, { ...lineOptions, key });

/** Grava um lote e devolve nada; a posição vem do log lido sob o lock. */
const append = (store: ProcessStore, ref: ProcessRef, count: number, key?: string) =>
  store.write(ref, (raw) => ({ line: batchLine(raw, count, key), result: undefined }));

/** Reenvio por `key`: `replayed` se o lote já está visível, senão grava o lote inteiro. */
const resend = (store: ProcessStore, ref: ProcessRef, count: number, key: string) =>
  store.write(ref, (raw) => {
    const { batches, end } = verifyProcess(raw);
    return batches.has(key)
      ? { result: 'replayed' as const }
      : {
          line: chainLine(ref.process, end, count, { ...lineOptions, key }),
          result: 'written' as const,
        };
  });

/** Tudo que o teste precisa de um processo novo num diretório de dados temporário. */
function setup(budgetMs?: number) {
  const dataDir = createTempDir('process-store');
  const { records, log } = captureLog();
  const store = createProcessStore({ dataDir, log, bootId: BOOT, budgetMs });
  const ref: ProcessRef = { project: 'demo', process: 'proc-1' };
  const manifest = emptyManifest(ref);
  store.create(ref, manifest);
  const paths = processPaths(dataDir, ref);
  return {
    dataDir,
    store,
    records,
    ref,
    manifest,
    dir: paths.dir,
    manifestFile: paths.manifest,
    logFile: paths.log,
    lockDir: paths.lock,
  };
}

const locksIn = (dir: string): string[] =>
  fs.readdirSync(dir).filter((name) => name.startsWith(LOCK_DIR));

/** Conta os `fsync` dados no arquivo de log (pelo inode: o do lock e o do diretório não entram). */
function countLogFsyncs(logFile: string): () => number {
  const realFsync = fs.fsyncSync;
  const ino = fs.statSync(logFile).ino;
  let count = 0;
  jest.spyOn(fs, 'fsyncSync').mockImplementation((fd) => {
    if (fs.fstatSync(fd).ino === ino) count += 1;
    realFsync(fd);
  });
  return () => count;
}

/** Registra, na ordem, os `write` e `fsync` dados no arquivo de log (pelo inode, como `countLogFsyncs`). */
function recordLogCalls(logFile: string): string[] {
  const realWrite = fs.writeSync;
  const realFsync = fs.fsyncSync;
  const ino = fs.statSync(logFile).ino;
  const calls: string[] = [];
  const onLog = (fd: number, call: string) => {
    if (fs.fstatSync(fd).ino === ino) calls.push(call);
  };
  spyOnWriteSync((fd, buffer, offset) => {
    onLog(fd, 'write');
    return realWrite(fd, buffer, offset);
  });
  jest.spyOn(fs, 'fsyncSync').mockImplementation((fd) => {
    onLog(fd, 'fsync');
    realFsync(fd);
  });
  return calls;
}

describe('createProcessStore', () => {
  afterEach(() => {
    jest.restoreAllMocks();
    killChildren();
  });

  it('should write the manifest and return false without touching it on a second create', () => {
    const { store, ref, manifest, dir, manifestFile: file } = setup();
    const before = fs.readFileSync(file, 'utf8');

    const created = store.create(ref, { ...manifest, createdAt: '2027-01-01T00:00:00.000Z' });

    expect(JSON.parse(before)).toEqual(manifest);
    expect(created).toBe(false);
    expect(fs.readFileSync(file, 'utf8')).toBe(before);
    expect(fs.readdirSync(dir).sort()).toEqual([MANIFEST_FILE, LOG_FILE]);
  });

  it('should open the log before the manifest and fsync the directory once on create', () => {
    const { store } = setup();
    const other: ProcessRef = { project: 'demo', process: 'proc-2' };
    const realOpen = fs.openSync;
    const opened: string[] = [];
    const fsyncs = countFsyncs();
    // o manifesto nasce como temporário `.process.json.*`, então a ordem vem desse prefixo
    jest.spyOn(fs, 'openSync').mockImplementation((file, flags, mode) => {
      opened.push(path.basename(String(file)));
      return realOpen(file, flags, mode);
    });

    const created = store.create(other, emptyManifest(other));

    expect(created).toBe(true);
    expect(fsyncs().directories).toBe(1);
    expect(
      opened.filter((name) => name === LOG_FILE || name.startsWith(`.${MANIFEST_FILE}.`)),
    ).toEqual([LOG_FILE, expect.stringContaining(`.${MANIFEST_FILE}.`)]);
  });

  it('should throw IO_ERROR with only the errno when create fails for a reason other than EEXIST, such as a parent that is a file', () => {
    const { dataDir, store } = setup();
    fs.writeFileSync(path.join(dataRoot(dataDir), 'blocked'), '');

    const error = captureError(() =>
      store.create(
        { project: 'blocked', process: 'x' },
        emptyManifest({ project: 'blocked', process: 'x' }),
      ),
    );

    expect(error).toMatchObject({
      code: 'IO_ERROR',
      details: [{ path: '', code: 'enotdir', message: 'I/O failure' }],
    });

    expectNoLeak(error, dataDir);
  });

  it('should read an empty log ending in a newline for a new process', () => {
    const { store, ref, manifest } = setup();

    expect(store.read(ref)).toEqual({ manifest, text: '', endsWithNewline: true });
  });

  it('should read a log with a written line as ending in a newline', async () => {
    const { store, ref, manifest, logFile } = setup();
    await append(store, ref, 1);
    const line = fs.readFileSync(logFile, 'utf8');

    expect(store.read(ref)).toEqual({ manifest, text: line, endsWithNewline: true });
  });

  it('should read a log with a torn tail as not ending in a newline', async () => {
    const { store, ref, logFile } = setup();
    await append(store, ref, 1);
    const line = fs.readFileSync(logFile, 'utf8');
    fs.appendFileSync(logFile, '{"links":[{"seq"');

    expect(store.read(ref)).toMatchObject({
      text: `${line}{"links":[{"seq"`,
      endsWithNewline: false,
    });
  });

  it('should throw PROCESS_NOT_FOUND when reading a missing process', () => {
    const { store, ref } = setup();

    expect(() => store.read({ ...ref, process: 'outro' })).toThrow(
      expect.objectContaining({ code: 'PROCESS_NOT_FOUND' }),
    );
  });

  it('should read a process without records.jsonl as an empty log', () => {
    const { store, ref, logFile } = setup();
    fs.rmSync(logFile);

    expect(store.read(ref)).toMatchObject({ text: '', endsWithNewline: true });
  });

  it('should return the manifest from readManifest', () => {
    const { store, ref, manifest } = setup();

    expect(store.readManifest(ref)).toEqual(manifest);
  });

  it('should throw PROCESS_NOT_FOUND from readManifest for a missing process', () => {
    const { store, ref } = setup();

    expect(() => store.readManifest({ ...ref, process: 'outro' })).toThrow(
      expect.objectContaining({ code: 'PROCESS_NOT_FOUND' }),
    );
  });

  it('should throw PROCESS_CORRUPTED from readManifest for an unreadable manifest', () => {
    const { store, ref, manifestFile } = setup();
    fs.writeFileSync(manifestFile, 'isto nao e json');

    expect(() => store.readManifest(ref)).toThrow(
      expect.objectContaining({
        code: 'PROCESS_CORRUPTED',
        details: [expect.objectContaining({ code: 'unreadable-manifest' })],
      }),
    );
  });

  it.each([
    ['text that is not JSON', 'isto nao e json'],
    ['JSON of the wrong shape', '{"project":"demo"}'],
    [
      'an invalid nested field (fixed.types.x = 1)',
      JSON.stringify({
        ...emptyManifest({ project: 'demo', process: 'proc-1' }),
        fixed: { types: { x: 1 }, relations: {}, gates: {} },
      }),
    ],
  ])(
    'should throw PROCESS_CORRUPTED without a path on read for an unreadable manifest: %s',
    (_name, content) => {
      const { dataDir, store, ref, manifestFile } = setup();
      fs.writeFileSync(manifestFile, content);

      const error = captureError(() => store.read(ref));

      expect(error).toMatchObject({
        code: 'PROCESS_CORRUPTED',
        details: [
          {
            path: '/process',
            code: 'unreadable-manifest',
            message: expect.any(String),
            process: ref.process,
          },
        ],
      });

      expectNoLeak(error, dataDir);
    },
  );

  it('should turn an I/O failure into IO_ERROR with only the errno and no path when the manifest is a directory', () => {
    const { dataDir, store, ref, manifestFile } = setup();
    fs.rmSync(manifestFile);
    fs.mkdirSync(manifestFile);

    const error = captureError(() => store.read(ref));

    expect(error).toMatchObject({
      code: 'IO_ERROR',
      details: [{ path: '', code: 'eisdir', message: 'I/O failure' }],
    });

    expectNoLeak(error, dataDir);
  });

  describe('with a sparse log near the 64 MiB cap', () => {
    /** Log esparso do tamanho pedido: o teto se testa sem gravar 64 MiB de verdade. */
    const sparseLog = (logFile: string, size: number) => fs.truncateSync(logFile, size);

    /** Ler 64 MiB como string leva centenas de ms; sob carga o limite padrão de 5 s não basta. */
    const LARGE_LOG_TIMEOUT_MS = 30_000;

    it('should return the manifest from readManifest without reading records.jsonl when the log is above the cap', () => {
      const { store, ref, manifest, logFile } = setup();
      sparseLog(logFile, MAX_LOG_BYTES + 1);
      const readFile = jest.spyOn(fs, 'readFileSync');

      const read = store.readManifest(ref);

      expect(read).toEqual(manifest);
      expect(readFile).not.toHaveBeenCalledWith(logFile, expect.anything());
    });

    it(
      'should still read a log of exactly 64 MiB',
      () => {
        const { store, ref, logFile } = setup();
        sparseLog(logFile, MAX_LOG_BYTES);

        // `toHaveLength` imprimiria os 64 MiB na falha.
        expect(store.read(ref).text.length).toBe(MAX_LOG_BYTES);
      },
      LARGE_LOG_TIMEOUT_MS,
    );

    it('should throw PROCESS_TOO_LARGE without a path and without reading the content when read finds a log 1 byte above the cap', () => {
      const { dataDir, store, ref, logFile } = setup();
      sparseLog(logFile, MAX_LOG_BYTES + 1);
      const readFile = jest.spyOn(fs, 'readFileSync');

      const error = captureError(() => store.read(ref));

      expect(error).toMatchObject({
        code: 'PROCESS_TOO_LARGE',
        details: [
          { path: '/process', code: 'too-large', message: expect.any(String), process: 'proc-1' },
        ],
      });
      expect(error.message).toBe("process 'proc-1' log exceeds 64 MiB");

      expectNoLeak(error, dataDir);

      expect(readFile).not.toHaveBeenCalledWith(logFile, expect.anything());
    });

    it('should refuse a write over a log above the cap without writing and release the lock', async () => {
      const { dataDir, store, ref, logFile, dir } = setup();
      sparseLog(logFile, MAX_LOG_BYTES + 1);
      const decide = jest.fn(() => ({ result: undefined }));

      const error = await rejectionOf(store.write(ref, decide), dataDir);

      expect(error).toMatchObject({
        code: 'PROCESS_TOO_LARGE',
        details: [{ code: 'too-large', process: 'proc-1' }],
      });
      expect(error.message).toContain('create a new process');
      expect(decide).not.toHaveBeenCalled();
      expect(fs.statSync(logFile).size).toBe(MAX_LOG_BYTES + 1);
      expect(locksIn(dir)).toEqual([]);
    });

    /** Prefixo `\n` (o log esparso termina em byte nulo) mais a linha: o lote tem `LINE.length + 1` bytes. */
    const LINE = 'x'.repeat(100);

    it(
      'should write a batch that closes the log at exactly 64 MiB and keep the process readable',
      async () => {
        const { store, ref, logFile } = setup();
        sparseLog(logFile, MAX_LOG_BYTES - LINE.length - 1);

        await store.write(ref, () => ({ line: LINE, result: undefined }));

        expect(fs.statSync(logFile).size).toBe(MAX_LOG_BYTES);
        expect(store.read(ref).text.length).toBe(MAX_LOG_BYTES);
      },
      LARGE_LOG_TIMEOUT_MS,
    );

    it(
      'should return the result of a write without a line (replay) over a log of exactly 64 MiB without writing',
      async () => {
        const { store, ref, logFile, dir } = setup();
        sparseLog(logFile, MAX_LOG_BYTES);

        const result = await store.write(ref, () => ({ result: 'replayed' }));

        expect(result).toBe('replayed');
        expect(fs.statSync(logFile).size).toBe(MAX_LOG_BYTES);
        expect(locksIn(dir)).toEqual([]);
      },
      LARGE_LOG_TIMEOUT_MS,
    );

    it(
      'should refuse a batch that would pass the cap by 1 byte, keep the file size, release the lock and keep read working',
      async () => {
        const { dataDir, store, ref, logFile, dir } = setup();
        sparseLog(logFile, MAX_LOG_BYTES - LINE.length);

        const error = await rejectionOf(
          store.write(ref, () => ({ line: LINE, result: undefined })),
          dataDir,
        );

        expect(error).toMatchObject({
          code: 'PROCESS_TOO_LARGE',
          details: [
            {
              path: '/process',
              code: 'too-large',
              message: expect.stringContaining('new process'),
              process: 'proc-1',
            },
          ],
        });
        expect(fs.statSync(logFile).size).toBe(MAX_LOG_BYTES - LINE.length);
        expect(locksIn(dir)).toEqual([]);
        expect(store.read(ref).text.length).toBe(MAX_LOG_BYTES - LINE.length);
      },
      LARGE_LOG_TIMEOUT_MS,
    );

    /** 50 caracteres e 100 bytes (`ç` e `ã` ocupam 2 bytes cada); com o `\n` de prefixo o lote tem 101 bytes. */
    const MULTIBYTE = 'çã'.repeat(25);

    it('should count the cap in bytes, not characters, and refuse a multibyte batch that only fits in characters', async () => {
      const { dataDir, store, ref, logFile } = setup();
      // sobram 60 bytes: o lote caberia em caracteres (51), mas não em bytes (101)
      sparseLog(logFile, MAX_LOG_BYTES - 60);

      const error = await rejectionOf(
        store.write(ref, () => ({ line: MULTIBYTE, result: undefined })),
        dataDir,
      );

      expect(error.code).toBe('PROCESS_TOO_LARGE');
      expect(fs.statSync(logFile).size).toBe(MAX_LOG_BYTES - 60);
    });

    it('should write a multibyte batch that closes the log at exactly 64 MiB counted in bytes', async () => {
      const { store, ref, logFile } = setup();
      sparseLog(logFile, MAX_LOG_BYTES - 101);

      await store.write(ref, () => ({ line: MULTIBYTE, result: undefined }));

      expect(fs.statSync(logFile).size).toBe(MAX_LOG_BYTES);
      expect(fs.readFileSync(logFile, 'utf8').endsWith(MULTIBYTE)).toBe(true);
    });
  });

  it('should return an empty list from listProjects for a data directory without projects', () => {
    const empty = createProcessStore({ dataDir: createTempDir('vazio'), log: () => undefined });

    expect(empty.listProjects()).toEqual([]);
  });

  it('should return an empty list from list for a project that is absent', () => {
    const { store } = setup();

    expect(store.list('ausente')).toEqual([]);
  });

  it('should sort the processes from list and skip folders without a manifest', () => {
    const { dataDir, store, ref, manifest } = setup();
    store.create({ project: 'demo', process: 'alpha' }, { ...manifest, process: 'alpha' });
    fs.mkdirSync(path.join(dataRoot(dataDir), 'demo', 'types'));
    fs.mkdirSync(path.join(dataRoot(dataDir), 'demo', ATTACHMENTS_DIR));

    expect(store.list('demo')).toEqual(['alpha', ref.process]);
  });

  it('should sort the projects from listProjects', () => {
    const { store, manifest } = setup();
    store.create(
      { project: 'abc', process: 'zeta' },
      { ...manifest, project: 'abc', process: 'zeta' },
    );

    expect(store.listProjects()).toEqual(['abc', 'demo']);
  });

  describe('with a path that is a file where a directory is expected', () => {
    const notADirectory = expect.objectContaining({
      code: 'IO_ERROR',
      details: [{ path: '', code: 'enotdir', message: 'I/O failure' }],
    });

    it('should throw IO_ERROR with only the errno from list when the project path is a file', () => {
      const { dataDir, store } = setup();
      fs.writeFileSync(path.join(dataRoot(dataDir), 'blocked'), '');

      expect(() => store.list('blocked')).toThrow(notADirectory);
    });

    it('should throw IO_ERROR with only the errno from listProjects when the data root is a file', () => {
      const flatDir = createTempDir('process-store-flat');
      fs.writeFileSync(dataRoot(flatDir), '');
      const flat = createProcessStore({ dataDir: flatDir, log: () => undefined });

      expect(() => flat.listProjects()).toThrow(notADirectory);
    });
  });

  describe('when the manifest stat fails with EACCES', () => {
    /** O `stat` do manifesto falha com `EACCES`, como numa pasta sem permissão de busca. */
    function denyManifestStat(): void {
      const realStat = fs.statSync;
      jest.spyOn(fs, 'statSync').mockImplementation((...args: Parameters<typeof fs.statSync>) => {
        if (String(args[0]).endsWith(MANIFEST_FILE)) throw errno('EACCES');
        return realStat(...args);
      });
    }

    it('should throw IO_ERROR from list instead of silently omitting the process', () => {
      const { store, ref } = setup();
      denyManifestStat();

      expect(() => store.list(ref.project)).toThrow(
        expect.objectContaining({
          code: 'IO_ERROR',
          details: [{ path: '', code: 'eacces', message: 'I/O failure' }],
        }),
      );
    });

    it('should throw IO_ERROR, not PROCESS_NOT_FOUND, from write and not call decide', async () => {
      const { dataDir, store, ref } = setup();
      denyManifestStat();
      const decide = jest.fn(() => ({ result: undefined }));

      const error = await rejectionOf(store.write(ref, decide), dataDir);

      expect(error).toMatchObject({
        code: 'IO_ERROR',
        details: [{ path: '', code: 'eacces', message: 'I/O failure' }],
      });
      expect(decide).not.toHaveBeenCalled();
    });
  });

  it('should not return folders created by hand with an invalid name from list', () => {
    const { dataDir, store, ref, manifest } = setup();
    for (const name of ['.tmp', 'a.b', 'Bad Name']) {
      // com manifesto dentro, só o filtro de nome as tira de `list`
      const stray = path.join(dataRoot(dataDir), ref.project, name);
      fs.mkdirSync(stray);
      fs.writeFileSync(path.join(stray, MANIFEST_FILE), JSON.stringify(manifest));
    }

    expect(store.list(ref.project)).toEqual([ref.process]);
  });

  it('should not return folders created by hand with an invalid name from listProjects', () => {
    const { dataDir, store, ref } = setup();
    for (const name of ['.tmp', 'a.b', 'Bad Name']) {
      fs.mkdirSync(path.join(dataRoot(dataDir), name));
    }

    expect(store.listProjects()).toEqual([ref.project]);
  });

  // Fixa o comportamento atual, não uma proteção: `<D>` é confiável (ADR 0009, item 9) e o store não
  // recusa symlink. Se o endurecimento de `io.ts#readIfPresent` entrar, este teste vira recusa.
  // Decisão do #63.
  it('should read and write through the target of a records.jsonl that is a symlink', async () => {
    const { store, ref, logFile } = setup();
    const target = path.join(createTempDir('process-store-target'), 'real.jsonl');
    fs.renameSync(logFile, target);
    fs.symlinkSync(target, logFile);

    await append(store, ref, 1);

    expect(fs.lstatSync(logFile).isSymbolicLink()).toBe(true);
    expect(fs.readFileSync(target, 'utf8')).not.toBe('');
    expect(store.read(ref).text).toBe(fs.readFileSync(target, 'utf8'));
  });

  describe('with an invalid name or a manifest that differs from the ref', () => {
    const invalidRefs: [string, ProcessRef][] = [
      ['a process with ../', { project: 'demo', process: '../../escaped' }],
      ['the project ..', { project: '..', process: 'proc-1' }],
      ['a process with a space and a capital letter', { project: 'demo', process: 'Bad Name' }],
      ['a project with a space and a capital letter', { project: 'Bad Name', process: 'proc-1' }],
    ];
    const invalid = expect.objectContaining({ code: 'INVALID_INPUT' });

    /** Só o processo do `setup` existe: a recusa não criou nada fora de `.v1` nem dentro dele. */
    const expectNothingCreated = (dataDir: string, ref: ProcessRef) => {
      expect(fs.readdirSync(dataDir)).toEqual([path.basename(dataRoot(dataDir))]);
      expect(fs.readdirSync(dataRoot(dataDir))).toEqual([ref.project]);
      expect(fs.readdirSync(path.join(dataRoot(dataDir), ref.project))).toEqual([ref.process]);
    };

    it.each(invalidRefs)(
      'should throw INVALID_INPUT from create for %s and create nothing outside .v1',
      (_name, bad) => {
        const { dataDir, store, ref } = setup();

        expect(() => store.create(bad, emptyManifest(bad))).toThrow(invalid);

        expectNothingCreated(dataDir, ref);
      },
    );

    it.each(invalidRefs)(
      'should throw INVALID_INPUT from read for %s and create nothing outside .v1',
      (_name, bad) => {
        const { dataDir, store, ref } = setup();

        expect(() => store.read(bad)).toThrow(invalid);

        expectNothingCreated(dataDir, ref);
      },
    );

    it.each(invalidRefs)(
      'should throw INVALID_INPUT from write for %s and create nothing outside .v1',
      async (_name, bad) => {
        const { dataDir, store, ref } = setup();

        await expect(append(store, bad, 1)).rejects.toEqual(invalid);

        expectNothingCreated(dataDir, ref);
      },
    );

    it.each([
      ['the project ..', '..'],
      ['a project with a space and a capital letter', 'Bad Name'],
    ])(
      'should throw INVALID_INPUT from list for %s without listing outside .v1',
      (_name, project) => {
        const { store } = setup();

        expect(() => store.list(project)).toThrow(
          expect.objectContaining({ code: 'INVALID_INPUT' }),
        );
      },
    );

    it('should throw RESERVED_NAME from create for a reserved process name and not create the folder', () => {
      const { dataDir, store } = setup();
      const reserved: ProcessRef = { project: 'demo', process: ATTACHMENTS_DIR };

      expect(() => store.create(reserved, emptyManifest(reserved))).toThrow(
        expect.objectContaining({ code: 'RESERVED_NAME' }),
      );
      expect(fs.existsSync(path.join(dataRoot(dataDir), 'demo', ATTACHMENTS_DIR))).toBe(false);
    });

    it.each([
      ['process', { process: 'outro' }],
      ['project', { project: 'outro' }],
    ])(
      'should throw from create when manifest.%s differs from the ref and not create a directory',
      (_field, override) => {
        const { dataDir, store, ref } = setup();
        const other: ProcessRef = { project: ref.project, process: 'proc-2' };

        expect(() => store.create(other, { ...emptyManifest(other), ...override })).toThrow(
          expect.objectContaining({ code: 'INTERNAL' }),
        );

        expect(fs.readdirSync(dataRoot(dataDir))).toEqual([ref.project]);
        expect(fs.readdirSync(path.join(dataRoot(dataDir), ref.project))).toEqual([ref.process]);
      },
    );
  });

  it('should write the line returned by decide, return its result and hand decide the raw log', async () => {
    const { store, ref, logFile } = setup();
    const line = batchLine(emptyRaw(emptyManifest(ref)), 2, 'k1');
    let received: RawProcess | undefined;

    const result = await store.write(ref, (raw) => {
      received = raw;
      return { line, result: 'pronto' };
    });

    expect(result).toBe('pronto');
    expect(received).toEqual({ manifest: emptyManifest(ref), text: '', endsWithNewline: true });
    expect(fs.readFileSync(logFile, 'utf8')).toBe(line);
  });

  it('should prefix a newline when the log ends in a torn tail', async () => {
    const { store, ref, logFile } = setup();
    fs.writeFileSync(logFile, '{"links":[{"seq"');

    await append(store, ref, 1);

    const text = fs.readFileSync(logFile, 'utf8');

    expect(text.startsWith('{"links":[{"seq"\n{"links":')).toBe(true);
    expect(verifyProcess(store.read(ref)).chain).toMatchObject({
      ok: true,
      totalRecords: 1,
      repairedLines: [0],
    });
  });

  it('should throw PROCESS_NOT_FOUND from write for a missing process and create nothing', async () => {
    const { dataDir, store, ref } = setup();
    const missing = { ...ref, process: 'outro' };

    const error = await rejectionOf(append(store, missing, 1), dataDir);

    expect(error.code).toBe('PROCESS_NOT_FOUND');
    expect(fs.existsSync(path.join(dataRoot(dataDir), ref.project, 'outro'))).toBe(false);
  });

  it('should serialize 8 concurrent writes to the same process with an intact chain and contiguous seq', async () => {
    const { store, ref, dir } = setup();

    await Promise.all(Array.from({ length: 8 }, (_, n) => append(store, ref, 1, `k${n}`)));

    const { chain, records } = verifyProcess(store.read(ref));

    expect(chain.ok).toBe(true);
    expect(records.map(({ seq }) => seq)).toEqual([0, 1, 2, 3, 4, 5, 6, 7]);
    expect(locksIn(dir)).toEqual([]);
  }, 30_000);

  describe('when no line is written', () => {
    it('should leave a rule error from decide unchanged, with no line and the lock released', async () => {
      const { store, ref, logFile, dir } = setup();
      const broken = new HexlogError('INVALID_RECORD', 'rule broken');

      await expect(
        store.write(ref, () => {
          throw broken;
        }),
      ).rejects.toBe(broken);

      expect(fs.readFileSync(logFile, 'utf8')).toBe('');
      expect(locksIn(dir)).toEqual([]);
    });

    /** Outro dono toma o lock entre a aquisição e a conferência do token. */
    const writeLosingToken = (
      store: ProcessStore,
      ref: ProcessRef,
      lockDir: string,
      line: string,
    ) =>
      store.write(ref, () => {
        fs.writeFileSync(
          path.join(lockDir, 'holder'),
          JSON.stringify({ pid: process.pid, token: 'outro', bootId: BOOT }),
        );
        return { line, result: undefined };
      });

    it('should throw lock-lost with no line when the token is lost before the write', async () => {
      const { dataDir, store, ref, logFile, lockDir } = setup();
      const line = batchLine(emptyRaw(emptyManifest(ref)), 1);

      const error = await rejectionOf(writeLosingToken(store, ref, lockDir, line), dataDir);

      expect(error).toMatchObject({
        code: 'LOCK_TIMEOUT',
        details: [{ path: '/process', code: 'lock-lost', message: expect.any(String) }],
      });
      expect(fs.readFileSync(logFile, 'utf8')).toBe('');
    });

    it('should take the orphan lock left by its own process on the next write after a lost token', async () => {
      const { dataDir, store, ref, lockDir } = setup();
      const line = batchLine(emptyRaw(emptyManifest(ref)), 1);
      await rejectionOf(writeLosingToken(store, ref, lockDir, line), dataDir);

      await append(store, ref, 1);

      expect(verifyProcess(store.read(ref)).chain).toMatchObject({ ok: true, totalRecords: 1 });
    });

    it('should not call decide and leave no line when a live owner holds the lock', async () => {
      const { dataDir, ref, logFile, lockDir } = setup();
      const store = createProcessStore({
        dataDir,
        log: () => undefined,
        bootId: BOOT,
        budgetMs: 50,
      });
      const pid = await liveForeignPid();
      fs.mkdirSync(lockDir);
      fs.writeFileSync(
        path.join(lockDir, 'holder'),
        JSON.stringify({ pid, token: 'alheio', bootId: BOOT }),
      );
      const decide = jest.fn(() => ({ line: 'nao deve gravar\n', result: undefined }));

      const error = await rejectionOf(store.write(ref, decide), dataDir);

      expect(error).toMatchObject({
        code: 'LOCK_TIMEOUT',
        details: [{ path: '/process', code: 'lock-busy', message: expect.any(String), pid }],
      });
      expect(decide).not.toHaveBeenCalled();
      expect(fs.readFileSync(logFile, 'utf8')).toBe('');
    });
  });

  describe('with one fsync per batch', () => {
    it('should fsync the log once for a batch of 50', async () => {
      const { store, ref, logFile } = setup();
      const fsyncs = countLogFsyncs(logFile);

      await append(store, ref, 50, 'k50');

      expect(fsyncs()).toBe(1);
      expect(verifyProcess(store.read(ref)).chain.totalRecords).toBe(50);
    });

    it('should fsync the log once for a replay without a line', async () => {
      const { store, ref, logFile } = setup();
      const fsyncs = countLogFsyncs(logFile);
      await append(store, ref, 50, 'k50');

      await store.write(ref, () => ({ result: undefined }));

      // 1 do lote de preparo mais 1 do replay
      expect(fsyncs()).toBe(2);
    });

    it('should fsync the log after writing it', async () => {
      const { store, ref, logFile } = setup();
      const calls = recordLogCalls(logFile);

      await append(store, ref, 3, 'lote');

      expect(calls).toEqual(['write', 'fsync']);
    });

    it('should only fsync on a replay without a line', async () => {
      const { store, ref, logFile } = setup();
      const calls = recordLogCalls(logFile);
      await append(store, ref, 3, 'lote');
      calls.length = 0;

      await store.write(ref, () => ({ result: undefined }));

      expect(calls).toEqual(['fsync']);
    });
  });

  describe('when the writer is killed with SIGKILL mid-batch', () => {
    const RUNS = 200;
    const RESEND_EVERY = 4;
    // filhos carregados à frente da rodada: só um deles escreve por vez, como no mesmo log reusado
    const PREFETCH = 4;
    const children: ChildProcess[] = [];

    afterEach(() => {
      for (const child of children.splice(0)) child.kill('SIGKILL');
    });

    /** Filho já carregado e parado à espera do `go`; um a menos por rodada é o que esconde o custo de subir. */
    function spawnWriter(dataDir: string, ref: ProcessRef, run: number): ChildProcess {
      const args: CrashWriterArgs = { dataDir, project: ref.project, process: ref.process, run };
      const child = spawn(process.execPath, [CRASH_WRITER, JSON.stringify(args)]);
      children.push(child);
      return child;
    }

    /** Roubos de lock de órfão no stderr do filho; ruído e a última linha, cortada pelo SIGKILL, não são JSON e caem fora. */
    function countOrphanSteals(stderr: string): number {
      return stderr.split('\n').filter((line) => {
        try {
          return (JSON.parse(line) as { event?: unknown }).event === 'lock-orphan-removed';
        } catch {
          return false;
        }
      }).length;
    }

    /**
     * Libera o filho, espera ele anunciar o primeiro lote, deixa passar `run % 8` ms (cobre a gravação, o
     * fsync e o começo do lote seguinte) e mata com SIGKILL. Devolve a `key` do último lote anunciado: o
     * único que pode estar incompleto, porque o filho só anuncia o seguinte depois de gravar o anterior;
     * e `steals`, os roubos de lock de órfão que o filho reportou.
     */
    function killMidBatch(
      child: ChildProcess,
      run: number,
    ): Promise<{ key: string; steals: number }> {
      const announced: string[] = [];
      let stderr = '';
      let pending = '';
      let killing = false;
      child.stderr?.on('data', (chunk) => (stderr += String(chunk)));
      child.stdout?.on('data', (chunk) => {
        const parts = (pending + String(chunk)).split('\n');
        pending = parts.pop() ?? '';
        announced.push(...parts);
        if (!killing && announced.length >= 1) {
          killing = true;
          setTimeout(() => child.kill('SIGKILL'), run % 8);
        }
      });
      child.stdin?.write('go\n');
      return new Promise((resolve, reject) => {
        child.on('error', reject);
        child.on('close', (status, signal) => {
          const last = announced.at(-1);
          if (signal === 'SIGKILL' && last !== undefined) {
            resolve({ key: last, steals: countOrphanSteals(stderr) });
          } else reject(new Error(`crash-writer ended by itself (${String(status)}): ${stderr}`));
        });
      });
    }

    it('should accept a new write over a log that 200 SIGKILL runs left with no half batch visible and every resent key once', async () => {
      const { store, ref, dataDir, dir, records } = setup();
      const resent: string[] = [];
      const ahead: ChildProcess[] = [];
      let childSteals = 0;
      for (let run = 0; run < RUNS; run += 1) {
        while (ahead.length < PREFETCH && run + ahead.length < RUNS) {
          ahead.push(spawnWriter(dataDir, ref, run + ahead.length));
        }
        const { key, steals } = await killMidBatch(ahead.shift()!, run);
        childSteals += steals;
        // verificar o log inteiro a cada rodada custaria O(n²); o reenvio é amostrado
        if (run % RESEND_EVERY === 0) {
          await resend(store, ref, 10, key);
          resent.push(key);
        }
      }
      const raw = store.read(ref);
      const { lines } = parseLog(raw.text, anchor(raw.manifest));
      const sizes = new Set(lines.map(({ links }) => links.length));
      const keys = lines.map(({ links }) => links[0]?.batch?.key);
      const before = verifyProcess(raw);
      const parentSteals = records.filter(({ event }) => event === 'lock-orphan-removed').length;
      const steals = parentSteals + childSteals;

      await append(store, ref, 1, 'depois-da-falha');

      const after = verifyProcess(store.read(ref));

      expect(resent).toHaveLength(RUNS / RESEND_EVERY);
      expect(sizes).toEqual(new Set([10]));
      expect(resent.filter((key) => keys.filter((seen) => seen === key).length !== 1)).toEqual([]);
      expect(before.chain.ok).toBe(true);
      // sem ao menos um roubo, nenhum kill pegou um filho segurando o lock e o teste não provaria a recuperação
      expect(steals).toBeGreaterThanOrEqual(1);
      expect(after.chain).toMatchObject({
        ok: true,
        totalRecords: before.chain.totalRecords + 1,
      });
      expect(after.records.at(-1)?.seq).toBe(before.chain.totalRecords);

      process.stdout.write(
        `steals=${steals} (parent ${parentSteals}, children ${childSteals}) repairedLines=${before.chain.repairedLines.length}\n`,
      );
      // sem asserção: o kill pode deixar `.tmp-`, `.dead-` ou `.released-` e não há limpeza automática (`lock.ts`, `ponytail:`)
      process.stdout.write(`lock residues: ${JSON.stringify(locksIn(dir))}\n`);
    }, 240_000);
  });

  describe('with a log torn at every byte offset', () => {
    it('should show a 3-record batch cut at each byte only when just the newline is missing and keep the chain going', async () => {
      const { store, ref, manifest, logFile } = setup();
      const bytes = Buffer.from(batchLine(emptyRaw(manifest), 3, 'lote'));
      const problems: string[] = [];

      expect(bytes.length).toBeGreaterThan(1300);
      expect(bytes.length).toBeLessThan(2000);

      for (let cut = 0; cut < bytes.length; cut += 1) {
        const visible = cut === bytes.length - 1;
        fs.writeFileSync(logFile, bytes.subarray(0, cut));
        const seen = verifyProcess(store.read(ref));
        const outcome = await resend(store, ref, 3, 'lote');
        // a gravação seguinte a um lote visível é a única que ainda não aconteceu: o reenvio só deu fsync
        if (visible || cut % 25 === 0) await append(store, ref, 1, `depois-${cut}`);
        const done = verifyProcess(store.read(ref));

        const got = {
          okBefore: seen.chain.ok,
          visible: seen.records.length === 3 && seen.batches.has('lote'),
          invisible: seen.records.length === 0 && !seen.batches.has('lote'),
          outcome,
          okAfter: done.chain.ok,
          seqs: done.records.map(({ seq }) => seq),
        };
        const want = {
          okBefore: true,
          visible,
          invisible: !visible,
          outcome: visible ? 'replayed' : 'written',
          okAfter: true,
          seqs: visible || cut % 25 === 0 ? [0, 1, 2, 3] : [0, 1, 2],
        };
        if (JSON.stringify(got) !== JSON.stringify(want))
          problems.push(`${cut}: ${JSON.stringify(got)}`);
      }

      expect(problems).toEqual([]);
    }, 120_000);

    /** Lote de um registro com `ç` e `ã` no texto, em bytes, para cortar no meio do UTF-8. */
    const multibyteBatch = (ref: ProcessRef, manifest: Manifest) =>
      Buffer.from(
        chainLine(ref.process, verifyProcess(emptyRaw(manifest)).end, 1, {
          ...lineOptions,
          text: () => 'çã'.repeat(40),
          key: 'lote',
        }),
      );

    it('should show a multibyte batch cut at each byte, even mid-character, only when just the newline is missing', () => {
      const { store, ref, manifest, logFile } = setup();
      const bytes = multibyteBatch(ref, manifest);
      const problems: string[] = [];

      for (let cut = 0; cut < bytes.length; cut += 1) {
        fs.writeFileSync(logFile, bytes.subarray(0, cut));
        const { chain, records } = verifyProcess(store.read(ref));
        const got = { ok: chain.ok, records: records.length };
        const want = { ok: true, records: cut === bytes.length - 1 ? 1 : 0 };
        if (JSON.stringify(got) !== JSON.stringify(want))
          problems.push(`${cut}: ${JSON.stringify(got)}`);
      }

      expect(problems).toEqual([]);
    });

    it('should accept the next write after a cut past the first byte of a multibyte character and close the chain', async () => {
      const { store, ref, manifest, logFile } = setup();
      const bytes = multibyteBatch(ref, manifest);
      fs.writeFileSync(logFile, bytes.subarray(0, bytes.indexOf(0xc3) + 1));

      await append(store, ref, 1);

      expect(verifyProcess(store.read(ref)).chain).toMatchObject({
        ok: true,
        totalRecords: 1,
        repairedLines: [0],
      });
    });

    const torn = (line: string): string => line.slice(0, 40);

    const tornTails: [string, (line: string) => string, number, number[]][] = [
      ['a tear plus a tear', (a) => `${torn(a)}\n${torn(a)}`, 0, [0, 1]],
      ['a tear plus only a newline', (a) => `${torn(a)}\n`, 0, [0]],
      ['a tear plus a valid tail', (a) => `${torn(a)}\n${a.slice(0, -1)}`, 3, [0]],
    ];

    it.each(tornTails)(
      'should count the records still visible in a log with %s',
      (_name, rest, visible) => {
        const { store, ref, manifest, logFile } = setup();
        fs.writeFileSync(logFile, rest(batchLine(emptyRaw(manifest), 3, 'lote')));

        expect(verifyProcess(store.read(ref)).chain.totalRecords).toBe(visible);
      },
    );

    it.each(tornTails)(
      'should accept the next write and close the chain after %s',
      async (_name, rest, visible, repaired) => {
        const { store, ref, manifest, logFile } = setup();
        fs.writeFileSync(logFile, rest(batchLine(emptyRaw(manifest), 3, 'lote')));
        verifyProcess(store.read(ref));

        await append(store, ref, 1);

        const { chain } = verifyProcess(store.read(ref));

        expect(chain).toMatchObject({
          ok: true,
          totalRecords: visible + 1,
          repairedLines: repaired,
        });
      },
    );
  });

  describe('with short writes and ENOSPC', () => {
    it('should write on the third attempt with an intact chain after two short writes that end in ENOSPC', async () => {
      const { dataDir, store, ref, logFile } = setup();
      const line = batchLine(emptyRaw(emptyManifest(ref)), 3, 'lote');
      scriptWrites([100, 'enospc', 100, 'enospc'], dataDir);
      const failures: { error: HexlogError; chain: ReturnType<typeof verifyProcess>['chain'] }[] =
        [];
      for (let attempt = 0; attempt < 2; attempt += 1) {
        const error = await rejectionOf(append(store, ref, 3, 'lote'), dataDir);
        failures.push({ error, chain: verifyProcess(store.read(ref)).chain });
      }
      const tornLog = fs.readFileSync(logFile, 'utf8');

      await append(store, ref, 3, 'lote');

      for (const { error, chain } of failures) {
        expect(error).toMatchObject({
          code: 'IO_ERROR',
          details: [{ path: '', code: 'enospc', message: 'I/O failure' }],
        });
        expect(chain).toMatchObject({ ok: true, totalRecords: 0 });
      }

      expect(tornLog).toBe(`${line.slice(0, 100)}\n${line.slice(0, 99)}`);
      expect(verifyProcess(store.read(ref)).chain).toMatchObject({
        ok: true,
        totalRecords: 3,
        repairedLines: [0, 1],
      });
    });

    it('should write exactly the line from the right offset after a short write that continues successfully', async () => {
      const { dataDir, store, ref, manifest, logFile } = setup();
      const line = batchLine(emptyRaw(manifest), 3, 'lote');
      scriptWrites([100], dataDir);

      await append(store, ref, 3, 'lote');

      expect(fs.readFileSync(logFile, 'utf8')).toBe(line);
      expect(verifyProcess(store.read(ref)).chain).toMatchObject({ ok: true, totalRecords: 3 });
    });

    it('should close the chain on the next write after a short write over a torn tail', async () => {
      const { dataDir, store, ref, manifest, logFile } = setup();
      fs.writeFileSync(logFile, batchLine(emptyRaw(manifest), 3, 'lote').slice(0, 60));
      scriptWrites([50, 'enospc'], dataDir);
      await rejectionOf(append(store, ref, 3, 'lote'), dataDir);

      await append(store, ref, 3, 'lote');

      expect(verifyProcess(store.read(ref)).chain).toMatchObject({
        ok: true,
        totalRecords: 3,
        repairedLines: [0, 1],
      });
    });

    it('should return replayed with an fsync when a batch is resent after ENOSPC hit everything but the newline', async () => {
      const { dataDir, store, ref, logFile } = setup();
      scriptWrites([-1, 'enospc'], dataDir);
      const error = await rejectionOf(append(store, ref, 3, 'lote'), dataDir);
      const seen = verifyProcess(store.read(ref));
      const fsyncs = countLogFsyncs(logFile);

      const result = await resend(store, ref, 3, 'lote');

      expect(error.code).toBe('IO_ERROR');
      expect(seen.chain).toMatchObject({ ok: true, totalRecords: 3 });
      expect(seen.batches.has('lote')).toBe(true);
      expect(result).toBe('replayed');
      expect(fsyncs()).toBe(1);
    });

    it('should accept a new write after the replay of a batch that was already visible', async () => {
      const { dataDir, store, ref } = setup();
      scriptWrites([-1, 'enospc'], dataDir);
      await rejectionOf(append(store, ref, 3, 'lote'), dataDir);
      await resend(store, ref, 3, 'lote');

      await append(store, ref, 1);

      expect(verifyProcess(store.read(ref)).chain).toMatchObject({ ok: true, totalRecords: 4 });
    });
  });
});
