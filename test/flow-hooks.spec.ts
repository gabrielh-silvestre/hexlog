import { afterEach, beforeAll, beforeEach, describe, expect, it } from '@jest/globals';
import * as fs from 'node:fs';
import * as path from 'node:path';
import {
  NO_MARKER,
  bash,
  createRepo,
  dropOriginRef,
  expectAllowed,
  expectDenied,
  git,
  hookPath,
  mcpCreate,
  MCP_CREATE,
  MCP_UPDATE,
  preHook,
  repoState,
  resetRepo,
  runHook,
  runNode,
  writeMarker,
  type RunResult,
} from './flow-repo.ts';
import { createTempDir } from './helpers.ts';

const UNPARSABLE = /unparsable shell command mentions gh pr create\/ready/;
const REPO_OPTION = /-R\/--repo is denied/;

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
      expectDenied(mcpCreate('feat/x'), NO_MARKER);
    }, 15_000);

    it('should allow draft true even without a marker', () => {
      expectAllowed(mcpCreate('feat/x', { draft: true }));
    }, 15_000);

    it('should allow with a marker whose sha equals the branch sha', () => {
      writeMarker('feat/x', repoState.tipSha);

      expectAllowed(mcpCreate('feat/x'));
    }, 15_000);

    it('should deny a marker whose sha differs from the branch sha', () => {
      writeMarker('feat/x', repoState.baseSha);

      expectDenied(mcpCreate('feat/x'), NO_MARKER);
    }, 15_000);

    it('should deny a marker whose branch is not the head branch', () => {
      fs.mkdirSync(repoState.markerDir, { recursive: true });
      fs.writeFileSync(path.join(repoState.markerDir, 'feat-x.ok'), `other\n${repoState.tipSha}\n`);

      expectDenied(mcpCreate('feat/x'), NO_MARKER);
    }, 15_000);

    it('should deny when the local branch ref does not exist', () => {
      writeMarker('ghost/branch', repoState.tipSha);

      expectDenied(
        mcpCreate('ghost/branch'),
        /git rev-parse --verify refs\/heads\/ghost\/branch failed/,
      );
    }, 15_000);

    it('should deny when origin/<head> points to another sha', () => {
      writeMarker('feat/x', repoState.tipSha);
      git(repoState.repo, 'update-ref', 'refs/remotes/origin/feat/x', repoState.baseSha);

      expectDenied(mcpCreate('feat/x'), NO_MARKER);
    }, 15_000);

    it('should allow when origin/<head> points to the same sha as the branch', () => {
      writeMarker('feat/x', repoState.tipSha);
      git(repoState.repo, 'update-ref', 'refs/remotes/origin/feat/x', repoState.tipSha);

      expectAllowed(mcpCreate('feat/x'));
    }, 15_000);

    it('should deny a head from another owner (owner:branch)', () => {
      writeMarker('feat/x', repoState.tipSha);

      expectDenied(mcpCreate('someone:feat/x'), /cross-repo PRs unsupported/);
    }, 15_000);

    it.each(ORIGIN_URLS)(
      'should allow the owner/repo that matches the origin %s',
      (url) => {
        git(repoState.repo, 'remote', 'set-url', 'origin', url);
        writeMarker('feat/x', repoState.tipSha);

        expectAllowed(mcpCreate('feat/x'));
      },
      15_000,
    );

    it.each(ORIGIN_URLS)(
      'should deny an owner or a repo that differs from the origin %s',
      (url) => {
        git(repoState.repo, 'remote', 'set-url', 'origin', url);
        writeMarker('feat/x', repoState.tipSha);

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
      writeMarker('feat/y', repoState.tipSha);

      expectAllowed(mcpCreate('feat/y', {}, repoState.repo));
      expectAllowed(mcpCreate('feat/y', {}, repoState.worktree));
    }, 15_000);

    it('should resolve the same marker from a subfolder and from a worktree', () => {
      writeMarker('feat/x', repoState.tipSha);

      expectAllowed(mcpCreate('feat/x', {}, path.join(repoState.repo, 'sub')));
      expectAllowed(mcpCreate('feat/x', {}, repoState.worktree));
    }, 15_000);
  });

  describe('with gh pr create', () => {
    it('should use the marker of the branch given by --head, -H or --head=', () => {
      writeMarker('feat/y', repoState.tipSha);

      expectAllowed(bash('gh pr create --head feat/y --title t'));
      expectAllowed(bash('gh pr create -H feat/y'));
      expectAllowed(bash('gh pr create --head=feat/y'));
    }, 15_000);

    it('should deny without --head when only another branch has a marker', () => {
      writeMarker('feat/y', repoState.tipSha);

      expectDenied(bash('gh pr create --title t'), NO_MARKER);
    }, 15_000);

    it('should deny -R and --repo', () => {
      writeMarker('feat/x', repoState.tipSha);

      expectDenied(bash('gh pr create -R x/y'), REPO_OPTION);
      expectDenied(bash('gh pr create --repo x/y'), REPO_OPTION);
    }, 15_000);

    it.each([
      ['gh pr create', NO_MARKER],
      ['gh -R x  pr  create', REPO_OPTION],
      ['GH_TOKEN=x gh pr create', NO_MARKER],
      ['/usr/bin/gh pr create', NO_MARKER],
      ['gh "pr" create', NO_MARKER],
      ["gh pr 'create'", NO_MARKER],
      ['time gh pr create', NO_MARKER],
      ['timeout 30 gh pr create', NO_MARKER],
      ['if x; then gh pr create; fi', NO_MARKER],
      ['{ gh pr create; }', NO_MARKER],
      ['! gh pr create', NO_MARKER],
      ['bash -c "gh pr create"', NO_MARKER],
      ['xargs gh pr create', NO_MARKER],
      ['eval "gh pr create"', NO_MARKER],
      ['echo $(gh pr create)', NO_MARKER],
      ['echo hi && gh pr create', NO_MARKER],
    ])(
      'should deny when gh pr create is in command position: %s',
      (command, message) => {
        expectDenied(bash(command), message);
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
        expectDenied(bash(command), UNPARSABLE);
      },
      15_000,
    );

    it('should allow an unpaired quote that mentions neither gh pr create nor ready', () => {
      expectAllowed(bash('echo "abc'));
    }, 15_000);
  });

  describe('with gh pr ready', () => {
    it('should deny the current branch without a marker', () => {
      expectDenied(bash('gh pr ready'), NO_MARKER);
    }, 15_000);

    it('should allow the current branch with a marker of the same sha', () => {
      writeMarker('feat/x', repoState.tipSha);

      expectAllowed(bash('gh pr ready'));
    }, 15_000);

    it('should use the marker of the branch given as argument', () => {
      writeMarker('feat/y', repoState.tipSha);

      expectAllowed(bash('gh pr ready feat/y'));
    }, 15_000);

    it('should deny without an argument when only another branch has a marker', () => {
      writeMarker('feat/y', repoState.tipSha);

      expectDenied(bash('gh pr ready'), NO_MARKER);
    }, 15_000);

    it.each(['gh pr ready 42', 'gh pr ready https://github.com/acme/widgets/pull/42'])(
      'should deny by number or URL: %s',
      (command) => {
        writeMarker('feat/x', repoState.tipSha);

        expectDenied(bash(command), /by number or URL is denied/);
      },
      15_000,
    );

    it('should deny -R x/y', () => {
      writeMarker('feat/x', repoState.tipSha);

      expectDenied(bash('gh pr ready -R x/y'), REPO_OPTION);
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
        expectDenied(bash(command), NO_MARKER);
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
      expectDenied(runHook(['pre-pr'], { input: 'not json' }), /is not valid JSON/);
    }, 15_000);

    it('should ignore a tool that is neither PR nor Bash', () => {
      expectAllowed(preHook('Read', { file_path: '/x' }));
    }, 15_000);

    it('should deny a failing git (cwd outside a repository)', () => {
      const outside = createTempDir('flow-hooks-outside');

      expectDenied(bash('gh pr ready', outside), /git symbolic-ref --short HEAD failed/);
    }, 15_000);
  });
});

