import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { createHash } from 'node:crypto';
// Import padrão: precisa ser o mesmo objeto de `src/archive.ts` para o `jest.spyOn` interceptar.
import fs from 'node:fs';
import * as path from 'node:path';
import * as tar from 'tar';
import { detectLegacy } from '../src/adapters/fs/data-format.ts';
import {
  ArchiveError,
  archiveLegacy,
  inspectLegacy,
  type ArchiveOptions,
  type ArchiveResult,
} from '../src/archive.ts';
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

/** Sobe um processo cujo `cmdline` termina em `file`; o padrão é o servidor 0.x instalado (`<libDir>/0.4.0/server.mjs`). */
function spawnLegacyServer(file = path.join(libDir, '0.4.0', 'server.mjs')): ChildProcess {
  const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)', file], {
    stdio: 'ignore',
  });
  children.push(child);
  return child;
}

/** `archiveLegacy` de um `<D>` que tem dado 0.x: estreita o resultado para ler `tarPath` e `dirs`. */
function archivedResult(): Extract<ArchiveResult, { archived: true }> {
  const result = archiveLegacy(dataDir, options);
  if (!result.archived) throw new Error('expected 0.x data to be archived');
  return result;
}

/** Planta `<D>/archive/<name>` com o formato de `tar` que o arquivador gera, variando o que ele contém. */
function plantTar(kind: 'complete' | 'other-sha' | 'partial' | 'garbage', name: string): void {
  const archiveDir = path.join(dataDir, 'archive');
  fs.mkdirSync(archiveDir, { recursive: true });
  const tarFile = path.join(archiveDir, name);
  if (kind === 'garbage') {
    fs.writeFileSync(tarFile, 'not a tar');
    return;
  }
  const staging = createTempDir('archive-stale');
  const [first, ...rest] = Object.keys(TREE);
  const names = kind === 'partial' ? [first!] : [first!, ...rest];
  for (const entry of names) {
    const absolute = path.join(staging, entry);
    fs.mkdirSync(path.dirname(absolute), { recursive: true });
    fs.writeFileSync(absolute, kind === 'other-sha' ? 'other content' : TREE[entry]!);
  }
  tar.create({ file: tarFile, cwd: staging, sync: true, portable: true }, names);
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

/** Troca `fs[method]` por um spy: `hook` recebe os argumentos de cada chamada e `real()`, que roda a original. */
function spyOnce<
  K extends 'renameSync' | 'unlinkSync' | 'readdirSync' | 'fsyncSync' | 'readFileSync',
>(method: K, hook: (args: unknown[], real: () => unknown) => unknown): void {
  const original = fs[method] as (...args: unknown[]) => unknown;
  jest
    .spyOn(fs, method)
    .mockImplementation(((...args: unknown[]) =>
      hook(args, () => original.apply(fs, args))) as never);
}

describe('inspectLegacy', () => {
  beforeEach(() => {
    dataDir = createTempDir('archive-data');
  });

  it('should list files with sha256 and directories without changing <D>', () => {
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

  it('should list the real tree of the fixture generated by the 0.x tools', () => {
    fs.cpSync(FIXTURE, dataDir, { recursive: true });

    const inventory = inspectLegacy(dataDir);

    expect(inventory.files.length).toBeGreaterThan(0);
    expect(inventory.dirs).toContain('alpha');
    expect(inventory.files.every((file) => /^[0-9a-f]{64}$/.test(file.sha256))).toBe(true);
  });

  it('should refuse a symlink with ArchiveError', () => {
    plant();
    fs.symlinkSync('/etc/hostname', path.join(dataDir, 'alpha', 'link'));

    expect(() => inspectLegacy(dataDir)).toThrow(ArchiveError);
  });

  it('should return an empty inventory for a <D> that does not exist', () => {
    expect(inspectLegacy(path.join(dataDir, 'missing'))).toEqual({ files: [], dirs: [] });
  });
});

describe('archiveLegacy', () => {
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

  it('should generate the .tar, check the sha256 and only then delete', () => {
    plant();
    const inventory = inspectLegacy(dataDir);

    const result = archivedResult();

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
    expect(fs.statSync(result.tarPath!).mode & 0o777).toBe(0o600);
    expect(fs.statSync(path.dirname(result.tarPath!)).mode & 0o777).toBe(0o700);
  });

  it('should archive the real fixture of the 0.x tools and leave only the archive', () => {
    fs.cpSync(FIXTURE, dataDir, { recursive: true });
    const { files } = inspectLegacy(dataDir);

    const result = archiveLegacy(dataDir, options);

    expect(result.files).toBe(files.length);
    expect(fs.readdirSync(dataDir)).toEqual(['archive']);
  });

  it('should do nothing and not create archive/ without 0.x data', () => {
    fs.mkdirSync(path.join(dataDir, '.v1'));
    const before = snapshot(dataDir);

    const result = archiveLegacy(dataDir, options);

    expect(result).toEqual({ archived: false, files: 0 });
    expect(snapshot(dataDir)).toEqual(before);
  });

  it('should do nothing on a second run', () => {
    plant();
    archiveLegacy(dataDir, options);
    const before = snapshot(dataDir);

    const result = archiveLegacy(dataDir, options);

    expect(result).toEqual({ archived: false, files: 0 });
    expect(snapshot(dataDir)).toEqual(before);
  });

  it('should delete nothing when the package verification fails', () => {
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

  it('should abort keeping the .tar when a file changes between the listing and the removal', () => {
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

  it('should abort and never delete a file created before the removal', () => {
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

  it('should never delete a file that appears during the removal', () => {
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
  });

  it('should archive what was left on the next run after a file appears during the removal', () => {
    plant();
    let unlinks = 0;
    spyOnce('unlinkSync', (args, real) => {
      real();
      if (++unlinks === 1) fs.writeFileSync(path.join(dataDir, 'alpha', 'appeared.txt'), 'new');
    });

    try {
      archiveLegacy(dataDir, options);
    } catch {
      // a 1ª execução termina interrompida pelo arquivo novo; é o estado que o caso prepara
    }
    jest.restoreAllMocks();

    const result = archiveLegacy(dataDir, options);

    expect(result).toMatchObject({ archived: true, files: 1 });
    expect(detectLegacy(dataDir)).toEqual([]);
  });

  it('should reuse the .tar and go through the re-hash when resuming after a partial removal', () => {
    plant();
    let unlinks = 0;
    spyOnce('unlinkSync', (args, real) => {
      if (++unlinks > 2) throw new Error('crash during removal');
      return real();
    });

    expect(() => archiveLegacy(dataDir, options)).toThrow('crash during removal');

    jest.restoreAllMocks();
    const [original] = packages();

    const resumed = archivedResult();

    expect(resumed.files).toBe(Object.keys(TREE).length - 2);
    expect(resumed.tarPath).toBe(path.join(dataDir, 'archive', original!));
    expect(packages()).toEqual([original]);
    expect(detectLegacy(dataDir)).toEqual([]);
  });

  describe('when an old .tar does not cover the files', () => {
    const OLD_TAR = 'hexlog-0x-29990101T000000Z.tar';

    it.each(['other-sha', 'partial', 'garbage'] as const)(
      'should generate a new package and leave the old .tar intact for the %s kind',
      (kind) => {
        plant();
        plantTar(kind, OLD_TAR);
        const staleBytes = fs.readFileSync(path.join(dataDir, 'archive', OLD_TAR));

        const result = archivedResult();

        expect(result.tarPath).not.toBe(path.join(dataDir, 'archive', OLD_TAR));
        expect(packages()).toHaveLength(2);
        expect(fs.readFileSync(path.join(dataDir, 'archive', OLD_TAR))).toEqual(staleBytes);
        expect(detectLegacy(dataDir)).toEqual([]);
      },
    );
  });

  it('should check the originals again and abort if one changed when resuming', () => {
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

  it('should remove a 0.x directory without files', () => {
    plantLock('gamma', undefined);
    const { files, dirs } = inspectLegacy(dataDir);

    expect(files).toEqual([]);

    const result = archiveLegacy(dataDir, options);

    expect(result).toEqual({
      archived: true,
      tarPath: undefined,
      files: 0,
      dirs: dirs.length,
    });
    expect(detectLegacy(dataDir)).toEqual([]);
  });

  it('should report no data on the run after removing a directory without files', () => {
    plantLock('gamma', undefined);
    archiveLegacy(dataDir, options);

    const result = archiveLegacy(dataDir, options);

    expect(result).toEqual({ archived: false, files: 0 });
  });

  it('should reuse the newest valid .tar and leave the others alone when resuming', () => {
    plant();
    plantTar('complete', 'hexlog-0x-20200101T000000Z.tar');
    plantTar('complete', 'hexlog-0x-29990101T000000Z.tar');

    const result = archivedResult();

    expect(result.tarPath).toBe(path.join(dataDir, 'archive', 'hexlog-0x-29990101T000000Z.tar'));
    expect(packages()).toHaveLength(2);
    expect(detectLegacy(dataDir)).toEqual([]);
  });

  it('should put a 0-byte file in the .tar and remove it from <D>', () => {
    plant({ 'alpha/main/events.jsonl': '' });

    const result = archivedResult();

    const packaged: string[] = [];
    tar.list({
      file: result.tarPath!,
      sync: true,
      onReadEntry: (entry) => packaged.push(entry.path),
    });

    expect(result.files).toBe(1);
    expect(packaged).toContain('alpha/main/events.jsonl');
    expect(detectLegacy(dataDir)).toEqual([]);
  });

  it('should fix the package on disk before deleting the first original', () => {
    plant();
    const calls: string[] = [];
    for (const method of ['renameSync', 'fsyncSync', 'unlinkSync'] as const) {
      spyOnce(method, (args, real) => {
        calls.push(method);
        return real();
      });
    }

    archiveLegacy(dataDir, options);

    jest.restoreAllMocks();

    expect(calls.slice(calls.indexOf('renameSync'), calls.indexOf('unlinkSync'))).toEqual([
      'renameSync',
      'fsyncSync',
    ]);
  });

  it('should abort citing the path and delete nothing for a hard link in the 0.x data', () => {
    plant();
    fs.linkSync(
      path.join(dataDir, 'alpha/main/events.jsonl'),
      path.join(dataDir, 'alpha/main/events.link'),
    );
    const before = snapshot(dataDir);

    expect(() => archiveLegacy(dataDir, options)).toThrow(
      /hard link\): alpha\/main\/events\.jsonl/,
    );

    expect(snapshot(dataDir)).toEqual(before);
  });

  it('should abort citing the path and keep the .tar when a file vanishes between the listing and the re-read', () => {
    plant();
    const events = path.join(dataDir, 'alpha/main/events.jsonl');
    let reads = 0;
    spyOnce('readFileSync', (args, real) => {
      if (args[0] === events && ++reads === 2) {
        throw Object.assign(new Error('ENOENT: no such file or directory'), {
          code: 'ENOENT',
          path: events,
        });
      }
      return real();
    });

    expect(() => archiveLegacy(dataDir, options)).toThrow(
      /vanished while archiving: .*events\.jsonl; rerun to resume/,
    );

    jest.restoreAllMocks();

    expect(packages()).toHaveLength(1);
    expect(inspectLegacy(dataDir).files).toHaveLength(Object.keys(TREE).length);
  });

  it('should abort citing the errno and delete nothing when archive is a regular file', () => {
    plant();
    fs.writeFileSync(path.join(dataDir, 'archive'), 'not a dir');
    const before = snapshot(dataDir);

    expect(() => archiveLegacy(dataDir, options)).toThrow(
      /0\.x archiving failed \(ENOTDIR\): .*archive/,
    );

    expect(snapshot(dataDir)).toEqual(before);
  });

  it('should delete an old .partial', () => {
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
  });

  it('should leave alone what is not in the listing', () => {
    plant();
    fs.mkdirSync(path.join(dataDir, '.v1', 'alpha'), { recursive: true });
    fs.writeFileSync(path.join(dataDir, '.v1', 'alpha', 'records.jsonl'), 'v1 data');
    fs.mkdirSync(path.join(dataDir, 'archive'));
    fs.writeFileSync(
      path.join(dataDir, 'archive', 'hexlog-0x-20200101T000000Z.tar.partial'),
      'junk',
    );

    archiveLegacy(dataDir, options);

    expect(fs.readFileSync(path.join(dataDir, '.v1', 'alpha', 'records.jsonl'), 'utf8')).toBe(
      'v1 data',
    );
  });

  describe('with a 0.x lock', () => {
    it('should abort without deleting when the lock pid is a running process', () => {
      plant();
      plantLock('alpha', `${process.pid}-deadbeef`);
      const before = snapshot(dataDir);

      expect(() => archiveLegacy(dataDir, options)).toThrow(
        /lock is held by a live process.*pid was reused: remove .*events\.jsonl\.lock by hand/,
      );

      expect(snapshot(dataDir)).toEqual(before);
    });

    it('should abort without deleting when the lock holder is unreadable', () => {
      plant();
      plantLock('alpha', 'not-a-token');

      expect(() => archiveLegacy(dataDir, options)).toThrow(
        /unreadable holder.*remove .*events\.jsonl\.lock by hand/,
      );
      expect(fs.existsSync(path.join(dataDir, 'alpha/main/process.json'))).toBe(true);
    });

    it('should abort as an unreadable holder, not as a live process, when the lock pid is outside int32', () => {
      plant();
      plantLock('alpha', '99999999999-deadbeef');

      expect(() => archiveLegacy(dataDir, options)).toThrow(/unreadable holder/);
      expect(fs.existsSync(path.join(dataDir, 'alpha/main/process.json'))).toBe(true);
    });

    it('should not block the archiving when the lock holder has 0 bytes, counting it as dead', () => {
      plant();
      plantLock('alpha', '');

      const result = archiveLegacy(dataDir, options);

      expect(result).toMatchObject({ archived: true });
      expect(detectLegacy(dataDir)).toEqual([]);
    });

    it('should not block the archiving when the lock pid already exited', () => {
      plant();
      plantLock('alpha', `${deadPid()}-deadbeef`);

      const result = archiveLegacy(dataDir, options);

      expect(result).toMatchObject({ archived: true });
      expect(detectLegacy(dataDir)).toEqual([]);
    });

    it('should abort at the second check when a live lock appears while the package is generated', () => {
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

  describe('with a 0.x server', () => {
    it('should abort without deleting when a live process runs <libDir>/0.4.0/server.mjs', () => {
      plant();
      const child = spawnLegacyServer();
      const before = snapshot(dataDir);

      expect(() => archiveLegacy(dataDir, options)).toThrow(`pid ${child.pid}`);

      expect(snapshot(dataDir)).toEqual(before);
    });

    it('should not block the archiving with a live server of another libDir', () => {
      plant();
      spawnLegacyServer(path.join(createTempDir('archive-other-lib'), '0.4.0', 'server.mjs'));

      expect(archiveLegacy(dataDir, options)).toMatchObject({ archived: true });
    });

    it.each(['1.0.0/server.mjs', '0.4.0/bash-guard.mjs'])(
      'should not block the archiving with a live process at <libDir>/%s',
      (file) => {
        plant();
        spawnLegacyServer(path.join(libDir, file));

        expect(archiveLegacy(dataDir, options)).toMatchObject({ archived: true });
      },
    );

    it('should find the live server through the libDir symlink when the cmdline uses the real path', () => {
      plant();
      const link = path.join(createTempDir('archive-link'), 'lib');
      fs.symlinkSync(libDir, link);
      spawnLegacyServer();

      expect(() => archiveLegacy(dataDir, { ...options, libDir: link })).toThrow(
        /a 0\.x server is running/,
      );
    });

    it('should not break the live-server check when the libDir does not exist', () => {
      plant();

      expect(
        archiveLegacy(dataDir, { ...options, libDir: path.join(libDir, 'missing') }),
      ).toMatchObject({ archived: true });
    });

    it('should abort without deleting when the live server cannot be confirmed without /proc', () => {
      plant();
      const before = snapshot(dataDir);

      expect(() =>
        archiveLegacy(dataDir, { ...options, procDir: path.join(dataDir, '..', 'no-proc') }),
      ).toThrow(/cannot confirm/);

      expect(snapshot(dataDir)).toEqual(before);
    });

    it('should abort without deleting when the live server cannot be confirmed with a /proc that has no pid', () => {
      plant();
      const before = snapshot(dataDir);

      expect(() =>
        archiveLegacy(dataDir, { ...options, procDir: createTempDir('archive-proc') }),
      ).toThrow(/cannot confirm/);

      expect(snapshot(dataDir)).toEqual(before);
    });

    it('should abort without deleting when the cmdline is unreadable by an errno that is not a permission one', () => {
      plant();
      const procDir = createTempDir('archive-proc');
      fs.mkdirSync(path.join(procDir, '123', 'cmdline'), { recursive: true });
      const before = snapshot(dataDir);

      expect(() => archiveLegacy(dataDir, { ...options, procDir })).toThrow(
        /cannot confirm.*cannot read .*cmdline \(EISDIR\)/,
      );

      expect(snapshot(dataDir)).toEqual(before);
    });

    it.each(['ENOENT', 'ESRCH', 'EACCES', 'EPERM'])(
      'should not block the archiving when the cmdline read is denied with %s',
      (code) => {
        plant();
        spyOnce('readFileSync', (args, real) => {
          if (String(args[0]).endsWith('/cmdline')) throw Object.assign(new Error(code), { code });
          return real();
        });

        expect(archiveLegacy(dataDir, options)).toMatchObject({ archived: true });
      },
    );

    it('should abort at the second check when a live server appears while the package is generated', () => {
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
});
