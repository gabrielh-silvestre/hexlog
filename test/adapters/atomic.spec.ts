import { afterEach, describe, expect, jest, test } from '@jest/globals';
import fs from 'node:fs';
import * as path from 'node:path';
import { writeFileAtomic } from '../../src/adapters/fs/atomic.ts';
import { createTempDir } from '../helpers.ts';

afterEach(() => {
  jest.restoreAllMocks();
});

describe('writeFileAtomic', () => {
  test('grava texto e bytes sem deixar temporário no diretório', () => {
    const dir = createTempDir('atomic');

    writeFileAtomic(path.join(dir, 'a.json'), '{"ok":true}');
    writeFileAtomic(path.join(dir, 'b.bin'), new Uint8Array([0, 255, 10]));

    expect(fs.readFileSync(path.join(dir, 'a.json'), 'utf8')).toBe('{"ok":true}');
    expect([...fs.readFileSync(path.join(dir, 'b.bin'))]).toEqual([0, 255, 10]);
    expect(fs.readdirSync(dir).sort()).toEqual(['a.json', 'b.bin']);
  });

  test('cria os diretórios ausentes com modo 0o700', () => {
    const dir = createTempDir('atomic');
    const file = path.join(dir, 'x', 'y', 'f.txt');

    writeFileAtomic(file, 'v');

    expect(fs.readFileSync(file, 'utf8')).toBe('v');
    expect(fs.statSync(path.dirname(file)).mode & 0o777).toBe(0o700);
  });

  test('sem exclusive, substitui o arquivo existente', () => {
    const dir = createTempDir('atomic');
    const file = path.join(dir, 'f.txt');
    fs.writeFileSync(file, 'velho');

    writeFileAtomic(file, 'novo');

    expect(fs.readFileSync(file, 'utf8')).toBe('novo');
    expect(fs.readdirSync(dir)).toEqual(['f.txt']);
  });

  test('com mode, publica o arquivo já no modo pedido, sem passar pela umask', () => {
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

  test('com exclusive, grava quando o arquivo não existe', () => {
    const dir = createTempDir('atomic');
    const file = path.join(dir, 'f.txt');

    writeFileAtomic(file, 'primeiro', { exclusive: true });

    expect(fs.readFileSync(file, 'utf8')).toBe('primeiro');
    expect(fs.readdirSync(dir)).toEqual(['f.txt']);
  });

  test('com exclusive, lança EEXIST cru, preserva o conteúdo e remove o temporário', () => {
    const dir = createTempDir('atomic');
    const file = path.join(dir, 'f.txt');
    writeFileAtomic(file, 'primeiro', { exclusive: true });

    expect(() => writeFileAtomic(file, 'segundo', { exclusive: true })).toThrow(
      expect.objectContaining({ code: 'EEXIST' }),
    );

    expect(fs.readFileSync(file, 'utf8')).toBe('primeiro');
    expect(fs.readdirSync(dir)).toEqual(['f.txt']);
  });

  test('erro de I/O que não é EEXIST sai cru e não deixa temporário', () => {
    const dir = createTempDir('atomic');
    const target = path.join(dir, 'pasta');
    fs.mkdirSync(target);

    // renomear arquivo por cima de diretório falha (EISDIR)
    expect(() => writeFileAtomic(target, 'v')).toThrow(expect.objectContaining({ code: 'EISDIR' }));

    expect(fs.readdirSync(dir)).toEqual(['pasta']);
  });

  test('falha do fsync do arquivo sai crua, não publica o arquivo e não deixa temporário', () => {
    const dir = createTempDir('atomic');
    const file = path.join(dir, 'f.txt');
    jest.spyOn(fs, 'fsyncSync').mockImplementation(() => {
      throw Object.assign(new Error('EIO: /abs/secret/path'), { code: 'EIO' });
    });

    expect(() => writeFileAtomic(file, 'v')).toThrow(expect.objectContaining({ code: 'EIO' }));

    expect(fs.readdirSync(dir)).toEqual([]);
  });

  test('com exclusive, link negado (EPERM, sem hard link no sistema de arquivos) sai cru e não deixa temporário', () => {
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

  test('o temporário leva pid e 8 bytes aleatórios (16 hex) no nome, para dois escritores não colidirem', () => {
    const dir = createTempDir('atomic');
    const realOpen = fs.openSync;
    const opened: string[] = [];
    jest.spyOn(fs, 'openSync').mockImplementation((file, flags, mode) => {
      opened.push(path.basename(String(file)));
      return realOpen(file, flags, mode);
    });

    writeFileAtomic(path.join(dir, 'f.txt'), 'v');

    expect(opened).toEqual([
      expect.stringMatching(new RegExp(`^\\.f\\.txt\\.${process.pid}\\.[0-9a-f]{16}$`)),
    ]);
  });

  test('o arquivo nasce com modo 0o600', () => {
    const dir = createTempDir('atomic');
    const file = path.join(dir, 'f.txt');

    writeFileAtomic(file, 'v');

    expect(fs.statSync(file).mode & 0o777).toBe(0o600);
  });

  test.each([
    { fsyncDir: false, directoryFsyncs: 0 },
    { fsyncDir: true, directoryFsyncs: 1 },
  ])(
    'fsyncDir $fsyncDir dá $directoryFsyncs fsync no diretório',
    ({ fsyncDir, directoryFsyncs }) => {
      const dir = createTempDir('atomic');
      const realFsync = fs.fsyncSync;
      const onDirectory: boolean[] = [];
      // passa direto para o fsync real; só registra se o descritor é um diretório
      jest.spyOn(fs, 'fsyncSync').mockImplementation((fd) => {
        onDirectory.push(fs.fstatSync(fd).isDirectory());
        realFsync(fd);
      });

      writeFileAtomic(path.join(dir, 'f.txt'), 'v', { fsyncDir });

      expect(onDirectory.filter(Boolean)).toHaveLength(directoryFsyncs);
      expect(onDirectory.filter((isDirectory) => !isDirectory)).toHaveLength(1);
    },
  );
});
