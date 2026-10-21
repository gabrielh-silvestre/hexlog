import { afterEach, beforeAll, beforeEach, describe, expect, test } from '@jest/globals';
import { spawnSync, type SpawnSyncReturns } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { planSync, type SyncInput } from '../scripts/flow/sync.ts';
import { processPaths } from '../src/adapters/fs/data-format.ts';
import type { RegisterResult } from '../src/commands/process.ts';
import { RESERVED_PROCESS_NAMES } from '../src/domain/ids.ts';
import type { QueryResult } from '../src/queries/query-service.ts';
import { createFlowEnvironment, registerFlowRecord } from './flow-data.ts';
import { at, copyToXdg, createTempDir } from './helpers.ts';
import { type Environment, createEnvironment } from './mcp/environment.ts';

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

beforeAll(async () => {
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
  // dado do hexlog com os gates verdes (sem URGENT nem lacuna) para os dois trabalhos que o `mark` marca
  const flow = await createFlowEnvironment(['feat-x', 'feat-y']);
  xdgHome = copyToXdg(flow.dataDir);
  await flow.close();
}, 30_000);

beforeEach(() => {
  fs.rmSync(markerDir, { recursive: true, force: true });
  git(repo, 'remote', 'set-url', 'origin', ORIGIN_URL);
});

afterEach(() => {
  git(repo, 'update-ref', '-d', 'refs/remotes/origin/feat/x');
});

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

