import { afterEach, beforeEach, describe, expect, jest, test } from '@jest/globals';
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { createHash } from 'node:crypto';
// Import padrão: precisa ser o mesmo objeto de `src/archive.ts` para o `jest.spyOn` interceptar.
import fs from 'node:fs';
import * as path from 'node:path';
import * as tar from 'tar';
import { detectLegacy } from '../src/adapters/fs/data-format.ts';
import { ArchiveError, archiveLegacy, inspectLegacy, type ArchiveOptions } from '../src/archive.ts';
import { createTempDir } from './helpers.ts';

const FIXTURE = path.resolve(__dirname, 'fixtures', 'legacy-0x');

const TREE: Record<string, string> = {
  'alpha/main/process.json': '{"project":"alpha"}\n',
  'alpha/main/events.jsonl': '{"seq":1}\n{"seq":2}\n',
  'alpha/schemas/note/1.0.json': '{"type":"object"}\n',
  'alpha/attachments/abc123': 'attachment bytes',
  'beta/main/process.json': '{"project":"beta"}\n',
};

let dataDir: string;
let libDir: string;
let options: ArchiveOptions;
let clockSeconds: number;
const children: ChildProcess[] = [];

function plant(files: Record<string, string> = TREE): void {
  for (const [relative, content] of Object.entries(files)) {
    const absolute = path.join(dataDir, relative);
    fs.mkdirSync(path.dirname(absolute), { recursive: true });
    fs.writeFileSync(absolute, content);
  }
}

function snapshot(root: string): Record<string, string | null> {
  return Object.fromEntries(
    fs
      .readdirSync(root, { recursive: true })
      .map(String)
      .sort()
      .map((relative) => {
        const absolute = path.join(root, relative);
        return [
          relative,
          fs.statSync(absolute).isDirectory() ? null : fs.readFileSync(absolute, 'utf8'),
        ];
      }),
  );
}

function withoutArchive(tree: Record<string, string | null>): Record<string, string | null> {
  return Object.fromEntries(Object.entries(tree).filter(([key]) => !key.startsWith('archive')));
}

/** Sobe um processo cujo `cmdline` aponta para `<libDir>/0.4.0/server.mjs`, como o servidor 0.x instalado. */
function spawnLegacyServer(): ChildProcess {
  const child = spawn(
    process.execPath,
    ['-e', 'setInterval(() => {}, 1000)', path.join(libDir, '0.4.0', 'server.mjs')],
    { stdio: 'ignore' },
  );
  children.push(child);
  return child;
}

function plantLock(project: string, token: string | undefined): void {
  const lockDir = path.join(dataDir, project, 'main', 'events.jsonl.lock');
  fs.mkdirSync(lockDir, { recursive: true });
  if (token !== undefined) fs.writeFileSync(path.join(lockDir, 'holder'), token);
}

function deadPid(): number {
  return spawnSync(process.execPath, ['-e', '0']).pid;
}

function packages(): string[] {
  return fs.readdirSync(path.join(dataDir, 'archive')).sort();
}

/** Primeira chamada de `target.method` com `when` verdadeiro roda `before`/`after` em volta da original. */
function spyOnce<K extends 'renameSync' | 'unlinkSync' | 'readdirSync' | 'fsyncSync'>(
  method: K,
  hook: (args: unknown[], real: () => unknown) => unknown,
): void {
  const original = fs[method] as (...args: unknown[]) => unknown;
  jest
    .spyOn(fs, method)
    .mockImplementation(((...args: unknown[]) =>
      hook(args, () => original.apply(fs, args))) as never);
}

beforeEach(() => {
  dataDir = createTempDir('archive-data');
  libDir = createTempDir('archive-lib');
  clockSeconds = 0;
  options = { libDir, now: () => new Date(Date.UTC(2026, 9, 3, 12, 0, clockSeconds++)) };
});

afterEach(() => {
  jest.restoreAllMocks();
  for (const child of children.splice(0)) child.kill('SIGKILL');
});

