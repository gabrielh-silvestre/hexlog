import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';
import { execFileSync } from 'node:child_process';
// Import padrão (não `* as fs`): o spy de `openSync`/`fstatSync`/`readSync` só intercepta o mesmo
// objeto que `attachment-store.ts` usa (P9).
import fs from 'node:fs';
import * as path from 'node:path';
import {
  ATTACHMENT_MAX_BYTES,
  createAttachmentStore,
} from '../../src/adapters/fs/attachment-store.ts';
import {
  attachmentsDir as attachmentsDirOf,
  blobFile,
  dataRoot,
} from '../../src/adapters/fs/data-format.ts';
import { sha256hex } from '../../src/domain/chain.ts';
import type { AttachmentPut, AttachmentStore } from '../../src/ports.ts';
import type { AttachmentProbeArgs } from '../fixtures/fixture-args.ts';
import { captureError, createTempDir, expectNoLeak } from '../helpers.ts';
import { countFsyncs } from './fsync-spy.ts';

const PROBE = path.join(__dirname, '..', 'fixtures', 'attachment-probe.ts');
const PROJECT = 'alpha';
const PLAN = '.omc/plans/x.md';
// mtime inteiro em segundos: `utimes` com sub-milissegundo perderia precisão e o teste não reproduziria o mtime.
const FIXED_TIME = new Date('2026-01-01T00:00:00.000Z');

let base: string;
let dataDir: string;
let cwd: string;
let outside: string;
let store: AttachmentStore;

function attachmentsDir(root = dataDir): string {
  return attachmentsDirOf(root, PROJECT);
}

function blobPath(hash: string, root = dataDir): string {
  return blobFile(root, PROJECT, hash);
}

function writeInCwd(relative: string, content: string | Buffer): string {
  const file = path.join(cwd, relative);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
  return file;
}

/** Erro de I/O como o do fs: `code` de errno e uma mensagem com o caminho absoluto. */
function fsError(code: string, file: string): Error {
  return Object.assign(new Error(`${code}: boom, open '${file}'`), { code });
}

/**
 * Roda `args.call` do `AttachmentStore` num filho: um `open` que travasse num FIFO estoura o
 * `timeout` (o filho é morto e o `execFileSync` lança) em vez de congelar a thread do jest.
 */
function probe(call: { call: 'status'; hash: string } | { call: 'putPath'; path: string }) {
  const args: AttachmentProbeArgs = { dataDir, cwd, project: PROJECT, ...call };
  const stdout = execFileSync(process.execPath, [PROBE, JSON.stringify(args)], {
    encoding: 'utf8',
    timeout: 10_000,
  });
  return JSON.parse(stdout) as { result?: string; error?: { code: string; details: unknown[] } };
}

/** O `fstat` passa a declarar `size` bytes, como um arquivo que cresceu depois dele. */
function understateSize(size: number): void {
  const realFstat = fs.fstatSync.bind(fs);
  jest.spyOn(fs, 'fstatSync').mockImplementation(((fd: number) =>
    Object.assign(Object.create(realFstat(fd) as object) as object, {
      size,
    })) as unknown as typeof fs.fstatSync);
}

/**
 * Repõe `FIXED_TIME` até o ctime sair de `previousCtimeMs`: o ctime só avança quando o relógio do
 * kernel (granularidade de alguns ms) avançou, então um único `utimes` pode deixá-lo igual. Teto de 2 s.
 */
function restoreTimesUntilCtimeChanges(file: string, previousCtimeMs: number): void {
  const deadline = Date.now() + 2_000;
  do {
    fs.utimesSync(file, FIXED_TIME, FIXED_TIME);
  } while (fs.statSync(file).ctimeMs === previousCtimeMs && Date.now() < deadline);
}

/** O `INVALID_INPUT` esperado: um único `detail` em `pointer`, de `code` kebab-case. */
function invalid(pointer: string, code: string) {
  return {
    code: 'INVALID_INPUT',
    details: [{ path: pointer, code, message: expect.any(String) }],
  };
}

/** A recusa não gravou nada: a pasta de anexos do projeto nem chegou a ser criada. */
function expectNothingStored(): void {
  expect(fs.existsSync(attachmentsDir())).toBe(false);
}

