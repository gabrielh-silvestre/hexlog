import { afterAll, afterEach, beforeAll, describe, expect, it, jest } from '@jest/globals';
// Import padrão: precisa ser o mesmo objeto que src/installation.ts usa, para o `jest.spyOn(fs, ...)`
// interceptar de fato a chamada feita lá dentro (mesmo motivo documentado no comentário do
// `import fs` de src/adapters/fs/process-store.ts).
import fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { sha256hex } from '../src/domain/chain.ts';
import { expectedRules, runRealHook } from '../src/guard.ts';
import {
  versionDirOf,
  readManifest,
  installArtifact,
  TOOLS_COUNT,
  registerGuard,
  writeSkillFolder,
  verifyInstallation,
  type Bundles,
} from '../src/installation.ts';
import { createTempDir } from './helpers.ts';
import { buildSettingsTemplate, installBaseline, repoRoot, useHome } from './install-helpers.ts';

type InstallArgs = Parameters<typeof installArtifact>[0];

describe('installArtifact', () => {
  // Bundles reais construídos uma vez (esbuild custa ~1s) e reaproveitados por
  // todos os casos que não precisam de um build "diferente" de propósito.
  let realBundles: Bundles;

  beforeAll(() => {
    const outdir = createTempDir('install-build');
    const build = spawnSync(
      process.execPath,
      [path.join(repoRoot, 'scripts/build.ts'), '--outdir', outdir],
      {
        encoding: 'utf8',
        cwd: repoRoot,
      },
    );
    if (build.status !== 0) {
      throw new Error(`build failed: ${build.stderr}`);
    }
    realBundles = {
      server: fs.readFileSync(path.join(outdir, 'server.mjs')),
      hook: fs.readFileSync(path.join(outdir, 'bash-guard.mjs')),
    };
  }, 30_000);

  // Roda o hook preparado (real) exatamente como `scripts/install.ts` injetaria.
  const runRealHookForInstall = (hookFile: string, stdin: string): { status: number | null } =>
    runRealHook(process.execPath, hookFile, stdin);

  /** Sobe o servidor preparado num HOME/XDG_DATA_HOME descartáveis e conta as tools anunciadas (uso real). */
  async function countRealTools(serverFile: string): Promise<number> {
    const disposableHome = createTempDir('verify');
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [serverFile],
      env: { HOME: disposableHome, XDG_DATA_HOME: path.join(disposableHome, 'data') },
    });
    const client = new Client({ name: 'install-test', version: '0.0.0' });
    await client.connect(transport);
    const { tools } = await client.listTools();
    await client.close();
    return tools.length;
  }

  const fakeVerifyServer = (): Promise<number> => Promise.resolve(TOOLS_COUNT);

  /** Argumentos de `installArtifact` com os bundles reais e as sondas reais; `overrides` muda só o que o caso prova. */
  const installArgs = (home: string, overrides: Partial<InstallArgs> = {}): InstallArgs => ({
    home,
    version: '0.1.0',
    bundles: realBundles,
    commit: null,
    dirty: false,
    clock: () => new Date(),
    runHook: runRealHookForInstall,
    verifyServer: fakeVerifyServer,
    ...overrides,
  });

  function runConcurrentFixture(
    home: string,
    version: string,
    variant: string,
    processId: number,
    totalProcesses: number,
    mode?: 'interleave',
  ): Promise<{ status: number | null; stdout: string; stderr: string }> {
    return new Promise((resolve, reject) => {
      const child = spawn(
        process.execPath,
        [
          path.join(repoRoot, 'test/fixtures/concurrent-install.ts'),
          home,
          version,
          variant,
          String(processId),
          String(totalProcesses),
          ...(mode === undefined ? [] : [mode]),
        ],
        { cwd: repoRoot },
      );
      let stdout = '';
      let stderr = '';
      child.stdout.on('data', (d) => (stdout += d));
      child.stderr.on('data', (d) => (stderr += d));
      child.on('error', reject);
      child.on('close', (status) => resolve({ status, stdout, stderr }));
    });
  }

  /** Instala uma versão com bundles sintéticos, o estado que o fixture de concorrência reinstala por cima. */
  function installInitialBuild(home: string): Promise<unknown> {
    return installArtifact(
      installArgs(home, {
        bundles: { server: Buffer.from('initial-server'), hook: Buffer.from('initial-hook') },
        runHook: (_hookFile, stdin) => ({ status: stdin.includes('/probe') ? 2 : 0 }),
      }),
    );
  }

  it('should install under <HOME>/.local/lib/hexlog/<version>/ with the 2 bundles and manifest.json using a real Client', async () => {
    const home = createTempDir('install-fresh');

    const result = await installArtifact(
      installArgs(home, {
        commit: 'test-commit',
        clock: () => new Date('2026-01-01T00:00:00.000Z'),
        verifyServer: countRealTools,
      }),
    );

    const versionDir = versionDirOf(home, '0.1.0');

    expect(result.action).toBe('installed');
    expect(result.versionDir).toBe(versionDir);
    expect(fs.existsSync(path.join(versionDir, 'server.mjs'))).toBe(true);
    expect(fs.existsSync(path.join(versionDir, 'bash-guard.mjs'))).toBe(true);
    expect(readManifest(versionDir)).toEqual({
      version: '0.1.0',
      sha256: {
        server: sha256hex(realBundles.server),
        hook: sha256hex(realBundles.hook),
      },
      builtAt: '2026-01-01T00:00:00.000Z',
      commit: 'test-commit',
      dirty: false,
    });
  }, 20_000);

  describe('when the install runs a second time without changes', () => {
    let first: Awaited<ReturnType<typeof installArtifact>>;
    let second: Awaited<ReturnType<typeof installArtifact>>;
    let settingsPath: string;
    let settingsBefore: string;
    let mtimeBefore: number;

    beforeAll(async () => {
      const home = createTempDir('install-rerun');
      const args = installArgs(home, { commit: 'c1' });
      first = await installArtifact(args);
      mtimeBefore = fs.statSync(first.versionDir).mtimeMs;
      const D = path.join(home, '.local', 'share', 'hexlog');
      settingsPath = path.join(home, '.claude', 'settings.json');
      fs.mkdirSync(path.dirname(settingsPath), { recursive: true });
      fs.writeFileSync(settingsPath, buildSettingsTemplate(home));
      registerGuard({
        settingsPath,
        expected: expectedRules(D, home, process.execPath, '0.1.0'),
      });
      settingsBefore = fs.readFileSync(settingsPath, 'utf8');

      second = await installArtifact(args);
    }, 30_000);

    it('should decide by the installed bytes and report no action', () => {
      expect(second).toEqual({
        action: 'none',
        versionDir: first.versionDir,
        manifest: first.manifest,
        warnings: [],
      });
    });

    it('should leave settings and the mtime of the version directory untouched', () => {
      expect(fs.statSync(first.versionDir).mtimeMs).toBe(mtimeBefore);
      expect(fs.readFileSync(settingsPath, 'utf8')).toBe(settingsBefore);
    });
  });

  it('should create a new version directory and keep the old one when the version changes', async () => {
    const home = createTempDir('install-new-version');
    const first = await installArtifact(installArgs(home, { version: '0.1.0' }));

    const second = await installArtifact(installArgs(home, { version: '0.2.0' }));

    expect(second.action).toBe('installed');
    expect(fs.existsSync(first.versionDir)).toBe(true);
    expect(fs.existsSync(second.versionDir)).toBe(true);
  }, 20_000);

  it('should swap atomically and warn when the same version is reinstalled with different bundles', async () => {
    const home = createTempDir('install-reinstall');
    await installArtifact(installArgs(home, { commit: 'c' }));
    const differentHook = Buffer.concat([realBundles.hook, Buffer.from('\n// different bytes\n')]);

    const result = await installArtifact(
      installArgs(home, {
        commit: 'c',
        bundles: { server: realBundles.server, hook: differentHook },
      }),
    );

    expect(result.action).toBe('reinstalled');
    expect(result.warnings).toEqual(
      expect.arrayContaining([expect.stringContaining('reinstalled with different content')]),
    );
    expect(fs.readFileSync(path.join(result.versionDir, 'bash-guard.mjs'))).toEqual(differentHook);
  }, 20_000);

  it.each([
    {
      name: 'the prepared hook does not deny',
      overrides: (): Partial<InstallArgs> => ({ runHook: () => ({ status: 0 }) }),
      message: expect.stringContaining('prepared hook does not deny access to the data directory'),
    },
    {
      name: 'the server bundle has a dynamic require',
      overrides: (): Partial<InstallArgs> => ({
        bundles: {
          server: Buffer.concat([
            realBundles.server,
            Buffer.from('\n// Dynamic require of "x" is not supported\n'),
          ]),
          hook: realBundles.hook,
        },
      }),
      message: expect.stringContaining('Dynamic require of'),
    },
    {
      name: 'the prepared server does not list every tool',
      overrides: (): Partial<InstallArgs> => ({
        verifyServer: () => Promise.resolve(TOOLS_COUNT - 1),
      }),
      message: expect.stringContaining(`${TOOLS_COUNT - 1} tools`),
    },
    {
      name: 'the prepared hook denies but does not allow a harmless command',
      overrides: (): Partial<InstallArgs> => {
        // a 1ª sonda (deny) devolve 2 e a 2ª (allow) devolve diferente de 0
        const statuses = [2, 1];
        return { runHook: () => ({ status: statuses.shift() ?? null }) };
      },
      message: 'prepared hook does not allow harmless commands',
    },
    {
      name: 'the prepared server fails to start',
      overrides: (): Partial<InstallArgs> => ({
        verifyServer: () => Promise.reject(new Error('boom')),
      }),
      message: 'prepared server failed to start: boom',
    },
  ])(
    'should abort with an INTERNAL error and without the version directory when $name',
    async ({ overrides, message }) => {
      const home = createTempDir('install-aborted');

      await expect(installArtifact(installArgs(home, overrides()))).rejects.toMatchObject({
        code: 'INTERNAL',
        message,
        details: [],
      });
      expect(fs.existsSync(versionDirOf(home, '0.1.0'))).toBe(false);
      expect(fs.readdirSync(path.join(home, '.local', 'lib', 'hexlog'))).toEqual([]);
    },
    20_000,
  );

  it('should leave the installed version untouched when a later install fails the verification', async () => {
    const home = createTempDir('install-later-fails');
    const installed = await installArtifact(installArgs(home));
    const hookBefore = fs.readFileSync(path.join(installed.versionDir, 'bash-guard.mjs'));

    await expect(
      installArtifact(
        installArgs(home, {
          bundles: {
            server: realBundles.server,
            hook: Buffer.concat([realBundles.hook, Buffer.from('\n// x\n')]),
          },
          runHook: () => ({ status: 0 }),
        }),
      ),
    ).rejects.toThrow(/does not deny/);
    expect(fs.readFileSync(path.join(installed.versionDir, 'bash-guard.mjs'))).toEqual(hookBefore);
    expect(fs.readdirSync(path.join(home, '.local', 'lib', 'hexlog')).sort()).toEqual(['0.1.0']);
  }, 20_000);

  it('should repair an installed artifact changed from outside on the next run', async () => {
    const home = createTempDir('install-repair');
    const args = installArgs(home);
    const first = await installArtifact(args);
    const installedHookFile = path.join(first.versionDir, 'bash-guard.mjs');
    fs.writeFileSync(
      installedHookFile,
      Buffer.concat([realBundles.hook, Buffer.from('\n// modified externally\n')]),
    );

    const second = await installArtifact(args);

    expect(second.action).toBe('repaired');
    expect(second.warnings).toEqual(
      expect.arrayContaining([expect.stringContaining('installed artifact modified')]),
    );
    expect(fs.readFileSync(installedHookFile)).toEqual(realBundles.hook);
  }, 20_000);

  it('should converge when concurrent installers run the same build', async () => {
    const home = createTempDir('concurrency-same');

    const [r1, r2] = await Promise.all([
      runConcurrentFixture(home, '0.1.0', 'x', 1, 2),
      runConcurrentFixture(home, '0.1.0', 'x', 2, 2),
    ]);

    expect([r1, r2]).toEqual([
      expect.objectContaining({ status: 0 }),
      expect.objectContaining({ status: 0 }),
    ]);
    expect(fs.readdirSync(versionDirOf(home, '0.1.0')).sort()).toEqual([
      'bash-guard.mjs',
      'manifest.json',
      'server.mjs',
    ]);
  }, 20_000);

  describe('when concurrent installers run different builds', () => {
    let home: string;
    let results: Awaited<ReturnType<typeof runConcurrentFixture>>[];

    beforeAll(async () => {
      home = createTempDir('concurrency-different');
      results = await Promise.all([
        runConcurrentFixture(home, '0.1.0', 'x', 1, 2),
        runConcurrentFixture(home, '0.1.0', 'y', 2, 2),
      ]);
    }, 30_000);

    it('should let only one win', () => {
      const sorted = results.sort((a, b) => (a.status ?? -1) - (b.status ?? -1));

      expect(sorted).toEqual([
        expect.objectContaining({ status: 0 }),
        expect.objectContaining({ status: 1 }),
      ]);
    });

    it('should tell the loser that two installations ran at the same time', () => {
      const loser = results.find(({ status }) => status === 1);

      expect(loser?.stdout).toContain('at the same time');
    });

    it('should leave the version directory with the 2 bundles and manifest.json', () => {
      expect(fs.readdirSync(versionDirOf(home, '0.1.0')).sort()).toEqual([
        'bash-guard.mjs',
        'manifest.json',
        'server.mjs',
      ]);
    });
  });

  it('should treat ENOENT on the first renameSync as concurrency, leaving no mixed directory on a concurrent reinstall', async () => {
    const home = createTempDir('concurrency-reinstall');
    // versão já instalada antes da corrida: o primeiro renameSync de cada
    // filho (versionDir → old) só pode achar ENOENT se o outro já a moveu.
    await installInitialBuild(home);

    const [r1, r2] = await Promise.all([
      runConcurrentFixture(home, '0.1.0', 'new', 1, 2),
      runConcurrentFixture(home, '0.1.0', 'new', 2, 2),
    ]);

    const versionDir = versionDirOf(home, '0.1.0');

    expect([r1, r2]).toEqual([
      expect.objectContaining({ status: 0 }),
      expect.objectContaining({ status: 0 }),
    ]);
    expect(fs.readdirSync(versionDir).sort()).toEqual([
      'bash-guard.mjs',
      'manifest.json',
      'server.mjs',
    ]);
    expect(fs.readFileSync(path.join(versionDir, 'server.mjs'), 'utf8')).toBe('server-new');
  }, 20_000);

  it('should not share the backup directory when concurrent reinstalls run in the same millisecond', async () => {
    const home = createTempDir('concurrency-same-ms');
    await installInitialBuild(home);

    // o processo 2 perde a troca; o 1 conclui e não sobra backup
    const [first, second] = await Promise.all([
      runConcurrentFixture(home, '0.1.0', 'new', 1, 2, 'interleave'),
      runConcurrentFixture(home, '0.1.0', 'new', 2, 2, 'interleave'),
    ]);

    expect(first).toEqual(expect.objectContaining({ status: 0 }));
    expect(second).toEqual(
      expect.objectContaining({
        status: 1,
        stdout: expect.stringContaining('another installation swapped'),
      }),
    );
    // os dois marcos provam que a intercalação do fixture de fato aconteceu
    expect(fs.existsSync(path.join(home, '.first-backed-up'))).toBe(true);
    expect(fs.existsSync(path.join(home, '.second-finished'))).toBe(true);
    expect(fs.readFileSync(path.join(versionDirOf(home, '0.1.0'), 'server.mjs'), 'utf8')).toBe(
      'server-new',
    );
    expect(fs.readdirSync(path.dirname(versionDirOf(home, '0.1.0')))).toEqual(['0.1.0']);
  }, 20_000);
});