describe('inspectLegacy (dado 0.x)', () => {
  test('lista arquivos com sha256 e diretórios sem alterar o <D>', () => {
    plant();
    fs.mkdirSync(path.join(dataDir, '.v1', 'alpha'), { recursive: true });
    fs.mkdirSync(path.join(dataDir, 'archive'));
    const before = snapshot(dataDir);

    const inventory = inspectLegacy(dataDir);

    expect(inventory.files.map((file) => file.path)).toEqual(Object.keys(TREE).sort());
    expect(inventory.files).toContainEqual({
      path: 'alpha/attachments/abc123',
      size: 16,
      sha256: createHash('sha256').update('attachment bytes').digest('hex'),
    });
    expect(inventory.dirs).toEqual(
      expect.arrayContaining(['alpha', 'alpha/main', 'alpha/schemas/note', 'beta', 'beta/main']),
    );
    expect(inventory.dirs.some((dir) => dir.startsWith('.v1') || dir.startsWith('archive'))).toBe(
      false,
    );
    expect(snapshot(dataDir)).toEqual(before);
  });

  test('lista a árvore real da fixture gerada pelas tools 0.x', () => {
    fs.cpSync(FIXTURE, dataDir, { recursive: true });

    const inventory = inspectLegacy(dataDir);

    expect(inventory.files.length).toBeGreaterThan(0);
    expect(inventory.dirs).toContain('alpha');
    expect(inventory.files.every((file) => /^[0-9a-f]{64}$/.test(file.sha256))).toBe(true);
  });

  test('lista recusa symlink com ArchiveError', () => {
    plant();
    fs.symlinkSync('/etc/hostname', path.join(dataDir, 'alpha', 'link'));

    expect(() => inspectLegacy(dataDir)).toThrow(ArchiveError);
  });

  test('lista de <D> inexistente ou sem dado 0.x vem vazia', () => {
    expect(inspectLegacy(path.join(dataDir, 'missing'))).toEqual({ files: [], dirs: [] });
  });
});

