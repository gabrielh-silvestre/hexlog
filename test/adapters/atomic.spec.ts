import { afterEach, describe, expect, it, jest } from '@jest/globals';
import fs from 'node:fs';
import * as path from 'node:path';
import { writeFileAtomic } from '../../src/adapters/fs/atomic.ts';
import { createTempDir } from '../helpers.ts';
import { spyOnOpen } from './fs-spies.ts';
import { countFsyncs } from './fsync-spy.ts';

describe('writeFileAtomic', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('should write text and bytes without leaving a temporary in the directory', () => {
    const dir = createTempDir('atomic');

    writeFileAtomic(path.join(dir, 'a.json'), '{"ok":true}');
    writeFileAtomic(path.join(dir, 'b.bin'), new Uint8Array([0, 255, 10]));

    expect(fs.readFileSync(path.join(dir, 'a.json'), 'utf8')).toBe('{"ok":true}');
    expect([...fs.readFileSync(path.join(dir, 'b.bin'))]).toEqual([0, 255, 10]);
    expect(fs.readdirSync(dir).sort()).toEqual(['a.json', 'b.bin']);
  });

  it('should create the missing directories with mode 0o700', () => {
    const dir = createTempDir('atomic');
    const file = path.join(dir, 'x', 'y', 'f.txt');

    writeFileAtomic(file, 'v');

    expect(fs.readFileSync(file, 'utf8')).toBe('v');
    expect(fs.statSync(path.dirname(file)).mode & 0o777).toBe(0o700);
  });

  it('should replace the existing file without exclusive', () => {
    const dir = createTempDir('atomic');
    const file = path.join(dir, 'f.txt');
    fs.writeFileSync(file, 'old');

    writeFileAtomic(file, 'new');

    expect(fs.readFileSync(file, 'utf8')).toBe('new');
    expect(fs.readdirSync(dir)).toEqual(['f.txt']);
  });

  it('should publish the file already in the requested mode with mode, bypassing the umask', () => {
    const dir = createTempDir('atomic');
    const file = path.join(dir, 'f.txt');
    const previousUmask = process.umask(0o077);

    try {
      writeFileAtomic(file, 'v', { mode: 0o664 });
    } finally {
      process.umask(previousUmask);
    }

    expect(fs.statSync(file).mode & 0o7777).toBe(0o664);
  });

  it('should write when the file does not exist with exclusive', () => {
    const dir = createTempDir('atomic');
    const file = path.join(dir, 'f.txt');

    writeFileAtomic(file, 'first', { exclusive: true });

    expect(fs.readFileSync(file, 'utf8')).toBe('first');
    expect(fs.readdirSync(dir)).toEqual(['f.txt']);
  });

  it('should throw a raw EEXIST with exclusive, keep the content and remove the temporary', () => {
    const dir = createTempDir('atomic');
    const file = path.join(dir, 'f.txt');
    writeFileAtomic(file, 'first', { exclusive: true });

    expect(() => writeFileAtomic(file, 'second', { exclusive: true })).toThrow(
      expect.objectContaining({ code: 'EEXIST' }),
    );

    expect(fs.readFileSync(file, 'utf8')).toBe('first');
    expect(fs.readdirSync(dir)).toEqual(['f.txt']);
  });

  it('should throw an I/O error other than EEXIST raw and leave no temporary', () => {
    const dir = createTempDir('atomic');
    const target = path.join(dir, 'folder');
    fs.mkdirSync(target);

    // renomear arquivo por cima de diretório falha (EISDIR)
    expect(() => writeFileAtomic(target, 'v')).toThrow(expect.objectContaining({ code: 'EISDIR' }));

    expect(fs.readdirSync(dir)).toEqual(['folder']);
  });

  it('should throw a raw file fsync failure, not publish the file and leave no temporary', () => {
    const dir = createTempDir('atomic');
    const file = path.join(dir, 'f.txt');
    jest.spyOn(fs, 'fsyncSync').mockImplementation(() => {
      throw Object.assign(new Error('EIO: /abs/secret/path'), { code: 'EIO' });
    });

    expect(() => writeFileAtomic(file, 'v')).toThrow(expect.objectContaining({ code: 'EIO' }));

    expect(fs.readdirSync(dir)).toEqual([]);
  });

  it('should throw a raw denied link with exclusive (EPERM, no hard link on the file system) and leave no temporary', () => {
    const dir = createTempDir('atomic');
    const file = path.join(dir, 'f.txt');
    jest.spyOn(fs, 'linkSync').mockImplementation(() => {
      throw Object.assign(new Error('EPERM: /abs/secret/path'), { code: 'EPERM' });
    });

    expect(() => writeFileAtomic(file, 'v', { exclusive: true })).toThrow(
      expect.objectContaining({ code: 'EPERM' }),
    );

    expect(fs.readdirSync(dir)).toEqual([]);
  });

  it('should name the temporary with the pid and 8 random bytes (16 hex), so two writers do not collide', () => {
    const dir = createTempDir('atomic');
    const opened: string[] = [];
    spyOnOpen((file) => opened.push(path.basename(file)));

    writeFileAtomic(path.join(dir, 'f.txt'), 'v');

    expect(opened).toEqual([
      expect.stringMatching(new RegExp(`^\\.f\\.txt\\.${process.pid}\\.[0-9a-f]{16}$`)),
    ]);
  });

  it('should create the file with mode 0o600', () => {
    const dir = createTempDir('atomic');
    const file = path.join(dir, 'f.txt');

    writeFileAtomic(file, 'v');

    expect(fs.statSync(file).mode & 0o777).toBe(0o600);
  });

  it.each([
    { fsyncDir: false, directoryFsyncs: 0 },
    { fsyncDir: true, directoryFsyncs: 1 },
  ])(
    'should fsync the directory $directoryFsyncs times with fsyncDir $fsyncDir',
    ({ fsyncDir, directoryFsyncs }) => {
      const dir = createTempDir('atomic');
      const fsyncs = countFsyncs();

      writeFileAtomic(path.join(dir, 'f.txt'), 'v', { fsyncDir });

      expect(fsyncs()).toEqual({ files: 1, directories: directoryFsyncs });
    },
  );
});
