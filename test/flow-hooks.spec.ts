import { afterEach, beforeAll, beforeEach, describe, expect, it } from '@jest/globals';
import { spawnSync, type SpawnSyncReturns } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { planSync, type SyncInput } from '../.claude/hooks/flow-sync.ts';
import { processPaths } from '../src/adapters/fs/data-format.ts';
import type { RegisterResult } from '../src/commands/process.ts';
import type { QueryResult } from '../src/queries/query-service.ts';
import { at, copyToXdg, createTempDir } from './helpers.ts';
import { type Environment, createEnvironment } from './mcp/environment.ts';

const repoRoot = path.resolve(__dirname, '..');
const hookPath = path.join(repoRoot, '.claude/hooks/flow-hooks.ts');

const MCP_CREATE = 'mcp__github-official__create_pull_request';
const MCP_UPDATE = 'mcp__github-official__update_pull_request';
const ORIGIN_URL = 'git@github.com:acme/widgets.git';

// Repositório temporário: checkout principal em `feat/x`, worktree real em `feat/y`.
// `refs/remotes/origin/*` é criado à mão com `update-ref`, sem rede.
let repo: string;
let worktree: string;
let baseSha: string;
let tipSha: string;
let markerDir: string;

function gitWithEnv(cwd: string, env: NodeJS.ProcessEnv, ...args: string[]): string {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8', env: { ...process.env, ...env } });
  if (result.status !== 0) throw new Error(`git ${args.join(' ')}: ${result.stderr}`);
  return result.stdout.trim();
}

const git = (cwd: string, ...args: string[]): string => gitWithEnv(cwd, {}, ...args);

// O lint exige hook dentro de `describe`, então cada alvo registra estes três com o seu próprio repositório.
function createRepo(): void {
  const root = createTempDir('flow-hooks');
  repo = path.join(root, 'repo');
  worktree = path.join(root, 'wt');
  fs.mkdirSync(repo);
  git(repo, 'init', '-q', '-b', 'main');
  git(repo, 'config', 'user.email', 'test@example.com');
  git(repo, 'config', 'user.name', 'Test');
  git(repo, 'commit', '-q', '--allow-empty', '-m', 'base');
  baseSha = git(repo, 'rev-parse', 'HEAD');
  git(repo, 'checkout', '-q', '-b', 'feat/x');
  git(repo, 'commit', '-q', '--allow-empty', '-m', 'work');
  tipSha = git(repo, 'rev-parse', 'HEAD');
  git(repo, 'remote', 'add', 'origin', ORIGIN_URL);
  git(repo, 'branch', 'feat/y', 'feat/x');
  git(repo, 'worktree', 'add', '-q', worktree, 'feat/y');
  fs.mkdirSync(path.join(repo, 'sub'));
  markerDir = path.join(repo, '.git', 'hexlog-flow');
}

function resetRepo(): void {
  fs.rmSync(markerDir, { recursive: true, force: true });
  git(repo, 'remote', 'set-url', 'origin', ORIGIN_URL);
}

function dropOriginRef(): void {
  git(repo, 'update-ref', '-d', 'refs/remotes/origin/feat/x');
}

type HookResult = SpawnSyncReturns<string>;

function runHook(args: string[], options: { input?: string; cwd?: string } = {}): HookResult {
  return spawnSync(process.execPath, [hookPath, ...args], {
    input: options.input ?? '',
    cwd: options.cwd ?? repo,
    encoding: 'utf8',
  });
}

function preHook(toolName: string, toolInput: object, cwd = repo): HookResult {
  return runHook(['pre-pr'], {
    input: JSON.stringify({ tool_name: toolName, tool_input: toolInput, cwd }),
  });
}

const bash = (command: string, cwd = repo): HookResult => preHook('Bash', { command }, cwd);

const mcpCreate = (head: string, extra: object = {}, cwd = repo): HookResult =>
  preHook(MCP_CREATE, { owner: 'acme', repo: 'widgets', head, base: 'main', ...extra }, cwd);

function writeMarker(branch: string, sha: string): void {
  fs.mkdirSync(markerDir, { recursive: true });
  const slug = runHook(['slug', branch]).stdout.trim();
  fs.writeFileSync(path.join(markerDir, `${slug}.ok`), `${branch}\n${sha}\n`);
}

function expectDenied(result: HookResult, message = /hexlog flow/): void {
  expect(result.status).toBe(2);
  expect(result.stderr).toMatch(message);
}

function expectAllowed(result: HookResult): void {
  expect(result.status).toBe(0);
  expect(result.stderr).toBe('');
}

type Hook = { type: string; command: string; if?: string };
type Entry = { matcher?: string; hooks: Hook[] };
const settings = JSON.parse(
  fs.readFileSync(path.join(repoRoot, '.claude/settings.json'), 'utf8'),
) as {
  hooks: Record<string, Entry[]>;
  permissions: { allow: string[]; ask: string[] };
};

