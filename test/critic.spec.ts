import { beforeAll, describe, expect, it } from '@jest/globals';
import * as fs from 'node:fs';
import * as path from 'node:path';
import {
  criticEnv,
  CRITIC_CLI,
  installShims,
  isRunning,
  makeMailbox,
  readAnswer,
  readSession,
  runProcess,
  waitFor,
  writeClaudeJson,
  type Run,
  type Shims,
} from './critic-helpers.ts';
import { createTempDir } from './helpers.ts';

const SPEC_TIMEOUT = 30_000;

type Scenario = { shims: Shims; home: string; tmpdir: string };

/** `HOME` com `~/.claude.json` e `TMPDIR` próprios: a CLI lê os dois pelo ambiente. */
function scenario(): Scenario {
  const home = createTempDir('critic-home');
  writeClaudeJson(home);
  return { shims: installShims(), home, tmpdir: createTempDir('critic-tmp') };
}

const cli = (
  { shims, home, tmpdir }: Scenario,
  args: string[],
  env: Record<string, string | undefined> = {},
  cwd?: string,
): Promise<Run> =>
  runProcess([CRITIC_CLI, ...args], criticEnv(shims, { HOME: home, TMPDIR: tmpdir, ...env }), cwd)
    .done;

describe('scripts/flow/critic.ts', () => {
  it.each([
    ['no verb', []],
    ['start without a slug', ['start']],
    ['an unknown verb', ['frobnicate', 'target']],
    ['a second positional', ['ask', 'one', 'two']],
    ['--tool on ask', ['ask', 'target', '--tool', 'agy']],
    ['--cwd on close', ['close', 'target', '--cwd', '.']],
    ['an unknown flag', ['start', 'task-1', '--bogus']],
  ])(
    'should print the usage and exit 1 for %s',
    async (_case, args) => {
      const result = await cli(scenario(), args);

      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain('usage: node scripts/flow/critic.ts');
    },
    SPEC_TIMEOUT,
  );

  it.each([
    ['--tool codex', ['start', 'task-1', '--tool', 'codex'], {}],
    ['HEXLOG_CRITIC_CLI=codex', ['start', 'task-1'], { HEXLOG_CRITIC_CLI: 'codex' }],
  ])(
    'should exit 1 for an unknown tool given by %s',
    async (_case, args, env) => {
      const result = await cli(scenario(), args, env);

      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain('unknown critic tool "codex"');
    },
    SPEC_TIMEOUT,
  );

  describe('with the start verb', () => {
    it.each([
      ['neither the flag nor the variable', [], undefined, 'claude'],
      ['--tool agy', ['--tool', 'agy'], undefined, 'agy'],
      ['HEXLOG_CRITIC_CLI=agy alone', [], 'agy', 'agy'],
      ['--tool claude over HEXLOG_CRITIC_CLI=agy', ['--tool', 'claude'], 'agy', 'claude'],
      ['--tool agy over HEXLOG_CRITIC_CLI=claude', ['--tool', 'agy'], 'claude', 'agy'],
    ])(
      'should write the tool of session.json by the precedence with %s',
      async (_case, flags, variable, expected) => {
        const s = scenario();

        const result = await cli(s, ['start', 'task-1', ...flags], {
          HEXLOG_CRITIC_CLI: variable,
        });

        expect(result.exitCode).toBe(0);
        expect(readSession(result.stdout.trim())).toMatchObject({ tool: expected });
      },
      SPEC_TIMEOUT,
    );

    it(
      'should print the mailbox path inside TMPDIR',
      async () => {
        const s = scenario();

        const result = await cli(s, ['start', 'task-1']);

        expect(path.dirname(result.stdout.trim())).toBe(s.tmpdir);
        expect(path.basename(result.stdout.trim())).toMatch(/^hexlog-critic-task-1-/);
      },
      SPEC_TIMEOUT,
    );

    it(
      'should record the --cwd directory in session.json',
      async () => {
        const s = scenario();
        const worktree = createTempDir('critic-worktree');

        const result = await cli(s, ['start', 'task-1', '--cwd', worktree]);

        expect(readSession(result.stdout.trim())).toMatchObject({ cwd: worktree });
      },
      SPEC_TIMEOUT,
    );

    it(
      'should default the cwd to the directory the command runs in',
      async () => {
        const s = scenario();
        const here = fs.realpathSync(createTempDir('critic-here'));

        const result = await cli(s, ['start', 'task-1'], {}, here);

        expect(readSession(result.stdout.trim())).toMatchObject({ cwd: here });
      },
      SPEC_TIMEOUT,
    );

    it(
      'should exit 3 with the reason on stderr when the tool is unavailable',
      async () => {
        const result = await cli(scenario(), ['start', 'task-1'], { FAKE_CRITIC_LOGGED_OUT: '1' });

        expect(result.exitCode).toBe(3);
        expect(result.stderr).toContain('claude is not logged in');
        expect(result.stdout).toBe('');
      },
      SPEC_TIMEOUT,
    );
  });

  describe('with the ask verb', () => {
    it(
      'should print the answer path on stdout and exit 0',
      async () => {
        const s = scenario();
        const { mailbox } = makeMailbox();

        const result = await cli(s, ['ask', mailbox], { FAKE_CRITIC_REPLY: 'cli answer' });

        expect(result).toMatchObject({
          exitCode: 0,
          stdout: `${path.join(mailbox, 'a-1.txt')}\n`,
          stderr: '',
        });
        expect(readAnswer(mailbox, 1)).toBe('cli answer');
      },
      SPEC_TIMEOUT,
    );

    it(
      'should exit 2 when the mailbox does not exist',
      async () => {
        const gone = path.join(createTempDir('critic-box'), 'hexlog-critic-gone');

        const result = await cli(scenario(), ['ask', gone]);

        expect(result.exitCode).toBe(2);
        expect(result.stderr).toContain('mailbox not found');
      },
      SPEC_TIMEOUT,
    );

    it(
      'should exit 4 with the reason on stderr for a credential failure',
      async () => {
        const { mailbox } = makeMailbox();

        const result = await cli(scenario(), ['ask', mailbox], { FAKE_CRITIC_MODE: 'credential' });

        expect(result.exitCode).toBe(4);
        expect(result.stderr).toContain('credential failure');
        expect(result.stdout).toBe('');
      },
      SPEC_TIMEOUT,
    );
  });

  describe('when a signal interrupts an ask', () => {
    const signals = ['SIGTERM', 'SIGINT'] as const;
    type Outcome = {
      run: Run;
      shims: Shims;
      mailbox: string;
      grandchild: number;
    };
    const outcomes = {} as Record<(typeof signals)[number], Outcome>;

    beforeAll(async () => {
      for (const signal of signals) {
        const s = scenario();
        const { mailbox } = makeMailbox();
        const { child, done } = runProcess(
          [CRITIC_CLI, 'ask', mailbox],
          criticEnv(s.shims, { HOME: s.home, TMPDIR: s.tmpdir, FAKE_CRITIC_MODE: 'grandchild' }),
        );
        await waitFor(
          'the grandchild pid',
          () => fs.existsSync(s.shims.pidFile) && fs.readFileSync(s.shims.pidFile, 'utf8') !== '',
        );
        child.kill(signal);
        outcomes[signal] = {
          run: await done,
          shims: s.shims,
          mailbox,
          grandchild: Number(fs.readFileSync(s.shims.pidFile, 'utf8')),
        };
      }
    }, SPEC_TIMEOUT);

    it.each([
      ['SIGTERM', 143],
      ['SIGINT', 130],
    ] as const)('should exit by the signal convention when it gets %s', (signal, code) => {
      expect(outcomes[signal].run.exitCode).toBe(code);
    });

    it.each(signals)('should release the lock when it gets %s', (signal) => {
      expect(fs.existsSync(path.join(outcomes[signal].mailbox, 'ask.lock'))).toBe(false);
    });

    it.each(signals)('should keep the mailbox and write no answer when it gets %s', (signal) => {
      const { mailbox } = outcomes[signal];

      expect(fs.existsSync(path.join(mailbox, 'session.json'))).toBe(true);
      expect(fs.existsSync(path.join(mailbox, 'a-1.txt'))).toBe(false);
    });

    it.each(signals)(
      'should kill the process group of the child when it gets %s',
      async (signal) => {
        await waitFor('the grandchild to die', () => !isRunning(outcomes[signal].grandchild));

        expect(isRunning(outcomes[signal].grandchild)).toBe(false);
      },
      SPEC_TIMEOUT,
    );
  });

  describe('with the close verb', () => {
    it(
      'should remove the mailbox and print its path',
      async () => {
        const s = scenario();
        const started = await cli(s, ['start', 'task-1']);
        const mailbox = started.stdout.trim();

        const result = await cli(s, ['close', mailbox]);

        expect(result).toMatchObject({ exitCode: 0, stdout: `${mailbox}\n` });
        expect(fs.existsSync(mailbox)).toBe(false);
      },
      SPEC_TIMEOUT,
    );

    it(
      'should succeed again on a mailbox that is already gone',
      async () => {
        const s = scenario();
        const mailbox = (await cli(s, ['start', 'task-1'])).stdout.trim();
        await cli(s, ['close', mailbox]);

        const result = await cli(s, ['close', mailbox]);

        expect(result.exitCode).toBe(0);
      },
      SPEC_TIMEOUT,
    );

    it(
      'should refuse a directory that is not a critic mailbox and keep it',
      async () => {
        const dir = createTempDir('not-a-mailbox');

        const result = await cli(scenario(), ['close', dir]);

        expect(result.exitCode).toBe(1);
        expect(result.stderr).toContain('not a critic mailbox');
        expect(fs.existsSync(dir)).toBe(true);
      },
      SPEC_TIMEOUT,
    );
  });
});
