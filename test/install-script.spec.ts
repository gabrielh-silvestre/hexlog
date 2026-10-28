import { beforeAll, describe, expect, it } from '@jest/globals';
import fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { detectLegacy } from '../src/adapters/fs/data-format.ts';
import { expectedRules } from '../src/guard.ts';
import { versionDirOf } from '../src/installation.ts';
import { at, createTempDir } from './helpers.ts';
import {
  buildSettingsTemplate,
  createInstallHome,
  denyOf,
  installBaseline,
  packageVersion,
  repoRoot,
  runInstaller,
} from './install-helpers.ts';

describe('scripts/install.ts', () => {
  const legacyFixture = path.join(repoRoot, 'test/fixtures/legacy-0x');
  const strayRule = 'Bash(rm:*)';

  function snapshotTree(root: string): Record<string, string | null> {
    return Object.fromEntries(
      fs
        .readdirSync(root, { recursive: true })
        .map(String)
        .sort()
        .map((relative) => {
          const absolute = path.join(root, relative);
          return [
            relative,
            fs.statSync(absolute).isDirectory() ? null : fs.readFileSync(absolute).toString('hex'),
          ];
        }),
    );
  }

  const packagesOf = (D: string): string[] => fs.readdirSync(path.join(D, 'archive')).sort();

  it('should abort before writing settings.json when the skill swap fails', () => {
    const { home, D } = createInstallHome('install-skill-swap-fails');
    const settingsPath = path.join(home, '.claude', 'settings.json');
    const template = buildSettingsTemplate(home);
    fs.mkdirSync(path.join(home, '.claude'), { recursive: true });
    fs.writeFileSync(settingsPath, template);
    // `skills` como arquivo comum: o mkdir de writeSkillFolder falha com EEXIST.
    fs.writeFileSync(path.join(home, '.claude', 'skills'), 'not a directory');

    const result = runInstaller(home, D, []);

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('EEXIST');
    expect(fs.readFileSync(settingsPath, 'utf8')).toBe(template);
  }, 60_000);

  it('should exit 1 with the message on stderr and write nothing for an unknown argument', () => {
    const disposableHome = createTempDir('install-unknown-arg');

    const result = runInstaller(disposableHome, path.join(disposableHome, 'data', 'hexlog'), [
      '--archive0x',
    ]);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('unknown argument: --archive0x');
    expect(fs.readdirSync(disposableHome)).toEqual([]);
  }, 30_000);

  describe('with --check', () => {
    let home: string;
    let D: string;
    let version: string;

    beforeAll(() => {
      ({ home, D, version } = installBaseline());
    }, 30_000);

    function runCheck(opts: { cwd?: string } = {}): { status: number | null; stdout: string } {
      const { status, stdout } = runInstaller(home, D, ['--check'], opts.cwd);
      return { status, stdout };
    }

    it('should exit 0 without artifact-modified or artifact-outdated on a complete installation', () => {
      const { status, stdout } = runCheck();

      expect(status).toBe(0);
      expect(stdout).not.toContain('artifact-modified');
      expect(stdout).not.toContain('artifact-outdated');
    }, 15_000);

    it('should report hook-file and exit 1 when the version directory is removed', () => {
      const versionDir = versionDirOf(home, version);
      const backup = `${versionDir}.backup-test`;
      fs.renameSync(versionDir, backup);
      try {
        const { status, stdout } = runCheck();

        expect(status).toBe(1);
        expect(stdout).toContain('hook-file');
      } finally {
        fs.renameSync(backup, versionDir);
      }
    }, 15_000);

    it('should report skill-file:<name> and exit 1 when a skill directory is removed', () => {
      const name = at(
        fs
          .readdirSync(path.join(repoRoot, 'skills'), { withFileTypes: true })
          .filter((entry) => entry.isDirectory())
          .map((entry) => entry.name),
        0,
      );
      const skillDir = path.join(home, '.claude', 'skills', name);
      const backup = `${skillDir}.backup-test`;
      fs.renameSync(skillDir, backup);
      try {
        const { status, stdout } = runCheck();

        expect(status).toBe(1);
        expect(stdout).toContain(`skill-file:${name}`);
      } finally {
        fs.renameSync(backup, skillDir);
      }
    }, 15_000);

    it('should give the same result when run from another cwd', () => {
      const fromRepo = runCheck();

      const fromOtherCwd = runCheck({ cwd: os.tmpdir() });

      expect(fromOtherCwd.status).toBe(fromRepo.status);
      expect(fromOtherCwd.stdout).toBe(fromRepo.stdout);
    }, 15_000);

    it('should still verify without aborting raw when <D> is unreadable with ENOTDIR', () => {
      const blocker = path.join(home, 'not-a-dir');
      fs.writeFileSync(blocker, '');

      const result = runInstaller(home, path.join(blocker, 'hexlog'), ['--check']);

      expect(result.stderr).not.toContain('ENOTDIR');
      expect(result.stdout).toContain('missing:');
    }, 15_000);
  });

  describe('with 0.x data', () => {
    it('should exit 2, list what it would archive and leave <D> intact without a flag', () => {
      const { home, D } = createInstallHome('install-legacy-list');
      fs.cpSync(legacyFixture, D, { recursive: true });
      const before = snapshotTree(D);

      const result = runInstaller(home, D, []);

      expect(result.status).toBe(2);
      expect(result.stdout).toContain('rerun with --archive-0x');
      expect(result.stdout).toContain('file: alpha/main/events.jsonl');
      expect(result.stdout).toContain('dir: alpha');
      expect(snapshotTree(D)).toEqual(before);
      expect(fs.readdirSync(home)).toEqual(['.local']);
    }, 30_000);

    it('should exit 1 without installing or deleting when a 0.x lock is held by a live process with --archive-0x', () => {
      const { home, D } = createInstallHome('install-legacy-live-lock');
      fs.cpSync(legacyFixture, D, { recursive: true });
      const lockDir = path.join(D, 'alpha', 'main', 'events.jsonl.lock');
      fs.mkdirSync(lockDir);
      // o pid do processo de teste está vivo enquanto o instalador roda
      fs.writeFileSync(path.join(lockDir, 'holder'), `${process.pid}-deadbeef`);
      const before = snapshotTree(D);

      const result = runInstaller(home, D, ['--archive-0x']);

      expect(result.status).toBe(1);
      expect(result.stderr).toContain('lock is held by a live process');
      expect(snapshotTree(D)).toEqual(before);
      expect(fs.readdirSync(home)).toEqual(['.local']);
    }, 30_000);

    it('should only verify and write nothing with --check --archive-0x', () => {
      const { home, D } = createInstallHome('install-legacy-check');
      fs.cpSync(legacyFixture, D, { recursive: true });
      const before = snapshotTree(home);

      const result = runInstaller(home, D, ['--check', '--archive-0x']);

      expect(result.status).toBe(1);
      expect(result.stdout).toContain('missing:');
      expect(snapshotTree(home)).toEqual(before);
    }, 30_000);
  });

  describe('with 0.x data archived by --archive-0x', () => {
    let home: string;
    let D: string;
    let version: string;
    let oldDenyRules: string[];
    let first: ReturnType<typeof runInstaller>;
    let second: ReturnType<typeof runInstaller>;
    let packagesAfterFirst: string[];

    // as duas execuções (build + servidor real) alimentam os testes do grupo, na ordem do uso real
    beforeAll(() => {
      version = packageVersion();
      ({ home, D } = createInstallHome('install-legacy-archived'));
      fs.cpSync(legacyFixture, D, { recursive: true });
      // <D> antigo que não existe em disco: só então o trio dele pode sair
      const old = expectedRules(
        path.join(home, 'old-data', 'hexlog'),
        home,
        process.execPath,
        version,
      );
      oldDenyRules = [old.denyReadDir, old.denyRead, old.denyEdit];
      fs.mkdirSync(path.join(home, '.claude'), { recursive: true });
      fs.writeFileSync(
        path.join(home, '.claude', 'settings.json'),
        JSON.stringify({ permissions: { deny: [strayRule, ...oldDenyRules] } }),
      );

      first = runInstaller(home, D, ['--archive-0x']);
      packagesAfterFirst = packagesOf(D);
      second = runInstaller(home, D, ['--archive-0x']);
    }, 120_000);

    it('should archive the 0.x data into <D>/archive on the first run', () => {
      expect(first.status).toBe(0);
      expect(first.stdout).toMatch(/archived \d+ file\(s\) of 0\.x data into .*hexlog-0x-.*\.tar/);
      expect(detectLegacy(D)).toEqual([]);
      expect(packagesAfterFirst).toHaveLength(1);
    });

    it('should install 1.0 after archiving on the first run', () => {
      expect(first.stdout).toContain(`hexlog ${version}: `);
      expect(fs.existsSync(path.join(versionDirOf(home, version), 'server.mjs'))).toBe(true);
    });

    it('should print one removed deny rule line per rule of the old <D> and keep the stray one', () => {
      const printed = first.stdout
        .split('\n')
        .filter((line) => line.includes('removed deny rule:'));
      const deny = denyOf(fs.readFileSync(path.join(home, '.claude', 'settings.json'), 'utf8'));

      expect(printed).toEqual(oldDenyRules.map((rule) => `  removed deny rule: ${rule}`));
      expect(deny).toContain(strayRule);

      for (const rule of oldDenyRules) expect(deny).not.toContain(rule);
    });

    it('should reinstall without error on a second run with --archive-0x', () => {
      expect(second.status).toBe(0);
    });

    it('should not archive again on a second run with --archive-0x', () => {
      expect(second.stdout).not.toContain('archived');
      expect(packagesOf(D)).toEqual(packagesAfterFirst);
    });

    it('should not remove any deny rule again on a second run with --archive-0x', () => {
      expect(second.stdout).not.toContain('removed deny rule');
    });
  });
});
