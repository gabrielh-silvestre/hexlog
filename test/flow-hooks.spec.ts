import { afterEach, beforeAll, beforeEach, describe, expect, test } from '@jest/globals';
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

  test('asks before reanchor.ts --apply and not before the dry-run', () => {
    const pattern = 'Bash(node *scripts/flow/reanchor.ts*--apply*)';
    expect(settings.permissions.ask).toContain(pattern);
    expect(settings.permissions.allow).not.toContain(pattern);
    // o motor de permissões não roda no jest: o curinga vira regex só para provar o alcance
    const inner = pattern.slice('Bash('.length, -1);
    const matcher = new RegExp(`^${inner.replaceAll('.', '\\.').replaceAll('*', '.*')}$`);
    expect(matcher.test('node scripts/flow/reanchor.ts --to directives-4 --apply')).toBe(true);
    expect(matcher.test('node scripts/flow/reanchor.ts --apply --to directives-4')).toBe(true);
    expect(matcher.test('node ./scripts/flow/reanchor.ts --apply')).toBe(true);
    expect(matcher.test('node scripts/flow/reanchor.ts --to directives-4')).toBe(false);
  }, 15_000);

  test('preserves the old gitnexus hook', () => {
    const gitnexus = (settings.hooks.PreToolUse ?? [])
      .flatMap((e) => e.hooks)
      .find((h) => h.if === 'Bash(*gitnexus*)');
    expect(gitnexus?.command).toContain('gitnexus');
  }, 15_000);
});