describe('writeSkillFolder', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  /** Pasta de origem sintética com um `SKILL.md` (e, se passado, um arquivo extra em `references/`). */
  function buildSrcDir(skillText: string, extraFile?: { path: string; text: string }): string {
    const srcDir = createTempDir('skill-src');
    fs.writeFileSync(path.join(srcDir, 'SKILL.md'), skillText);
    if (extraFile) {
      fs.mkdirSync(path.join(srcDir, path.dirname(extraFile.path)), { recursive: true });
      fs.writeFileSync(path.join(srcDir, extraFile.path), extraFile.text);
    }
    return srcDir;
  }

  /** `skills/` de um `<home>/.claude` descartável. */
  const skillsDirOf = (home: string): string => path.join(home, '.claude', 'skills');

  /** Faz o 2º `renameSync` (tmp → dstDir) falhar; o 1º (dstDir → old) passa de verdade. */
  function failSecondRename(): void {
    const originalRenameSync = fs.renameSync;
    jest
      .spyOn(fs, 'renameSync')
      .mockImplementationOnce((...args) => originalRenameSync(...args))
      .mockImplementationOnce(() => {
        throw new Error('boom: simulated 2nd renameSync failure');
      });
  }

  it('should copy SKILL.md and references/ to <home>/.claude/skills/<name>/', () => {
    const home = createTempDir('skill-copy');
    const srcDir = buildSrcDir('# hexlog skill\n', {
      path: 'references/guide.md',
      text: '# guide\n',
    });

    writeSkillFolder(home, 'hexlog', srcDir);

    const skillDir = path.join(skillsDirOf(home), 'hexlog');

    expect(fs.readFileSync(path.join(skillDir, 'SKILL.md'), 'utf8')).toBe('# hexlog skill\n');
    expect(fs.readFileSync(path.join(skillDir, 'references', 'guide.md'), 'utf8')).toBe(
      '# guide\n',
    );
  });

  it('should leave the file identical when installed twice in a row', () => {
    const home = createTempDir('skill-twice');
    const srcDir = buildSrcDir('# hexlog skill\n');
    writeSkillFolder(home, 'hexlog', srcDir);

    writeSkillFolder(home, 'hexlog', srcDir);

    expect(fs.readFileSync(path.join(skillsDirOf(home), 'hexlog', 'SKILL.md'), 'utf8')).toBe(
      '# hexlog skill\n',
    );
  });

  it('should overwrite a hand-edited file with the canonical one without creating a .bak', () => {
    const home = createTempDir('skill-hand-edited');
    const srcDir = buildSrcDir('# hexlog skill\n');
    const skillDir = path.join(skillsDirOf(home), 'hexlog');
    const skillFile = path.join(skillDir, 'SKILL.md');
    fs.mkdirSync(skillDir, { recursive: true });
    fs.writeFileSync(skillFile, 'editado à mão');

    writeSkillFolder(home, 'hexlog', srcDir);

    expect(fs.readFileSync(skillFile, 'utf8')).toBe('# hexlog skill\n');
    expect(fs.existsSync(`${skillFile}.bak-hexlog`)).toBe(false);
    expect(fs.readdirSync(skillDir)).toEqual(['SKILL.md']);
  });

  it('should remove an orphaned references/ file when reinstalling from a srcDir without it', () => {
    const home = createTempDir('skill-orphan-reference');
    writeSkillFolder(
      home,
      'hexlog',
      buildSrcDir('# hexlog skill v1\n', {
        path: 'references/old-guide.md',
        text: '# old guide\n',
      }),
    );
    const orphanFile = path.join(skillsDirOf(home), 'hexlog', 'references', 'old-guide.md');

    expect(fs.existsSync(orphanFile)).toBe(true);

    writeSkillFolder(home, 'hexlog', buildSrcDir('# hexlog skill v2\n'));

    expect(fs.existsSync(orphanFile)).toBe(false);
  });

  it('should keep the previous dstDir content intact when srcDir does not exist and cpSync fails', () => {
    const home = createTempDir('skill-missing-src');
    writeSkillFolder(home, 'hexlog', buildSrcDir('# hexlog skill\n'));
    const missingSrcDir = path.join(os.tmpdir(), 'hexlog-skill-src-does-not-exist');

    expect(() => writeSkillFolder(home, 'hexlog', missingSrcDir)).toThrow(/ENOENT/);

    expect(fs.readFileSync(path.join(skillsDirOf(home), 'hexlog', 'SKILL.md'), 'utf8')).toBe(
      '# hexlog skill\n',
    );
  });

  it.each([
    {
      name: 'tmp-/old- plus digits leftovers of the skill',
      skills: ['hexlog'],
      removed: ['hexlog.tmp-123', 'hexlog.old-123'],
      kept: ['hexlog.old-notes', 'other.tmp-123'],
    },
    {
      name: 'entries whose suffix is not tmp-/old- plus digits',
      skills: ['hexlog'],
      removed: ['hexlog.tmp-7', 'hexlog.old-42'],
      kept: ['hexlog.tmp-', 'hexlog.tmp-12a', 'hexlog.old-1-2', 'hexlog.bak-123', 'hexlog-tmp-123'],
    },
    {
      name: 'skill names with regex metacharacters',
      skills: ['c++', 'c+(a[b'],
      removed: ['c++.tmp-123', 'c++.old-123', 'c+(a[b.old-5'],
      kept: ['c++.old-notes', 'cc.tmp-123', 'c+(a[b.tmp-9x'],
    },
  ])(
    'should sweep only the legacy leftovers of the skill in skills/, as in $name',
    ({ skills, removed, kept }) => {
      const home = createTempDir('skill-legacy-sweep');
      const srcDir = buildSrcDir('# skill\n');
      const skillsDir = skillsDirOf(home);
      for (const leftover of [...removed, ...kept]) {
        fs.mkdirSync(path.join(skillsDir, leftover), { recursive: true });
      }

      for (const skill of skills) writeSkillFolder(home, skill, srcDir);

      expect(fs.readdirSync(skillsDir).sort()).toEqual([...skills, ...kept].sort());
    },
  );

  it('should keep the previous skill when the 2nd renameSync fails mid-swap, leaving no temporary in skills/ or .claude/', () => {
    const home = createTempDir('skill-rename-fails');
    writeSkillFolder(home, 'hexlog', buildSrcDir('# hexlog skill v1\n'));
    failSecondRename();

    expect(() => writeSkillFolder(home, 'hexlog', buildSrcDir('# hexlog skill v2\n'))).toThrow(
      'boom',
    );

    expect(fs.readdirSync(skillsDirOf(home))).toEqual(['hexlog']);
    expect(fs.readdirSync(path.join(home, '.claude'))).toEqual(['skills']);
    expect(fs.readFileSync(path.join(skillsDirOf(home), 'hexlog', 'SKILL.md'), 'utf8')).toBe(
      '# hexlog skill v1\n',
    );
  });

  it('should finish the install and keep sweeping the legacy residue when removing one entry fails', () => {
    const home = createTempDir('skill-sweep-eacces');
    const srcDir = buildSrcDir('# hexlog skill v2\n');
    const originalRmSync = fs.rmSync;
    const skillsDir = skillsDirOf(home);
    fs.mkdirSync(path.join(skillsDir, 'hexlog.tmp-1'), { recursive: true });
    fs.mkdirSync(path.join(skillsDir, 'hexlog.old-2'), { recursive: true });
    jest.spyOn(fs, 'rmSync').mockImplementation((target, options) => {
      if (String(target).endsWith('hexlog.tmp-1')) {
        throw Object.assign(new Error('EACCES: permission denied'), { code: 'EACCES' });
      }
      originalRmSync(target, options);
    });

    expect(() => writeSkillFolder(home, 'hexlog', srcDir)).not.toThrow();

    expect(fs.readFileSync(path.join(skillsDir, 'hexlog', 'SKILL.md'), 'utf8')).toBe(
      '# hexlog skill v2\n',
    );
    expect(fs.readdirSync(skillsDir).sort()).toEqual(['hexlog', 'hexlog.tmp-1']);
  });

  it('should ignore, in the orphan sweep, a failure to list the temporary directory', () => {
    const home = createTempDir('skill-orphans-unreadable');
    const srcDir = buildSrcDir('# hexlog skill v2\n');
    const originalReaddirSync = fs.readdirSync.bind(fs) as (dir: fs.PathLike) => string[];
    const claudeDir = path.join(fs.realpathSync(home), '.claude');
    const orphan = `.hexlog-skill-hexlog.tmp-${spawnSync(process.execPath, ['-e', '']).pid}`;
    fs.mkdirSync(path.join(claudeDir, orphan), { recursive: true });
    jest.spyOn(fs, 'readdirSync').mockImplementation(((dir: fs.PathLike) => {
      if (String(dir) === claudeDir) {
        throw Object.assign(new Error('EACCES: permission denied'), { code: 'EACCES' });
      }
      return originalReaddirSync(dir);
    }) as typeof fs.readdirSync);

    expect(() => writeSkillFolder(home, 'hexlog', srcDir)).not.toThrow();

    jest.restoreAllMocks();

    expect(fs.readFileSync(path.join(claudeDir, 'skills', 'hexlog', 'SKILL.md'), 'utf8')).toBe(
      '# hexlog skill v2\n',
    );
    expect(fs.readdirSync(claudeDir).sort()).toEqual([orphan, 'skills'].sort());
  }, 15_000);

  it('should remove, in the orphan sweep, temporaries of a dead pid and keep live, foreign and non-numeric ones', () => {
    const home = createTempDir('skill-orphans');
    const srcDir = buildSrcDir('# hexlog skill\n');
    const claudeDir = path.join(home, '.claude');
    const deadPid = spawnSync(process.execPath, ['-e', '']).pid;
    const orphans = [`.hexlog-skill-hexlog.tmp-${deadPid}`, `.hexlog-skill-hexlog.old-${deadPid}`];
    const kept = [
      `.hexlog-skill-hexlog.tmp-${process.ppid}`,
      `.hexlog-skill-hexlog.old-${process.ppid}`,
      `.hexlog-skill-hexlog.old-${deadPid}x`,
      `.hexlog-skill-other.tmp-${deadPid}`,
    ];
    for (const leftover of [...orphans, ...kept]) {
      fs.mkdirSync(path.join(claudeDir, leftover), { recursive: true });
    }

    writeSkillFolder(home, 'hexlog', srcDir);

    const remaining = fs
      .readdirSync(claudeDir)
      .filter((entry) => entry.startsWith('.hexlog-skill-'));

    expect(remaining.sort()).toEqual([...kept].sort());
  }, 15_000);

  it('should keep, in the orphan sweep, a temporary whose pid is above the int32 range', () => {
    const home = createTempDir('skill-orphans-big-pid');
    const srcDir = buildSrcDir('# hexlog skill\n');
    const claudeDir = path.join(home, '.claude');
    const huge = `.hexlog-skill-hexlog.tmp-${2 ** 31}`;
    fs.mkdirSync(path.join(claudeDir, huge), { recursive: true });

    writeSkillFolder(home, 'hexlog', srcDir);

    expect(fs.readdirSync(claudeDir)).toContain(huge);
  }, 15_000);

  it('should keep the temporaries beside the target and avoid EXDEV when skills/ is a link to another filesystem', () => {
    const home = createTempDir('skill-link');
    const elsewhere = createTempDir('skill-link-target');
    const srcDir = buildSrcDir('# hexlog skill\n');
    const originalRenameSync = fs.renameSync;
    // `skills/` aponta para fora do HOME: simula o outro filesystem (dotfiles, mount).
    const realSkills = path.join(elsewhere, 'skills');
    fs.mkdirSync(realSkills);
    fs.mkdirSync(path.join(home, '.claude'), { recursive: true });
    fs.symlinkSync(realSkills, skillsDirOf(home));
    const realHome = fs.realpathSync(home);
    const deviceOf = (target: string): string =>
      fs.realpathSync(path.dirname(target)).startsWith(realHome) ? 'home' : 'elsewhere';
    jest.spyOn(fs, 'renameSync').mockImplementation((from, to) => {
      if (deviceOf(String(from)) !== deviceOf(String(to))) {
        throw Object.assign(new Error('EXDEV: cross-device link not permitted'), {
          code: 'EXDEV',
        });
      }
      originalRenameSync(from, to);
    });

    writeSkillFolder(home, 'hexlog', srcDir);

    expect(fs.readFileSync(path.join(realSkills, 'hexlog', 'SKILL.md'), 'utf8')).toBe(
      '# hexlog skill\n',
    );
    expect(fs.readdirSync(realSkills)).toEqual(['hexlog']);
    expect(fs.readdirSync(elsewhere)).toEqual(['skills']);
    expect(fs.readdirSync(path.join(home, '.claude'))).toEqual(['skills']);
  });

  it('should fall back to <home>/.claude for the temporaries when the parent of the link target is not writable', () => {
    const home = createTempDir('skill-link-readonly');
    const elsewhere = createTempDir('skill-link-readonly-target');
    const srcDir = buildSrcDir('# hexlog skill\n');
    const originalRenameSync = fs.renameSync;
    const originalAccessSync = fs.accessSync;
    const realSkills = path.join(elsewhere, 'skills');
    fs.mkdirSync(realSkills);
    fs.mkdirSync(path.join(home, '.claude'), { recursive: true });
    fs.symlinkSync(realSkills, skillsDirOf(home));
    const realElsewhere = fs.realpathSync(elsewhere);
    // Simula o pai do alvo sem permissão de escrita sem depender de chmod (que root ignora).
    jest.spyOn(fs, 'accessSync').mockImplementation((target, mode) => {
      if (String(target) === realElsewhere) {
        throw Object.assign(new Error('EACCES: permission denied'), { code: 'EACCES' });
      }
      originalAccessSync(target, mode);
    });
    const tempParents: string[] = [];
    jest.spyOn(fs, 'renameSync').mockImplementation((from, to) => {
      if (path.basename(String(from)).startsWith('.hexlog-skill-')) {
        tempParents.push(path.dirname(String(from)));
      }
      originalRenameSync(from, to);
    });

    writeSkillFolder(home, 'hexlog', srcDir);

    expect(tempParents).toEqual([path.join(fs.realpathSync(home), '.claude')]);
    expect(fs.readFileSync(path.join(realSkills, 'hexlog', 'SKILL.md'), 'utf8')).toBe(
      '# hexlog skill\n',
    );
    expect(fs.readdirSync(elsewhere)).toEqual(['skills']);
    expect(fs.readdirSync(path.join(home, '.claude'))).toEqual(['skills']);
  });

  it.each(['../escape', 'a/b', '.', '..', ''])(
    'should reject the name %j before touching the filesystem',
    (name) => {
      const home = createTempDir('skill-invalid-name');
      const srcDir = buildSrcDir('# hexlog skill\n');

      expect(() => writeSkillFolder(home, name, srcDir)).toThrow('invalid skill name');

      expect(fs.existsSync(skillsDirOf(home))).toBe(false);
    },
  );
});

