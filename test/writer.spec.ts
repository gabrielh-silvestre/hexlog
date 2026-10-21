import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, jest, test } from '@jest/globals';
import { checkInstalled, gitDiffQuiet, openWriter } from '../scripts/flow/writer.ts';
import { createFlowEnvironment } from './flow-data.ts';
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
  test('returns no problem when the installed code is the repository code', () => {
    expect(checkInstalled(installed())).toEqual([]);
  });

  test('reads the manifest from the folder of the registered server', () => {
    const readManifest = jest.fn<(versionDir: string) => string>(() => manifestText());

    checkInstalled(installed({ readManifest }));

    expect(readManifest).toHaveBeenCalledWith(VERSION_DIR);
  });

  test.each([
    ['a missing ~/.claude.json', null],
    ['invalid JSON', '{'],
    ['no hexlog entry', JSON.stringify({ mcpServers: {} })],
    ['args that are not a list', JSON.stringify({ mcpServers: { hexlog: { args: 'x' } } })],
    ['an empty args list', JSON.stringify({ mcpServers: { hexlog: { args: [] } } })],
  ])('reports the server as unregistered with %s', (_title, claudeJsonText) => {
    expect(checkInstalled(installed({ claudeJsonText }))).toEqual([
      'hexlog server not registered in ~/.claude.json: run node scripts/install.ts',
    ]);
  });

  test('reports a version folder that differs from the repository version', () => {
    const claudeJsonText = claudeJson('/home/dev/.local/lib/hexlog/1.1.0/server.mjs');

    const problems = checkInstalled(installed({ claudeJsonText }));

    expect(problems).toEqual([
      'installed server is not version 1.2.0 (/home/dev/.local/lib/hexlog/1.1.0): run node scripts/install.ts',
    ]);
  });

  test('reports a manifest whose version differs from the repository version', () => {
    const problems = checkInstalled(
      installed({ readManifest: () => manifestText({ version: '1.1.0' }) }),
    );

    expect(problems).toEqual([
      `installed server is not version 1.2.0 (${VERSION_DIR}): run node scripts/install.ts`,
    ]);
  });

  test.each([
    ['an absent file', null],
    ['invalid JSON', '{'],
    ['an array', '[]'],
    ['a numeric version', manifestText({ version: 1 })],
    ['a numeric commit', manifestText({ commit: 1 })],
    ['a string dirty', manifestText({ dirty: 'false' })],
    ['a missing dirty', JSON.stringify({ version: VERSION, commit: COMMIT })],
  ])('reports the manifest as invalid with %s', (_title, text) => {
    const gitDiffQuietSpy = jest.fn(() => 'same' as const);

    const problems = checkInstalled(
      installed({ readManifest: () => text, gitDiffQuiet: gitDiffQuietSpy }),
    );

    expect(problems).toContain(
      `manifest.json missing or invalid in ${VERSION_DIR}: run node scripts/install.ts`,
    );
    expect(gitDiffQuietSpy).not.toHaveBeenCalled();
  });

  test.each([
    ['a dirty tree', manifestText({ dirty: true })],
    ['an unknown commit', manifestText({ commit: null })],
  ])('asks to move the version folder aside and reinstall with %s', (_title, text) => {
    const gitDiffQuietSpy = jest.fn(() => 'same' as const);

    const problems = checkInstalled(
      installed({ readManifest: () => text, gitDiffQuiet: gitDiffQuietSpy }),
    );

    expect(problems).toEqual([
      `installed build has a dirty tree or an unknown commit: with a clean tree at the wanted commit, move ${VERSION_DIR} aside and run node scripts/install.ts`,
    ]);
    expect(gitDiffQuietSpy).not.toHaveBeenCalled();
  });

  test('reports src/ that differs from the installed commit', () => {
    const gitDiffQuietSpy = jest.fn<(commit: string) => 'differs'>(() => 'differs');

    const problems = checkInstalled(installed({ gitDiffQuiet: gitDiffQuietSpy }));

    expect(gitDiffQuietSpy).toHaveBeenCalledWith(COMMIT);
    expect(problems).toEqual([
      `src/ differs from the installed commit ${COMMIT}: run node scripts/install.ts`,
    ]);
  });

  test('reports a git failure when comparing src/', () => {
    const problems = checkInstalled(installed({ gitDiffQuiet: () => 'error' }));

    expect(problems).toEqual([
      `cannot compare src/ with the installed commit ${COMMIT} (unknown in this clone, or git failed): run node scripts/install.ts`,
    ]);
  });
});