describe('archiveLegacy (dado 0.x)', () => {
  test('arquiva gera o .tar, confere o sha256 e só então apaga', () => {
    plant();
    const inventory = inspectLegacy(dataDir);

    const result = archiveLegacy(dataDir, options);

    expect(result).toEqual({
      archived: true,
      tarPath: path.join(dataDir, 'archive', 'hexlog-0x-20261003T120000Z.tar'),
      files: Object.keys(TREE).length,
      dirs: inventory.dirs.length,
    });
    const packaged: Record<string, string> = {};
    tar.list({
      file: result.tarPath!,
      sync: true,
      onReadEntry: (entry) => {
        const chunks: Buffer[] = [];
        entry.on('data', (chunk: Buffer) => chunks.push(chunk));
        entry.on('end', () => {
          packaged[entry.path] = createHash('sha256').update(Buffer.concat(chunks)).digest('hex');
        });
      },
    });
    expect(packaged).toEqual(
      Object.fromEntries(inventory.files.map((file) => [file.path, file.sha256])),
    );
    expect(detectLegacy(dataDir)).toEqual([]);
    expect(packages()).toEqual(['hexlog-0x-20261003T120000Z.tar']);
  });

  test('arquiva a fixture real das tools 0.x e deixa só o archive', () => {
    fs.cpSync(FIXTURE, dataDir, { recursive: true });
    const { files } = inspectLegacy(dataDir);

    const result = archiveLegacy(dataDir, options);

    expect(result.files).toBe(files.length);
    expect(fs.readdirSync(dataDir)).toEqual(['archive']);
  });

  test('arquiva sem dado 0.x não faz nada, nem cria archive/', () => {
    fs.mkdirSync(path.join(dataDir, '.v1'));
    const before = snapshot(dataDir);

    expect(archiveLegacy(dataDir, options)).toEqual({ archived: false, files: 0 });
    expect(snapshot(dataDir)).toEqual(before);
  });

  test('arquiva uma segunda vez sem fazer nada', () => {
    plant();
    archiveLegacy(dataDir, options);
    const before = snapshot(dataDir);

    expect(archiveLegacy(dataDir, options)).toEqual({ archived: false, files: 0 });
    expect(snapshot(dataDir)).toEqual(before);
  });

  test('arquiva e falha de verificação do pacote não apaga nada', () => {
    plant();
    const before = snapshot(dataDir);
    const archiveDir = path.join(dataDir, 'archive');
    spyOnce('fsyncSync', (args, real) => {
      const partial = fs.readdirSync(archiveDir).find((name) => name.endsWith('.partial'));
      if (partial !== undefined) {
        const fd = fs.openSync(path.join(archiveDir, partial), 'r+');
        fs.writeSync(fd, 'X', 512);
        fs.closeSync(fd);
      }
      return real();
    });

    expect(() => archiveLegacy(dataDir, options)).toThrow(/does not match the listed files/);

    jest.restoreAllMocks();
    expect(packages()).toEqual([]);
    expect(withoutArchive(snapshot(dataDir))).toEqual(withoutArchive(before));
  });

  test('arquiva e arquivo que muda entre a lista e a remoção aborta mantendo o .tar', () => {
    plant();
    spyOnce('renameSync', (args, real) => {
      if (String(args[0]).endsWith('.partial')) {
        fs.appendFileSync(path.join(dataDir, 'alpha/main/events.jsonl'), '{"seq":3}\n');
      }
      return real();
    });

    expect(() => archiveLegacy(dataDir, options)).toThrow(/changed while archiving/);

    jest.restoreAllMocks();
    expect(packages()).toEqual(['hexlog-0x-20261003T120000Z.tar']);
    expect(fs.readFileSync(path.join(dataDir, 'alpha/main/events.jsonl'), 'utf8')).toContain(
      '"seq":3',
    );
    expect(inspectLegacy(dataDir).files).toHaveLength(Object.keys(TREE).length);
  });

  test('arquiva e arquivo novo antes da remoção aborta e nunca é apagado', () => {
    plant();
    spyOnce('renameSync', (args, real) => {
      if (String(args[0]).endsWith('.partial')) {
        fs.writeFileSync(path.join(dataDir, 'beta/main/late.json'), 'late');
      }
      return real();
    });

    expect(() => archiveLegacy(dataDir, options)).toThrow(ArchiveError);

    jest.restoreAllMocks();
    expect(fs.readFileSync(path.join(dataDir, 'beta/main/late.json'), 'utf8')).toBe('late');
    expect(fs.existsSync(path.join(dataDir, 'alpha/main/process.json'))).toBe(true);
  });

  test('arquiva e arquivo que aparece durante a remoção nunca é apagado', () => {
    plant();
    let unlinks = 0;
    spyOnce('unlinkSync', (args, real) => {
      real();
      if (++unlinks === 1) fs.writeFileSync(path.join(dataDir, 'alpha', 'appeared.txt'), 'new');
    });

    expect(() => archiveLegacy(dataDir, options)).toThrow(/did not empty.*alpha/);

    jest.restoreAllMocks();
    expect(fs.readFileSync(path.join(dataDir, 'alpha', 'appeared.txt'), 'utf8')).toBe('new');
    expect(packages()).toHaveLength(1);

    // a execução seguinte arquiva o que sobrou
    expect(archiveLegacy(dataDir, options)).toMatchObject({ archived: true, files: 1 });
    expect(detectLegacy(dataDir)).toEqual([]);
  });

  test('arquiva retomada após remoção parcial reaproveita o .tar e passa pelo re-hash', () => {
    plant();
    let unlinks = 0;
    spyOnce('unlinkSync', (args, real) => {
      if (++unlinks > 2) throw new Error('crash during removal');
      return real();
    });
    expect(() => archiveLegacy(dataDir, options)).toThrow('crash during removal');
    jest.restoreAllMocks();
    const [original] = packages();

    const resumed = archiveLegacy(dataDir, options);

    expect(resumed.files).toBe(Object.keys(TREE).length - 2);
    expect(resumed.tarPath).toBe(path.join(dataDir, 'archive', original!));
    expect(packages()).toEqual([original]);
    expect(detectLegacy(dataDir)).toEqual([]);
  });

  test('arquiva retomada confere de novo os originais e aborta se algum mudou', () => {
    plant();
    let unlinks = 0;
    spyOnce('unlinkSync', (args, real) => {
      if (++unlinks > 2) throw new Error('crash during removal');
      return real();
    });
    expect(() => archiveLegacy(dataDir, options)).toThrow('crash during removal');
    jest.restoreAllMocks();
    const archiveDir = path.join(dataDir, 'archive');
    const remaining = inspectLegacy(dataDir).files[0]!.path;
    spyOnce('readdirSync', (args, real) => {
      const result = real();
      if (args[0] === archiveDir) fs.appendFileSync(path.join(dataDir, remaining), 'changed');
      return result;
    });

    expect(() => archiveLegacy(dataDir, options)).toThrow(/changed while archiving/);

    jest.restoreAllMocks();
    expect(fs.readFileSync(path.join(dataDir, remaining), 'utf8')).toContain('changed');
  });

  test('arquiva remove diretório 0.x sem arquivo e a execução seguinte sai sem dado', () => {
    plantLock('gamma', undefined);
    const { files, dirs } = inspectLegacy(dataDir);
    expect(files).toEqual([]);

    expect(archiveLegacy(dataDir, options)).toEqual({
      archived: true,
      tarPath: undefined,
      files: 0,
      dirs: dirs.length,
    });

    expect(detectLegacy(dataDir)).toEqual([]);
    expect(archiveLegacy(dataDir, options)).toEqual({ archived: false, files: 0 });
  });

  test('arquiva apaga .partial velho e não toca no que não está na lista', () => {
    plant();
    fs.mkdirSync(path.join(dataDir, '.v1', 'alpha'), { recursive: true });
    fs.writeFileSync(path.join(dataDir, '.v1', 'alpha', 'records.jsonl'), 'v1 data');
    fs.mkdirSync(path.join(dataDir, 'archive'));
    fs.writeFileSync(
      path.join(dataDir, 'archive', 'hexlog-0x-20200101T000000Z.tar.partial'),
      'junk',
    );

    archiveLegacy(dataDir, options);

    expect(packages()).toEqual(['hexlog-0x-20261003T120000Z.tar']);
    expect(fs.readFileSync(path.join(dataDir, '.v1', 'alpha', 'records.jsonl'), 'utf8')).toBe(
      'v1 data',
    );
  });
});

