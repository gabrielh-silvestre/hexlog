import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { afterEach, beforeAll, beforeEach, describe, expect, it, jest } from '@jest/globals';
import { ZodError } from 'zod';
import { checkInstalled, gitDiffQuiet, openWriter } from '../scripts/flow/writer.ts';
import { createFlowEnvironment } from './flow-data.ts';
import { git } from './flow-repo.ts';
import { createTempDir, snapshot } from './helpers.ts';
import type { Environment } from './mcp/environment.ts';

const VERSION = '1.2.0';
const VERSION_DIR = `/home/dev/.local/lib/hexlog/${VERSION}`;
const COMMIT = 'abc1234';
const AUTHOR = { agent: 'flow-reanchor', client: 'hexlog-flow-reanchor' };
const SLUG = 'feat-x';

const claudeJson = (serverFile: string): string =>
  JSON.stringify({ mcpServers: { hexlog: { command: 'node', args: [serverFile] } } });

const manifestText = (fields: Record<string, unknown> = {}): string =>
  JSON.stringify({ version: VERSION, commit: COMMIT, dirty: false, ...fields });

/** Instalação coerente com o repositório; cada teste troca só o campo que quer quebrar. */
function installed(overrides: Partial<Parameters<typeof checkInstalled>[0]> = {}) {
  return {
    version: VERSION,
    claudeJsonText: claudeJson(`${VERSION_DIR}/server.mjs`),
    readManifest: () => manifestText(),
    gitDiffQuiet: () => 'same' as const,
    ...overrides,
  };
}