describe('flow-hooks.ts pre-pr', () => {
  beforeAll(createRepo, 15_000);
  beforeEach(resetRepo);
  afterEach(dropOriginRef);

  describe('with create_pull_request', () => {
    const ORIGIN_URLS = [
      'git@github.com:acme/widgets.git',
      'https://github.com/acme/widgets',
      'https://github.com/acme/widgets.git',
      'ssh://git@github.com/acme/widgets.git',
    ];

    it('should deny without draft and without a marker', () => {
      expectDenied(mcpCreate('feat/x'), /no valid pre-PR marker/);
    }, 15_000);

    it('should allow draft true even without a marker', () => {
      expectAllowed(mcpCreate('feat/x', { draft: true }));
    }, 15_000);

    it('should allow with a marker whose sha equals the branch sha', () => {
      writeMarker('feat/x', tipSha);

      expectAllowed(mcpCreate('feat/x'));
    }, 15_000);

    it('should deny a marker whose sha differs from the branch sha', () => {
      writeMarker('feat/x', baseSha);

      expectDenied(mcpCreate('feat/x'), /no valid pre-PR marker/);
    }, 15_000);

    it('should deny a marker whose branch is not the head branch', () => {
      fs.mkdirSync(markerDir, { recursive: true });
      fs.writeFileSync(path.join(markerDir, 'feat-x.ok'), `other\n${tipSha}\n`);

      expectDenied(mcpCreate('feat/x'), /no valid pre-PR marker/);
    }, 15_000);

    it('should deny when the local branch ref does not exist', () => {
      writeMarker('ghost/branch', tipSha);

      expectDenied(mcpCreate('ghost/branch'));
    }, 15_000);

    it('should deny when origin/<head> points to another sha', () => {
      writeMarker('feat/x', tipSha);
      git(repo, 'update-ref', 'refs/remotes/origin/feat/x', baseSha);

      expectDenied(mcpCreate('feat/x'), /no valid pre-PR marker/);
    }, 15_000);

    it('should allow when origin/<head> points to the same sha as the branch', () => {
      writeMarker('feat/x', tipSha);
      git(repo, 'update-ref', 'refs/remotes/origin/feat/x', tipSha);

      expectAllowed(mcpCreate('feat/x'));
    }, 15_000);

    it('should deny a head from another owner (owner:branch)', () => {
      writeMarker('feat/x', tipSha);

      expectDenied(mcpCreate('someone:feat/x'), /cross-repo PRs unsupported/);
    }, 15_000);

    it.each(ORIGIN_URLS)(
      'should allow the owner/repo that matches origin %s',
      (url) => {
        git(repo, 'remote', 'set-url', 'origin', url);
        writeMarker('feat/x', tipSha);

        expectAllowed(mcpCreate('feat/x'));
      },
      15_000,
    );

    it.each(ORIGIN_URLS)(
      'should deny an owner or a repo that differs from origin %s',
      (url) => {
        git(repo, 'remote', 'set-url', 'origin', url);
        writeMarker('feat/x', tipSha);

        expectDenied(
          preHook(MCP_CREATE, { owner: 'other', repo: 'widgets', head: 'feat/x' }),
          /but origin is acme\/widgets/,
        );
        expectDenied(
          preHook(MCP_CREATE, { owner: 'acme', repo: 'gadgets', head: 'feat/x' }),
          /but origin is acme\/widgets/,
        );
      },
      15_000,
    );

    it('should share the marker between a session in one checkout and the PR branch in another worktree', () => {
      writeMarker('feat/y', tipSha);

      expectAllowed(mcpCreate('feat/y', {}, repo));
      expectAllowed(mcpCreate('feat/y', {}, worktree));
    }, 15_000);

    it('should resolve the same marker from a subfolder and from a worktree', () => {
      writeMarker('feat/x', tipSha);

      expectAllowed(mcpCreate('feat/x', {}, path.join(repo, 'sub')));
      expectAllowed(mcpCreate('feat/x', {}, worktree));
    }, 15_000);
  });

  describe('with gh pr create', () => {
    it('should use the marker of the branch given by --head, -H or --head=', () => {
      writeMarker('feat/y', tipSha);

      expectAllowed(bash('gh pr create --head feat/y --title t'));
      expectAllowed(bash('gh pr create -H feat/y'));
      expectAllowed(bash('gh pr create --head=feat/y'));
    }, 15_000);

    it('should deny without --head when only another branch has a marker', () => {
      writeMarker('feat/y', tipSha);

      expectDenied(bash('gh pr create --title t'));
    }, 15_000);

    it('should deny -R and --repo', () => {
      writeMarker('feat/x', tipSha);

      expectDenied(bash('gh pr create -R x/y'), /-R\/--repo is denied/);
      expectDenied(bash('gh pr create --repo x/y'), /-R\/--repo is denied/);
    }, 15_000);

    it.each([
      'gh pr create',
      'gh -R x  pr  create',
      'GH_TOKEN=x gh pr create',
      '/usr/bin/gh pr create',
      'gh "pr" create',
      "gh pr 'create'",
      'time gh pr create',
      'timeout 30 gh pr create',
      'if x; then gh pr create; fi',
      '{ gh pr create; }',
      '! gh pr create',
      'bash -c "gh pr create"',
      'xargs gh pr create',
      'eval "gh pr create"',
      'echo $(gh pr create)',
      'echo hi && gh pr create',
    ])(
      'should deny when gh pr create is in command position: %s',
      (command) => {
        expectDenied(bash(command));
      },
      15_000,
    );

    it('should allow gh pr create with --draft or -d', () => {
      expectAllowed(bash('gh pr create --draft --title t'));
      expectAllowed(bash('gh pr create -d'));
    }, 15_000);

    it.each([
      'git commit -m "gh pr create"',
      "rg 'gh pr create'",
      `echo '{"command":"gh pr create"}' | node ${hookPath} pre-pr`,
      'gh pr view --body "it\'s"',
      'git commit -m "$(cat <<\'EOF\'\nfix: gh pr create\nEOF\n)"',
      'echo hi # gh pr create',
      'ls -la',
    ])(
      'should allow a command that is not a gh pr create call: %s',
      (command) => {
        expectAllowed(bash(command));
      },
      15_000,
    );

    it.each(['gh pr create --title "x', "echo 'gh pr create", 'echo $(gh pr create'])(
      'should deny an unpaired quote that matches the loose regex: %s',
      (command) => {
        expectDenied(bash(command));
      },
      15_000,
    );

    it('should allow an unpaired quote that mentions neither gh pr create nor ready', () => {
      expectAllowed(bash('echo "abc'));
    }, 15_000);
  });

  describe('with gh pr ready', () => {
    it('should deny the current branch without a marker', () => {
      expectDenied(bash('gh pr ready'), /no valid pre-PR marker/);
    }, 15_000);

    it('should allow the current branch with a marker of the same sha', () => {
      writeMarker('feat/x', tipSha);

      expectAllowed(bash('gh pr ready'));
    }, 15_000);

    it('should use the marker of the branch given as argument', () => {
      writeMarker('feat/y', tipSha);

      expectAllowed(bash('gh pr ready feat/y'));
    }, 15_000);

    it('should deny without an argument when only another branch has a marker', () => {
      writeMarker('feat/y', tipSha);

      expectDenied(bash('gh pr ready'), /no valid pre-PR marker/);
    }, 15_000);

    it.each(['gh pr ready 42', 'gh pr ready https://github.com/acme/widgets/pull/42'])(
      'should deny by number or URL: %s',
      (command) => {
        writeMarker('feat/x', tipSha);

        expectDenied(bash(command), /by number or URL is denied/);
      },
      15_000,
    );

    it('should deny -R x/y', () => {
      writeMarker('feat/x', tipSha);

      expectDenied(bash('gh pr ready -R x/y'), /-R\/--repo is denied/);
    }, 15_000);

    it('should pass --undo', () => {
      expectAllowed(bash('gh pr ready --undo'));
    }, 15_000);

    it.each([
      'gh pr ready',
      'time gh pr ready',
      'if x; then gh pr ready; fi',
      'GH_TOKEN=x gh pr ready',
      '/usr/bin/gh pr ready',
      'gh "pr" ready',
      'bash -c "gh pr ready"',
    ])(
      'should deny when gh pr ready is in command position: %s',
      (command) => {
        expectDenied(bash(command));
      },
      15_000,
    );

    it.each([
      'git commit -m "gh pr ready"',
      "echo 'gh pr ready'",
      "rg 'gh pr ready'",
      "cat <<'EOF'\ngh pr ready\nEOF",
    ])(
      'should pass when the phrase is in quotes or in a heredoc: %s',
      (command) => {
        expectAllowed(bash(command));
      },
      15_000,
    );
  });

  describe('with update_pull_request', () => {
    it('should deny draft false with the message that cites gh pr ready', () => {
      expectDenied(
        preHook(MCP_UPDATE, { owner: 'acme', repo: 'widgets', draft: false }),
        /gh pr ready/,
      );
    }, 15_000);

    it.each([
      { draft: true },
      { title: 'novo título' },
      { body: 'novo corpo' },
      { state: 'closed' },
    ])(
      'should pass an update with %j',
      (extra) => {
        expectAllowed(
          preHook(MCP_UPDATE, { owner: 'acme', repo: 'widgets', pullNumber: 1, ...extra }),
        );
      },
      15_000,
    );
  });

  describe('with unexpected input or a failing git', () => {
    it('should deny stdin that is not JSON', () => {
      expectDenied(runHook(['pre-pr'], { input: 'not json' }));
    }, 15_000);

    it('should ignore a tool that is neither PR nor Bash', () => {
      expectAllowed(preHook('Read', { file_path: '/x' }));
    }, 15_000);

    it('should deny a failing git (cwd outside a repository)', () => {
      const outside = createTempDir('flow-hooks-outside');

      expectDenied(bash('gh pr ready', outside));
    }, 15_000);
  });
});