const SAMPLES: [string, string][] = [
  ['pt-BR', 'Decisão: não há ação — coração\n'],
  ['emoji', 'ok 😀 e 🚀 fim'],
  ['CRLF', 'linha 1\r\nlinha 2\r\n'],
  ['BOM', '\uFEFFcom BOM'],
  ['NUL', 'antes\u0000depois'],
];

describe('createAttachmentStore', () => {
  beforeEach(() => {
    base = createTempDir('attachment-store');
    dataDir = path.join(base, 'data');
    cwd = path.join(base, 'cwd');
    outside = path.join(base, 'outside');
    fs.mkdirSync(path.join(cwd, '.omc', 'plans'), { recursive: true });
    fs.mkdirSync(outside);
    store = createAttachmentStore({ dataDir, cwd });
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it.each(SAMPLES)(
    'should store the exact bytes and hash and round-trip the text identically for %s',
    (_name, text) => {
      const result = store.putText(PROJECT, text);

      expect(result).toEqual({
        hash: sha256hex(Buffer.from(text, 'utf8')),
        bytes: Buffer.byteLength(text),
        deduplicated: false,
      });
      expect(fs.readFileSync(blobPath(result.hash))).toEqual(Buffer.from(text, 'utf8'));
      expect(store.read(PROJECT, result.hash)).toBe(text);
    },
  );

  it('should write the blob with mode 0o600 and the folder with 0o700, leaving no temporary file', () => {
    const { hash } = store.putText(PROJECT, 'modo');

    expect(fs.statSync(blobPath(hash)).mode & 0o777).toBe(0o600);
    expect(fs.statSync(attachmentsDir()).mode & 0o777).toBe(0o700);
    expect(fs.readdirSync(attachmentsDir())).toEqual([hash]);
  });

  it('should give the same hash and leave the blob untouched when putText gets the same text again (dedupe)', () => {
    const first = store.putText(PROJECT, 'igual');
    fs.utimesSync(blobPath(first.hash), FIXED_TIME, FIXED_TIME);
    const before = fs.statSync(blobPath(first.hash));

    const second = store.putText(PROJECT, 'igual');
    const after = fs.statSync(blobPath(first.hash));

    expect(first.deduplicated).toBe(false);
    expect(second).toEqual({ ...first, deduplicated: true });
    expect(fs.readdirSync(attachmentsDir())).toEqual([first.hash]);
    expect([after.ino, after.mtimeMs]).toEqual([before.ino, before.mtimeMs]);
  });

  it('should refuse with ATTACHMENT_CORRUPTED, without overwriting, when putText gets the same text over a tampered blob', () => {
    const { hash } = store.putText(PROJECT, 'original');
    fs.writeFileSync(blobPath(hash), 'adulterado');

    expect(captureError(() => store.putText(PROJECT, 'original')).code).toBe(
      'ATTACHMENT_CORRUPTED',
    );
    expect(fs.readFileSync(blobPath(hash), 'utf8')).toBe('adulterado');
    expect(fs.readdirSync(attachmentsDir())).toEqual([hash]);
  });

  it('should accept a text up to the ceiling counted in bytes, not in characters', () => {
    const atCeiling = 'a'.repeat(ATTACHMENT_MAX_BYTES);

    expect(store.putText(PROJECT, atCeiling).bytes).toBe(ATTACHMENT_MAX_BYTES);
    // 2 bytes por caractere: metade do teto em caracteres cabe, exatamente, em bytes
    expect(store.putText(PROJECT, 'ã'.repeat(ATTACHMENT_MAX_BYTES / 2)).bytes).toBe(
      ATTACHMENT_MAX_BYTES,
    );
  });

  it('should refuse with too-big a text above the ceiling counted in bytes, not in characters', () => {
    const atCeiling = 'a'.repeat(ATTACHMENT_MAX_BYTES);

    expect(captureError(() => store.putText(PROJECT, `${atCeiling}a`))).toMatchObject(
      invalid('/text', 'too-big'),
    );
    // metade do teto em caracteres, mas acima dele em bytes
    expect(
      captureError(() => store.putText(PROJECT, 'ã'.repeat(ATTACHMENT_MAX_BYTES / 2 + 1))),
    ).toMatchObject(invalid('/text', 'too-big'));
  });

  it('should refuse an invalid project name in putText before reaching the disk', () => {
    expect(captureError(() => store.putText('../fora', 'x'))).toMatchObject(
      invalid('/project', 'invalid-name'),
    );
    expect(fs.existsSync(dataDir)).toBe(false);
  });

  it('should refuse an invalid hash in status before reaching the disk', () => {
    expect(captureError(() => store.status(PROJECT, '../x'))).toMatchObject(
      invalid('/hash', 'invalid-hash'),
    );
    expect(fs.existsSync(dataDir)).toBe(false);
  });

  it('should refuse an invalid hash in read before reaching the disk', () => {
    expect(captureError(() => store.read(PROJECT, 'A'.repeat(64)))).toMatchObject(
      invalid('/hash', 'invalid-hash'),
    );
    expect(fs.existsSync(dataDir)).toBe(false);
  });

  it('should fsync the file and the directory after the link', () => {
    const fsyncs = countFsyncs();

    store.putText(PROJECT, 'durável');

    expect(fsyncs()).toEqual({ files: 1, directories: 1 });
  });

  it('should not fsync on a deduplicated put', () => {
    const fsyncs = countFsyncs();
    store.putText(PROJECT, 'durável');

    // o `lstat` acha o blob antes de criar o temporário, então não há o que sincronizar
    const result = store.putText(PROJECT, 'durável');

    expect(result.deduplicated).toBe(true);
    expect(fsyncs()).toEqual({ files: 1, directories: 1 });
  });

  it('should only open the blob, to reread it, on a deduplicated put, creating no temporary file', () => {
    const { hash } = store.putText(PROJECT, 'repetido');
    const opens = jest.spyOn(fs, 'openSync');

    const result = store.putText(PROJECT, 'repetido');

    expect(result.deduplicated).toBe(true);
    expect(opens).toHaveBeenCalledTimes(1);
    expect(opens).toHaveBeenCalledWith(blobPath(hash), expect.anything());
    expect(fs.readdirSync(attachmentsDir())).toEqual([hash]);
  });

  it.each(['mkdirSync', 'openSync', 'writeFileSync', 'fsyncSync'] as const)(
    'should turn a %s error on write into IO_ERROR with only the errno and no absolute path',
    (method) => {
      (jest.spyOn(fs, method) as jest.Mock).mockImplementation(() => {
        throw fsError('EIO', attachmentsDir());
      });

      const error = captureError(() => store.putText(PROJECT, 'io'));

      expect(error.code).toBe('IO_ERROR');
      expect(error.details).toEqual([{ path: '', code: 'eio', message: 'I/O failure' }]);

      expectNoLeak(error, base);
    },
  );

  it('should leave a single new put when a rival writes the same text between the temporary file and the link', () => {
    const rival = createAttachmentStore({ dataDir, cwd });
    const realLink = fs.linkSync.bind(fs);
    let rivalResult: AttachmentPut | undefined;
    jest.spyOn(fs, 'linkSync').mockImplementationOnce((existing, target) => {
      rivalResult = rival.putText(PROJECT, 'corrida');
      realLink(existing, target);
    });

    const result = store.putText(PROJECT, 'corrida');

    expect(rivalResult?.deduplicated).toBe(false);
    expect(result).toEqual({ ...rivalResult, deduplicated: true });
    expect(fs.readdirSync(attachmentsDir())).toEqual([result.hash]);
    expect(store.read(PROJECT, result.hash)).toBe('corrida');
  });

  it('should refuse with ATTACHMENT_CORRUPTED when the link hits EEXIST but the blob vanished before the reread', () => {
    jest.spyOn(fs, 'linkSync').mockImplementationOnce(() => {
      throw fsError('EEXIST', attachmentsDir());
    });

    expect(captureError(() => store.putText(PROJECT, 'sumiu')).code).toBe('ATTACHMENT_CORRUPTED');
    // nada publicado e o temporário foi removido
    expect(fs.readdirSync(attachmentsDir())).toEqual([]);
  });

  it('should return ok from status for an intact blob', () => {
    const { hash } = store.putText(PROJECT, 'conteúdo');

    expect(store.status(PROJECT, hash)).toBe('ok');
  });

  it('should return missing from status for an absent blob', () => {
    const absent = 'b'.repeat(64);

    expect(store.status(PROJECT, absent)).toBe('missing');
  });

  it('should refuse read of an absent blob with ATTACHMENT_NOT_FOUND', () => {
    const absent = 'b'.repeat(64);

    expect(captureError(() => store.read(PROJECT, absent))).toMatchObject({
      code: 'ATTACHMENT_NOT_FOUND',
      details: [{ path: '/hash', code: 'not-found', message: expect.any(String) }],
    });
  });

  it('should return corrupted from status for a tampered blob', () => {
    const { hash } = store.putText(PROJECT, 'conteúdo');
    fs.writeFileSync(blobPath(hash), 'conteúdA');

    expect(store.status(PROJECT, hash)).toBe('corrupted');
  });

  it('should refuse read of a tampered blob with ATTACHMENT_CORRUPTED', () => {
    const { hash } = store.putText(PROJECT, 'conteúdo');
    fs.writeFileSync(blobPath(hash), 'conteúdA');

    expect(captureError(() => store.read(PROJECT, hash))).toMatchObject({
      code: 'ATTACHMENT_CORRUPTED',
      details: [{ path: '/hash', code: 'corrupted', message: expect.any(String) }],
    });
  });

  it('should refuse read with ATTACHMENT_CORRUPTED for intact bytes that are not UTF-8', () => {
    const bytes = Buffer.from([0x61, 0xff, 0xfe]);
    const hash = sha256hex(bytes);
    fs.mkdirSync(attachmentsDir(), { recursive: true });
    fs.writeFileSync(blobPath(hash), bytes);

    expect(captureError(() => store.read(PROJECT, hash)).code).toBe('ATTACHMENT_CORRUPTED');
  });

  it('should return corrupted from status for a symlink with the right content', () => {
    const hash = sha256hex('conteudo');
    fs.mkdirSync(attachmentsDir(), { recursive: true });
    fs.writeFileSync(path.join(outside, 'alvo'), 'conteudo');
    fs.symlinkSync(path.join(outside, 'alvo'), blobPath(hash));

    expect(store.status(PROJECT, hash)).toBe('corrupted');
  });

  it('should refuse read of a symlink with the right content with ATTACHMENT_CORRUPTED', () => {
    const hash = sha256hex('conteudo');
    fs.mkdirSync(attachmentsDir(), { recursive: true });
    fs.writeFileSync(path.join(outside, 'alvo'), 'conteudo');
    fs.symlinkSync(path.join(outside, 'alvo'), blobPath(hash));

    expect(captureError(() => store.read(PROJECT, hash)).code).toBe('ATTACHMENT_CORRUPTED');
  });

  it('should return corrupted from status, without hanging, for a FIFO in place of the blob', () => {
    const fifo = sha256hex('fifo');
    fs.mkdirSync(attachmentsDir(), { recursive: true });
    execFileSync('mkfifo', [blobPath(fifo)]);

    expect(probe({ call: 'status', hash: fifo })).toEqual({ result: 'corrupted' });
  });

  it.each([
    ['a directory', 'diretório', (file: string) => fs.mkdirSync(file)],
    [
      'a file above 1 MiB',
      'grande',
      (file: string) => fs.writeFileSync(file, Buffer.alloc(ATTACHMENT_MAX_BYTES + 1, 0x61)),
    ],
  ])(
    'should return corrupted from status, without hanging, for %s in place of the blob',
    (_name, seed, occupy) => {
      const hash = sha256hex(seed);
      fs.mkdirSync(attachmentsDir(), { recursive: true });
      occupy(blobPath(hash));

      expect(store.status(PROJECT, hash)).toBe('corrupted');
    },
  );

  it('should return corrupted from status for a blob that grows between the fstat and the read, even with the right sha256 of the bytes', () => {
    // blob legítimo de 11 bytes; o `fstat` diz 10: a releitura vê 11 e recusa, embora o hash bata
    const bytes = Buffer.alloc(11, 0x61);
    const hash = sha256hex(bytes);
    fs.mkdirSync(attachmentsDir(), { recursive: true });
    fs.writeFileSync(blobPath(hash), bytes);
    understateSize(10);

    expect(store.status(PROJECT, hash)).toBe('corrupted');
  });

  it('should refuse read with ATTACHMENT_CORRUPTED for a blob that grows between the fstat and the read, even with the right sha256 of the bytes', () => {
    // blob legítimo de 11 bytes; o `fstat` diz 10: a releitura vê 11 e recusa, embora o hash bata
    const bytes = Buffer.alloc(11, 0x61);
    const hash = sha256hex(bytes);
    fs.mkdirSync(attachmentsDir(), { recursive: true });
    fs.writeFileSync(blobPath(hash), bytes);
    understateSize(10);

    expect(captureError(() => store.read(PROJECT, hash)).code).toBe('ATTACHMENT_CORRUPTED');
  });

  it('should turn a blob read error into IO_ERROR with only the errno and no absolute path', () => {
    const { hash } = store.putText(PROJECT, 'io');
    jest.spyOn(fs, 'readSync').mockImplementation(() => {
      throw fsError('EIO', blobPath(hash));
    });

    const error = captureError(() => store.read(PROJECT, hash));

    expect(error.code).toBe('IO_ERROR');
    expect(error.details).toEqual([{ path: '', code: 'eio', message: 'I/O failure' }]);

    expectNoLeak(error, base);
  });

  it('should open the blob once on the first status call', () => {
    const { hash } = store.putText(PROJECT, 'memo');
    const opens = jest.spyOn(fs, 'openSync');

    const status = store.status(PROJECT, hash);

    expect(status).toBe('ok');
    expect(opens).toHaveBeenCalledTimes(1);
  });

  it('should not reread the blob on the second status call', () => {
    const { hash } = store.putText(PROJECT, 'memo');
    const opens = jest.spyOn(fs, 'openSync');
    store.status(PROJECT, hash);

    const status = store.status(PROJECT, hash);

    expect(status).toBe('ok');
    expect(opens).toHaveBeenCalledTimes(1);
  });

  it('should reread the blob on every read, even after a memoized status', () => {
    const { hash } = store.putText(PROJECT, 'memo');
    const opens = jest.spyOn(fs, 'openSync');
    store.status(PROJECT, hash);
    store.status(PROJECT, hash);

    store.read(PROJECT, hash);

    expect(opens).toHaveBeenCalledTimes(2);
  });

  it('should see through the ctime a tampering that preserves size and mtime', () => {
    const { hash } = store.putText(PROJECT, 'AAAA');
    fs.utimesSync(blobPath(hash), FIXED_TIME, FIXED_TIME);
    const before = fs.statSync(blobPath(hash));
    const memoized = store.status(PROJECT, hash);
    fs.writeFileSync(blobPath(hash), 'BBBB');
    restoreTimesUntilCtimeChanges(blobPath(hash), before.ctimeMs);
    const after = fs.statSync(blobPath(hash));

    const status = store.status(PROJECT, hash);

    expect(memoized).toBe('ok');
    expect([after.size, after.mtimeMs]).toEqual([before.size, before.mtimeMs]);
    expect(after.ctimeMs).not.toBe(before.ctimeMs);
    expect(status).toBe('corrupted');
  });

  it('should return missing from status for a removed blob', () => {
    const { hash } = store.putText(PROJECT, 'some');
    const memoized = store.status(PROJECT, hash);
    fs.rmSync(blobPath(hash));

    const status = store.status(PROJECT, hash);

    expect(memoized).toBe('ok');
    expect(status).toBe('missing');
  });

  it('should store the exact bytes of a file in a dot folder by relative path (P16, D-15)', () => {
    const text = 'Decisão longa — ação\r\n\uFEFF'.repeat(11_000);
    writeInCwd(PLAN, text);

    const relative = store.putPath(PROJECT, PLAN);

    expect(relative.bytes).toBe(Buffer.byteLength(text));
    expect(fs.readFileSync(blobPath(relative.hash))).toEqual(Buffer.from(text, 'utf8'));
    expect(relative.hash).toBe(sha256hex(Buffer.from(text, 'utf8')));
  });

  it('should store the same blob, deduplicated, by absolute path (P16, D-15)', () => {
    const text = 'Decisão longa — ação\r\n\uFEFF'.repeat(11_000);
    const file = writeInCwd(PLAN, text);
    const relative = store.putPath(PROJECT, PLAN);

    const absolute = store.putPath(PROJECT, file);

    expect(absolute).toEqual({ ...relative, deduplicated: true });
  });

  it('should read from any folder of the cwd, the cwd itself included, not only from .omc/plans (P16, D-15)', () => {
    writeInCwd('docs/fundo/notas.txt', 'subpasta');
    writeInCwd('raiz.md', 'raiz');

    expect(store.putPath(PROJECT, 'docs/fundo/notas.txt').hash).toBe(sha256hex('subpasta'));
    expect(store.putPath(PROJECT, 'raiz.md').hash).toBe(sha256hex('raiz'));
  });

  it('should accept a file of exactly 1 MiB (P16, D-15)', () => {
    writeInCwd(PLAN, Buffer.alloc(ATTACHMENT_MAX_BYTES, 0x61));

    expect(store.putPath(PROJECT, PLAN).bytes).toBe(ATTACHMENT_MAX_BYTES);
  });

  it('should land on the same blob, deduplicated, when the same content comes by path and by text (P16, D-15)', () => {
    writeInCwd(PLAN, 'mesmo conteúdo');
    const byPath = store.putPath(PROJECT, PLAN);

    const byText = store.putText(PROJECT, 'mesmo conteúdo');

    expect(byText).toEqual({ ...byPath, deduplicated: true });
    expect(fs.readdirSync(attachmentsDir())).toEqual([byPath.hash]);
  });

  it('should refuse paths outside the cwd, relative or absolute, with outside-allowed-root, storing nothing (P16, D-15)', () => {
    fs.writeFileSync(path.join(outside, 'x.md'), 'fora');

    expect(captureError(() => store.putPath(PROJECT, '../outside/x.md'))).toMatchObject(
      invalid('/path', 'outside-allowed-root'),
    );
    expect(captureError(() => store.putPath(PROJECT, path.join(outside, 'x.md')))).toMatchObject(
      invalid('/path', 'outside-allowed-root'),
    );

    expectNothingStored();
  });

  it('should refuse a directory symlink pointing outside the cwd with outside-allowed-root, storing nothing (P16, D-15)', () => {
    fs.writeFileSync(path.join(outside, 'x.md'), 'fora');
    fs.symlinkSync(outside, path.join(cwd, 'atalho'));

    expect(captureError(() => store.putPath(PROJECT, 'atalho/x.md'))).toMatchObject(
      invalid('/path', 'outside-allowed-root'),
    );

    expectNothingStored();
  });

  it.each([
    ['a missing directory', () => cwd, 'nao/existe/x.md'],
    ['a missing cwd', () => path.join(base, 'nao-existe'), PLAN],
  ] as const)(
    'should refuse %s with outside-allowed-root, leaking neither errno nor path (P16, D-15)',
    (_name, cwdOf, target) => {
      const error = captureError(() =>
        createAttachmentStore({ dataDir, cwd: cwdOf() }).putPath(PROJECT, target),
      );

      expect(error.code).toBe('INVALID_INPUT');
      expect(error.details.map((detail) => detail.code)).toEqual(['outside-allowed-root']);

      expectNoLeak(error, base);
      expectNoLeak(error, 'ENOENT');
    },
  );

  it('should read inside a cwd that is a symlink, as the root is the resolved target (P16, D-15)', () => {
    const linkedCwd = path.join(base, 'cwd-link');
    fs.symlinkSync(cwd, linkedCwd);
    writeInCwd(PLAN, 'via symlink');
    const linked = createAttachmentStore({ dataDir, cwd: linkedCwd });

    expect(linked.putPath(PROJECT, PLAN).hash).toBe(sha256hex('via symlink'));
  });

  it('should keep refusing outside a cwd that is a symlink (P16, D-15)', () => {
    const linkedCwd = path.join(base, 'cwd-link');
    fs.symlinkSync(cwd, linkedCwd);
    fs.writeFileSync(path.join(outside, 'x.md'), 'fora');
    const linked = createAttachmentStore({ dataDir, cwd: linkedCwd });

    expect(captureError(() => linked.putPath(PROJECT, path.join(outside, 'x.md')))).toMatchObject(
      invalid('/path', 'outside-allowed-root'),
    );
  });

  it('should refuse a file in the target of a dataDir symlink pointing inside the cwd with inside-data-dir (P16, D-15)', () => {
    const real = path.join(cwd, 'dados');
    const linkedDataDir = path.join(base, 'dados-link');
    fs.mkdirSync(real);
    fs.symlinkSync(real, linkedDataDir);
    fs.writeFileSync(path.join(real, 'x.md'), 'dentro');
    const linked = createAttachmentStore({ dataDir: linkedDataDir, cwd });

    expect(captureError(() => linked.putPath(PROJECT, 'dados/x.md'))).toMatchObject(
      invalid('/path', 'inside-data-dir'),
    );
    expect(fs.existsSync(attachmentsDir(real))).toBe(false);
  });

  describe('with the dataDir inside the cwd', () => {
    beforeEach(() => {
      dataDir = path.join(cwd, 'dados');
      store = createAttachmentStore({ dataDir, cwd });
    });

    it('should refuse a file inside the dataDir with inside-data-dir, storing nothing (P16, D-15)', () => {
      const inside = path.join(dataRoot(dataDir), PROJECT, 'x.md');
      fs.mkdirSync(path.dirname(inside), { recursive: true });
      fs.writeFileSync(inside, 'dentro');

      expect(captureError(() => store.putPath(PROJECT, inside))).toMatchObject(
        invalid('/path', 'inside-data-dir'),
      );
      expect(fs.existsSync(attachmentsDir())).toBe(false);
    });

    it('should refuse a directory symlink pointing inside the dataDir with inside-data-dir, after the realpath (P16, D-15)', () => {
      const inside = path.join(dataRoot(dataDir), PROJECT);
      fs.mkdirSync(inside, { recursive: true });
      fs.writeFileSync(path.join(inside, 'x.md'), 'dentro');
      fs.symlinkSync(inside, path.join(cwd, 'atalho'));

      expect(captureError(() => store.putPath(PROJECT, 'atalho/x.md'))).toMatchObject(
        invalid('/path', 'inside-data-dir'),
      );
      expect(fs.existsSync(attachmentsDir())).toBe(false);
    });

    it('should refuse with inside-data-dir before not-found (P16, D-15)', () => {
      fs.mkdirSync(dataDir);

      expect(captureError(() => store.putPath(PROJECT, 'dados/nao-existe.md'))).toMatchObject(
        invalid('/path', 'inside-data-dir'),
      );
    });

    it('should keep putting a file outside the dataDir normally (P16, D-15)', () => {
      fs.mkdirSync(dataDir);
      writeInCwd(PLAN, 'fora do dataDir');

      expect(store.putPath(PROJECT, PLAN).hash).toBe(sha256hex('fora do dataDir'));
    });
  });

  it('should put normally when the dataDir does not exist, as there is nothing to refuse (P16, D-15)', () => {
    writeInCwd(PLAN, 'sem dataDir');
    const dataDirExisted = fs.existsSync(dataDir);

    const result = store.putPath(PROJECT, PLAN);

    expect(dataDirExisted).toBe(false);
    expect(result.hash).toBe(sha256hex('sem dataDir'));
  });

  it('should refuse with outside-allowed-root before not-found (P16, D-15)', () => {
    expect(
      captureError(() => store.putPath(PROJECT, path.join(outside, 'nao-existe.md'))),
    ).toMatchObject(invalid('/path', 'outside-allowed-root'));
  });

  it('should refuse a missing file with not-found, leaking neither errno nor path (P16, D-15)', () => {
    const error = captureError(() => store.putPath(PROJECT, '.omc/plans/nao-existe.md'));

    expect(error.code).toBe('INVALID_INPUT');
    expect(error.details.map((detail) => detail.code)).toEqual(['not-found']);

    expectNoLeak(error, base);
    expectNoLeak(error, 'ENOENT');
    expectNothingStored();
  });

  // No filho (`probe`): o FIFO travaria a thread do jest se o `open` perdesse o `O_NONBLOCK`.
  it.each([
    [
      'a symlink as the final component, even when pointing inside the cwd',
      () => {
        writeInCwd('alvo.md', 'alvo');
        fs.symlinkSync(path.join(cwd, 'alvo.md'), path.join(cwd, '.omc', 'plans', 'link.md'));
        return '.omc/plans/link.md';
      },
    ],
    [
      'a directory named *.md',
      () => {
        fs.mkdirSync(path.join(cwd, 'pasta.md'));
        return 'pasta.md';
      },
    ],
    [
      'a FIFO named *.md',
      () => {
        execFileSync('mkfifo', [path.join(cwd, 'fila.md')]);
        return 'fila.md';
      },
    ],
    [
      'a hardlink (nlink > 1)',
      () => {
        writeInCwd('segredo.md', 'segredo');
        fs.linkSync(path.join(cwd, 'segredo.md'), path.join(cwd, '.omc', 'plans', 'link.md'));
        return '.omc/plans/link.md';
      },
    ],
  ])('should refuse %s with not-regular, storing nothing (P16, D-15)', (_name, prepare) => {
    const candidate = prepare();

    expect(probe({ call: 'putPath', path: candidate })).toEqual({
      error: invalid('/path', 'not-regular'),
    });

    expectNothingStored();
  });

  it('should refuse a file above 1 MiB with too-big, storing nothing (P16, D-15)', () => {
    writeInCwd(PLAN, Buffer.alloc(ATTACHMENT_MAX_BYTES + 1, 0x61));

    expect(captureError(() => store.putPath(PROJECT, PLAN))).toMatchObject(
      invalid('/path', 'too-big'),
    );

    expectNothingStored();
  });

  it('should refuse with too-big a file that grows between the fstat and the read (P16, D-15)', () => {
    writeInCwd(PLAN, Buffer.alloc(ATTACHMENT_MAX_BYTES + 1, 0x61));
    understateSize(10);

    const error = captureError(() => store.putPath(PROJECT, PLAN));

    expect(error).toMatchObject(invalid('/path', 'too-big'));
    expect(error.message).toBe('file changed while being read');
  });

  it('should refuse an empty file with bad-args, storing nothing (P16, D-15)', () => {
    writeInCwd('vazio.md', '');

    expect(captureError(() => store.putPath(PROJECT, 'vazio.md'))).toMatchObject(
      invalid('/path', 'bad-args'),
    );

    expectNothingStored();
  });

  it('should refuse bytes that are not UTF-8 with invalid-utf8, storing nothing (P16, D-15)', () => {
    writeInCwd('binario.md', Buffer.from([0x61, 0xff, 0xfe]));

    expect(captureError(() => store.putPath(PROJECT, 'binario.md'))).toMatchObject(
      invalid('/path', 'invalid-utf8'),
    );

    expectNothingStored();
  });

  it('should turn a file read error into IO_ERROR with only the errno and no absolute path (P16, D-15)', () => {
    const file = writeInCwd(PLAN, 'conteúdo');
    jest.spyOn(fs, 'readSync').mockImplementation(() => {
      throw fsError('EIO', file);
    });

    const error = captureError(() => store.putPath(PROJECT, PLAN));

    expect(error.code).toBe('IO_ERROR');
    expect(error.details).toEqual([{ path: '', code: 'eio', message: 'I/O failure' }]);

    expectNoLeak(error, base);
  });

  describe('with a directory swapped for a symlink between the realpath and the open', () => {
    beforeEach(() => {
      fs.writeFileSync(path.join(outside, 'x.md'), 'fora');
      writeInCwd(PLAN, 'dentro');
    });

    /** Na 1ª chamada de `openSync` (a do arquivo) troca `.omc/plans` por um symlink para `outside`. */
    function swapDirectoryOnOpen(): void {
      const plans = path.join(cwd, '.omc', 'plans');
      const realOpen = fs.openSync.bind(fs);
      let swapped = false;
      jest.spyOn(fs, 'openSync').mockImplementation((...args: Parameters<typeof fs.openSync>) => {
        if (!swapped) {
          swapped = true;
          fs.renameSync(plans, `${plans}-original`);
          fs.symlinkSync(outside, plans);
        }
        return realOpen(...args);
      });
    }

    function withoutProc(): void {
      const realRealpath = fs.realpathSync.bind(fs);
      jest.spyOn(fs, 'realpathSync').mockImplementation((target: fs.PathLike) => {
        if (String(target).startsWith('/proc/self/fd/')) throw fsError('ENOENT', String(target));
        return realRealpath(target);
      });
    }

    it('should refuse the swap with outside-allowed-root, storing nothing, with /proc (P16, D-15)', () => {
      swapDirectoryOnOpen();

      expect(captureError(() => store.putPath(PROJECT, PLAN))).toMatchObject(
        invalid('/path', 'outside-allowed-root'),
      );

      expectNothingStored();
    });

    it('should refuse the swap too without /proc (macOS) (P16, D-15)', () => {
      withoutProc();
      swapDirectoryOnOpen();

      expect(captureError(() => store.putPath(PROJECT, PLAN))).toMatchObject(
        invalid('/path', 'outside-allowed-root'),
      );

      expectNothingStored();
    });

    it('should put normally without /proc and without a swap (P16, D-15)', () => {
      withoutProc();

      expect(store.putPath(PROJECT, PLAN).hash).toBe(sha256hex('dentro'));
    });
  });
});