describe('pre-pr: create_pull_request and the marker', () => {
  test('denies without draft and without a marker', () => {
    expectDenied(mcpCreate('feat/x'), /no valid pre-PR marker/);
  }, 15_000);

  test('allows draft true even without a marker', () => {
    expectAllowed(mcpCreate('feat/x', { draft: true }));
  }, 15_000);

  test('allows with a marker whose sha equals the branch sha', () => {
    writeMarker('feat/x', tipSha);
    expectAllowed(mcpCreate('feat/x'));
  }, 15_000);

  test('denies a marker whose sha differs from the branch sha', () => {
    writeMarker('feat/x', baseSha);
    expectDenied(mcpCreate('feat/x'), /no valid pre-PR marker/);
  }, 15_000);

  test('denies a marker whose branch is not the head branch', () => {
    fs.mkdirSync(markerDir, { recursive: true });
    fs.writeFileSync(path.join(markerDir, 'feat-x.ok'), `other\n${tipSha}\n`);
    expectDenied(mcpCreate('feat/x'), /no valid pre-PR marker/);
  }, 15_000);

  test('denies when the local branch ref does not exist', () => {
    writeMarker('ghost/branch', tipSha);
    expectDenied(mcpCreate('ghost/branch'));
  }, 15_000);

  test('denies when origin/<head> points to another sha and allows when it is the same', () => {
    writeMarker('feat/x', tipSha);
    git(repo, 'update-ref', 'refs/remotes/origin/feat/x', baseSha);
    expectDenied(mcpCreate('feat/x'), /no valid pre-PR marker/);
    git(repo, 'update-ref', 'refs/remotes/origin/feat/x', tipSha);
    expectAllowed(mcpCreate('feat/x'));
  }, 15_000);

  test('denies a head from another owner (owner:branch)', () => {
    writeMarker('feat/x', tipSha);
    expectDenied(mcpCreate('someone:feat/x'), /cross-repo PRs unsupported/);
  }, 15_000);

  test.each([
    'git@github.com:acme/widgets.git',
    'https://github.com/acme/widgets',
    'https://github.com/acme/widgets.git',
    'ssh://git@github.com/acme/widgets.git',
  ])(
    'checks owner/repo against the origin %s',
    (url) => {
      git(repo, 'remote', 'set-url', 'origin', url);
      writeMarker('feat/x', tipSha);
      expectAllowed(mcpCreate('feat/x'));
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

  test('gh pr create --head X uses the marker of X', () => {
    writeMarker('feat/y', tipSha);
    expectAllowed(bash('gh pr create --head feat/y --title t'));
    expectAllowed(bash('gh pr create -H feat/y'));
    expectAllowed(bash('gh pr create --head=feat/y'));
    expectDenied(bash('gh pr create --title t'));
  }, 15_000);

  test('gh with -R or --repo is denied', () => {
    writeMarker('feat/x', tipSha);
    expectDenied(bash('gh pr create -R x/y'), /-R\/--repo is denied/);
    expectDenied(bash('gh pr create --repo x/y'), /-R\/--repo is denied/);
  }, 15_000);

  test('a session in one checkout and the PR branch in another worktree share the marker', () => {
    writeMarker('feat/y', tipSha);
    expectAllowed(mcpCreate('feat/y', {}, repo));
    expectAllowed(mcpCreate('feat/y', {}, worktree));
  }, 15_000);

  test('cwd in a subfolder and in a worktree resolve the same marker', () => {
    writeMarker('feat/x', tipSha);
    expectAllowed(mcpCreate('feat/x', {}, path.join(repo, 'sub')));
    expectAllowed(mcpCreate('feat/x', {}, worktree));
  }, 15_000);
});

describe('pre-pr: gh pr ready', () => {
  test('denies without a marker and passes with a marker of the same sha (current branch)', () => {
    expectDenied(bash('gh pr ready'), /no valid pre-PR marker/);
    writeMarker('feat/x', tipSha);
    expectAllowed(bash('gh pr ready'));
  }, 15_000);

  test('with a branch name as argument uses the marker of that branch', () => {
    writeMarker('feat/y', tipSha);
    expectAllowed(bash('gh pr ready feat/y'));
    expectDenied(bash('gh pr ready'), /no valid pre-PR marker/);
  }, 15_000);

  test.each(['gh pr ready 42', 'gh pr ready https://github.com/acme/widgets/pull/42'])(
    'denies by number or URL: %s',
    (command) => {
      writeMarker('feat/x', tipSha);
      expectDenied(bash(command), /by number or URL is denied/);
    },
    15_000,
  );

  test('denies -R x/y', () => {
    writeMarker('feat/x', tipSha);
    expectDenied(bash('gh pr ready -R x/y'), /-R\/--repo is denied/);
  }, 15_000);

  test('passes --undo', () => {
    expectAllowed(bash('gh pr ready --undo'));
  }, 15_000);

  test.each([
    'gh pr ready',
    'time gh pr ready',
    'if x; then gh pr ready; fi',
    'GH_TOKEN=x gh pr ready',
    '/usr/bin/gh pr ready',
    'gh "pr" ready',
    'bash -c "gh pr ready"',
  ])(
    'denies in command position: %s',
    (command) => {
      expectDenied(bash(command));
    },
    15_000,
  );

  test.each([
    'git commit -m "gh pr ready"',
    "echo 'gh pr ready'",
    "rg 'gh pr ready'",
    "cat <<'EOF'\ngh pr ready\nEOF",
  ])(
    'passes when the phrase is quoted or in a heredoc: %s',
    (command) => {
      expectAllowed(bash(command));
    },
    15_000,
  );
});

describe('pre-pr: update_pull_request', () => {
  test('denies draft false with the message that cites gh pr ready', () => {
    expectDenied(
      preHook(MCP_UPDATE, { owner: 'acme', repo: 'widgets', draft: false }),
      /gh pr ready/,
    );
  }, 15_000);

  test.each([
    { draft: true },
    { title: 'novo título' },
    { body: 'novo corpo' },
    { state: 'closed' },
  ])(
    'passes with %j',
    (extra) => {
      expectAllowed(
        preHook(MCP_UPDATE, { owner: 'acme', repo: 'widgets', pullNumber: 1, ...extra }),
      );
    },
    15_000,
  );
});

describe('pre-pr: Bash matching (create)', () => {
  test.each([
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
    'denies: %s',
    (command) => {
      expectDenied(bash(command));
    },
    15_000,
  );

  test('allows gh pr create --draft and -d', () => {
    expectAllowed(bash('gh pr create --draft --title t'));
    expectAllowed(bash('gh pr create -d'));
  }, 15_000);

  test.each([
    'git commit -m "gh pr create"',
    "rg 'gh pr create'",
    `echo '{"command":"gh pr create"}' | node ${hookPath} pre-pr`,
    'gh pr view --body "it\'s"',
    'git commit -m "$(cat <<\'EOF\'\nfix: gh pr create\nEOF\n)"',
    'echo hi # gh pr create',
    'ls -la',
  ])(
    'allows: %s',
    (command) => {
      expectAllowed(bash(command));
    },
    15_000,
  );

  test.each(['gh pr create --title "x', "echo 'gh pr create", 'echo $(gh pr create'])(
    'denies an unpaired quote that matches the loose regex: %s',
    (command) => {
      expectDenied(bash(command));
    },
    15_000,
  );

  test('allows an unpaired quote that mentions neither gh pr create nor ready', () => {
    expectAllowed(bash('echo "abc'));
  }, 15_000);
});

describe('pre-pr: input and failure', () => {
  test('denies stdin that is not JSON', () => {
    expectDenied(runHook(['pre-pr'], { input: 'not json' }));
  }, 15_000);

  test('ignores a tool that is neither PR nor Bash', () => {
    expectAllowed(preHook('Read', { file_path: '/x' }));
  }, 15_000);

  test('denies a failing git (cwd outside a repository)', () => {
    const outside = createTempDir('flow-hooks-outside');
    expectDenied(bash('gh pr ready', outside));
  }, 15_000);

  test('the PR matcher command, with an empty PATH, exits with 2', () => {
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
});

describe('modes', () => {
  test('subagent-start returns the doc path and the branch slug', () => {
    const result = runHook(['subagent-start'], { input: JSON.stringify({ cwd: repo }) });
    expect(result.status).toBe(0);
    const { hookSpecificOutput } = JSON.parse(result.stdout) as {
      hookSpecificOutput: { hookEventName: string; additionalContext: string };
    };
    expect(hookSpecificOutput.hookEventName).toBe('SubagentStart');
    expect(hookSpecificOutput.additionalContext.split('\n')).toHaveLength(3);
    expect(hookSpecificOutput.additionalContext).toContain('docs/directives/fluxo-hexlog.md');
    expect(hookSpecificOutput.additionalContext).toContain('work process: feat-x');
    expect(hookSpecificOutput.additionalContext).toContain('tell whoever launched you');
  }, 15_000);

  test('subagent-start without readable input still returns the context', () => {
    const result = runHook(['subagent-start'], { input: 'not json' });
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('additionalContext');
  }, 15_000);

  test.each([
    ['feat/x', 'feat-x'],
    ['feat!/v1-cutover', 'feat-v1-cutover'],
    ['docs/a.b_c', 'docs-a-b-c'],
    ['Feat/UPPER', 'feat-upper'],
    [`${'a'.repeat(62)}/b`, 'a'.repeat(62)],
    ['a'.repeat(70), 'a'.repeat(63)],
  ])(
    'slug of %s is %s',
    (branch, expected) => {
      const result = runFlow(['slug', branch]);
      expect(result.status).toBe(0);
      expect(result.stdout).toBe(`${expected}\n`);
    },
    15_000,
  );

  test.each(['///', '', 'directives', 'audits', 'audits-2', 'directives-4', 'main', 'develop'])(
    'slug refuses "%s" with exit 1',
    (branch) => {
      const result = runFlow(['slug', branch]);
      expect(result.status).toBe(1);
      expect(result.stdout).toBe('');
    },
    15_000,
  );

  test.each(RESERVED_PROCESS_NAMES)(
    'slug refuses "%s", a name create_process rejects, with exit 1',
    (branch) => {
      const result = runFlow(['slug', branch]);
      expect(result.status).toBe(1);
      expect(result.stdout).toBe('');
    },
    15_000,
  );

  test('mark writes the marker in the git-common-dir and the hook starts accepting the PR and gh pr ready', () => {
    expectDenied(mcpCreate('feat/x'));
    const result = runMark('feat-x');
    expect(result.status).toBe(0);
    expect(fs.readFileSync(path.join(markerDir, 'feat-x.ok'), 'utf8')).toBe(`feat/x\n${tipSha}\n`);
    expectAllowed(mcpCreate('feat/x'));
    expectAllowed(bash('gh pr create --title t'));
    expectAllowed(bash('gh pr ready'));
  }, 15_000);

  test('mark in a worktree writes to the shared git-common-dir', () => {
    const result = runMark('feat-y', worktree);
    expect(result.status).toBe(0);
    expect(fs.existsSync(path.join(markerDir, 'feat-y.ok'))).toBe(true);
  }, 15_000);

  test('mark writes the marker with a dirty working tree and green gates', () => {
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

  test('mark refuses and writes nothing when a gate is red', async () => {
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

  test('mark refuses a branch that yields no slug', () => {
    const result = runMark('other-slug');
    expect(result.status).toBe(1);
    expect(result.stderr).toMatch(/does not yield slug/);
    expect(fs.existsSync(markerDir)).toBe(false);
  }, 15_000);

  test('sync-plan returns the same plan as planSync called directly', () => {
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

  describe('sync-plan with an invalid path', () => {
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

    test('an empty path exits with 0 and the error in the JSON', () => {
      expect(syncPlan({ path: '' })).toEqual(refused);
    }, 15_000);

    test('a path outside docs/directives exits with 0 and the error in the JSON', () => {
      expect(syncPlan({ docSlug: 'convencoes', path: 'docs/x.md' })).toEqual(refused);
    }, 15_000);

    // sem o pré-check o hook leria o arquivo malformado e sairia com 2 e o motivo no stderr
    test('estrategia with an absolute path to a malformed file is not read', () => {
      const file = path.join(createTempDir('strategy'), 'estrategia.md');
      fs.writeFileSync(file, '## Tema\n- sem crase: linha ruim');

      expect(syncPlan({ path: file })).toEqual(refused);
    }, 15_000);

    test('estrategia with an absolute path to a missing file is not read', () => {
      const file = path.join(createTempDir('strategy'), 'faltando.md');

      expect(syncPlan({ path: file })).toEqual(refused);
    }, 15_000);
  });

  test('an unknown mode exits with 2', () => {
    expectDenied(runHook(['nope']), /unknown mode/);
    expectDenied(runFlow(['nope']), /unknown mode/);
  }, 15_000);

  test.each(['slug', 'mark', 'sync-plan'])(
    'the hook only has pre-pr and subagent-start: %s is unknown',
    (mode) => {
      expectDenied(runHook([mode, 'feat-x']), /unknown mode/);
    },
    15_000,
  );

  test('marker.ts imports only node builtins', () => {
    const specifiers = [...fs.readFileSync(markerSource, 'utf8').matchAll(/from '([^']+)'/g)].map(
      (match) => match[1],
    );
    expect(specifiers.length).toBeGreaterThan(0);
    for (const specifier of specifiers) expect(specifier).toMatch(/^node:/);
  });
});

describe('settings.json', () => {
  const flowCommand = (mode: string): string =>
    `node "$CLAUDE_PROJECT_DIR/.claude/hooks/flow-hooks.ts" ${mode}`;

  test('has a SubagentStart entry with an empty matcher', () => {
    const entries = settings.hooks.SubagentStart ?? [];
    expect(entries).toHaveLength(1);
    expect(entries[0]?.matcher).toBe('');
    expect(entries[0]?.hooks[0]?.command).toBe(flowCommand('subagent-start'));
  }, 15_000);

  test('the MCP PR matcher ends with || exit 2', () => {
    const entry = (settings.hooks.PreToolUse ?? []).find(
      (e) => e.matcher === '^mcp__github-official__(create|update)_pull_request$',
    );
    expect(entry?.hooks[0]?.command).toBe(`${flowCommand('pre-pr')} || exit 2`);
  }, 15_000);

  const bashPrHook = (): Hook | undefined =>
    (settings.hooks.PreToolUse ?? [])
      .filter((e) => e.matcher === 'Bash')
      .flatMap((e) => e.hooks)
      .find((h) => h.command.startsWith(flowCommand('pre-pr')));

  test('the Bash entry has if Bash(gh *) and ends with || exit 2', () => {
    const hook = bashPrHook();
    expect(hook?.command).toBe(`${flowCommand('pre-pr')} || exit 2`);
    expect(hook?.if).toBe('Bash(gh *)');
  }, 15_000);

  test('the Bash matcher command, with an empty PATH, exits with 2', () => {
    const result = spawnSync('/bin/sh', ['-c', bashPrHook()?.command ?? ''], {
      env: { PATH: '', CLAUDE_PROJECT_DIR: repoRoot },
      input: JSON.stringify({ tool_name: 'Bash', tool_input: { command: 'gh pr create' } }),
      encoding: 'utf8',
    });
    expect(result.status).toBe(2);
  }, 15_000);

  test('has the allow rules of the flow scripts', () => {
    expect(settings.permissions.allow).toEqual([
      'Bash(node scripts/flow/flow.ts slug *)',
      'Bash(node scripts/flow/flow.ts sync-plan *)',
      'Bash(node scripts/flow/mark.ts *)',
      'Bash(node scripts/flow/gate.ts *)',
      'Bash(node scripts/flow/report.ts *)',
    ]);
  }, 15_000);

  test('flow-report is not a hook: no hooks command cites it', () => {
    const commands = Object.values(settings.hooks).flatMap((entries) =>
      entries.flatMap((entry) => entry.hooks.map((hook) => hook.command)),
    );
    expect(commands.filter((command) => command.includes('flow-report'))).toEqual([]);
  }, 15_000);

  test('asks before any install.ts invocation, flags included', () => {
    const pattern = 'Bash(node *scripts/install.ts*)';
    expect(settings.permissions.ask).toContain(pattern);
    // o motor de permissões não roda no jest: o curinga vira regex só para provar o alcance
    const inner = pattern.slice('Bash('.length, -1);
    const matcher = new RegExp(`^${inner.replaceAll('.', '\\.').replaceAll('*', '.*')}$`);
    expect(matcher.test('node scripts/install.ts')).toBe(true);
    expect(matcher.test('node scripts/install.ts --archive-0x')).toBe(true);
    expect(matcher.test('node ./scripts/install.ts --check')).toBe(true);
    expect(matcher.test('node scripts/build.ts')).toBe(false);
  }, 15_000);

  test('preserves the old gitnexus hook', () => {
    const gitnexus = (settings.hooks.PreToolUse ?? [])
      .flatMap((e) => e.hooks)
      .find((h) => h.if === 'Bash(*gitnexus*)');
    expect(gitnexus?.command).toContain('gitnexus');
  }, 15_000);
});

describe('flow-report', () => {
  const reportPath = path.join(repoRoot, 'scripts/flow/report.ts');
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

  const premise = (proc: string, short: string): Item => ({
    type: 'premise',
    target: `${proc}.premise.${short}`,
    data: { statement: `Premise ${short}` },
  });

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

  /** Objetivo, `premises` premissas `p00`, `p01`... e `decisions` decisões `d0`... que citam só o objetivo. */
  async function registerObjectiveFixture(
    environment: Environment,
    proc: string,
    { premises, decisions }: { premises: number; decisions: number },
  ): Promise<void> {
    const shorts = Array.from({ length: premises }, (_, i) => `p${String(i).padStart(2, '0')}`);
    const [objective] = await registerItems(environment, proc, [
      premise(proc, 'objective'),
      ...shorts.map((short) => premise(proc, short)),
    ]);
    await registerItems(
      environment,
      proc,
      Array.from({ length: decisions }, (_, index) =>
        decision(proc, `d${index}`, [rests(objective ?? '')]),
      ),
    );
  }

  let xdg: string;
  let xdgWithoutDirectives: string;
  let gitRepo: string;
  let ids: Record<string, string>;
  let inheritedIds: Record<string, string>;
  let currentIds: Set<string>;

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
      'feat-edge-lines',
      'feat-edge-wide',
      'feat-inherit',
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
      gamma: premise('feat-r', 'gamma'),
      'd-obj': decision('feat-r', 'd-obj', [rests('@objective')]),
      'd-none': decision('feat-r', 'd-none', [rests(directive('none'))]),
      'd-both-none': decision('feat-r', 'd-both-none', [
        rests('@objective'),
        rests(directive('none')),
      ]),
      'd-revoked-prem': decision('feat-r', 'd-revoked-prem', [
        rests('@objective'),
        rests('@gamma'),
      ]),
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
      // revoga a premissa `gamma`, que `d-revoked-prem` ainda cita
      'revoker-prem': {
        type: 'gap',
        target: 'feat-r.gap.revoker-prem',
        data: { question: 'Why revoke the premise?', context: 'Fixture' },
        relations: [{ kind: 'revokes', to: '@gamma' }],
      },
    });

    const clean = await registerNamed(environment, 'feat-clean', {
      objective: premise('feat-clean', 'objective'),
      alpha: premise('feat-clean', 'alpha'),
    });
    await registerItems(environment, 'feat-clean', [
      decision('feat-clean', 'd-ok', [rests(clean.alpha ?? '')]),
    ]);

    // `d-new` não regrava o `rests-on` de `d-old`: o apoio só chega pela herança da linhagem
    inheritedIds = await registerNamed(environment, 'feat-inherit', {
      objective: premise('feat-inherit', 'objective'),
      alpha: premise('feat-inherit', 'alpha'),
      'd-old': decision('feat-inherit', 'd-old', [rests('@objective')]),
      'd-new': decision('feat-inherit', 'd-old', [{ kind: 'supersedes', to: '@d-old' }]),
    });

    await registerObjectiveFixture(environment, 'feat-many', { premises: 0, decisions: 101 });
    await registerObjectiveFixture(environment, 'feat-wide', { premises: 12, decisions: 1 });
    // as bordas: 100 linhas e 10 premissas cabem inteiras, sem corte
    await registerObjectiveFixture(environment, 'feat-edge-lines', { premises: 0, decisions: 100 });
    await registerObjectiveFixture(environment, 'feat-edge-wide', { premises: 10, decisions: 1 });

    const { records: currentDecisions } = await environment.ok<QueryResult>('query', {
      project: PROJECT,
      process: 'feat-r',
      type: 'decision',
      limit: 200,
    });
    currentIds = new Set(currentDecisions.map((record) => record.id));

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
    for (const doc of ['convencoes', 'fluxo-hexlog']) {
      fs.writeFileSync(path.join(gitRepo, `docs/directives/${doc}.md`), `# ${doc}\n`);
    }
    git(gitRepo, 'add', '.');
    git(gitRepo, 'commit', '-q', '-m', 'docs');
    git(gitRepo, 'update-ref', 'refs/remotes/origin/develop', 'HEAD');
    git(gitRepo, 'checkout', '-q', '-b', 'feat/r');
    fs.appendFileSync(path.join(gitRepo, 'docs/directives/convencoes.md'), 'amended\n');
    git(gitRepo, 'commit', '-q', '-am', 'amend convencoes');
    // a base avança com `fluxo-hexlog.md` depois de `feat/r` sair: só o diff contra o merge-base o ignora
    git(gitRepo, 'checkout', '-q', 'main');
    fs.appendFileSync(path.join(gitRepo, 'docs/directives/fluxo-hexlog.md'), 'amended on base\n');
    git(gitRepo, 'commit', '-q', '-am', 'amend fluxo-hexlog on base');
    git(gitRepo, 'update-ref', 'refs/remotes/origin/develop', 'HEAD');
    git(gitRepo, 'checkout', '-q', 'feat/r');
  }, 60_000);

  function runReport(args: string[], options: { xdg?: string } = {}): SpawnSyncReturns<string> {
    return spawnSync(process.execPath, [reportPath, ...args], {
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

  describe('feat-r against the default base', () => {
    let result: SpawnSyncReturns<string>;

    beforeAll(() => {
      result = runReport(['feat-r']);
    }, 30_000);

    test('exits with status 0 and no warning on stderr', () => {
      expect(result.status).toBe(0);
      expect(result.stderr).not.toMatch(/flow-report:/);
    });

    test('flags the decision that cites only the objective premise, with the uncited premises', () => {
      expect(rowFor(result, 'd-obj')).toEqual([
        idOf('d-obj'),
        'feat-r.decision.d-obj',
        OBJECTIVE_UNCITED,
      ]);
    });

    test('flags the decision that cites only the sentinel, with the uncited premises', () => {
      expect(rowFor(result, 'd-none')).toEqual([
        idOf('d-none'),
        'feat-r.decision.d-none',
        'only-sentinel: uncited=feat-r.premise.objective,feat-r.premise.alpha,feat-r.premise.beta',
      ]);
    });

    test('flags the decision that cites the objective and the sentinel together', () => {
      expect(rowFor(result, 'd-both-none')).toEqual([
        idOf('d-both-none'),
        'feat-r.decision.d-both-none',
        OBJECTIVE_UNCITED.replace('only-objective:', 'only-objective+sentinel:'),
      ]);
    });

    test('counts a revoked premise as a citation, so the decision is not flagged', () => {
      expect(rowFor(result, 'd-revoked-prem')).toBeUndefined();
    });

    test('does not flag the decision that cites a delivery premise', () => {
      expect(rowFor(result, 'd-ok')).toBeUndefined();
    });

    test('does not flag the decision without any rests-on', () => {
      expect(rowFor(result, 'd-no-rest')).toBeUndefined();
    });

    test('flags as doc-amended the decision anchored in a doc changed in the diff', () => {
      expect(rowFor(result, 'd-doc')).toEqual([
        idOf('d-doc'),
        'feat-r.decision.d-doc',
        DOC_AMENDED,
      ]);
    });

    test('does not flag the decision anchored in a doc changed only on the base after the merge-base', () => {
      expect(rowFor(result, 'd-far')).toBeUndefined();
    });

    test('joins both reasons on the same line, separated by "; "', () => {
      expect(rowFor(result, 'd-both')).toEqual([
        idOf('d-both'),
        'feat-r.decision.d-both',
        `${OBJECTIVE_UNCITED}; ${DOC_AMENDED}`,
      ]);
    });

    test.each(['d-old', 'd-rev', 'd-a', 'd-b'])(
      'does not flag %s, which is not current',
      (name) => {
        expect(rowFor(result, name)).toBeUndefined();
      },
    );

    test('does not flag d-new, which is current and cites a delivery premise', () => {
      expect(rowFor(result, 'd-new')).toBeUndefined();
    });

    test('prints only ids that the server query reports as current', () => {
      const printed = printedIds(result);
      expect(printed.length).toBeGreaterThan(0);
      for (const id of printed) expect(currentIds).toContain(id);
    });
  });

  test('with the base swapped for feat/r the diff is empty and doc-amended disappears', () => {
    const result = runReport(['feat-r', 'feat/r']);
    expect(result.status).toBe(0);
    expect(rowFor(result, 'd-doc')).toBeUndefined();
    expect(rowFor(result, 'd-both')?.[2]).toBe(OBJECTIVE_UNCITED);
  }, 30_000);

  test('counts the rests-on that a superseding decision inherits from its lineage', () => {
    const result = runReport(['feat-inherit']);
    expect(result.status).toBe(0);
    expect(rowsOf(result)).toEqual([
      [
        inheritedIds['d-new'] ?? '',
        'feat-inherit.decision.d-old',
        'only-objective: uncited=feat-inherit.premise.alpha',
      ],
    ]);
  }, 30_000);

  test('prints nothing to flag when the process has nothing to flag', () => {
    const result = runReport(['feat-clean']);
    expect(result.status).toBe(0);
    expect(result.stdout).toBe('nothing to flag\n');
  }, 30_000);

  test('a missing process warns PROCESS_NOT_FOUND on stderr, with no stdout and status 0', () => {
    const result = runReport(['ghost']);
    expect(result.status).toBe(0);
    expect(result.stdout).toBe('');
    expect(result.stderr).toMatch(/^flow-report: [\s\S]*PROCESS_NOT_FOUND/);
  }, 30_000);

  test('legacy 0.x data warns on stderr, with no stdout and status 0', () => {
    const legacy = createTempDir('flow-report-legacy');
    fs.cpSync(path.join(__dirname, 'fixtures', 'legacy-0x'), path.join(legacy, 'hexlog'), {
      recursive: true,
    });

    const result = runReport(['feat-r'], { xdg: legacy });

    expect(result.status).toBe(0);
    expect(result.stdout).toBe('');
    expect(result.stderr).toMatch(/^flow-report: [\s\S]*LEGACY_DATA/);
  }, 30_000);

  test('an unknown base ref warns from git and keeps only the only-objective', () => {
    const result = runReport(['feat-r', 'origin/nope']);
    expect(result.status).toBe(0);
    expect(result.stderr).toMatch(
      /^flow-report: git: cannot diff HEAD against "origin\/nope", doc-amended skipped\n$/,
    );
    expect(rowFor(result, 'd-obj')?.[2]).toBe(OBJECTIVE_UNCITED);
    expect(rowFor(result, 'd-doc')).toBeUndefined();
  }, 30_000);

  test('a base that looks like an option exits with usage on stderr and status 0', () => {
    const result = runReport(['feat-r', '-x']);
    expect(result.status).toBe(0);
    expect(result.stdout).toBe('');
    expect(result.stderr).toMatch(/^flow-report: usage:/);
  }, 30_000);

  test.each([
    [['Feat_R']],
    [['../x']],
    [['a$b']],
    [['feat-r', 'a b']],
    [['feat-r', 'x;y']],
    [['feat-r', '$(id)']],
  ])(
    'refuses the invalid slug or base %j with usage on stderr and status 0',
    (args) => {
      const result = runReport(args);
      expect(result.status).toBe(0);
      expect(result.stdout).toBe('');
      expect(result.stderr).toMatch(/^flow-report: usage:/);
    },
    30_000,
  );

  test('no argument exits with usage on stderr and status 0', () => {
    const result = runReport([]);
    expect(result.status).toBe(0);
    expect(result.stdout).toBe('');
    expect(result.stderr).toMatch(/^flow-report: usage:/);
  }, 30_000);

  describe('a failing read of the foreign process', () => {
    let result: SpawnSyncReturns<string>;

    beforeAll(() => {
      result = runReport(['feat-r'], { xdg: xdgWithoutDirectives });
    }, 30_000);

    test('exits with status 0 and one warning per prefix, not per id', () => {
      expect(result.status).toBe(0);
      expect(result.stderr.match(/flow-report:/g)).toHaveLength(1);
      expect(result.stderr).toContain('PROCESS_NOT_FOUND');
    });

    test('keeps the only-objective, which does not depend on the foreign process', () => {
      expect(rowFor(result, 'd-obj')?.[2]).toBe(OBJECTIVE_UNCITED);
    });

    test('does not wrongly flag the sentinel citation nor doc-amended without a target', () => {
      expect(rowFor(result, 'd-none')).toBeUndefined();
      expect(rowFor(result, 'd-doc')).toBeUndefined();
    });
  });

  test('cuts at 100 lines and says how many were omitted', () => {
    const rows = runReport(['feat-many'])
      .stdout.split('\n')
      .filter((line) => line !== '');
    expect(rows).toHaveLength(101);
    expect(rows.at(-1)).toBe('... 1 more omitted');
  }, 30_000);

  test('lists up to 10 uncited premises and counts the rest', () => {
    const [row] = rowsOf(runReport(['feat-wide']));
    const uncited = row?.[2]?.split('uncited=')[1];
    expect(uncited?.endsWith(' (+2)')).toBe(true);
    expect(uncited?.replace(' (+2)', '').split(',')).toHaveLength(10);
  }, 30_000);

  test('prints exactly 100 lines without the omitted line', () => {
    const rows = runReport(['feat-edge-lines'])
      .stdout.split('\n')
      .filter((line) => line !== '');
    expect(rows).toHaveLength(100);
    expect(rows.join('\n')).not.toContain('omitted');
  }, 30_000);

  test('lists exactly 10 uncited premises without the count suffix', () => {
    const [row] = rowsOf(runReport(['feat-edge-wide']));
    const uncited = row?.[2]?.split('uncited=')[1];
    expect(uncited).not.toContain('(+');
    expect(uncited?.split(',')).toHaveLength(10);
  }, 30_000);
});