describe('.claude/hooks/flow-hooks.ts subagent-start', () => {
  type Output = { hookSpecificOutput: { hookEventName: string; additionalContext: string } };
  const outputOf = (result: RunResult): Output => JSON.parse(result.stdout) as Output;
  let result: RunResult;

  describe('with a readable input', () => {
    beforeAll(() => {
      createRepo();
      result = runHook(['subagent-start'], { input: JSON.stringify({ cwd: repoState.repo }) });
    }, 15_000);

    it('should exit with 0', () => {
      expect(result.status).toBe(0);
    });

    it('should name the SubagentStart event', () => {
      expect(outputOf(result).hookSpecificOutput.hookEventName).toBe('SubagentStart');
    });

    it('should return the context in three lines', () => {
      expect(outputOf(result).hookSpecificOutput.additionalContext.split('\n')).toHaveLength(3);
    });

    it('should cite the flow doc', () => {
      expect(outputOf(result).hookSpecificOutput.additionalContext).toContain(
        'docs/directives/fluxo-hexlog.md',
      );
    });

    it('should name the work process after the branch slug', () => {
      expect(outputOf(result).hookSpecificOutput.additionalContext).toContain(
        'work process: feat-x',
      );
    });

    it('should tell the agent to report a missing process to whoever launched it', () => {
      expect(outputOf(result).hookSpecificOutput.additionalContext).toContain(
        'tell whoever launched you',
      );
    });

    it('should put the hand-back rule with the owner-seat carve-out on line 1 for any agent', () => {
      const [first] = outputOf(result).hookSpecificOutput.additionalContext.split('\n');

      expect(first).toContain(
        'Found a NEW gap or critical point nobody handed you? Stop and hand it back to whoever ' +
          'launched you (docs/directives/cadeira-do-dono.md); the owner-seat critic and its ' +
          'context actions answer instead of handing back.',
      );
    });
  });

  describe('with an unreadable input', () => {
    beforeAll(() => {
      createRepo();
      result = runHook(['subagent-start'], { input: 'not json' });
    }, 15_000);

    it('should exit with 0', () => {
      expect(result.status).toBe(0);
    });

    it('should still return the context', () => {
      expect(outputOf(result).hookSpecificOutput.additionalContext).toContain(
        'Hexlog project: hexlog',
      );
    });
  });
});

describe('.claude/hooks/flow-hooks.ts', () => {
  it('should exit with 2 for an unknown mode', () => {
    expectDenied(runNode(hookPath, ['nope']), /unknown mode/);
  }, 15_000);

  it.each(['slug', 'mark', 'sync-plan'])(
    'should exit with 2 for %s, which is not a hook mode',
    (mode) => {
      expectDenied(runNode(hookPath, [mode, 'feat-x']), /unknown mode/);
    },
    15_000,
  );
});
