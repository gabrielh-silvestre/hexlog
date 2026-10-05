import { afterEach, describe, expect, jest, test } from '@jest/globals';
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
  expectNoLeak,
  rejectionOf,
  scriptWrites,
  spyOnWriteSync,
} from '../helpers.ts';
import { countFsyncs } from './fsync-spy.ts';
import { killChildren, liveForeignPid } from './lock-helpers.ts';

const CRASH_WRITER = path.join(__dirname, '..', 'fixtures', 'crash-writer.ts');
const BOOT = 'boot-a';

afterEach(() => {
  jest.restoreAllMocks();
  killChildren();
});

/** Erro cru do fs, como o `fs` o lança (`code` em maiúsculas, caminho absoluto na mensagem). */
const errno = (code: string): Error =>
  Object.assign(new Error(`${code}: /abs/secret/path`), { code });

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

/** Lote de `count` elos depois do fim do log lido em `raw`; com `key`, o primeiro leva `batch.key` (D-06). */
const batchLine = (raw: RawProcess, count: number, key?: string): string =>
  chainLine(raw.manifest.process, verifyProcess(raw).end, count, { ...lineOptions, key });

/** Grava um lote e devolve nada; a posição vem do log lido sob o lock. */
const append = (store: ProcessStore, ref: ProcessRef, count: number, key?: string) =>
  store.write(ref, (raw) => ({ line: batchLine(raw, count, key), result: undefined }));

/** Reenvio por `key` (D-06): `replayed` se o lote já está visível, senão grava o lote inteiro. */
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