describe('flow-hooks.ts subagent-start', () => {
  beforeAll(createRepo, 15_000);

  it('should return the doc path and the branch slug in three lines of context', () => {
    const result = runHook(['subagent-start'], { input: JSON.stringify({ cwd: repo }) });
    const { hookSpecificOutput } = JSON.parse(result.stdout) as {
      hookSpecificOutput: { hookEventName: string; additionalContext: string };
    };

    expect(result.status).toBe(0);
    expect(hookSpecificOutput.hookEventName).toBe('SubagentStart');
    expect(hookSpecificOutput.additionalContext.split('\n')).toHaveLength(3);
    expect(hookSpecificOutput.additionalContext).toContain('docs/directives/fluxo-hexlog.md');
    expect(hookSpecificOutput.additionalContext).toContain('work process: feat-x');
    expect(hookSpecificOutput.additionalContext).toContain('tell whoever launched you');
  }, 15_000);

  it.each(['oh-my-claudecode:critic', 'oh-my-claudecode:executor'])(
    'should put the hand-back rule with the owner-seat carve-out on line 1 for %s',
    (agentType) => {
      const result = runHook(['subagent-start'], {
        input: JSON.stringify({ cwd: repo, agent_type: agentType }),
      });
      const { hookSpecificOutput } = JSON.parse(result.stdout) as {
        hookSpecificOutput: { additionalContext: string };
      };
      const lines = hookSpecificOutput.additionalContext.split('\n');

      expect(result.status).toBe(0);
      expect(lines).toHaveLength(3);
      expect(lines[0]).toContain(
        'Found a NEW gap or critical point nobody handed you? Stop and hand it back to whoever ' +
          'launched you (docs/directives/cadeira-do-dono.md); the owner-seat critic and its ' +
          'context actions answer instead of handing back.',
      );
    },
    15_000,
  );

  it('should still return the context without readable input', () => {
    const result = runHook(['subagent-start'], { input: 'not json' });

    expect(result.status).toBe(0);
    expect(result.stdout).toContain('additionalContext');
  }, 15_000);
});

describe('flow-hooks.ts slug', () => {
  beforeAll(createRepo, 15_000);

  it.each([
    ['feat/x', 'feat-x'],
    ['feat!/v1-cutover', 'feat-v1-cutover'],
    ['docs/a.b_c', 'docs-a-b-c'],
    ['Feat/UPPER', 'feat-upper'],
    [`${'a'.repeat(62)}/b`, 'a'.repeat(62)],
    ['a'.repeat(70), 'a'.repeat(63)],
  ])(
    'should turn the branch %s into the slug %s',
    (branch, expected) => {
      const result = runHook(['slug', branch]);

      expect(result.status).toBe(0);
      expect(result.stdout).toBe(`${expected}\n`);
    },
    15_000,
  );

  it.each([
    '///',
    '',
    'directives',
    'audits-2',
    'types',
    'relations',
    'gates',
    'attachments',
    'archive',
    'main',
    'develop',
  ])(
    'should refuse "%s" with exit 1',
    (branch) => {
      const result = runHook(['slug', branch]);

      expect(result.status).toBe(1);
      expect(result.stdout).toBe('');
    },
    15_000,
  );
});

describe('flow-hooks.ts mark', () => {
  beforeAll(createRepo, 15_000);
  beforeEach(resetRepo);

  it('should write the marker in the git-common-dir', () => {
    const result = runHook(['mark', 'feat-x']);

    expect(result.status).toBe(0);
    expect(fs.readFileSync(path.join(markerDir, 'feat-x.ok'), 'utf8')).toBe(`feat/x\n${tipSha}\n`);
  }, 15_000);

  it('should make the pre-pr hook start accepting the PR and gh pr ready', () => {
    expectDenied(mcpCreate('feat/x'));
    runHook(['mark', 'feat-x']);

    expectAllowed(mcpCreate('feat/x'));
    expectAllowed(bash('gh pr create --title t'));
    expectAllowed(bash('gh pr ready'));
  }, 15_000);

  it('should write to the shared git-common-dir when run in a worktree', () => {
    const result = runHook(['mark', 'feat-y'], { cwd: worktree });

    expect(result.status).toBe(0);
    expect(fs.existsSync(path.join(markerDir, 'feat-y.ok'))).toBe(true);
  }, 15_000);

  it('should refuse a dirty tree', () => {
    const dirty = path.join(repo, 'dirty.txt');
    fs.writeFileSync(dirty, 'x');

    try {
      const result = runHook(['mark', 'feat-x']);

      expect(result.status).toBe(1);
      expect(result.stderr).toMatch(/not clean/);
      expect(fs.existsSync(path.join(markerDir, 'feat-x.ok'))).toBe(false);
    } finally {
      fs.rmSync(dirty);
    }
  }, 15_000);

  it('should refuse a branch that does not yield the slug', () => {
    const result = runHook(['mark', 'other-slug']);

    expect(result.status).toBe(1);
    expect(result.stderr).toMatch(/does not yield slug/);
    expect(fs.existsSync(markerDir)).toBe(false);
  }, 15_000);
});

