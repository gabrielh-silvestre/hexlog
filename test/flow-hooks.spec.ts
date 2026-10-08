import { afterEach, beforeAll, beforeEach, describe, expect, test } from '@jest/globals';
import { spawnSync, type SpawnSyncReturns } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { planSync, type SyncInput } from '../.claude/hooks/flow-sync.ts';
import { createTempDir } from './helpers.ts';

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

function git(cwd: string, ...args: string[]): string {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8' });
  if (result.status !== 0) throw new Error(`git ${args.join(' ')}: ${result.stderr}`);
  return result.stdout.trim();
}

beforeAll(() => {
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
}, 15_000);

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

describe('pre-pr: create_pull_request e marcador', () => {
  test('nega sem draft e sem marcador', () => {
    expectDenied(mcpCreate('feat/x'), /no valid pre-PR marker/);
  }, 15_000);

  test('permite draft true mesmo sem marcador', () => {
    expectAllowed(mcpCreate('feat/x', { draft: true }));
  }, 15_000);

  test('permite com marcador de sha igual ao da branch', () => {
    writeMarker('feat/x', tipSha);
    expectAllowed(mcpCreate('feat/x'));
  }, 15_000);

  test('nega marcador com sha diferente do da branch', () => {
    writeMarker('feat/x', baseSha);
    expectDenied(mcpCreate('feat/x'), /no valid pre-PR marker/);
  }, 15_000);

  test('nega marcador cuja branch não é a do head', () => {
    fs.mkdirSync(markerDir, { recursive: true });
    fs.writeFileSync(path.join(markerDir, 'feat-x.ok'), `other\n${tipSha}\n`);
    expectDenied(mcpCreate('feat/x'), /no valid pre-PR marker/);
  }, 15_000);

  test('nega quando a ref local da branch não existe', () => {
    writeMarker('ghost/branch', tipSha);
    expectDenied(mcpCreate('ghost/branch'));
  }, 15_000);

  test('nega quando origin/<head> aponta para outro sha e permite quando é o mesmo', () => {
    writeMarker('feat/x', tipSha);
    git(repo, 'update-ref', 'refs/remotes/origin/feat/x', baseSha);
    expectDenied(mcpCreate('feat/x'), /no valid pre-PR marker/);
    git(repo, 'update-ref', 'refs/remotes/origin/feat/x', tipSha);
    expectAllowed(mcpCreate('feat/x'));
  }, 15_000);

  test('nega head de outro dono (owner:branch)', () => {
    writeMarker('feat/x', tipSha);
    expectDenied(mcpCreate('someone:feat/x'), /cross-repo PRs unsupported/);
  }, 15_000);

  test.each([
    'git@github.com:acme/widgets.git',
    'https://github.com/acme/widgets',
    'https://github.com/acme/widgets.git',
    'ssh://git@github.com/acme/widgets.git',
  ])(
    'confere owner/repo contra o origin %s',
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

  test('gh pr create --head X usa o marcador de X', () => {
    writeMarker('feat/y', tipSha);
    expectAllowed(bash('gh pr create --head feat/y --title t'));
    expectAllowed(bash('gh pr create -H feat/y'));
    expectAllowed(bash('gh pr create --head=feat/y'));
    expectDenied(bash('gh pr create --title t'));
  }, 15_000);

  test('gh com -R ou --repo é negado', () => {
    writeMarker('feat/x', tipSha);
    expectDenied(bash('gh pr create -R x/y'), /-R\/--repo is denied/);
    expectDenied(bash('gh pr create --repo x/y'), /-R\/--repo is denied/);
  }, 15_000);

  test('sessão num checkout e branch do PR em outro worktree compartilham o marcador', () => {
    writeMarker('feat/y', tipSha);
    expectAllowed(mcpCreate('feat/y', {}, repo));
    expectAllowed(mcpCreate('feat/y', {}, worktree));
  }, 15_000);

  test('cwd em subpasta e em worktree resolvem o mesmo marcador', () => {
    writeMarker('feat/x', tipSha);
    expectAllowed(mcpCreate('feat/x', {}, path.join(repo, 'sub')));
    expectAllowed(mcpCreate('feat/x', {}, worktree));
  }, 15_000);
});

describe('pre-pr: gh pr ready', () => {
  test('nega sem marcador e passa com marcador de sha igual (branch atual)', () => {
    expectDenied(bash('gh pr ready'), /no valid pre-PR marker/);
    writeMarker('feat/x', tipSha);
    expectAllowed(bash('gh pr ready'));
  }, 15_000);

  test('com nome de branch como argumento usa o marcador dessa branch', () => {
    writeMarker('feat/y', tipSha);
    expectAllowed(bash('gh pr ready feat/y'));
    expectDenied(bash('gh pr ready'), /no valid pre-PR marker/);
  }, 15_000);

  test.each(['gh pr ready 42', 'gh pr ready https://github.com/acme/widgets/pull/42'])(
    'nega por número ou URL: %s',
    (command) => {
      writeMarker('feat/x', tipSha);
      expectDenied(bash(command), /by number or URL is denied/);
    },
    15_000,
  );

  test('nega -R x/y', () => {
    writeMarker('feat/x', tipSha);
    expectDenied(bash('gh pr ready -R x/y'), /-R\/--repo is denied/);
  }, 15_000);

  test('passa --undo', () => {
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
    'nega em posição de comando: %s',
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
    'passa quando a frase está entre aspas ou em heredoc: %s',
    (command) => {
      expectAllowed(bash(command));
    },
    15_000,
  );
});

describe('pre-pr: update_pull_request', () => {
  test('nega draft false com a mensagem que cita gh pr ready', () => {
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
    'passa com %j',
    (extra) => {
      expectAllowed(
        preHook(MCP_UPDATE, { owner: 'acme', repo: 'widgets', pullNumber: 1, ...extra }),
      );
    },
    15_000,
  );
});

describe('pre-pr: casamento do Bash (create)', () => {
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
    'nega: %s',
    (command) => {
      expectDenied(bash(command));
    },
    15_000,
  );

  test('permite gh pr create --draft e -d', () => {
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
    'permite: %s',
    (command) => {
      expectAllowed(bash(command));
    },
    15_000,
  );

  test.each(['gh pr create --title "x', "echo 'gh pr create", 'echo $(gh pr create'])(
    'nega aspa sem par que casa a regex solta: %s',
    (command) => {
      expectDenied(bash(command));
    },
    15_000,
  );

  test('permite aspa sem par que não menciona gh pr create nem ready', () => {
    expectAllowed(bash('echo "abc'));
  }, 15_000);
});

describe('pre-pr: entrada e falha', () => {
  test('nega stdin que não é JSON', () => {
    expectDenied(runHook(['pre-pr'], { input: 'not json' }));
  }, 15_000);

  test('ignora ferramenta que não é de PR nem Bash', () => {
    expectAllowed(preHook('Read', { file_path: '/x' }));
  }, 15_000);

  test('nega git falhando (cwd fora de repositório)', () => {
    const outside = createTempDir('flow-hooks-outside');
    expectDenied(bash('gh pr ready', outside));
  }, 15_000);

  test('o comando do matcher de PR, com PATH vazio, sai com 2', () => {
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

describe('modos', () => {
  test('subagent-start devolve o caminho do doc e o slug da branch', () => {
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

  test('subagent-start sem entrada legível ainda devolve o contexto', () => {
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
    'slug de %s é %s',
    (branch, expected) => {
      const result = runHook(['slug', branch]);
      expect(result.status).toBe(0);
      expect(result.stdout).toBe(`${expected}\n`);
    },
    15_000,
  );

  test.each([
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
    'slug recusa "%s" com exit 1',
    (branch) => {
      const result = runHook(['slug', branch]);
      expect(result.status).toBe(1);
      expect(result.stdout).toBe('');
    },
    15_000,
  );

  test('mark grava o marcador no git-common-dir e o hook passa a aceitar o PR e o gh pr ready', () => {
    expectDenied(mcpCreate('feat/x'));
    const result = runHook(['mark', 'feat-x']);
    expect(result.status).toBe(0);
    expect(fs.readFileSync(path.join(markerDir, 'feat-x.ok'), 'utf8')).toBe(`feat/x\n${tipSha}\n`);
    expectAllowed(mcpCreate('feat/x'));
    expectAllowed(bash('gh pr create --title t'));
    expectAllowed(bash('gh pr ready'));
  }, 15_000);

  test('mark no worktree grava no git-common-dir compartilhado', () => {
    const result = runHook(['mark', 'feat-y'], { cwd: worktree });
    expect(result.status).toBe(0);
    expect(fs.existsSync(path.join(markerDir, 'feat-y.ok'))).toBe(true);
  }, 15_000);

  test('mark recusa árvore suja', () => {
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

  test('mark recusa branch que não gera o slug', () => {
    const result = runHook(['mark', 'other-slug']);
    expect(result.status).toBe(1);
    expect(result.stderr).toMatch(/does not yield slug/);
    expect(fs.existsSync(markerDir)).toBe(false);
  }, 15_000);

  test('sync-plan devolve o mesmo plano que flow-sync chamado direto', () => {
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

  describe('sync-plan com path inválido', () => {
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

    test('path vazio sai com 0 e o erro no JSON', () => {
      expect(syncPlan({ path: '' })).toEqual(refused);
    }, 15_000);

    test('path fora de docs/directives sai com 0 e o erro no JSON', () => {
      expect(syncPlan({ docSlug: 'convencoes', path: 'docs/x.md' })).toEqual(refused);
    }, 15_000);

    // sem o pré-check o hook leria o arquivo malformado e sairia com 2 e o motivo no stderr
    test('estrategia com path absoluto de arquivo malformado não é lido', () => {
      const file = path.join(createTempDir('strategy'), 'estrategia.md');
      fs.writeFileSync(file, '## Tema\n- sem crase: linha ruim');

      expect(syncPlan({ path: file })).toEqual(refused);
    }, 15_000);

    test('estrategia com path absoluto de arquivo inexistente não é lido', () => {
      const file = path.join(createTempDir('strategy'), 'faltando.md');

      expect(syncPlan({ path: file })).toEqual(refused);
    }, 15_000);
  });

  test('modo desconhecido sai com 2', () => {
    expectDenied(runHook(['nope']), /unknown mode/);
  }, 15_000);
});

describe('settings.json', () => {
  const flowCommand = (mode: string): string =>
    `node "$CLAUDE_PROJECT_DIR/.claude/hooks/flow-hooks.ts" ${mode}`;

  test('tem uma entrada SubagentStart com matcher vazio', () => {
    const entries = settings.hooks.SubagentStart ?? [];
    expect(entries).toHaveLength(1);
    expect(entries[0]?.matcher).toBe('');
    expect(entries[0]?.hooks[0]?.command).toBe(flowCommand('subagent-start'));
  }, 15_000);

  test('o matcher de PR do MCP termina em || exit 2', () => {
    const entry = (settings.hooks.PreToolUse ?? []).find(
      (e) => e.matcher === '^mcp__github-official__(create|update)_pull_request$',
    );
    expect(entry?.hooks[0]?.command).toBe(`${flowCommand('pre-pr')} || exit 2`);
  }, 15_000);

  test('a entrada Bash tem if Bash(gh *) e não termina em || exit 2', () => {
    const hook = (settings.hooks.PreToolUse ?? [])
      .filter((e) => e.matcher === 'Bash')
      .flatMap((e) => e.hooks)
      .find((h) => h.command === flowCommand('pre-pr'));
    expect(hook?.if).toBe('Bash(gh *)');
  }, 15_000);

  test('tem as regras allow do padrão 15', () => {
    expect(settings.permissions.allow).toEqual(
      expect.arrayContaining([
        'Bash(node .claude/hooks/flow-hooks.ts slug *)',
        'Bash(node .claude/hooks/flow-hooks.ts mark *)',
        'Bash(node .claude/hooks/flow-hooks.ts sync-plan *)',
      ]),
    );
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

  test('preserva o hook antigo do gitnexus', () => {
    const gitnexus = (settings.hooks.PreToolUse ?? [])
      .flatMap((e) => e.hooks)
      .find((h) => h.if === 'Bash(*gitnexus*)');
    expect(gitnexus?.command).toContain('gitnexus');
  }, 15_000);
});