describe('verifyInstallation', () => {
  let home: string;
  let D: string;
  let version: string;
  let restoreHome: () => void;

  beforeAll(() => {
    ({ home, D, version } = installBaseline());
    restoreHome = useHome(home);
  }, 30_000);

  afterAll(() => {
    restoreHome();
  });

  it('should warn artifact-outdated and keep the exit when the current build differs from the manifest and the installed bytes are intact', () => {
    const versionDir = versionDirOf(home, version);
    const manifest = readManifest(versionDir)!;
    const expected = expectedRules(D, home, process.execPath, version);
    const settingsText = fs.readFileSync(path.join(home, '.claude', 'settings.json'), 'utf8');
    const claudeJsonText = fs.readFileSync(path.join(home, '.claude.json'), 'utf8');
    // Simula um build atual diferente do que gerou o manifesto, sem alterar a working tree real.
    const bundlesSimulatingNewBuild: Bundles = {
      server: Buffer.from('server-from-a-future-build'),
      hook: fs.readFileSync(expected.hookFile),
    };

    const result = verifyInstallation({
      home,
      version,
      execPath: process.execPath,
      D,
      skillNames: [],
      currentBundles: bundlesSimulatingNewBuild,
      settingsText,
      claudeJsonText,
      runHook: runRealHook,
      currentHead: 'test-simulated-head',
    });

    expect(result.exit).toBe(0);
    expect(result.warnings).toEqual(
      expect.arrayContaining([
        expect.stringMatching(/^artifact-outdated/),
        expect.stringContaining(String(manifest.commit)),
        expect.stringContaining('test-simulated-head'),
      ]),
    );
  }, 15_000);
});