describe('flow-hooks.ts sync-plan', () => {
  beforeAll(createRepo, 15_000);

  it('should return the same plan as flow-sync called directly', () => {
    const input: SyncInput = {
      docSlug: 'convencoes',
      path: 'docs/directives/convencoes.md',
      hash: 'a'.repeat(64),
      current: null,
      vigent: [],
      extracted: [{ slug: 'idioma', rule: 'Código em inglês.', section: 'Idioma' }],
    };

    const result = runHook(['sync-plan'], { input: JSON.stringify(input) });

    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual(JSON.parse(JSON.stringify(planSync(input))));
  }, 15_000);

  describe('with an invalid path', () => {
    const syncPlan = (input: Partial<SyncInput>) => {
      const result = runHook(['sync-plan'], {
        input: JSON.stringify({
          docSlug: 'estrategia',
          path: 'docs/directives/estrategia.md',
          hash: '',
          current: null,
          vigent: [],
          extracted: [],
          ...input,
        }),
      });
      return {
        status: result.status,
        stderr: result.stderr,
        plan: JSON.parse(result.stdout) as unknown,
      };
    };
    const refused = {
      status: 0,
      stderr: '',
      plan: expect.objectContaining({ batches: [], error: 'invalid-path' }),
    };

    it('should exit with 0 and the error in the JSON for an empty path', () => {
      expect(syncPlan({ path: '' })).toEqual(refused);
    }, 15_000);

    it('should exit with 0 and the error in the JSON for a path outside docs/directives', () => {
      expect(syncPlan({ docSlug: 'convencoes', path: 'docs/x.md' })).toEqual(refused);
    }, 15_000);

    // sem o pré-check o hook leria o arquivo malformado e sairia com 2 e o motivo no stderr
    it('should not read estrategia given an absolute path to a malformed file', () => {
      const file = path.join(createTempDir('strategy'), 'estrategia.md');
      fs.writeFileSync(file, '## Tema\n- sem crase: linha ruim');

      expect(syncPlan({ path: file })).toEqual(refused);
    }, 15_000);

    it('should not read estrategia given an absolute path to a nonexistent file', () => {
      const file = path.join(createTempDir('strategy'), 'faltando.md');

      expect(syncPlan({ path: file })).toEqual(refused);
    }, 15_000);
  });
});

describe('flow-hooks.ts', () => {
  beforeAll(createRepo, 15_000);

  it('should exit with 2 for an unknown mode', () => {
    expectDenied(runHook(['nope']), /unknown mode/);
  }, 15_000);
});

describe('.claude/settings.json', () => {
  const flowCommand = (mode: string): string =>
    `node "$CLAUDE_PROJECT_DIR/.claude/hooks/flow-hooks.ts" ${mode}`;

  it('should have a SubagentStart entry with an empty matcher', () => {
    const entries = settings.hooks.SubagentStart ?? [];

    expect(entries).toHaveLength(1);
    expect(entries[0]?.matcher).toBe('');
    expect(entries[0]?.hooks[0]?.command).toBe(flowCommand('subagent-start'));
  }, 15_000);

  it('should end the MCP PR matcher command with || exit 2', () => {
    const entry = (settings.hooks.PreToolUse ?? []).find(
      (e) => e.matcher === '^mcp__github-official__(create|update)_pull_request$',
    );

    expect(entry?.hooks[0]?.command).toBe(`${flowCommand('pre-pr')} || exit 2`);
  }, 15_000);

  it('should exit the PR matcher command with 2 when PATH is empty', () => {
    const entry = (settings.hooks.PreToolUse ?? []).find((e) =>
      e.matcher?.includes('(create|update)_pull_request'),
    );
    const command = entry?.hooks[0]?.command ?? '';

    const result = spawnSync('/bin/sh', ['-c', command], {
      env: { PATH: '', CLAUDE_PROJECT_DIR: repoRoot },
      input: JSON.stringify({ tool_name: MCP_UPDATE, tool_input: { draft: true } }),
      encoding: 'utf8',
    });

    expect(command).toContain('pre-pr');
    expect(result.status).toBe(2);
  }, 15_000);

  it('should set if Bash(gh *) on the Bash entry, which does not end with || exit 2', () => {
    const hook = (settings.hooks.PreToolUse ?? [])
      .filter((e) => e.matcher === 'Bash')
      .flatMap((e) => e.hooks)
      .find((h) => h.command === flowCommand('pre-pr'));

    expect(hook?.if).toBe('Bash(gh *)');
  }, 15_000);

  it('should allow the slug, mark and sync-plan modes and the flow-report command (pattern 15)', () => {
    expect(settings.permissions.allow).toEqual(
      expect.arrayContaining([
        'Bash(node .claude/hooks/flow-hooks.ts slug *)',
        'Bash(node .claude/hooks/flow-hooks.ts mark *)',
        'Bash(node .claude/hooks/flow-hooks.ts sync-plan *)',
        'Bash(node .claude/hooks/flow-report.ts *)',
      ]),
    );
  }, 15_000);

  it('should not cite flow-report in any hooks command, since it is not a hook', () => {
    const commands = Object.values(settings.hooks).flatMap((entries) =>
      entries.flatMap((entry) => entry.hooks.map((hook) => hook.command)),
    );

    expect(commands.filter((command) => command.includes('flow-report'))).toEqual([]);
  }, 15_000);

  it('should ask before any install.ts invocation, flags included', () => {
    const pattern = 'Bash(node *scripts/install.ts*)';
    // o motor de permissões não roda no jest: o curinga vira regex só para provar o alcance
    const inner = pattern.slice('Bash('.length, -1);
    const matcher = new RegExp(`^${inner.replaceAll('.', '\\.').replaceAll('*', '.*')}$`);

    expect(settings.permissions.ask).toContain(pattern);
    expect(matcher.test('node scripts/install.ts')).toBe(true);
    expect(matcher.test('node scripts/install.ts --archive-0x')).toBe(true);
    expect(matcher.test('node ./scripts/install.ts --check')).toBe(true);
    expect(matcher.test('node scripts/build.ts')).toBe(false);
  }, 15_000);

  it('should preserve the gitnexus hook', () => {
    const gitnexus = (settings.hooks.PreToolUse ?? [])
      .flatMap((e) => e.hooks)
      .find((h) => h.if === 'Bash(*gitnexus*)');

    expect(gitnexus?.command).toContain('gitnexus');
  }, 15_000);
});

