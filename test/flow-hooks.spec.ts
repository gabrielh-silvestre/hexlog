import { afterEach, beforeAll, beforeEach, describe, expect, test } from '@jest/globals';
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
        'Bash(node .claude/hooks/flow-report.ts *)',
      ]),
    );
  }, 15_000);

  test('flow-report não é hook: nenhum command de hooks o cita', () => {
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

  test('preserva o hook antigo do gitnexus', () => {
    const gitnexus = (settings.hooks.PreToolUse ?? [])
      .flatMap((e) => e.hooks)
      .find((h) => h.if === 'Bash(*gitnexus*)');
    expect(gitnexus?.command).toContain('gitnexus');
  }, 15_000);
});

describe('flow-report', () => {
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
    for (const proc of ['directives-9', 'feat-r', 'feat-clean', 'feat-many', 'feat-wide']) {
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
      'd-new': decision('feat-r', 'd-new', [{ kind: 'supersedes', to: '@d-old' }, rests('@alpha')]),
      'd-rev': decision('feat-r', 'd-rev', [rests('@objective')]),
      'd-a': decision('feat-r', 'd-a', [rests('@objective')]),
      'd-b': decision('feat-r', 'd-b', [{ kind: 'supersedes', to: '@d-a' }, rests('@alpha')]),
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
    for (const doc of ['convencoes', 'fluxo-hexlog']) {
      fs.writeFileSync(path.join(gitRepo, `docs/directives/${doc}.md`), `# ${doc}\n`);
    }
    git(gitRepo, 'add', '.');
    git(gitRepo, 'commit', '-q', '-m', 'docs');
    git(gitRepo, 'update-ref', 'refs/remotes/origin/develop', 'HEAD');
    git(gitRepo, 'checkout', '-q', '-b', 'feat/r');
    fs.appendFileSync(path.join(gitRepo, 'docs/directives/convencoes.md'), 'amended\n');
    git(gitRepo, 'commit', '-q', '-am', 'amend convencoes');
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

  describe('feat-r contra a base padrão', () => {
    let result: SpawnSyncReturns<string>;

    beforeAll(() => {
      result = runReport(['feat-r']);
    }, 30_000);

    test('sai com status 0 e sem aviso no stderr', () => {
      expect(result.status).toBe(0);
      expect(result.stderr).toBe('');
    });

    test('aponta a decisão que só cita a premissa-objetivo com as premissas não citadas', () => {
      expect(rowFor(result, 'd-obj')).toEqual([
        idOf('d-obj'),
        'feat-r.decision.d-obj',
        OBJECTIVE_UNCITED,
      ]);
    });

    test('aponta a decisão que só cita a sentinela com as premissas não citadas', () => {
      expect(rowFor(result, 'd-none')).toEqual([
        idOf('d-none'),
        'feat-r.decision.d-none',
        'only-sentinel: uncited=feat-r.premise.objective,feat-r.premise.alpha,feat-r.premise.beta',
      ]);
    });

    test('não aponta a decisão que cita uma premissa da entrega', () => {
      expect(rowFor(result, 'd-ok')).toBeUndefined();
    });

    test('não aponta a decisão sem nenhum rests-on', () => {
      expect(rowFor(result, 'd-no-rest')).toBeUndefined();
    });

    test('aponta como doc-amended a decisão ancorada num doc alterado no diff', () => {
      expect(rowFor(result, 'd-doc')).toEqual([
        idOf('d-doc'),
        'feat-r.decision.d-doc',
        DOC_AMENDED,
      ]);
    });

    test('não aponta a decisão ancorada num doc fora do diff', () => {
      expect(rowFor(result, 'd-far')).toBeUndefined();
    });

    test('junta os dois motivos na mesma linha, separados por "; "', () => {
      expect(rowFor(result, 'd-both')).toEqual([
        idOf('d-both'),
        'feat-r.decision.d-both',
        `${OBJECTIVE_UNCITED}; ${DOC_AMENDED}`,
      ]);
    });

    test.each(['d-old', 'd-rev', 'd-a', 'd-b'])('não aponta %s, que não é vigente', (name) => {
      expect(rowFor(result, name)).toBeUndefined();
    });

    test('não aponta d-new, vigente e citando uma premissa da entrega', () => {
      expect(rowFor(result, 'd-new')).toBeUndefined();
    });

    test('só imprime ids que a query do servidor tem como vigentes', () => {
      const printed = printedIds(result);
      expect(printed.length).toBeGreaterThan(0);
      for (const id of printed) expect(currentIds).toContain(id);
    });

    test('nenhum id impresso consta dos não vigentes da query', () => {
      expect(nonCurrentIds.size).toBeGreaterThan(0);
      for (const id of printedIds(result)) expect(nonCurrentIds).not.toContain(id);
    });
  });

  test('com a base trocada por feat/r o diff zera e o doc-amended some', () => {
    const result = runReport(['feat-r', 'feat/r']);
    expect(result.status).toBe(0);
    expect(rowFor(result, 'd-doc')).toBeUndefined();
    expect(rowFor(result, 'd-both')?.[2]).toBe(OBJECTIVE_UNCITED);
  }, 30_000);

  test('imprime nothing to flag quando o processo não tem nada a apontar', () => {
    const result = runReport(['feat-clean']);
    expect(result.status).toBe(0);
    expect(result.stdout).toBe('nothing to flag\n');
  }, 30_000);

  test('processo inexistente avisa PROCESS_NOT_FOUND no stderr, sem stdout e com status 0', () => {
    const result = runReport(['ghost']);
    expect(result.status).toBe(0);
    expect(result.stdout).toBe('');
    expect(result.stderr).toMatch(/^flow-report: [\s\S]*PROCESS_NOT_FOUND/);
  }, 30_000);

  test('sem node_modules avisa no stderr, sem stdout e com status 0', () => {
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

  test('ref de base desconhecido avisa do git e mantém só o only-objective', () => {
    const result = runReport(['feat-r', 'origin/nope']);
    expect(result.status).toBe(0);
    expect(result.stderr).toMatch(/^flow-report: git: /);
    expect(rowFor(result, 'd-obj')?.[2]).toBe(OBJECTIVE_UNCITED);
    expect(rowFor(result, 'd-doc')).toBeUndefined();
  }, 30_000);

  test('base que parece opção sai com o uso no stderr e status 0', () => {
    const result = runReport(['feat-r', '-x']);
    expect(result.status).toBe(0);
    expect(result.stdout).toBe('');
    expect(result.stderr).toMatch(/^flow-report: usage:/);
  }, 30_000);

  test('sem argumento sai com o uso no stderr e status 0', () => {
    const result = runReport([]);
    expect(result.status).toBe(0);
    expect(result.stdout).toBe('');
    expect(result.stderr).toMatch(/^flow-report: usage:/);
  }, 30_000);

  describe('export estrangeiro que falha', () => {
    let result: SpawnSyncReturns<string>;

    beforeAll(() => {
      result = runReport(['feat-r'], { xdg: xdgWithoutDirectives });
    }, 30_000);

    test('sai com status 0 e um aviso por prefixo, não por id', () => {
      expect(result.status).toBe(0);
      expect(result.stderr.match(/flow-report:/g)).toHaveLength(1);
      expect(result.stderr).toContain('PROCESS_NOT_FOUND');
    });

    test('mantém o only-objective, que não depende do processo estrangeiro', () => {
      expect(rowFor(result, 'd-obj')?.[2]).toBe(OBJECTIVE_UNCITED);
    });

    test('não aponta por engano a citação da sentinela nem o doc-amended sem target', () => {
      expect(rowFor(result, 'd-none')).toBeUndefined();
      expect(rowFor(result, 'd-doc')).toBeUndefined();
    });
  });

  test('corta em 100 linhas e diz quantas omitiu', () => {
    const rows = runReport(['feat-many'])
      .stdout.split('\n')
      .filter((line) => line !== '');
    expect(rows).toHaveLength(101);
    expect(rows.at(-1)).toBe('... 1 more omitted');
  }, 30_000);

  test('lista até 10 premissas não citadas e conta as demais', () => {
    const [row] = rowsOf(runReport(['feat-wide']));
    const uncited = row?.[2]?.split('uncited=')[1];
    expect(uncited?.endsWith(' (+2)')).toBe(true);
    expect(uncited?.replace(' (+2)', '').split(',')).toHaveLength(10);
  }, 30_000);
});
