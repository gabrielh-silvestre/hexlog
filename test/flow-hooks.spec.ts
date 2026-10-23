import { afterEach, beforeAll, beforeEach, describe, expect, it } from '@jest/globals';
import { spawnSync, type SpawnSyncReturns } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { planSync, type SyncInput } from '../scripts/flow/sync.ts';
import { RESERVED_PROCESS_NAMES } from '../src/domain/ids.ts';
import { createFlowEnvironment, registerFlowRecord } from './flow-data.ts';
import { copyToXdg, createTempDir } from './helpers.ts';

const repoRoot = path.resolve(__dirname, '..');
const hookPath = path.join(repoRoot, '.claude/hooks/flow-hooks.ts');
const flowPath = path.join(repoRoot, 'scripts/flow/flow.ts');
const markPath = path.join(repoRoot, 'scripts/flow/mark.ts');
const markerSource = path.join(repoRoot, 'scripts/flow/marker.ts');

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
let xdgHome: string;

function git(cwd: string, ...args: string[]): string {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8' });
  if (result.status !== 0) throw new Error(`git ${args.join(' ')}: ${result.stderr}`);
  return result.stdout.trim();
}

// O lint exige hook dentro de `describe`, então cada alvo registra estes com o seu próprio repositório.
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

// dado do hexlog com os gates verdes (sem URGENT nem lacuna) para os dois trabalhos que o `mark` marca
async function createMarkData(): Promise<void> {
  const flow = await createFlowEnvironment(['feat-x', 'feat-y']);
  xdgHome = copyToXdg(flow.dataDir);
  await flow.close();
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

function runFlow(args: string[], options: { input?: string; cwd?: string } = {}): HookResult {
  return spawnSync(process.execPath, [flowPath, ...args], {
    input: options.input ?? '',
    cwd: options.cwd ?? repo,
    encoding: 'utf8',
  });
}

function runMark(slug: string, cwd = repo, xdg = xdgHome): HookResult {
  return spawnSync(process.execPath, [markPath, slug], {
    cwd,
    encoding: 'utf8',
    env: { ...process.env, XDG_DATA_HOME: xdg },
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
  const slug = runFlow(['slug', branch]).stdout.trim();
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

describe('.claude/hooks/flow-hooks.ts pre-pr', () => {
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
      'should allow the owner/repo that matches the origin %s',
      (url) => {
        git(repo, 'remote', 'set-url', 'origin', url);
        writeMarker('feat/x', tipSha);

        expectAllowed(mcpCreate('feat/x'));
      },
      15_000,
    );

    it.each(ORIGIN_URLS)(
      'should deny an owner or a repo that differs from the origin %s',
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

describe('.claude/hooks/flow-hooks.ts subagent-start', () => {
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

  it('should put the hand-back rule with the owner-seat carve-out on line 1 for any agent', () => {
    const result = runHook(['subagent-start'], {
      input: JSON.stringify({ cwd: repo }),
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
  }, 15_000);

  it('should still return the context without readable input', () => {
    const result = runHook(['subagent-start'], { input: 'not json' });

    expect(result.status).toBe(0);
    expect(result.stdout).toContain('additionalContext');
  }, 15_000);
});

describe('.claude/hooks/flow-hooks.ts', () => {
  beforeAll(createRepo, 15_000);

  it('should exit with 2 for an unknown mode', () => {
    expectDenied(runHook(['nope']), /unknown mode/);
  }, 15_000);

  it.each(['slug', 'mark', 'sync-plan'])(
    'should exit with 2 for %s, which is not a hook mode',
    (mode) => {
      expectDenied(runHook([mode, 'feat-x']), /unknown mode/);
    },
    15_000,
  );
});

describe('scripts/flow/flow.ts slug', () => {
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
      const result = runFlow(['slug', branch]);

      expect(result.status).toBe(0);
      expect(result.stdout).toBe(`${expected}\n`);
    },
    15_000,
  );

  it.each(['///', '', 'directives', 'audits', 'audits-2', 'directives-4', 'main', 'develop'])(
    'should refuse "%s" with exit 1',
    (branch) => {
      const result = runFlow(['slug', branch]);

      expect(result.status).toBe(1);
      expect(result.stdout).toBe('');
    },
    15_000,
  );

  it.each(RESERVED_PROCESS_NAMES)(
    'should refuse "%s", a name create_process rejects, with exit 1',
    (branch) => {
      const result = runFlow(['slug', branch]);

      expect(result.status).toBe(1);
      expect(result.stdout).toBe('');
    },
    15_000,
  );
});

describe('scripts/flow/flow.ts sync-plan', () => {
  beforeAll(createRepo, 15_000);

  it('should return the same plan as planSync called directly', () => {
    const input: SyncInput = {
      docSlug: 'convencoes',
      path: 'docs/directives/convencoes.md',
      hash: 'a'.repeat(64),
      current: null,
      vigent: [],
      extracted: [{ slug: 'idioma', rule: 'Código em inglês.', section: 'Idioma' }],
    };

    const result = runFlow(['sync-plan'], { input: JSON.stringify(input) });

    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual(JSON.parse(JSON.stringify(planSync(input))));
  }, 15_000);

  describe('with an invalid path', () => {
    const syncPlan = (input: Partial<SyncInput>) => {
      const result = runFlow(['sync-plan'], {
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

    it('should not read estrategia given an absolute path to a missing file', () => {
      const file = path.join(createTempDir('strategy'), 'faltando.md');

      expect(syncPlan({ path: file })).toEqual(refused);
    }, 15_000);
  });
});

describe('scripts/flow/flow.ts', () => {
  beforeAll(createRepo, 15_000);

  it('should exit with 2 for an unknown mode', () => {
    expectDenied(runFlow(['nope']), /unknown mode/);
  }, 15_000);
});

describe('scripts/flow/mark.ts', () => {
  beforeAll(createRepo, 15_000);
  beforeAll(createMarkData, 30_000);
  beforeEach(resetRepo);

  it('should write the marker in the git-common-dir', () => {
    const result = runMark('feat-x');

    expect(result.status).toBe(0);
    expect(fs.readFileSync(path.join(markerDir, 'feat-x.ok'), 'utf8')).toBe(`feat/x\n${tipSha}\n`);
  }, 15_000);

  it('should make the pre-pr hook accept the PR and gh pr ready', () => {
    runMark('feat-x');

    expectAllowed(mcpCreate('feat/x'));
    expectAllowed(bash('gh pr create --title t'));
    expectAllowed(bash('gh pr ready'));
  }, 15_000);

  it('should write to the shared git-common-dir when run in a worktree', () => {
    const result = runMark('feat-y', worktree);

    expect(result.status).toBe(0);
    expect(fs.existsSync(path.join(markerDir, 'feat-y.ok'))).toBe(true);
  }, 15_000);

  it('should write the marker with a dirty working tree and green gates', () => {
    const dirty = path.join(repo, 'dirty.txt');
    fs.writeFileSync(dirty, 'x');

    try {
      const result = runMark('feat-x');

      expect(result.status).toBe(0);
      expect(fs.readFileSync(path.join(markerDir, 'feat-x.ok'), 'utf8')).toBe(
        `feat/x\n${tipSha}\n`,
      );
    } finally {
      fs.rmSync(dirty);
    }
  }, 15_000);

  it('should refuse and write nothing when a gate is red', async () => {
    const flow = await createFlowEnvironment(['feat-x']);
    try {
      const findingId = await registerFlowRecord(flow, 'feat-x', {
        type: 'finding',
        target: 'feat-x.finding.a',
        data: { severity: 'URGENT', origin: 'review', description: 'No bound', location: 'a.ts' },
      });

      const result = runMark('feat-x', repo, copyToXdg(flow.dataDir));

      expect(result.status).toBe(1);
      expect(result.stderr).toContain(`gates are not green\npre-pr: no_pending: ${findingId}`);
      expect(fs.existsSync(markerDir)).toBe(false);
    } finally {
      await flow.close();
    }
  }, 30_000);

  it('should refuse a branch that yields no slug', () => {
    const result = runMark('other-slug');

    expect(result.status).toBe(1);
    expect(result.stderr).toMatch(/does not yield slug/);
    expect(fs.existsSync(markerDir)).toBe(false);
  }, 15_000);
});

describe('scripts/flow/marker.ts', () => {
  it('should import only node builtins', () => {
    const specifiers = [...fs.readFileSync(markerSource, 'utf8').matchAll(/from '([^']+)'/g)].map(
      (match) => match[1],
    );

    expect(specifiers.length).toBeGreaterThan(0);

    for (const specifier of specifiers) expect(specifier).toMatch(/^node:/);
  });
});

describe('.claude/settings.json', () => {
  const flowCommand = (mode: string): string =>
    `node "$CLAUDE_PROJECT_DIR/.claude/hooks/flow-hooks.ts" ${mode}`;

  const bashPrHook = (): Hook | undefined =>
    (settings.hooks.PreToolUse ?? [])
      .filter((e) => e.matcher === 'Bash')
      .flatMap((e) => e.hooks)
      .find((h) => h.command.startsWith(flowCommand('pre-pr')));

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

    expect(command).toContain('pre-pr');

    const result = spawnSync('/bin/sh', ['-c', command], {
      env: { PATH: '', CLAUDE_PROJECT_DIR: repoRoot },
      input: JSON.stringify({ tool_name: MCP_UPDATE, tool_input: { draft: true } }),
      encoding: 'utf8',
    });

    expect(result.status).toBe(2);
  }, 15_000);

  it('should end the Bash entry command with || exit 2', () => {
    const hook = bashPrHook();

    expect(hook?.command).toBe(`${flowCommand('pre-pr')} || exit 2`);
  }, 15_000);

  it('should set if Bash(gh *) on the Bash entry', () => {
    const hook = bashPrHook();

    expect(hook?.if).toBe('Bash(gh *)');
  }, 15_000);

  it('should exit the Bash matcher command with 2 when PATH is empty', () => {
    const result = spawnSync('/bin/sh', ['-c', bashPrHook()?.command ?? ''], {
      env: { PATH: '', CLAUDE_PROJECT_DIR: repoRoot },
      input: JSON.stringify({ tool_name: 'Bash', tool_input: { command: 'gh pr create' } }),
      encoding: 'utf8',
    });

    expect(result.status).toBe(2);
  }, 15_000);

  it('should allow the commands of the flow scripts', () => {
    expect(settings.permissions.allow).toEqual([
      'Bash(node scripts/flow/flow.ts slug *)',
      'Bash(node scripts/flow/flow.ts sync-plan *)',
      'Bash(node scripts/flow/mark.ts *)',
      'Bash(node scripts/flow/gate.ts *)',
      'Bash(node scripts/flow/report.ts *)',
      'Bash(node scripts/flow/critic.ts *)',
    ]);
  }, 15_000);

  it('should allow every verb of the critic runner without asking', () => {
    const pattern = 'Bash(node scripts/flow/critic.ts *)';
    // o motor de permissões não roda no jest: o curinga vira regex só para provar o alcance
    const inner = pattern.slice('Bash('.length, -1);
    const matcher = new RegExp(`^${inner.replaceAll('.', '\\.').replaceAll('*', '.*')}$`);

    expect(settings.permissions.allow).toContain(pattern);
    expect(settings.permissions.ask).not.toContain(pattern);
    expect(matcher.test('node scripts/flow/critic.ts start my-slug --tool agy')).toBe(true);
    expect(matcher.test('node scripts/flow/critic.ts ask /tmp/hexlog-critic-x-AbCdEf')).toBe(true);
    expect(matcher.test('node scripts/flow/critic.ts close /tmp/hexlog-critic-x-AbCdEf')).toBe(
      true,
    );
    expect(matcher.test('node scripts/flow/mark.ts my-slug')).toBe(false);
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

  it('should ask before reanchor.ts --apply and not before the dry-run', () => {
    const pattern = 'Bash(node *scripts/flow/reanchor.ts*--apply*)';
    // o motor de permissões não roda no jest: o curinga vira regex só para provar o alcance
    const inner = pattern.slice('Bash('.length, -1);
    const matcher = new RegExp(`^${inner.replaceAll('.', '\\.').replaceAll('*', '.*')}$`);

    expect(settings.permissions.ask).toContain(pattern);
    expect(settings.permissions.allow).not.toContain(pattern);
    expect(matcher.test('node scripts/flow/reanchor.ts --to directives-4 --apply')).toBe(true);
    expect(matcher.test('node scripts/flow/reanchor.ts --apply --to directives-4')).toBe(true);
    expect(matcher.test('node ./scripts/flow/reanchor.ts --apply')).toBe(true);
    expect(matcher.test('node scripts/flow/reanchor.ts --to directives-4')).toBe(false);
  }, 15_000);

  it('should preserve the gitnexus hook', () => {
    const gitnexus = (settings.hooks.PreToolUse ?? [])
      .flatMap((e) => e.hooks)
      .find((h) => h.if === 'Bash(*gitnexus*)');

    expect(gitnexus?.command).toContain('gitnexus');
  }, 15_000);
});