describe('flow-report.ts', () => {
  const reportPath = path.join(repoRoot, '.claude/hooks/flow-report.ts');
  const hexlogDir = path.join(repoRoot, '.hexlog');
  const PROJECT = 'hexlog';
  const AGENT = 'flow-report-spec';
  const BATCH_LIMIT = 50;

  type Item = {
    type: string;
    target: string;
    data: Record<string, unknown>;
    alias?: string;
    relations?: Record<string, unknown>[];
  };

  const rests = (to: string) => ({ kind: 'derivesFrom', as: 'rests-on', to });
  const anchoredIn = (to: string) => ({ kind: 'derivesFrom', as: 'anchored-in', to });

  const premise = (
    proc: string,
    short: string,
    extra: { answeredBy?: string; relations?: Record<string, unknown>[] } = {},
  ): Item => ({
    type: 'premise',
    target: `${proc}.premise.${short}`,
    data: {
      statement: `Premise ${short}`,
      ...(extra.answeredBy === undefined ? {} : { answeredBy: extra.answeredBy }),
    },
    ...(extra.relations === undefined ? {} : { relations: extra.relations }),
  });

  const gapOf = (
    proc: string,
    short: string,
    context: string,
    relations: Record<string, unknown>[] = [],
  ): Item => ({
    type: 'gap',
    target: `${proc}.gap.${short}`,
    data: { question: `Question ${short}`, context },
    relations,
  });

  const criticalGap = (proc: string, short: string, rule: string): Item =>
    gapOf(proc, short, `Class: critical; rule: ${rule}`);

  const fillsGap = (to: string) => ({ kind: 'answers', as: 'fills-gap', to });

  const decision = (proc: string, short: string, relations: Record<string, unknown>[]): Item => ({
    type: 'decision',
    target: `${proc}.decision.${short}`,
    data: {
      choice: `Choice ${short}`,
      alternatives: [{ option: 'Other', reason: 'Not needed' }],
      rationale: 'Because',
      grounds: 'directive',
      confidence: 'high',
    },
    relations,
  });

  /** Define os tipos e as relações de `.hexlog/` no projeto, como `flow-definitions.spec.ts`. */
  async function defineFlow(environment: Environment): Promise<void> {
    const bodyOf = (kind: string, file: string) =>
      JSON.parse(fs.readFileSync(path.join(hexlogDir, kind, file), 'utf8')) as Record<
        string,
        unknown
      >;
    for (const file of fs.readdirSync(path.join(hexlogDir, 'types'))) {
      const name = file.replace(/\.json$/, '');
      await environment.ok('define_type', {
        project: PROJECT,
        name,
        schema: bodyOf('types', file),
      });
    }
    for (const file of fs.readdirSync(path.join(hexlogDir, 'relations'))) {
      const name = file.replace(/\.json$/, '');
      await environment.ok('define_relation', {
        project: PROJECT,
        name,
        ...bodyOf('relations', file),
      });
    }
  }

  /** Grava `items` em lotes de até `BATCH_LIMIT` e devolve os ids na ordem. */
  async function registerItems(
    environment: Environment,
    proc: string,
    items: Item[],
  ): Promise<string[]> {
    const ids: string[] = [];
    for (let start = 0; start < items.length; start += BATCH_LIMIT) {
      const { records } = await environment.ok<RegisterResult>('register', {
        project: PROJECT,
        process: proc,
        agent: AGENT,
        records: items.slice(start, start + BATCH_LIMIT),
      });
      ids.push(...records.map((record) => record.id));
    }
    return ids;
  }

  /** Um lote só: a chave de cada item é o alias que as relações do lote citam como `@chave`. */
  async function registerNamed(
    environment: Environment,
    proc: string,
    items: Record<string, Item>,
  ): Promise<Record<string, string>> {
    const entries = Object.entries(items);
    const ids = await registerItems(
      environment,
      proc,
      entries.map(([alias, item]) => ({ ...item, alias })),
    );
    return Object.fromEntries(entries.map(([name], index) => [name, at(ids, index)]));
  }

  let xdg: string;
  let xdgWithoutDirectives: string;
  let gitRepo: string;
  let ids: Record<string, string>;
  let currentIds: Set<string>;
  let nonCurrentIds: Set<string>;

  const idOf = (name: string): string => {
    const id = ids[name];
    if (id === undefined) throw new Error(`no fixture id "${name}"`);
    return id;
  };

  beforeAll(async () => {
    const environment = await createEnvironment();
    await defineFlow(environment);
    for (const proc of [
      'directives-9',
      'feat-r',
      'feat-clean',
      'feat-many',
      'feat-wide',
      'feat-c',
    ]) {
      await environment.ok('create_process', { project: PROJECT, process: proc });
    }
    const { hash: source } = await environment.ok<{ hash: string }>('attach', {
      project: PROJECT,
      text: 'rule text',
    });
    // `directives-9` (e não o `directives-N` real) prova que o relatório lê o processo pelo prefixo do id.
    const directives = await registerNamed(environment, 'directives-9', {
      r1: {
        type: 'directive',
        target: 'directives.convencoes.r1',
        data: { rule: 'Rule one', section: 'Section', source },
      },
      r2: {
        type: 'directive',
        target: 'directives.fluxo-hexlog.r2',
        data: { rule: 'Rule two', section: 'Section', source },
      },
      none: {
        type: 'premise',
        target: 'directives.estrategia.none',
        data: { statement: 'No premise applies' },
      },
    });
    const directive = (name: string): string => directives[name] ?? '';

    ids = await registerNamed(environment, 'feat-r', {
      objective: premise('feat-r', 'objective'),
      alpha: premise('feat-r', 'alpha'),
      beta: premise('feat-r', 'beta'),
      'd-obj': decision('feat-r', 'd-obj', [rests('@objective')]),
      'd-none': decision('feat-r', 'd-none', [rests(directive('none'))]),
      'd-ok': decision('feat-r', 'd-ok', [rests('@alpha')]),
      'd-doc': decision('feat-r', 'd-doc', [anchoredIn(directive('r1')), rests('@alpha')]),
      'd-far': decision('feat-r', 'd-far', [anchoredIn(directive('r2')), rests('@beta')]),
      'd-both': decision('feat-r', 'd-both', [anchoredIn(directive('r1')), rests('@objective')]),
      'd-no-rest': decision('feat-r', 'd-no-rest', []),
      'd-old': decision('feat-r', 'd-old', [rests('@objective')]),
      // `supersedes` exige o mesmo target do antecessor
      'd-new': {
        ...decision('feat-r', 'd-new', [{ kind: 'supersedes', to: '@d-old' }, rests('@alpha')]),
        target: 'feat-r.decision.d-old',
      },
      'd-rev': decision('feat-r', 'd-rev', [rests('@objective')]),
      'd-a': decision('feat-r', 'd-a', [rests('@objective')]),
      'd-b': {
        ...decision('feat-r', 'd-b', [{ kind: 'supersedes', to: '@d-a' }, rests('@alpha')]),
        target: 'feat-r.decision.d-a',
      },
      // revoga `d-rev` e o superseder `d-b`: nem `d-a` nem `d-b` voltam a valer
      revoker: {
        type: 'gap',
        target: 'feat-r.gap.revoker',
        data: { question: 'Why revoke?', context: 'Fixture' },
        relations: [
          { kind: 'revokes', to: '@d-rev' },
          { kind: 'revokes', to: '@d-b' },
        ],
      },
    });

    // lacunas críticas: a chave do fixture é o alias do lote
    Object.assign(
      ids,
      await registerNamed(environment, 'feat-c', {
        objective: premise('feat-c', 'objective'),
        'g-open': criticalGap('feat-c', 'open', 'directives.fronteiras.r1'),
        'p-open-sim': premise('feat-c', 'open-sim', { answeredBy: 'simulated' }),
        'g-sim': criticalGap('feat-c', 'sim', 'directives.convencoes.r1'),
        'p-sim': premise('feat-c', 'sim', {
          answeredBy: 'simulated',
          relations: [fillsGap('@g-sim')],
        }),
        'g-ok': criticalGap('feat-c', 'ok', 'directives.invariantes.r2'),
        'p-ok-sim': premise('feat-c', 'ok-sim', { answeredBy: 'simulated' }),
        'p-ok': premise('feat-c', 'ok', {
          answeredBy: 'simulated-approved',
          relations: [fillsGap('@g-ok'), { kind: 'derivesFrom', to: '@p-ok-sim' }],
        }),
        'g-noamend': criticalGap('feat-c', 'noamend', 'directives.fronteiras.r1'),
        'p-noamend': premise('feat-c', 'noamend', {
          answeredBy: 'simulated-approved',
          relations: [fillsGap('@g-noamend')],
        }),
        'g-dir': criticalGap('feat-c', 'dir', 'directives.convencoes.r1'),
        'dir-closer': {
          type: 'directive',
          target: 'directives.convencoes.r9',
          data: { rule: 'Rule nine', section: 'Section', source },
          relations: [{ kind: 'answers', as: 'closes-gap', to: '@g-dir' }],
        },
        'g-none': criticalGap('feat-c', 'none', 'directives.convencoes.r1'),
        'p-none': premise('feat-c', 'none', { relations: [fillsGap('@g-none')] }),
        'g-amended': criticalGap('feat-c', 'amended', 'directives.convencoes.r1'),
        'p-amended': premise('feat-c', 'amended', {
          answeredBy: 'simulated-approved',
          relations: [fillsGap('@g-amended')],
        }),
        'g-human': criticalGap('feat-c', 'human', 'directives.invariantes.r2'),
        'p-human': premise('feat-c', 'human', {
          answeredBy: 'human',
          relations: [fillsGap('@g-human')],
        }),
        'g-norule': gapOf('feat-c', 'norule', 'Class: critical'),
        'p-norule': premise('feat-c', 'norule', {
          answeredBy: 'simulated-approved',
          relations: [fillsGap('@g-norule')],
        }),
        'g-common': gapOf('feat-c', 'common', 'Class: common'),
        'g-common-closed': gapOf('feat-c', 'common-closed', 'Class: common'),
        'p-common': premise('feat-c', 'common', {
          answeredBy: 'simulated',
          relations: [fillsGap('@g-common-closed')],
        }),
        'g-old': criticalGap('feat-c', 'old', 'directives.fronteiras.r1'),
        'g-new': {
          ...gapOf('feat-c', 'new', 'Class: critical; rule: directives.invariantes.r2', [
            { kind: 'supersedes', to: '@g-old' },
          ]),
          target: 'feat-c.gap.old',
        },
        'p-new': premise('feat-c', 'new', {
          answeredBy: 'simulated-approved',
          relations: [fillsGap('@g-new')],
        }),
        'g-revoked': criticalGap('feat-c', 'revoked', 'directives.invariantes.r2'),
        'p-revoked': premise('feat-c', 'revoked', {
          answeredBy: 'simulated-approved',
          relations: [fillsGap('@g-revoked')],
        }),
        'revoke-closer': gapOf('feat-c', 'revoke-closer', 'Fixture', [
          { kind: 'revokes', to: '@p-revoked' },
        ]),
        'd-rests-sim': decision('feat-c', 'rests-sim', [rests('@p-open-sim')]),
        'd-rests-approved': decision('feat-c', 'rests-approved', [rests('@p-ok-sim')]),
        'd-rests-common': decision('feat-c', 'rests-common', [rests('@p-common')]),
      }),
    );

    const clean = await registerNamed(environment, 'feat-clean', {
      objective: premise('feat-clean', 'objective'),
      alpha: premise('feat-clean', 'alpha'),
    });
    await registerItems(environment, 'feat-clean', [
      decision('feat-clean', 'd-ok', [rests(clean.alpha ?? '')]),
    ]);

    const [manyObjective] = await registerItems(environment, 'feat-many', [
      premise('feat-many', 'objective'),
    ]);
    await registerItems(
      environment,
      'feat-many',
      Array.from({ length: 101 }, (_, index) =>
        decision('feat-many', `d${index}`, [rests(manyObjective ?? '')]),
      ),
    );

    const wideShorts = Array.from({ length: 12 }, (_, i) => `p${String(i).padStart(2, '0')}`);
    const [wideObjective] = await registerItems(environment, 'feat-wide', [
      premise('feat-wide', 'objective'),
      ...wideShorts.map((short) => premise('feat-wide', short)),
    ]);
    await registerItems(environment, 'feat-wide', [
      decision('feat-wide', 'd-wide', [rests(wideObjective ?? '')]),
    ]);

    const queryDecisions = (includeNonCurrent: boolean) =>
      environment.ok<QueryResult>('query', {
        project: PROJECT,
        process: 'feat-r',
        type: 'decision',
        includeNonCurrent,
        limit: 200,
      });
    currentIds = new Set((await queryDecisions(false)).records.map((record) => record.id));
    const everyId = (await queryDecisions(true)).records.map((record) => record.id);
    nonCurrentIds = new Set(everyId.filter((id) => !currentIds.has(id)));

    xdg = copyToXdg(environment.dataDir);
    xdgWithoutDirectives = copyToXdg(environment.dataDir);
    fs.rmSync(
      processPaths(path.join(xdgWithoutDirectives, 'hexlog'), {
        project: PROJECT,
        process: 'directives-9',
      }).dir,
      { recursive: true },
    );
    await environment.close();

    // main com dois docs; `feat/r` altera só `convencoes.md`; a base `origin/develop` é criada à mão
    gitRepo = createTempDir('flow-report-git');
    git(gitRepo, 'init', '-q', '-b', 'main');
    git(gitRepo, 'config', 'user.email', 'test@example.com');
    git(gitRepo, 'config', 'user.name', 'Test');
    fs.mkdirSync(path.join(gitRepo, 'docs/directives'), { recursive: true });
    for (const doc of ['convencoes', 'fluxo-hexlog', 'invariantes']) {
      fs.writeFileSync(path.join(gitRepo, `docs/directives/${doc}.md`), `# ${doc}\n`);
    }
    git(gitRepo, 'add', '.');
    git(gitRepo, 'commit', '-q', '-m', 'docs');
    git(gitRepo, 'update-ref', 'refs/remotes/origin/develop', 'HEAD');
    git(gitRepo, 'checkout', '-q', '-b', 'feat/r');
    fs.appendFileSync(path.join(gitRepo, 'docs/directives/convencoes.md'), 'amended\n');
    // datas fixas separam "antes" e "depois" dos registros, que nascem segundos antes do repositório
    const committedOn = (date: string) => ({ GIT_COMMITTER_DATE: date });
    gitWithEnv(
      gitRepo,
      committedOn('2099-01-01T00:00:00Z'),
      'commit',
      '-q',
      '-am',
      'amend convencoes',
    );
    fs.appendFileSync(path.join(gitRepo, 'docs/directives/invariantes.md'), 'amended\n');
    gitWithEnv(
      gitRepo,
      committedOn('2000-01-01T00:00:00Z'),
      'commit',
      '-q',
      '-am',
      'amend invariantes',
    );
    // a base avança com `fluxo-hexlog.md` depois de `feat/r` sair: só o diff contra o merge-base o ignora
    git(gitRepo, 'checkout', '-q', 'main');
    fs.appendFileSync(path.join(gitRepo, 'docs/directives/fluxo-hexlog.md'), 'amended on base\n');
    git(gitRepo, 'commit', '-q', '-am', 'amend fluxo-hexlog on base');
    git(gitRepo, 'update-ref', 'refs/remotes/origin/develop', 'HEAD');
    git(gitRepo, 'checkout', '-q', 'feat/r');
  }, 60_000);

  function runReport(
    args: string[],
    options: { xdg?: string; script?: string } = {},
  ): SpawnSyncReturns<string> {
    return spawnSync(process.execPath, [options.script ?? reportPath, ...args], {
      cwd: gitRepo,
      encoding: 'utf8',
      env: { ...process.env, XDG_DATA_HOME: options.xdg ?? xdg },
    });
  }

  /** Colunas por TAB de cada linha impressa. */
  const rowsOf = (result: SpawnSyncReturns<string>): string[][] =>
    result.stdout
      .split('\n')
      .filter((line) => line !== '')
      .map((line) => line.split('\t'));

  const rowFor = (result: SpawnSyncReturns<string>, name: string): string[] | undefined =>
    rowsOf(result).find(([id]) => id === idOf(name));

  const printedIds = (result: SpawnSyncReturns<string>): string[] =>
    rowsOf(result).map(([id]) => id ?? '');

  const OBJECTIVE_UNCITED = 'only-objective: uncited=feat-r.premise.alpha,feat-r.premise.beta';
  const DOC_AMENDED = 'doc-amended: docs/directives/convencoes.md (directives.convencoes.r1)';

  describe('with the process feat-r against the default base', () => {
    let result: SpawnSyncReturns<string>;

    beforeAll(() => {
      result = runReport(['feat-r']);
    }, 30_000);

    it('should exit with status 0 and no warning on stderr', () => {
      expect(result.status).toBe(0);
      expect(result.stderr).toBe('');
    });

    it('should flag the decision that cites only the objective premise with the uncited premises', () => {
      expect(rowFor(result, 'd-obj')).toEqual([
        idOf('d-obj'),
        'feat-r.decision.d-obj',
        OBJECTIVE_UNCITED,
      ]);
    });

    it('should flag the decision that cites only the sentinel with the uncited premises', () => {
      expect(rowFor(result, 'd-none')).toEqual([
        idOf('d-none'),
        'feat-r.decision.d-none',
        'only-sentinel: uncited=feat-r.premise.objective,feat-r.premise.alpha,feat-r.premise.beta',
      ]);
    });

    it('should not flag a decision that cites a delivery premise', () => {
      expect(rowFor(result, 'd-ok')).toBeUndefined();
    });

    it('should not flag a decision with no rests-on', () => {
      expect(rowFor(result, 'd-no-rest')).toBeUndefined();
    });

    it('should flag as doc-amended a decision anchored in a doc changed in the diff', () => {
      expect(rowFor(result, 'd-doc')).toEqual([
        idOf('d-doc'),
        'feat-r.decision.d-doc',
        DOC_AMENDED,
      ]);
    });

    it('should not flag a decision anchored in a doc changed only on the base after the merge-base', () => {
      expect(rowFor(result, 'd-far')).toBeUndefined();
    });

    it('should join both reasons on the same line, separated by "; "', () => {
      expect(rowFor(result, 'd-both')).toEqual([
        idOf('d-both'),
        'feat-r.decision.d-both',
        `${OBJECTIVE_UNCITED}; ${DOC_AMENDED}`,
      ]);
    });

    it.each(['d-old', 'd-rev', 'd-a', 'd-b'])(
      'should not flag %s, which is not current',
      (name) => {
        expect(rowFor(result, name)).toBeUndefined();
      },
    );

    it('should not flag d-new, which is current and cites a delivery premise', () => {
      expect(rowFor(result, 'd-new')).toBeUndefined();
    });

    it('should only print ids that the server query has as current', () => {
      const printed = printedIds(result);

      expect(printed.length).toBeGreaterThan(0);

      for (const id of printed) expect(currentIds).toContain(id);
    });

    it('should not print any id among the non-current ones of the query', () => {
      expect(nonCurrentIds.size).toBeGreaterThan(0);

      for (const id of printedIds(result)) expect(nonCurrentIds).not.toContain(id);
    });
  });

  describe('with the process feat-c', () => {
    let result: SpawnSyncReturns<string>;

    beforeAll(() => {
      result = runReport(['feat-c']);
    }, 30_000);

    it('should flag an open critical gap as pending approval', () => {
      expect(rowFor(result, 'g-open')).toEqual([
        idOf('g-open'),
        'feat-c.gap.open',
        'critical-gap: open, approval pending',
      ]);
    });

    it('should flag a critical gap closed by a simulated premise', () => {
      expect(rowFor(result, 'g-sim')).toEqual([
        idOf('g-sim'),
        'feat-c.gap.sim',
        'critical-gap: closed by feat-c.premise.sim (answeredBy=simulated)',
      ]);
    });

    it('should keep a gap closed by simulated-approved with the doc in the diff clean', () => {
      expect(rowFor(result, 'g-ok')).toBeUndefined();
    });

    it('should map the convencoes target to convencoes.md in the diff', () => {
      expect(result.stdout).not.toContain('docs/directives/convencoes.md not in the diff');
    });

    it('should flag a gap closed without the amendment of its critical doc in the diff', () => {
      expect(rowFor(result, 'g-noamend')).toEqual([
        idOf('g-noamend'),
        'feat-c.gap.noamend',
        'critical-gap: docs/directives/fronteiras.md not in the diff',
      ]);
    });

    it('should list a gap closed by a directive as answeredBy=none', () => {
      expect(rowFor(result, 'g-dir')).toEqual([
        idOf('g-dir'),
        'feat-c.gap.dir',
        'critical-gap-review: closed by directives.convencoes.r9 (answeredBy=none)',
      ]);
    });

    it('should list a gap closed by a premise without answeredBy', () => {
      expect(rowFor(result, 'g-none')).toEqual([
        idOf('g-none'),
        'feat-c.gap.none',
        'critical-gap-review: closed by feat-c.premise.none (answeredBy=none)',
      ]);
    });

    it('should flag a simulated-approved recorded before the commit that amended the doc', () => {
      expect(rowFor(result, 'g-amended')).toEqual([
        idOf('g-amended'),
        'feat-c.gap.amended',
        'critical-gap: doc amended after the approval (docs/directives/convencoes.md)',
      ]);
    });

    it('should keep a human closer clean when the doc was amended before the approval', () => {
      expect(rowFor(result, 'g-human')).toBeUndefined();
    });

    it('should flag a critical gap without a rule target as an unknown rule doc', () => {
      expect(rowFor(result, 'g-norule')).toEqual([
        idOf('g-norule'),
        'feat-c.gap.norule',
        'critical-gap: rule doc unknown',
      ]);
    });

    it('should not flag a common-class gap', () => {
      expect(rowFor(result, 'g-common')).toBeUndefined();
    });

    it('should not flag a superseded critical gap nor the one that replaced it', () => {
      expect(rowFor(result, 'g-old')).toBeUndefined();
      expect(rowFor(result, 'g-new')).toBeUndefined();
    });

    it('should treat a gap whose closer was revoked as open', () => {
      expect(rowFor(result, 'g-revoked')).toEqual([
        idOf('g-revoked'),
        'feat-c.gap.revoked',
        'critical-gap: open, approval pending',
      ]);
    });

    it('should flag a decision resting on a simulated premise without simulated-approved', () => {
      expect(rowFor(result, 'd-rests-sim')).toEqual([
        idOf('d-rests-sim'),
        'feat-c.decision.rests-sim',
        'rests-on-simulated: feat-c.premise.open-sim has no simulated-approved',
      ]);
    });

    it('should keep a decision resting on a simulated premise with simulated-approved clean', () => {
      expect(rowFor(result, 'd-rests-approved')).toBeUndefined();
    });

    it('should keep a decision resting on a simulated premise that filled a common gap clean', () => {
      expect(rowFor(result, 'd-rests-common')).toBeUndefined();
    });
  });

  describe('when the foreign export fails', () => {
    let result: SpawnSyncReturns<string>;

    beforeAll(() => {
      result = runReport(['feat-r'], { xdg: xdgWithoutDirectives });
    }, 30_000);

    it('should exit with status 0 and one warning per prefix, not per id', () => {
      expect(result.status).toBe(0);
      expect(result.stderr.match(/flow-report:/g)).toHaveLength(1);
      expect(result.stderr).toContain('PROCESS_NOT_FOUND');
    });

    it('should keep the only-objective, which does not depend on the foreign process', () => {
      expect(rowFor(result, 'd-obj')?.[2]).toBe(OBJECTIVE_UNCITED);
    });

    it('should not wrongly flag the sentinel citation nor doc-amended without a target', () => {
      expect(rowFor(result, 'd-none')).toBeUndefined();
      expect(rowFor(result, 'd-doc')).toBeUndefined();
    });
  });

  it('should skip the doc checks of a closed critical gap when git cannot resolve the base', () => {
    const result = runReport(['feat-c', 'no-such-base']);

    expect(result.status).toBe(0);
    expect(result.stderr).toContain('doc-amended skipped');
    expect(rowFor(result, 'g-amended')).toBeUndefined();
    expect(rowFor(result, 'g-noamend')).toBeUndefined();
    expect(rowFor(result, 'g-norule')?.[2]).toBe('critical-gap: rule doc unknown');
    expect(rowFor(result, 'g-open')?.[2]).toBe('critical-gap: open, approval pending');
  }, 30_000);

  it('should drop doc-amended when the base is switched to feat/r and the diff is empty', () => {
    const result = runReport(['feat-r', 'feat/r']);

    expect(result.status).toBe(0);
    expect(rowFor(result, 'd-doc')).toBeUndefined();
    expect(rowFor(result, 'd-both')?.[2]).toBe(OBJECTIVE_UNCITED);
  }, 30_000);

  it('should print nothing to flag when the process has nothing to flag', () => {
    const result = runReport(['feat-clean']);

    expect(result.status).toBe(0);
    expect(result.stdout).toBe('nothing to flag\n');
  }, 30_000);

  it('should warn PROCESS_NOT_FOUND on stderr, with no stdout and status 0, for a nonexistent process', () => {
    const result = runReport(['ghost']);

    expect(result.status).toBe(0);
    expect(result.stdout).toBe('');
    expect(result.stderr).toMatch(/^flow-report: [\s\S]*PROCESS_NOT_FOUND/);
  }, 30_000);

  it('should warn on stderr, with no stdout and status 0, without node_modules', () => {
    // `export.ts` de uma linha reproduz o ERR_MODULE_NOT_FOUND de um worktree sem `npm ci`
    const root = createTempDir('flow-report-bare');
    fs.mkdirSync(path.join(root, '.claude/hooks'), { recursive: true });
    fs.mkdirSync(path.join(root, 'scripts'));
    fs.copyFileSync(reportPath, path.join(root, '.claude/hooks/flow-report.ts'));
    fs.writeFileSync(path.join(root, 'scripts/export.ts'), "import 'pacote-inexistente';\n");

    const result = runReport(['feat-r'], {
      script: path.join(root, '.claude/hooks/flow-report.ts'),
    });

    expect(result.status).toBe(0);
    expect(result.stdout).toBe('');
    expect(result.stderr).toMatch(/^flow-report: [\s\S]*pacote-inexistente/);
  }, 30_000);

  it('should warn from git and keep only the only-objective for an unknown base ref', () => {
    const result = runReport(['feat-r', 'origin/nope']);

    expect(result.status).toBe(0);
    expect(result.stderr).toMatch(/^flow-report: git: /);
    expect(rowFor(result, 'd-obj')?.[2]).toBe(OBJECTIVE_UNCITED);
    expect(rowFor(result, 'd-doc')).toBeUndefined();
  }, 30_000);

  it('should exit with usage on stderr and status 0 for a base that looks like an option', () => {
    const result = runReport(['feat-r', '-x']);

    expect(result.status).toBe(0);
    expect(result.stdout).toBe('');
    expect(result.stderr).toMatch(/^flow-report: usage:/);
  }, 30_000);

  it('should exit with usage on stderr and status 0 without an argument', () => {
    const result = runReport([]);

    expect(result.status).toBe(0);
    expect(result.stdout).toBe('');
    expect(result.stderr).toMatch(/^flow-report: usage:/);
  }, 30_000);

  it('should cut at 100 lines and say how many it omitted', () => {
    const rows = runReport(['feat-many'])
      .stdout.split('\n')
      .filter((line) => line !== '');

    expect(rows).toHaveLength(101);
    expect(rows.at(-1)).toBe('... 1 more omitted');
  }, 30_000);

  it('should list up to 10 uncited premises and count the rest', () => {
    const [row] = rowsOf(runReport(['feat-wide']));
    const uncited = row?.[2]?.split('uncited=')[1];

    expect(uncited?.endsWith(' (+2)')).toBe(true);
    expect(uncited?.replace(' (+2)', '').split(',')).toHaveLength(10);
  }, 30_000);
});