describe('archiveLegacy lock vivo (dado 0.x)', () => {
  test('lock vivo com pid de processo em execução aborta sem apagar', () => {
    plant();
    plantLock('alpha', `${process.pid}-deadbeef`);
    const before = snapshot(dataDir);

    expect(() => archiveLegacy(dataDir, options)).toThrow(/lock is held by a live process/);

    expect(snapshot(dataDir)).toEqual(before);
  });

  test('lock vivo com holder ilegível aborta sem apagar', () => {
    plant();
    plantLock('alpha', 'not-a-token');

    expect(() => archiveLegacy(dataDir, options)).toThrow(/unreadable holder/);
    expect(fs.existsSync(path.join(dataDir, 'alpha/main/process.json'))).toBe(true);
  });

  test('lock morto com pid que já saiu não impede o arquivamento', () => {
    plant();
    plantLock('alpha', `${deadPid()}-deadbeef`);

    expect(archiveLegacy(dataDir, options)).toMatchObject({ archived: true });
    expect(detectLegacy(dataDir)).toEqual([]);
  });
  test('lock vivo que surge durante a geração do pacote aborta na segunda checagem', () => {
    plant();
    plantLock('alpha', `${deadPid()}-deadbeef`);
    // Plantar o holder no meio mudaria a lista e abortaria antes; o que muda é o pid passar a estar vivo.
    let packaged = false;
    const realKill = process.kill.bind(process);
    jest
      .spyOn(process, 'kill')
      .mockImplementation((pid: number, signal?: string | number) =>
        packaged ? true : realKill(pid, signal),
      );
    spyOnce('renameSync', (args, real) => {
      if (String(args[0]).endsWith('.partial')) packaged = true;
      return real();
    });

    expect(() => archiveLegacy(dataDir, options)).toThrow(/lock is held by a live process/);

    jest.restoreAllMocks();
    expect(packages()).toHaveLength(1);
    expect(inspectLegacy(dataDir).files).toHaveLength(Object.keys(TREE).length + 1);
  });
});

describe('archiveLegacy servidor vivo (dado 0.x)', () => {
  test('servidor vivo com cmdline em <libDir>/0.4.0/server.mjs aborta sem apagar', () => {
    plant();
    const child = spawnLegacyServer();
    const before = snapshot(dataDir);

    expect(() => archiveLegacy(dataDir, options)).toThrow(`pid ${child.pid}`);

    expect(snapshot(dataDir)).toEqual(before);
  });

  test('servidor vivo de outro libDir não impede o arquivamento', () => {
    plant();
    const other = createTempDir('archive-other-lib');
    const child = spawn(
      process.execPath,
      ['-e', 'setInterval(() => {}, 1000)', path.join(other, '0.4.0', 'server.mjs')],
      { stdio: 'ignore' },
    );
    children.push(child);

    expect(archiveLegacy(dataDir, options)).toMatchObject({ archived: true });
  });

  test('servidor vivo não confirmável sem /proc aborta sem apagar', () => {
    plant();
    const before = snapshot(dataDir);

    expect(() =>
      archiveLegacy(dataDir, { ...options, procDir: path.join(dataDir, '..', 'no-proc') }),
    ).toThrow(/cannot confirm/);

    expect(snapshot(dataDir)).toEqual(before);
  });

  test('servidor vivo que surge durante a geração do pacote aborta na segunda checagem', () => {
    plant();
    spyOnce('renameSync', (args, real) => {
      if (String(args[0]).endsWith('.partial')) spawnLegacyServer();
      return real();
    });

    expect(() => archiveLegacy(dataDir, options)).toThrow(/a 0\.x server is running/);

    jest.restoreAllMocks();
    expect(packages()).toHaveLength(1);
    expect(inspectLegacy(dataDir).files).toHaveLength(Object.keys(TREE).length);
  });
});