describe('checkInstalled', () => {
  it('should return no problem when the installed code is the repository code', () => {
    expect(checkInstalled(installed())).toEqual([]);
  });

  it('should read the manifest from the folder of the registered server', () => {
    const readManifest = jest.fn<(versionDir: string) => string>(() => manifestText());

    checkInstalled(installed({ readManifest }));

    expect(readManifest).toHaveBeenCalledWith(VERSION_DIR);
  });

  it.each([
    ['a missing ~/.claude.json', null],
    ['invalid JSON', '{'],
    ['no hexlog entry', JSON.stringify({ mcpServers: {} })],
    ['args that are not a list', JSON.stringify({ mcpServers: { hexlog: { args: 'x' } } })],
    ['an empty args list', JSON.stringify({ mcpServers: { hexlog: { args: [] } } })],
  ])('should report the server as unregistered with %s', (_title, claudeJsonText) => {
    expect(checkInstalled(installed({ claudeJsonText }))).toEqual([
      'hexlog server not registered in ~/.claude.json: run node scripts/install.ts',
    ]);
  });

  it('should report a version folder that differs from the repository version', () => {
    const claudeJsonText = claudeJson('/home/dev/.local/lib/hexlog/1.1.0/server.mjs');

    const problems = checkInstalled(installed({ claudeJsonText }));

    expect(problems).toEqual([
      'installed server is not version 1.2.0 (/home/dev/.local/lib/hexlog/1.1.0): run node scripts/install.ts',
    ]);
  });

  it('should report both a version folder and a src/ that differ, the version first', () => {
    const claudeJsonText = claudeJson('/home/dev/.local/lib/hexlog/1.1.0/server.mjs');

    const problems = checkInstalled(installed({ claudeJsonText, gitDiffQuiet: () => 'differs' }));

    expect(problems).toEqual([
      'installed server is not version 1.2.0 (/home/dev/.local/lib/hexlog/1.1.0): run node scripts/install.ts',
      `src/ differs from the installed commit ${COMMIT}: run node scripts/install.ts`,
    ]);
  });

  it('should report both an invalid manifest and a version folder that differs, the manifest first', () => {
    const claudeJsonText = claudeJson('/home/dev/.local/lib/hexlog/1.1.0/server.mjs');

    const problems = checkInstalled(installed({ claudeJsonText, readManifest: () => null }));

    expect(problems).toEqual([
      'manifest.json missing or invalid in /home/dev/.local/lib/hexlog/1.1.0: run node scripts/install.ts',
      'installed server is not version 1.2.0 (/home/dev/.local/lib/hexlog/1.1.0): run node scripts/install.ts',
    ]);
  });

  it('should report a manifest whose version differs from the repository version', () => {
    const problems = checkInstalled(
      installed({ readManifest: () => manifestText({ version: '1.1.0' }) }),
    );

    expect(problems).toEqual([
      `installed server is not version 1.2.0 (${VERSION_DIR}): run node scripts/install.ts`,
    ]);
  });

  const INVALID_MANIFESTS = [
    ['an absent file', null],
    ['invalid JSON', '{'],
    ['an array', '[]'],
    ['a numeric version', manifestText({ version: 1 })],
    ['a numeric commit', manifestText({ commit: 1 })],
    ['a string dirty', manifestText({ dirty: 'false' })],
    ['a missing dirty', JSON.stringify({ version: VERSION, commit: COMMIT })],
  ] as const;
  const UNTRUSTED_BUILDS = [
    ['a dirty tree', manifestText({ dirty: true })],
    ['an unknown commit', manifestText({ commit: null })],
  ] as const;

  it.each(INVALID_MANIFESTS)('should report the manifest as invalid with %s', (_title, text) => {
    const problems = checkInstalled(installed({ readManifest: () => text }));

    expect(problems).toContain(
      `manifest.json missing or invalid in ${VERSION_DIR}: run node scripts/install.ts`,
    );
  });

  it.each(UNTRUSTED_BUILDS)(
    'should ask to move the version folder aside and reinstall with %s',
    (_title, text) => {
      const problems = checkInstalled(installed({ readManifest: () => text }));

      expect(problems).toEqual([
        `installed build has a dirty tree or an unknown commit: with a clean tree at the wanted commit, move ${VERSION_DIR} aside and run node scripts/install.ts`,
      ]);
    },
  );

  it.each([...INVALID_MANIFESTS, ...UNTRUSTED_BUILDS])(
    'should skip the src/ comparison with %s',
    (_title, text) => {
      const gitDiffQuietSpy = jest.fn(() => 'same' as const);

      checkInstalled(installed({ readManifest: () => text, gitDiffQuiet: gitDiffQuietSpy }));

      expect(gitDiffQuietSpy).not.toHaveBeenCalled();
    },
  );

  it('should compare src/ with the installed commit', () => {
    const gitDiffQuietSpy = jest.fn<(commit: string) => 'same'>(() => 'same');

    checkInstalled(installed({ gitDiffQuiet: gitDiffQuietSpy }));

    expect(gitDiffQuietSpy).toHaveBeenCalledWith(COMMIT);
  });

  it('should report src/ that differs from the installed commit', () => {
    const problems = checkInstalled(installed({ gitDiffQuiet: () => 'differs' }));

    expect(problems).toEqual([
      `src/ differs from the installed commit ${COMMIT}: run node scripts/install.ts`,
    ]);
  });

  it('should report a git failure when comparing src/', () => {
    const problems = checkInstalled(installed({ gitDiffQuiet: () => 'error' }));

    expect(problems).toEqual([
      `cannot compare src/ with the installed commit ${COMMIT} (unknown in this clone, or git failed): run node scripts/install.ts`,
    ]);
  });
});