describe('gitDiffQuiet', () => {
  const GIT_IDENTITY = ['-c', 'user.name=Test', '-c', 'user.email=test@example.com'];

  function git(cwd: string, ...args: string[]): string {
    const result = spawnSync('git', [...GIT_IDENTITY, '-c', 'commit.gpgsign=false', ...args], {
      cwd,
      encoding: 'utf8',
    });
    if (result.status !== 0) throw new Error(`git ${args.join(' ')}: ${result.stderr}`);
    return result.stdout.trim();
  }

  /** Repositório com `src/a.ts` e `scripts/b.ts` no commit `first`; `second` só muda `src/a.ts`. */
  function repoWithTwoCommits() {
    const root = createTempDir('writer-git');
    git(root, 'init', '-q', '-b', 'main');
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

  test('returns same for the HEAD commit and differs for an older commit', () => {
    const { root, first, second } = repoWithTwoCommits();

    expect(gitDiffQuiet(root)(second)).toBe('same');
    expect(gitDiffQuiet(root)(first)).toBe('differs');
  }, 30_000);

  test('ignores a change outside src/', () => {
    const { root, second } = repoWithTwoCommits();
    fs.writeFileSync(path.join(root, 'scripts', 'b.ts'), 'export const b = 2;\n');
    git(root, 'commit', '-q', '-am', 'third');

    expect(gitDiffQuiet(root)(second)).toBe('same');
  }, 30_000);

  test('returns error for an unknown commit', () => {
    const { root } = repoWithTwoCommits();

    expect(gitDiffQuiet(root)('deadbeef')).toBe('error');
  }, 30_000);

  test.each(['--help', '-p', 'HEAD; echo', ''])(
    'returns error for %p without running git',
    (commit) => {
      const { root } = repoWithTwoCommits();

      expect(gitDiffQuiet(root)(commit)).toBe('error');
    },
    30_000,
  );

  test('returns error when the root is not a repository', () => {
    const { first } = repoWithTwoCommits();

    expect(gitDiffQuiet(createTempDir('writer-not-git'))(first)).toBe('error');
  }, 30_000);

  test('gives the same answer from inside scripts/ and from outside the repository', () => {
    const { root, first, second } = repoWithTwoCommits();
    const outside = createTempDir('writer-outside');

    for (const cwd of [path.join(root, 'scripts'), outside]) {
      expect(withCwd(cwd, () => gitDiffQuiet(root)(first))).toBe('differs');
      expect(withCwd(cwd, () => gitDiffQuiet(root)(second))).toBe('same');
    }
  }, 30_000);
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

  test('writes a batch through the real register, with the given author', async () => {
    const result = await open().write({ process: SLUG, key: 'k1', records: [premise('a')] });

    expect(result.records).toHaveLength(1);
    expect(await premisesInLog()).toEqual([
      expect.objectContaining({
        target: `${SLUG}.premise.a`,
        author: expect.objectContaining(AUTHOR),
      }),
    ]);
  }, 30_000);

  test('replays a repeated key without writing again', async () => {
    const writer = open();
    const batch = { process: SLUG, key: 'k1', records: [premise('a')] };
    await writer.write(batch);

    const replay = await writer.write(batch);

    expect(replay.replayed).toBe(true);
    expect(await premisesInLog()).toHaveLength(1);
  }, 30_000);

  test('refuses to open with the problems of the installed check, before touching the data', () => {
    const before = snapshot(environment.dataDir);

    expect(() => open({ installed: installed({ gitDiffQuiet: () => 'differs' }) })).toThrow(
      /installed code check failed:\n- src\/ differs from the installed commit abc1234: run node scripts\/install\.ts/,
    );
    expect(snapshot(environment.dataDir)).toEqual(before);
  });

  test('refuses legacy 0.x data', () => {
    environment.seedLegacy();

    expect(() => open()).toThrow(expect.objectContaining({ code: 'LEGACY_DATA' }));
  });

  test('refuses an invalid author', () => {
    expect(() => open({ author: { agent: '', client: 'c' } })).toThrow();
  });

  test.each([
    ['a key that is empty', { key: '' }],
    ['a key above 200 characters', { key: 'k'.repeat(201) }],
    ['a process name that is not a name', { process: 'Not A Name' }],
  ])(
    'rejects %s without writing',
    async (_title, patch) => {
      const before = snapshot(environment.dataDir);
      const batch = { process: SLUG, key: 'k1', records: [premise('a')], ...patch };

      await expect(open().write(batch)).rejects.toThrow();

      expect(snapshot(environment.dataDir)).toEqual(before);
    },
    30_000,
  );
});