describe('create, read e list', () => {
  test('create grava o manifesto, e uma segunda chamada devolve false sem tocá-lo', () => {
    const { store, ref, manifest, dir, manifestFile: file } = setup();
    const before = fs.readFileSync(file, 'utf8');

    expect(JSON.parse(before)).toEqual(manifest);
    expect(store.create(ref, { ...manifest, createdAt: '2027-01-01T00:00:00.000Z' })).toBe(false);
    expect(fs.readFileSync(file, 'utf8')).toBe(before);
    expect(fs.readdirSync(dir).sort()).toEqual([MANIFEST_FILE, LOG_FILE]);
  });

  test('create abre o log antes do manifesto e dá 1 fsync no diretório (D-25)', () => {
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

    expect(store.create(other, emptyManifest(other))).toBe(true);

    expect(fsyncs().directories).toBe(1);
    expect(
      opened.filter((name) => name === LOG_FILE || name.startsWith(`.${MANIFEST_FILE}.`)),
    ).toEqual([LOG_FILE, expect.stringContaining(`.${MANIFEST_FILE}.`)]);
  });

  test('create com erro que não é EEXIST dá IO_ERROR só com o errno (pai do processo é arquivo)', () => {
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

  test('read de um processo novo devolve log vazio terminado; com cauda rasgada, não terminado', async () => {
    const { store, ref, manifest, logFile } = setup();
    expect(store.read(ref)).toEqual({ manifest, text: '', endsWithNewline: true });

    await append(store, ref, 1);
    const line = fs.readFileSync(logFile, 'utf8');
    expect(store.read(ref)).toEqual({ manifest, text: line, endsWithNewline: true });

    fs.appendFileSync(logFile, '{"links":[{"seq"');
    expect(store.read(ref)).toMatchObject({
      text: `${line}{"links":[{"seq"`,
      endsWithNewline: false,
    });
  });

  test('read sem processo dá PROCESS_NOT_FOUND; sem records.jsonl lê como vazio', () => {
    const { store, ref, logFile } = setup();

    expect(() => store.read({ ...ref, process: 'outro' })).toThrow(
      expect.objectContaining({ code: 'PROCESS_NOT_FOUND' }),
    );
    fs.rmSync(logFile);
    expect(store.read(ref)).toMatchObject({ text: '', endsWithNewline: true });
  });

  test('readManifest sem processo dá PROCESS_NOT_FOUND; com manifesto ilegível, PROCESS_CORRUPTED', () => {
    const { store, ref, manifest, manifestFile } = setup();

    expect(store.readManifest(ref)).toEqual(manifest);
    expect(() => store.readManifest({ ...ref, process: 'outro' })).toThrow(
      expect.objectContaining({ code: 'PROCESS_NOT_FOUND' }),
    );
    fs.writeFileSync(manifestFile, 'isto nao e json');
    expect(() => store.readManifest(ref)).toThrow(
      expect.objectContaining({
        code: 'PROCESS_CORRUPTED',
        details: [expect.objectContaining({ code: 'unreadable-manifest' })],
      }),
    );
  });

  test.each([
    ['texto que não é JSON', 'isto nao e json'],
    ['JSON de forma errada', '{"project":"demo"}'],
    [
      'campo aninhado inválido (fixed.types.x = 1)',
      JSON.stringify({
        ...emptyManifest({ project: 'demo', process: 'proc-1' }),
        fixed: { types: { x: 1 }, relations: {}, gates: {} },
      }),
    ],
  ])('read de manifesto ilegível (%s) dá PROCESS_CORRUPTED sem caminho', (_name, content) => {
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
  });

  test('erro de I/O vira IO_ERROR só com o errno, sem caminho (manifesto que é diretório)', () => {
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

  describe('teto do log (N8)', () => {
    /** Log esparso do tamanho pedido: o teto se testa sem gravar 64 MiB de verdade. */
    const sparseLog = (logFile: string, size: number) => fs.truncateSync(logFile, size);

    /** Ler 64 MiB como string leva centenas de ms; sob carga o limite padrão de 5 s não basta. */
    const LARGE_LOG_TIMEOUT_MS = 30_000;

    test('readManifest com o log acima do teto devolve o manifesto sem ler o records.jsonl', () => {
      const { store, ref, manifest, logFile } = setup();
      sparseLog(logFile, MAX_LOG_BYTES + 1);
      const readFile = jest.spyOn(fs, 'readFileSync');

      expect(store.readManifest(ref)).toEqual(manifest);
      expect(readFile).not.toHaveBeenCalledWith(logFile, expect.anything());
    });

    test(
      'read de um log com exatamente 64 MiB ainda lê',
      () => {
        const { store, ref, logFile } = setup();
        sparseLog(logFile, MAX_LOG_BYTES);

        // `toHaveLength` imprimiria os 64 MiB na falha.
        expect(store.read(ref).text.length).toBe(MAX_LOG_BYTES);
      },
      LARGE_LOG_TIMEOUT_MS,
    );

    test('read de um log 1 byte acima do teto dá PROCESS_TOO_LARGE sem caminho e sem ler o conteúdo', () => {
      const { dataDir, store, ref, logFile } = setup();
      sparseLog(logFile, MAX_LOG_BYTES + 1);
      const readFile = jest.spyOn(fs, 'readFileSync');

      const error = captureError(() => store.read(ref));

      expect(error).toMatchObject({
        code: 'PROCESS_TOO_LARGE',
        details: [{ path: '/process', code: 'too-large', message: expect.any(String) }],
      });
      expectNoLeak(error, dataDir);
      expect(readFile).not.toHaveBeenCalledWith(logFile, expect.anything());
    });

    test('write sobre um log acima do teto recusa sem gravar e solta o lock', async () => {
      const { dataDir, store, ref, logFile, dir } = setup();
      sparseLog(logFile, MAX_LOG_BYTES + 1);
      const decide = jest.fn(() => ({ result: undefined }));

      const error = await rejectionOf(store.write(ref, decide), dataDir);

      expect(error.code).toBe('PROCESS_TOO_LARGE');
      expect(decide).not.toHaveBeenCalled();
      expect(fs.statSync(logFile).size).toBe(MAX_LOG_BYTES + 1);
      expect(locksIn(dir)).toEqual([]);
    });

    /** Prefixo `\n` (o log esparso termina em byte nulo) mais a linha: o lote tem `LINE.length + 1` bytes. */
    const LINE = 'x'.repeat(100);

    test(
      'write de um lote que fecha o log em exatamente 64 MiB grava e o processo segue legível',
      async () => {
        const { store, ref, logFile } = setup();
        sparseLog(logFile, MAX_LOG_BYTES - LINE.length - 1);

        await store.write(ref, () => ({ line: LINE, result: undefined }));

        expect(fs.statSync(logFile).size).toBe(MAX_LOG_BYTES);
        expect(store.read(ref).text.length).toBe(MAX_LOG_BYTES);
      },
      LARGE_LOG_TIMEOUT_MS,
    );

    test(
      'write sem line (replay) sobre um log em exatamente 64 MiB devolve o resultado sem gravar',
      async () => {
        const { store, ref, logFile, dir } = setup();
        sparseLog(logFile, MAX_LOG_BYTES);

        await expect(store.write(ref, () => ({ result: 'replayed' }))).resolves.toBe('replayed');

        expect(fs.statSync(logFile).size).toBe(MAX_LOG_BYTES);
        expect(locksIn(dir)).toEqual([]);
      },
      LARGE_LOG_TIMEOUT_MS,
    );

    test(
      'write de um lote que passaria 1 byte do teto recusa, não cresce o arquivo, solta o lock e o read segue',
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

    test('o teto conta bytes, não caracteres: lote com ç e ã que só cabe contado em caracteres é recusado', async () => {
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

    test('lote com ç e ã que fecha o log em exatamente 64 MiB em bytes grava', async () => {
      const { store, ref, logFile } = setup();
      sparseLog(logFile, MAX_LOG_BYTES - 101);

      await store.write(ref, () => ({ line: MULTIBYTE, result: undefined }));

      expect(fs.statSync(logFile).size).toBe(MAX_LOG_BYTES);
      expect(fs.readFileSync(logFile, 'utf8').endsWith(MULTIBYTE)).toBe(true);
    });
  });

  test('list e listProjects ordenam e ignoram pastas sem manifesto; ausentes dão lista vazia', () => {
    const { dataDir, store, ref, manifest } = setup();
    expect(
      createProcessStore({ dataDir: createTempDir('vazio'), log: () => undefined }).listProjects(),
    ).toEqual([]);
    expect(store.list('ausente')).toEqual([]);

    store.create({ project: 'demo', process: 'alpha' }, { ...manifest, process: 'alpha' });
    store.create(
      { project: 'abc', process: 'zeta' },
      { ...manifest, project: 'abc', process: 'zeta' },
    );
    fs.mkdirSync(path.join(dataRoot(dataDir), 'demo', 'types'));
    fs.mkdirSync(path.join(dataRoot(dataDir), 'demo', ATTACHMENTS_DIR));

    expect(store.list('demo')).toEqual(['alpha', ref.process]);
    expect(store.listProjects()).toEqual(['abc', 'demo']);
  });

  test('list e listProjects com erro de I/O que não é ENOENT dão IO_ERROR só com o errno (diretório que é arquivo)', () => {
    const { dataDir, store } = setup();
    fs.writeFileSync(path.join(dataRoot(dataDir), 'blocked'), '');
    const flatDir = createTempDir('process-store-flat');
    fs.writeFileSync(dataRoot(flatDir), '');
    const flat = createProcessStore({ dataDir: flatDir, log: () => undefined });
    const ioError = expect.objectContaining({
      code: 'IO_ERROR',
      details: [{ path: '', code: 'enotdir', message: 'I/O failure' }],
    });

    expect(() => store.list('blocked')).toThrow(ioError);
    expect(() => flat.listProjects()).toThrow(ioError);
  });

  describe('só ENOENT vale "processo ausente" (M11)', () => {
    /** O `stat` do manifesto falha com `EACCES`, como numa pasta sem permissão de busca. */
    function denyManifestStat(): void {
      const realStat = fs.statSync;
      jest.spyOn(fs, 'statSync').mockImplementation((...args: Parameters<typeof fs.statSync>) => {
        if (String(args[0]).endsWith(MANIFEST_FILE)) throw errno('EACCES');
        return realStat(...args);
      });
    }

    test('list não omite em silêncio o processo cujo manifesto dá EACCES: dá IO_ERROR', () => {
      const { store, ref } = setup();
      denyManifestStat();

      expect(() => store.list(ref.project)).toThrow(
        expect.objectContaining({
          code: 'IO_ERROR',
          details: [{ path: '', code: 'eacces', message: 'I/O failure' }],
        }),
      );
    });

    test('write com o manifesto em EACCES dá IO_ERROR, não PROCESS_NOT_FOUND, e não chama decide', async () => {
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

  test('list e listProjects não devolvem pastas criadas à mão com nome inválido', () => {
    const { dataDir, store, ref, manifest } = setup();
    for (const name of ['.tmp', 'a.b', 'Bad Name']) {
      // com manifesto dentro, só o filtro de nome as tira de `list`
      const stray = path.join(dataRoot(dataDir), ref.project, name);
      fs.mkdirSync(stray);
      fs.writeFileSync(path.join(stray, MANIFEST_FILE), JSON.stringify(manifest));
      fs.mkdirSync(path.join(dataRoot(dataDir), name));
    }

    expect(store.list(ref.project)).toEqual([ref.process]);
    expect(store.listProjects()).toEqual([ref.project]);
  });
});

// Fixa o comportamento atual, não uma proteção: `<D>` é confiável (ADR 0009, item 9) e o store não
// recusa symlink. Se o endurecimento de `io.ts#readIfPresent` entrar, este teste vira recusa.
describe('records.jsonl que é symlink (decisão do #63 M12)', () => {
  test('o store lê e grava pelo destino do link, que segue um symlink', async () => {
    const { store, ref, logFile } = setup();
    const target = path.join(createTempDir('process-store-target'), 'real.jsonl');
    fs.renameSync(logFile, target);
    fs.symlinkSync(target, logFile);

    await append(store, ref, 1);

    expect(fs.lstatSync(logFile).isSymbolicLink()).toBe(true);
    expect(fs.readFileSync(target, 'utf8')).not.toBe('');
    expect(store.read(ref).text).toBe(fs.readFileSync(target, 'utf8'));
  });
});

describe('nomes e manifesto recusados antes de qualquer I/O (N1, N3)', () => {
  test.each([
    ['process com ../', { project: 'demo', process: '../../escaped' }],
    ['project ..', { project: '..', process: 'proc-1' }],
    ['process com espaço e maiúscula', { project: 'demo', process: 'Bad Name' }],
    ['project com espaço e maiúscula', { project: 'Bad Name', process: 'proc-1' }],
  ])(
    'create, read e write com %s dão INVALID_INPUT e nada nasce fora de .v1',
    async (_name, bad) => {
      const { dataDir, store, ref } = setup();
      const invalid = expect.objectContaining({ code: 'INVALID_INPUT' });

      expect(() => store.create(bad, emptyManifest(bad))).toThrow(invalid);
      expect(() => store.read(bad)).toThrow(invalid);
      await expect(append(store, bad, 1)).rejects.toEqual(invalid);

      expect(fs.readdirSync(dataDir)).toEqual([path.basename(dataRoot(dataDir))]);
      expect(fs.readdirSync(dataRoot(dataDir))).toEqual([ref.project]);
      expect(fs.readdirSync(path.join(dataRoot(dataDir), ref.project))).toEqual([ref.process]);
    },
  );

  test.each([
    ['..', '..'],
    ['com espaço e maiúscula', 'Bad Name'],
  ])('list com project %s dá INVALID_INPUT sem listar fora de .v1', (_name, project) => {
    const { store } = setup();

    expect(() => store.list(project)).toThrow(expect.objectContaining({ code: 'INVALID_INPUT' }));
  });

  test('create com nome reservado de processo dá RESERVED_NAME e não cria a pasta', () => {
    const { dataDir, store } = setup();
    const reserved: ProcessRef = { project: 'demo', process: ATTACHMENTS_DIR };

    expect(() => store.create(reserved, emptyManifest(reserved))).toThrow(
      expect.objectContaining({ code: 'RESERVED_NAME' }),
    );
    expect(fs.existsSync(path.join(dataRoot(dataDir), 'demo', ATTACHMENTS_DIR))).toBe(false);
  });

  test.each([
    ['process', { process: 'outro' }],
    ['project', { project: 'outro' }],
  ])('create com manifest.%s diferente do ref lança e não cria diretório', (_field, override) => {
    const { dataDir, store, ref } = setup();
    const other: ProcessRef = { project: ref.project, process: 'proc-2' };

    expect(() => store.create(other, { ...emptyManifest(other), ...override })).toThrow(
      expect.objectContaining({ code: 'INTERNAL' }),
    );

    expect(fs.readdirSync(dataRoot(dataDir))).toEqual([ref.project]);
    expect(fs.readdirSync(path.join(dataRoot(dataDir), ref.project))).toEqual([ref.process]);
  });
});

describe('write', () => {
  test('grava a linha devolvida por decide e devolve o result; decide recebe o log cru', async () => {
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

  test('prefixa \\n quando o log termina numa cauda rasgada', async () => {
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

  test('processo inexistente dá PROCESS_NOT_FOUND e não cria nada', async () => {
    const { dataDir, store, ref } = setup();
    const missing = { ...ref, process: 'outro' };

    const error = await rejectionOf(append(store, missing, 1), dataDir);

    expect(error.code).toBe('PROCESS_NOT_FOUND');
    expect(fs.existsSync(path.join(dataRoot(dataDir), ref.project, 'outro'))).toBe(false);
  });

  test('8 escritas concorrentes no mesmo processo serializam: cadeia íntegra e seq contíguo', async () => {
    const { store, ref, dir } = setup();

    await Promise.all(Array.from({ length: 8 }, (_, n) => append(store, ref, 1, `k${n}`)));

    const { chain, records } = verifyProcess(store.read(ref));
    expect(chain.ok).toBe(true);
    expect(records.map(({ seq }) => seq)).toEqual([0, 1, 2, 3, 4, 5, 6, 7]);
    expect(locksIn(dir)).toEqual([]);
  }, 30_000);
});

describe('sem linha gravada (SE3c)', () => {
  test('erro de regra em decide sai inalterado, sem linha e com o lock solto', async () => {
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

  test('token perdido antes do write dá lock-lost, sem linha, e o órfão do próprio processo é tomado depois', async () => {
    const { dataDir, store, ref, logFile, lockDir } = setup();
    const line = batchLine(emptyRaw(emptyManifest(ref)), 1);

    const error = await rejectionOf(
      store.write(ref, () => {
        // outro dono toma o lock entre a aquisição e a conferência do token
        fs.writeFileSync(
          path.join(lockDir, 'holder'),
          JSON.stringify({ pid: process.pid, token: 'outro', bootId: BOOT }),
        );
        return { line, result: undefined };
      }),
      dataDir,
    );

    expect(error).toMatchObject({
      code: 'LOCK_TIMEOUT',
      details: [{ path: '/process', code: 'lock-lost', message: expect.any(String) }],
    });
    expect(fs.readFileSync(logFile, 'utf8')).toBe('');

    await append(store, ref, 1);
    expect(verifyProcess(store.read(ref)).chain).toMatchObject({ ok: true, totalRecords: 1 });
  });

  test('lock-busy de dono vivo não chama decide e não deixa linha', async () => {
    const { dataDir, ref, logFile, lockDir } = setup();
    const store = createProcessStore({ dataDir, log: () => undefined, bootId: BOOT, budgetMs: 50 });
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

describe('fsync por lote (TF5, D-05)', () => {
  test('lote de 50 dá 1 fsync no log, e o replay sem linha também dá 1', async () => {
    const { store, ref, logFile } = setup();
    const fsyncs = countLogFsyncs(logFile);

    await append(store, ref, 50, 'k50');
    expect(fsyncs()).toBe(1);

    await store.write(ref, () => ({ result: undefined }));
    expect(fsyncs()).toBe(2);
    expect(verifyProcess(store.read(ref)).chain.totalRecords).toBe(50);
  });

  test('o fsync do log vem depois da escrita; o replay sem linha só dá fsync', async () => {
    const { store, ref, logFile } = setup();
    const calls = recordLogCalls(logFile);

    await append(store, ref, 3, 'lote');
    expect(calls).toEqual(['write', 'fsync']);

    calls.length = 0;
    await store.write(ref, () => ({ result: undefined }));
    expect(calls).toEqual(['fsync']);
  });
});

describe('kill -9 no meio do lote (TF1, SE3b)', () => {
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

  test('200 execuções mortas com SIGKILL sobre o mesmo log: nenhum meio lote visível, reenvio por key e gravação nova entra', async () => {
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
    expect(resent).toHaveLength(RUNS / RESEND_EVERY);
    expect(sizes).toEqual(new Set([10]));
    expect(resent.filter((key) => keys.filter((seen) => seen === key).length !== 1)).toEqual([]);

    const before = verifyProcess(raw);
    expect(before.chain.ok).toBe(true);
    const parentSteals = records.filter(({ event }) => event === 'lock-orphan-removed').length;
    const steals = parentSteals + childSteals;
    process.stdout.write(
      `steals=${steals} (parent ${parentSteals}, children ${childSteals}) repairedLines=${before.chain.repairedLines.length}\n`,
    );
    // sem ao menos um roubo, nenhum kill pegou um filho segurando o lock e o teste não provaria a recuperação
    expect(steals).toBeGreaterThanOrEqual(1);
    await append(store, ref, 1, 'depois-da-falha');
    const after = verifyProcess(store.read(ref));
    expect(after.chain).toMatchObject({ ok: true, totalRecords: before.chain.totalRecords + 1 });
    expect(after.records.at(-1)?.seq).toBe(before.chain.totalRecords);
    // sem asserção: o kill pode deixar `.tmp-`, `.dead-` ou `.released-` e não há limpeza automática (`lock.ts`, `ponytail:`)
    process.stdout.write(`lock residues: ${JSON.stringify(locksIn(dir))}\n`);
  }, 240_000);
});

describe('truncamento em cada offset e falhas consecutivas (rasgo, P1)', () => {
  test('lote de 3 registros cortado em cada byte: só o corte sem o \\n deixa o lote visível, e a cadeia segue', async () => {
    const { store, ref, manifest, logFile } = setup();
    const bytes = Buffer.from(batchLine(emptyRaw(manifest), 3, 'lote'));
    expect(bytes.length).toBeGreaterThan(1300);
    expect(bytes.length).toBeLessThan(2000);
    const problems: string[] = [];

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

  test('lote com ç e ã cortado em cada byte, inclusive no meio do UTF-8: só o corte sem o \\n deixa o lote visível', async () => {
    const { store, ref, manifest, logFile } = setup();
    const bytes = Buffer.from(
      chainLine(ref.process, verifyProcess(emptyRaw(manifest)).end, 1, {
        ...lineOptions,
        text: () => 'çã'.repeat(40),
        key: 'lote',
      }),
    );
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

    // a gravação seguinte a um corte depois do primeiro byte de um `ç` entra e fecha a cadeia
    fs.writeFileSync(logFile, bytes.subarray(0, bytes.indexOf(0xc3) + 1));
    await append(store, ref, 1);
    expect(verifyProcess(store.read(ref)).chain).toMatchObject({
      ok: true,
      totalRecords: 1,
      repairedLines: [0],
    });
  });

  describe('falhas consecutivas a partir de um resto rasgado', () => {
    const torn = (line: string): string => line.slice(0, 40);

    test.each([
      ['rasgo + rasgo', (a: string) => `${torn(a)}\n${torn(a)}`, [0, 1], 0],
      ['rasgo + só \\n', (a: string) => `${torn(a)}\n`, [0], 0],
      ['rasgo + cauda válida', (a: string) => `${torn(a)}\n${a.slice(0, -1)}`, [0], 3],
    ])('%s: a gravação seguinte entra e a cadeia fecha', async (_name, rest, repaired, visible) => {
      const { store, ref, manifest, logFile } = setup();
      fs.writeFileSync(logFile, rest(batchLine(emptyRaw(manifest), 3, 'lote')));
      expect(verifyProcess(store.read(ref)).chain.totalRecords).toBe(visible);

      await append(store, ref, 1);

      const { chain } = verifyProcess(store.read(ref));
      expect(chain).toMatchObject({ ok: true, totalRecords: visible + 1, repairedLines: repaired });
    });
  });
});

describe('escrita curta (P9)', () => {
  test('escrita curta e depois ENOSPC dá IO_ERROR sem caminho; duas seguidas e a terceira grava com a cadeia íntegra', async () => {
    const { dataDir, store, ref, logFile } = setup();
    const line = batchLine(emptyRaw(emptyManifest(ref)), 3, 'lote');

    scriptWrites([100, 'enospc', 100, 'enospc'], dataDir);
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const error = await rejectionOf(append(store, ref, 3, 'lote'), dataDir);
      expect(error).toMatchObject({
        code: 'IO_ERROR',
        details: [{ path: '', code: 'enospc', message: 'I/O failure' }],
      });
      expect(verifyProcess(store.read(ref)).chain).toMatchObject({ ok: true, totalRecords: 0 });
    }
    expect(fs.readFileSync(logFile, 'utf8')).toBe(`${line.slice(0, 100)}\n${line.slice(0, 99)}`);

    await append(store, ref, 3, 'lote');

    expect(verifyProcess(store.read(ref)).chain).toMatchObject({
      ok: true,
      totalRecords: 3,
      repairedLines: [0, 1],
    });
  });

  test('escrita curta e continuação com sucesso: o log recebe exatamente a linha, a partir do offset certo', async () => {
    const { dataDir, store, ref, manifest, logFile } = setup();
    const line = batchLine(emptyRaw(manifest), 3, 'lote');
    scriptWrites([100], dataDir);

    await append(store, ref, 3, 'lote');

    expect(fs.readFileSync(logFile, 'utf8')).toBe(line);
    expect(verifyProcess(store.read(ref)).chain).toMatchObject({ ok: true, totalRecords: 3 });
  });

  test('rasgo + escrita curta: sobre uma cauda rasgada, a falha e a gravação seguinte fecham a cadeia', async () => {
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

  test('tudo menos o \\n e depois ENOSPC dá IO_ERROR, o lote fica visível e o reenvio devolve replayed com fsync', async () => {
    const { dataDir, store, ref, logFile } = setup();
    scriptWrites([-1, 'enospc'], dataDir);

    const error = await rejectionOf(append(store, ref, 3, 'lote'), dataDir);

    expect(error.code).toBe('IO_ERROR');
    const seen = verifyProcess(store.read(ref));
    expect(seen.chain).toMatchObject({ ok: true, totalRecords: 3 });
    expect(seen.batches.has('lote')).toBe(true);
    const fsyncs = countLogFsyncs(logFile);

    await expect(resend(store, ref, 3, 'lote')).resolves.toBe('replayed');

    expect(fsyncs()).toBe(1);
    await append(store, ref, 1);
    expect(verifyProcess(store.read(ref)).chain).toMatchObject({ ok: true, totalRecords: 4 });
  });
});