describe('gitDiffQuiet', () => {
  /** Repositório com `src/a.ts` e `scripts/b.ts` no commit `first`; `second` só muda `src/a.ts`. */
  function repoWithTwoCommits() {
    const root = createTempDir('writer-git');
    git(root, 'init', '-q', '-b', 'main');
    git(root, 'config', 'user.name', 'Test');
    git(root, 'config', 'user.email', 'test@example.com');
    git(root, 'config', 'commit.gpgsign', 'false');
    fs.mkdirSync(path.join(root, 'src'));
    fs.mkdirSync(path.join(root, 'scripts'));
    fs.writeFileSync(path.join(root, 'src', 'a.ts'), 'export const a = 1;\n');
    fs.writeFileSync(path.join(root, 'scripts', 'b.ts'), 'export const b = 1;\n');
    git(root, 'add', '.');
    git(root, 'commit', '-q', '-m', 'first');
    const first = git(root, 'rev-parse', 'HEAD');
    fs.writeFileSync(path.join(root, 'src', 'a.ts'), 'export const a = 2;\n');
    git(root, 'commit', '-q', '-am', 'second');
    return { root, first, second: git(root, 'rev-parse', 'HEAD') };
  }

  /** `process.chdir` num try/finally: o adaptador herda o `cwd` do processo de teste. */
  function withCwd<T>(dir: string, run: () => T): T {
    const previous = process.cwd();
    process.chdir(dir);
    try {
      return run();
    } finally {
      process.chdir(previous);
    }
  }

  // os casos que só leem compartilham o repositório; o que commita de novo cria o seu
  let shared: ReturnType<typeof repoWithTwoCommits>;

  beforeAll(() => {
    shared = repoWithTwoCommits();
  }, 30_000);

  it('should return same for the HEAD commit', () => {
    const { root, second } = shared;

    expect(gitDiffQuiet(root)(second)).toBe('same');
  }, 30_000);

  it('should return differs for an older commit', () => {
    const { root, first } = shared;

    expect(gitDiffQuiet(root)(first)).toBe('differs');
  }, 30_000);

  it('should ignore a change outside src/', () => {
    const { root, second } = repoWithTwoCommits();
    fs.writeFileSync(path.join(root, 'scripts', 'b.ts'), 'export const b = 2;\n');
    git(root, 'commit', '-q', '-am', 'third');

    expect(gitDiffQuiet(root)(second)).toBe('same');
  }, 30_000);

  it('should return error for an unknown commit', () => {
    const { root } = shared;

    expect(gitDiffQuiet(root)('deadbeef')).toBe('error');
  }, 30_000);

  it.each(['--help', '-p', 'HEAD; echo', ''])(
    'should return error for the malformed commit %p',
    (commit) => {
      const { root } = shared;

      expect(gitDiffQuiet(root)(commit)).toBe('error');
    },
    30_000,
  );

  it('should return error when the root is not a repository', () => {
    const { first } = shared;

    expect(gitDiffQuiet(createTempDir('writer-not-git'))(first)).toBe('error');
  }, 30_000);

  it.each([
    { place: 'inside scripts/', cwdOf: (root: string) => path.join(root, 'scripts') },
    { place: 'outside the repository', cwdOf: () => createTempDir('writer-outside') },
  ])(
    'should give the same answer from $place',
    ({ cwdOf }) => {
      const { root, first, second } = shared;
      const cwd = cwdOf(root);

      expect(withCwd(cwd, () => gitDiffQuiet(root)(first))).toBe('differs');
      expect(withCwd(cwd, () => gitDiffQuiet(root)(second))).toBe('same');
    },
    30_000,
  );
});

describe('openWriter', () => {
  let environment: Environment;

  beforeEach(async () => {
    environment = await createFlowEnvironment([SLUG]);
  });

  afterEach(async () => {
    await environment.close();
  });

  const open = (overrides: Partial<Parameters<typeof openWriter>[0]> = {}) =>
    openWriter({
      dataDir: environment.dataDir,
      cwd: process.cwd(),
      author: AUTHOR,
      installed: installed(),
      ...overrides,
    });

  const premise = (short: string, statement = 'Keep it small') => ({
    type: 'premise',
    target: `${SLUG}.premise.${short}`,
    data: { statement },
  });

  const premisesInLog = async () => {
    const { records } = await environment.ok<{ records: { target: string; author: unknown }[] }>(
      'query',
      { project: 'hexlog', process: SLUG, type: 'premise' },
    );
    return records;
  };

  const batch = { process: SLUG, key: 'k1', records: [premise('a')] };

  it('should write a batch through the real register, with the given author', async () => {
    const result = await open().write(batch);

    expect(result.records).toHaveLength(1);
    expect(await premisesInLog()).toEqual([
      expect.objectContaining({
        target: `${SLUG}.premise.a`,
        author: expect.objectContaining(AUTHOR),
      }),
    ]);
  }, 30_000);

  it('should replay a repeated key', async () => {
    const writer = open();
    await writer.write(batch);

    const replay = await writer.write(batch);

    expect(replay.replayed).toBe(true);
  }, 30_000);

  it('should not write again on a repeated key', async () => {
    const writer = open();
    await writer.write(batch);

    await writer.write(batch);

    expect(await premisesInLog()).toHaveLength(1);
  }, 30_000);

  it('should refuse to open with the problems of the installed check', () => {
    expect(() => open({ installed: installed({ gitDiffQuiet: () => 'differs' }) })).toThrow(
      /installed code check failed:\n- src\/ differs from the installed commit abc1234: run node scripts\/install\.ts/,
    );
  });

  it('should not touch the data when the installed check fails', () => {
    const before = snapshot(environment.dataDir);

    expect(() => open({ installed: installed({ gitDiffQuiet: () => 'differs' }) })).toThrow();

    expect(snapshot(environment.dataDir)).toEqual(before);
  });

  it('should refuse legacy 0.x data', () => {
    environment.seedLegacy();

    expect(() => open()).toThrow(expect.objectContaining({ code: 'LEGACY_DATA' }));
  });

  describe('when attaching a file', () => {
    const NOTE = 'Rule text\n';
    const NOTE_HASH = createHash('sha256').update(NOTE).digest('hex');

    /** Pasta de trabalho do writer com `note.md` e `data.json`. */
    function workDir() {
      const dir = createTempDir('writer-attach');
      fs.writeFileSync(path.join(dir, 'note.md'), NOTE);
      fs.writeFileSync(path.join(dir, 'data.json'), '{}');
      return dir;
    }

    it('should return the sha256 of the bytes of the file', () => {
      const writer = open({ cwd: workDir() });

      expect(writer.attach('note.md')).toBe(NOTE_HASH);
    });

    it('should store the blob under the attachments folder of the project', () => {
      const writer = open({ cwd: workDir() });

      writer.attach('note.md');

      expect(
        fs.readFileSync(
          path.join(environment.dataDir, '.v1', 'hexlog', 'attachments', NOTE_HASH),
          'utf8',
        ),
      ).toBe(NOTE);
    });

    it('should return the same hash for a repeated file', () => {
      const writer = open({ cwd: workDir() });
      const first = writer.attach('note.md');

      const second = writer.attach('note.md');

      expect(second).toBe(first);
    });

    it('should refuse a file that is not .md or .txt', () => {
      const writer = open({ cwd: workDir() });

      expect(() => writer.attach('data.json')).toThrow(
        expect.objectContaining({ code: 'INVALID_INPUT' }),
      );
    });

    it('should refuse a file outside the cwd of the writer', () => {
      const writer = open({ cwd: workDir() });
      const outside = path.join(workDir(), 'note.md');

      expect(() => writer.attach(outside)).toThrow(
        expect.objectContaining({ code: 'INVALID_INPUT' }),
      );
    });
  });

  it('should refuse an invalid author', () => {
    expect(() => open({ author: { agent: '', client: 'c' } })).toThrow(ZodError);
  });

  describe('with a batch that is invalid', () => {
    const INVALID_BATCHES = [
      { title: 'a key that is empty', patch: { key: '' }, issueCode: 'too_small' },
      {
        title: 'a key above 200 characters',
        patch: { key: 'k'.repeat(201) },
        issueCode: 'too_big',
      },
      {
        title: 'a process name that is not a name',
        patch: { process: 'Not A Name' },
        issueCode: 'invalid_format',
      },
    ] as const;

    it.each(INVALID_BATCHES)(
      'should reject $title',
      async ({ patch, issueCode }) => {
        const invalid = { ...batch, ...patch };

        const error = await open()
          .write(invalid)
          .catch((thrown: unknown) => thrown);

        expect(error).toBeInstanceOf(ZodError);
        expect(error).toMatchObject({ issues: [{ code: issueCode }] });
      },
      30_000,
    );

    it.each(INVALID_BATCHES)(
      'should write nothing for $title',
      async ({ patch }) => {
        const before = snapshot(environment.dataDir);
        const invalid = { ...batch, ...patch };

        await expect(open().write(invalid)).rejects.toThrow(ZodError);

        expect(snapshot(environment.dataDir)).toEqual(before);
      },
      30_000,
    );
  });
});
