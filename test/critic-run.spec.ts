import { afterAll, beforeAll, describe, expect, it } from '@jest/globals';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { closeMailbox, procStartTime } from '../scripts/flow/critic-run.ts';
import { parseCatalog, renderActions } from '../scripts/flow/critic-catalog.ts';
import { buildCommand, buildRules } from '../scripts/flow/critic-tools.ts';
import {
  CATALOG_DOC,
  criticEnv,
  installShims,
  isRunning,
  MAILBOX_RULES,
  makeMailbox,
  type MailboxOptions,
  readAnswer,
  readSession,
  readTurns,
  runDriver,
  valueAfter,
  waitFor,
  writeCatalogDoc,
  writeClaudeJson,
  type Shims,
} from './critic-helpers.ts';
import { at, createTempDir } from './helpers.ts';

type Reply = { exitCode: number; message: string };
type TurnResult = {
  exitCode: number | null;
  timedOut: boolean;
  spawnError?: string;
  aborted: boolean;
  stderrTail: string;
  elapsedMs: number;
  turn: { sessionId?: string; established: boolean; final?: { text: string; isError: boolean } };
};

const SPEC_TIMEOUT = 30_000;
const NO_BINARY = '/nonexistent-critic-bin';
const RUN_TIMING = { idleMs: 20_000, capMs: 60_000, backoffMs: [], maxTextBytes: 1_048_576 };
const CLAUDE_TURN = {
  prompt: 'the question',
  rules: 'the rules',
  mcpConfigPath: '/box/mcp.json',
  sessionId: 'sess-1',
  resume: false,
};

describe('runTurn', () => {
  type Scenario = { shims: Shims; cwd: string };
  const scenario = (): Scenario => ({
    shims: installShims(),
    cwd: fs.realpathSync(createTempDir('critic-cwd')),
  });

  const run = (
    { shims, cwd }: Scenario,
    env: Record<string, string | undefined>,
    timing: Partial<typeof RUN_TIMING> = {},
    command = buildCommand('claude', CLAUDE_TURN),
  ) =>
    runDriver<TurnResult>(
      { call: 'runTurn', command, cwd, tool: 'claude', timing: { ...RUN_TIMING, ...timing } },
      criticEnv(shims, env),
    );

  describe('with a normal reply', () => {
    let s: Scenario;
    let result: TurnResult;

    beforeAll(async () => {
      s = scenario();
      result = await run(s, { FAKE_CRITIC_REPLY: 'the final answer' });
    }, SPEC_TIMEOUT);

    it('should return the final text of the stream', () => {
      expect(result.turn.final).toEqual({ text: 'the final answer', isError: false });
    });

    it('should return the session id and the established flag', () => {
      expect(result.turn).toMatchObject({ sessionId: 'sess-1', established: true });
    });

    it('should report a clean exit', () => {
      expect(result).toMatchObject({ exitCode: 0, timedOut: false, aborted: false });
    });

    it('should run the child in the given working directory', () => {
      expect(at(readTurns(s.shims), 0).cwd).toBe(s.cwd);
    });
  });

  it(
    'should keep the final text when the stream carries a line over the line cap',
    async () => {
      const result = await run(
        scenario(),
        { FAKE_CRITIC_MODE: 'huge-line', FAKE_CRITIC_REPLY: 'still here' },
        { maxTextBytes: 10 },
      );

      expect(result.turn.final).toEqual({ text: 'still here', isError: false });
    },
    SPEC_TIMEOUT,
  );

  it(
    'should not time out while new bytes keep arriving inside the idle window',
    async () => {
      const result = await run(
        scenario(),
        { FAKE_CRITIC_MODE: 'slow', FAKE_CRITIC_GAP_MS: '250' },
        { idleMs: 700 },
      );

      expect(result).toMatchObject({ timedOut: false, exitCode: 0 });
      expect(result.elapsedMs).toBeGreaterThan(700);
    },
    SPEC_TIMEOUT,
  );

  it(
    'should time out when the stream goes quiet for the idle window',
    async () => {
      const result = await run(scenario(), { FAKE_CRITIC_MODE: 'silent' }, { idleMs: 400 });

      expect(result.timedOut).toBe(true);
    },
    SPEC_TIMEOUT,
  );

  it(
    'should keep the session id of a stream that timed out after the init event',
    async () => {
      const result = await run(scenario(), { FAKE_CRITIC_MODE: 'silent' }, { idleMs: 400 });

      expect(result.turn).toMatchObject({ sessionId: 'sess-1', established: true });
    },
    SPEC_TIMEOUT,
  );

  it(
    'should time out at the absolute cap even while bytes keep arriving',
    async () => {
      const result = await run(
        scenario(),
        { FAKE_CRITIC_MODE: 'slow', FAKE_CRITIC_GAP_MS: '250' },
        { idleMs: 20_000, capMs: 600 },
      );

      expect(result.timedOut).toBe(true);
    },
    SPEC_TIMEOUT,
  );

  it(
    'should kill the whole process group, grandchild included, on a timeout',
    async () => {
      const s = scenario();

      const result = await run(s, { FAKE_CRITIC_MODE: 'grandchild' }, { idleMs: 1000 });
      const grandchild = Number(fs.readFileSync(s.shims.pidFile, 'utf8'));

      await waitFor('the grandchild to die', () => !isRunning(grandchild));

      expect(result.timedOut).toBe(true);
    },
    SPEC_TIMEOUT,
  );

  it(
    'should report ENOENT as a spawn error when the binary is missing',
    async () => {
      const result = await run(scenario(), {}, {}, { bin: 'no-such-critic-cli', args: [] });

      expect(result).toMatchObject({ spawnError: 'ENOENT', exitCode: null, timedOut: false });
    },
    SPEC_TIMEOUT,
  );

  it(
    'should keep the stderr tail of a failed turn',
    async () => {
      const result = await run(scenario(), { FAKE_CRITIC_MODE: 'init-then-fail' });

      expect(result.exitCode).toBe(1);
      expect(result.stderrTail).toContain('connection reset by peer');
    },
    SPEC_TIMEOUT,
  );
});

describe('startSession', () => {
  type Scenario = { shims: Shims; tmpdir: string; home: string; claudeJsonPath: string };
  const scenario = (): Scenario => {
    const home = createTempDir('critic-home');
    writeCatalogDoc(home);
    return {
      shims: installShims(),
      tmpdir: createTempDir('critic-tmp'),
      home,
      claudeJsonPath: writeClaudeJson(home),
    };
  };

  const start = (
    { shims, tmpdir, home, claudeJsonPath }: Scenario,
    tool: 'claude' | 'agy',
    env: Record<string, string | undefined> = {},
    over: { slug?: string; cwd?: string; claudeJsonPath?: string; catalogPath?: string } = {},
  ) =>
    runDriver<Reply>(
      {
        call: 'startSession',
        options: { tool, slug: 'task-1', cwd: home, tmpdir, claudeJsonPath, ...over },
      },
      criticEnv(shims, env),
    );

  describe('with every precondition in place', () => {
    let s: Scenario;
    let reply: Reply;

    beforeAll(async () => {
      s = scenario();
      reply = await start(s, 'claude');
    }, SPEC_TIMEOUT);

    it('should exit 0 and print the mailbox path inside the tmpdir', () => {
      expect(reply.exitCode).toBe(0);
      expect(reply.message).toMatch(
        new RegExp(`^${s.tmpdir}/hexlog-critic-task-1-[A-Za-z0-9]{6}$`),
      );
    });

    it('should create the mailbox with mode 0700', () => {
      expect(fs.statSync(reply.message).mode & 0o777).toBe(0o700);
    });

    it('should write the mcp config with mode 0600', () => {
      expect(fs.statSync(path.join(reply.message, 'mcp.json')).mode & 0o777).toBe(0o600);
    });

    it('should keep only the command and args of the hexlog server, without its env', () => {
      expect(JSON.parse(fs.readFileSync(path.join(reply.message, 'mcp.json'), 'utf8'))).toEqual({
        mcpServers: { hexlog: { command: 'node', args: ['server.mjs'] } },
      });
    });

    it('should freeze the claude-runner rules of the catalog in rules.txt with mode 0600', () => {
      const file = path.join(reply.message, 'rules.txt');

      expect(fs.statSync(file).mode & 0o777).toBe(0o600);
      expect(fs.readFileSync(file, 'utf8')).toBe(
        buildRules(renderActions(parseCatalog(CATALOG_DOC), 'claude-runner')),
      );
    });

    it('should write the initial session state with mode 0600', () => {
      const file = path.join(reply.message, 'session.json');

      expect(fs.statSync(file).mode & 0o777).toBe(0o600);
      expect(readSession(reply.message)).toEqual({
        tool: 'claude',
        cwd: s.home,
        sessionId: null,
        confirmed: false,
        failures: 0,
        broken: false,
      });
    });
  });

  it(
    'should start an agy session when agy is available and lists the hexlog server',
    async () => {
      const reply = await start(scenario(), 'agy');

      expect(reply.exitCode).toBe(0);
      expect(readSession(reply.message)).toMatchObject({ tool: 'agy' });
    },
    SPEC_TIMEOUT,
  );

  it(
    'should freeze the agy rules without jury when the tool is agy',
    async () => {
      const reply = await start(scenario(), 'agy');

      expect(fs.readFileSync(path.join(reply.message, 'rules.txt'), 'utf8')).toBe(
        buildRules(renderActions(parseCatalog(CATALOG_DOC), 'agy')),
      );
    },
    SPEC_TIMEOUT,
  );

  it(
    'should read the catalog from the injected path instead of the cwd',
    async () => {
      const s = scenario();
      const elsewhere = writeCatalogDoc(createTempDir('critic-catalog'));
      fs.rmSync(path.join(s.home, 'docs'), { recursive: true });

      const reply = await start(s, 'claude', {}, { catalogPath: elsewhere });

      expect(reply.exitCode).toBe(0);
    },
    SPEC_TIMEOUT,
  );

  it.each([
    ['missing', (file: string) => fs.rmSync(file)],
    ['out of format', (file: string) => fs.writeFileSync(file, '# Cadeira do dono\n')],
  ])(
    'should exit 3 naming the unreadable catalog and create nothing when the doc is %s',
    async (_case, breakDoc) => {
      const s = scenario();
      breakDoc(path.join(s.home, 'docs', 'directives', 'cadeira-do-dono.md'));

      const reply = await start(s, 'claude');

      expect(reply.exitCode).toBe(3);
      expect(reply.message).toContain('catálogo ilegível');
      expect(fs.readdirSync(s.tmpdir)).toEqual([]);
    },
    SPEC_TIMEOUT,
  );

  it(
    'should name the expected heading when the doc lost its catalog section',
    async () => {
      const s = scenario();
      fs.writeFileSync(path.join(s.home, 'docs', 'directives', 'cadeira-do-dono.md'), '# x\n');

      const reply = await start(s, 'claude');

      expect(reply.message).toContain('## Catálogo de ações');
    },
    SPEC_TIMEOUT,
  );

  const unavailable: [string, 'claude' | 'agy', Record<string, string | undefined>, string][] = [
    ['the claude binary is missing', 'claude', { PATH: NO_BINARY }, 'claude is not available'],
    ['the agy binary is missing', 'agy', { PATH: NO_BINARY }, 'agy is not available'],
    ['claude is logged out', 'claude', { FAKE_CRITIC_LOGGED_OUT: '1' }, 'claude is not logged in'],
    ['agy is logged out', 'agy', { FAKE_CRITIC_LOGGED_OUT: '1' }, 'agy is not logged in'],
    [
      'agy does not list the hexlog server',
      'agy',
      { FAKE_CRITIC_NO_AGY_MCP: '1' },
      'not registered in agy',
    ],
  ];

  it.each(unavailable)(
    'should exit 3 when %s',
    async (_cause, tool, env, message) => {
      const reply = await start(scenario(), tool, env);

      expect(reply.exitCode).toBe(3);
      expect(reply.message).toContain(message);
    },
    SPEC_TIMEOUT,
  );

  it.each(unavailable)(
    'should create nothing when %s',
    async (_cause, tool, env) => {
      const s = scenario();

      await start(s, tool, env);

      expect(fs.readdirSync(s.tmpdir)).toEqual([]);
    },
    SPEC_TIMEOUT,
  );

  it(
    'should exit 3 when ~/.claude.json has no hexlog entry',
    async () => {
      const s = scenario();
      fs.writeFileSync(s.claudeJsonPath, JSON.stringify({ mcpServers: { other: {} } }));

      const reply = await start(s, 'claude');

      expect(reply).toEqual({
        exitCode: 3,
        message: 'hexlog server not registered in ~/.claude.json',
      });
    },
    SPEC_TIMEOUT,
  );

  it(
    'should exit 3 when ~/.claude.json does not exist',
    async () => {
      const s = scenario();

      const reply = await start(
        s,
        'claude',
        {},
        { claudeJsonPath: path.join(s.home, 'missing.json') },
      );

      expect(reply.exitCode).toBe(3);
    },
    SPEC_TIMEOUT,
  );

  it(
    'should exit 1 and create nothing for a slug that is not kebab-case',
    async () => {
      const s = scenario();

      const reply = await start(s, 'claude', {}, { slug: 'Bad Slug' });

      expect(reply.exitCode).toBe(1);
      expect(fs.readdirSync(s.tmpdir)).toEqual([]);
    },
    SPEC_TIMEOUT,
  );

  it(
    'should exit 1 and create nothing when the cwd is not a directory',
    async () => {
      const s = scenario();

      const reply = await start(s, 'claude', {}, { cwd: path.join(s.home, 'missing-dir') });

      expect(reply.exitCode).toBe(1);
      expect(fs.readdirSync(s.tmpdir)).toEqual([]);
    },
    SPEC_TIMEOUT,
  );

  it(
    'should leave old mailboxes alone',
    async () => {
      const s = scenario();
      const old = path.join(s.tmpdir, 'hexlog-critic-old-AbCdEf');
      fs.mkdirSync(old);

      await start(s, 'claude');

      expect(fs.existsSync(old)).toBe(true);
    },
    SPEC_TIMEOUT,
  );
});

describe('askQuestion', () => {
  type Scenario = { shims: Shims; mailbox: string; cwd: string };
  const scenario = (options?: MailboxOptions): Scenario => ({
    shims: installShims(),
    ...makeMailbox(options),
  });

  type AskInput = {
    env?: Record<string, string | undefined>;
    timing?: { idleMs?: number; maxTextBytes?: number; backoffMs?: number[] };
    startTimes?: Record<number, number>;
  };
  const ask = ({ shims, mailbox }: Scenario, { env, timing, startTimes }: AskInput = {}) =>
    runDriver<Reply>(
      { call: 'askQuestion', mailbox, timing: { backoffMs: [30, 30], ...timing }, startTimes },
      criticEnv(shims, env),
    );
  const lockFile = ({ mailbox }: Scenario) => path.join(mailbox, 'ask.lock');
  const turns = ({ shims }: Scenario) => readTurns(shims);
  const turnArgs = (s: Scenario, index = 0) => at(turns(s), index).args;

  describe('with the opening turn on claude', () => {
    let s: Scenario;
    let reply: Reply;

    beforeAll(async () => {
      s = scenario({ questions: ['FIRST QUESTION'] });
      reply = await ask(s, { env: { FAKE_CRITIC_REPLY: 'the verdict\ncontext: ok' } });
    }, SPEC_TIMEOUT);

    it('should exit 0 and print the answer path', () => {
      expect(reply).toEqual({ exitCode: 0, message: path.join(s.mailbox, 'a-1.txt') });
    });

    it('should write the final text to the answer file with mode 0600', () => {
      expect(readAnswer(s.mailbox, 1)).toBe('the verdict\ncontext: ok');
      expect(fs.statSync(path.join(s.mailbox, 'a-1.txt')).mode & 0o777).toBe(0o600);
    });

    it('should send the critic rules and the first question as the prompt', () => {
      expect(turnArgs(s).at(-1)).toBe(`${MAILBOX_RULES}\n\nFIRST QUESTION`);
    });

    it('should open the claude session with --session-id and not --resume', () => {
      expect(turnArgs(s)).toContain('--session-id');
      expect(turnArgs(s)).not.toContain('--resume');
    });

    it('should run the turn in the cwd of the session', () => {
      expect(at(turns(s), 0).cwd).toBe(s.cwd);
    });

    it('should confirm the session and remember the session id', () => {
      const id = valueAfter(at(turns(s), 0), '--session-id');

      expect(readSession(s.mailbox)).toMatchObject({ confirmed: true, sessionId: id, failures: 0 });
    });

    it('should release the lock', () => {
      expect(fs.existsSync(lockFile(s))).toBe(false);
    });
  });

  it(
    'should retake a confirmed session with --resume and send only the question',
    async () => {
      const s = scenario({
        questions: ['FIRST QUESTION', 'SECOND QUESTION'],
        session: { confirmed: true, sessionId: 'sess-9' },
      });

      await ask(s);

      const call = at(turns(s), 0);

      expect(valueAfter(call, '--resume')).toBe('sess-9');
      expect(call.args.at(-1)).toBe('SECOND QUESTION');
    },
    SPEC_TIMEOUT,
  );

  it(
    'should send the rules, the first question and the current one when nothing was confirmed',
    async () => {
      const s = scenario({ questions: ['FIRST QUESTION', 'SECOND QUESTION'] });

      await ask(s);

      expect(turnArgs(s).at(-1)).toBe(`${MAILBOX_RULES}\n\nFIRST QUESTION\n\nSECOND QUESTION`);
    },
    SPEC_TIMEOUT,
  );

  describe('when the question was already answered', () => {
    let s: Scenario;
    let reply: Reply;

    beforeAll(async () => {
      s = scenario();
      fs.writeFileSync(path.join(s.mailbox, 'a-1.txt'), 'old answer');
      reply = await ask(s);
    }, SPEC_TIMEOUT);

    it('should print the existing answer path with exit 0', () => {
      expect(reply).toEqual({ exitCode: 0, message: path.join(s.mailbox, 'a-1.txt') });
    });

    it('should not run the tool again', () => {
      expect(turns(s)).toEqual([]);
    });

    it('should keep the existing answer', () => {
      expect(readAnswer(s.mailbox, 1)).toBe('old answer');
    });
  });

  describe('with agy', () => {
    let s: Scenario;

    beforeAll(async () => {
      s = scenario({ tool: 'agy', questions: ['FIRST QUESTION'] });
      await ask(s, { env: { FAKE_CRITIC_AGY_ID: 'conv-42' } });
      fs.writeFileSync(path.join(s.mailbox, 'q-2.txt'), 'SECOND QUESTION');
      await ask(s, { env: { FAKE_CRITIC_AGY_ID: 'conv-42' } });
    }, SPEC_TIMEOUT);

    it('should send the critic rules in the opening prompt', () => {
      expect(turnArgs(s, 0).at(-1)).toBe(`${MAILBOX_RULES}\n\nFIRST QUESTION`);
    });

    it('should open without a conversation id', () => {
      expect(turnArgs(s, 0)).not.toContain('--conversation');
    });

    it('should remember the conversation id the tool delivered', () => {
      expect(readSession(s.mailbox)).toMatchObject({ sessionId: 'conv-42', confirmed: true });
    });

    it('should resume the second question by --conversation', () => {
      expect(valueAfter(at(turns(s), 1), '--conversation')).toBe('conv-42');
    });

    it('should send the rules before the question on the second turn', () => {
      expect(turnArgs(s, 1).at(-1)).toBe(`${MAILBOX_RULES}\n\nSECOND QUESTION`);
    });
  });

  describe('when another ask holds the lock', () => {
    let s: Scenario;
    let first: Promise<Reply>;
    let second: Reply;

    beforeAll(async () => {
      s = scenario();
      first = ask(s, { env: { FAKE_CRITIC_MODE: 'slow', FAKE_CRITIC_GAP_MS: '300' } });
      await waitFor('the lock', () => fs.existsSync(lockFile(s)));
      second = await ask(s);
    }, SPEC_TIMEOUT);

    it('should exit 6 without waiting', () => {
      expect(second.exitCode).toBe(6);
    });

    it(
      'should run a single turn',
      async () => {
        await first;

        expect(turns(s)).toHaveLength(1);
      },
      SPEC_TIMEOUT,
    );

    it(
      'should let the first ask finish and release the lock',
      async () => {
        const reply = await first;

        expect(reply.exitCode).toBe(0);
        expect(fs.existsSync(lockFile(s))).toBe(false);
      },
      SPEC_TIMEOUT,
    );
  });

  describe('with a lock left behind', () => {
    const plant = (s: Scenario, holder: { pid: number; startTime: number | null }) =>
      fs.writeFileSync(lockFile(s), JSON.stringify({ ...holder, token: 'planted' }));

    it(
      'should steal the lock of a dead pid',
      async () => {
        const s = scenario();
        plant(s, { pid: spawnSync('true').pid, startTime: null });

        const reply = await ask(s);

        expect(reply.exitCode).toBe(0);
      },
      SPEC_TIMEOUT,
    );

    it(
      'should steal the lock of a live pid whose start time differs',
      async () => {
        const s = scenario();
        plant(s, { pid: process.pid, startTime: 1 });

        const reply = await ask(s, { startTimes: { [process.pid]: 2 } });

        expect(reply.exitCode).toBe(0);
      },
      SPEC_TIMEOUT,
    );

    it(
      'should exit 6 for a live pid whose start time matches',
      async () => {
        const s = scenario();
        plant(s, { pid: process.pid, startTime: 7 });

        const reply = await ask(s, { startTimes: { [process.pid]: 7 } });

        expect(reply.exitCode).toBe(6);
      },
      SPEC_TIMEOUT,
    );

    it(
      'should keep the lock of a live owner untouched',
      async () => {
        const s = scenario();
        plant(s, { pid: process.pid, startTime: 7 });

        await ask(s, { startTimes: { [process.pid]: 7 } });

        expect(JSON.parse(fs.readFileSync(lockFile(s), 'utf8'))).toMatchObject({
          token: 'planted',
        });
      },
      SPEC_TIMEOUT,
    );
  });

  describe('with a transient failure', () => {
    it(
      'should retry and answer after one failure without any event',
      async () => {
        const s = scenario();

        const reply = await ask(s, { env: { FAKE_CRITIC_MODE: 'fail-once' } });

        expect(reply.exitCode).toBe(0);
        expect(turns(s)).toHaveLength(2);
      },
      SPEC_TIMEOUT,
    );

    it(
      'should open a new session id on the retry when no event arrived',
      async () => {
        const s = scenario();

        await ask(s, { env: { FAKE_CRITIC_MODE: 'fail-once' } });

        expect(valueAfter(at(turns(s), 1), '--session-id')).not.toBe(
          valueAfter(at(turns(s), 0), '--session-id'),
        );
      },
      SPEC_TIMEOUT,
    );

    it(
      'should retake the session by --resume when the failed turn already emitted init',
      async () => {
        const s = scenario();

        await ask(s, { env: { FAKE_CRITIC_MODE: 'init-then-fail-once' } });

        expect(valueAfter(at(turns(s), 1), '--resume')).toBe(
          valueAfter(at(turns(s), 0), '--session-id'),
        );
      },
      SPEC_TIMEOUT,
    );

    it(
      'should retake the agy conversation by --conversation when the failed turn delivered an id',
      async () => {
        const s = scenario({ tool: 'agy' });

        await ask(s, {
          env: { FAKE_CRITIC_MODE: 'init-then-fail-once', FAKE_CRITIC_AGY_ID: 'conv-7' },
        });

        expect(turnArgs(s, 0)).not.toContain('--conversation');
        expect(valueAfter(at(turns(s), 1), '--conversation')).toBe('conv-7');
      },
      SPEC_TIMEOUT,
    );

    it(
      'should treat an agy success without a conversation id as a failure',
      async () => {
        const s = scenario({ tool: 'agy' });

        const reply = await ask(s, { env: { FAKE_CRITIC_MODE: 'no-id' } });

        expect(reply.exitCode).toBe(5);
      },
      SPEC_TIMEOUT,
    );

    it(
      'should take the number of attempts from the backoff list',
      async () => {
        const s = scenario();

        await ask(s, { env: { FAKE_CRITIC_MODE: 'error' }, timing: { backoffMs: [30] } });

        expect(turns(s)).toHaveLength(2);
      },
      SPEC_TIMEOUT,
    );

    it(
      'should reset the failure counter after an answered turn',
      async () => {
        const s = scenario({ session: { failures: 2 } });

        await ask(s);

        expect(readSession(s.mailbox)).toMatchObject({ failures: 0, broken: false });
      },
      SPEC_TIMEOUT,
    );
  });

  describe('when every attempt fails', () => {
    let s: Scenario;
    let reply: Reply;

    beforeAll(async () => {
      s = scenario();
      reply = await ask(s, { env: { FAKE_CRITIC_MODE: 'error' } });
    }, SPEC_TIMEOUT);

    it('should exit 5 after three attempts', () => {
      expect(reply.exitCode).toBe(5);
      expect(reply.message).toContain('turn failed after 3 attempts');
      expect(turns(s)).toHaveLength(3);
    });

    it('should count one failure and leave the session usable', () => {
      expect(readSession(s.mailbox)).toMatchObject({ failures: 1, broken: false });
    });

    it('should write no answer', () => {
      expect(fs.existsSync(path.join(s.mailbox, 'a-1.txt'))).toBe(false);
    });
  });

  describe('when the third question in a row fails', () => {
    let s: Scenario;
    let third: Reply;

    beforeAll(async () => {
      s = scenario({ session: { failures: 2 } });
      third = await ask(s, { env: { FAKE_CRITIC_MODE: 'error' } });
    }, SPEC_TIMEOUT);

    it('should mark the session as broken and say so', () => {
      expect(third.exitCode).toBe(5);
      expect(third.message).toContain('the session is now broken');
      expect(readSession(s.mailbox)).toMatchObject({ failures: 3, broken: true });
    });

    it(
      'should refuse the next ask with exit 5 without running the tool',
      async () => {
        fs.writeFileSync(path.join(s.mailbox, 'q-2.txt'), 'another question');
        const turnsBefore = turns(s).length;

        const reply = await ask(s);

        expect(reply.exitCode).toBe(5);
        expect(reply.message).toContain('the session is broken');
        expect(turns(s)).toHaveLength(turnsBefore);
      },
      SPEC_TIMEOUT,
    );
  });

  describe('when the claude init does not connect the hexlog server', () => {
    let s: Scenario;
    let reply: Reply;

    beforeAll(async () => {
      s = scenario({ session: { failures: 1 } });
      reply = await ask(s, { env: { FAKE_CRITIC_MODE: 'mcp-down' } });
    }, SPEC_TIMEOUT);

    it('should exit 3 with its own message', () => {
      expect(reply.exitCode).toBe(3);
      expect(reply.message).toContain('hexlog MCP server not connected');
    });

    it('should not retry', () => {
      expect(turns(s)).toHaveLength(1);
    });

    it('should write no answer', () => {
      expect(fs.existsSync(path.join(s.mailbox, 'a-1.txt'))).toBe(false);
    });

    it('should leave the failure counter and the broken flag alone', () => {
      expect(readSession(s.mailbox)).toMatchObject({ failures: 1, broken: false });
    });
  });

  describe('when the tool exits 1 after an intact answer', () => {
    let s: Scenario;
    let reply: Reply;

    beforeAll(async () => {
      s = scenario();
      reply = await ask(s, {
        env: { FAKE_CRITIC_MODE: 'exit-after-answer', FAKE_CRITIC_REPLY: 'kept answer' },
      });
    }, SPEC_TIMEOUT);

    it('should exit 0 and print the answer path', () => {
      expect(reply).toEqual({ exitCode: 0, message: path.join(s.mailbox, 'a-1.txt') });
    });

    it('should write the answer', () => {
      expect(readAnswer(s.mailbox, 1)).toBe('kept answer');
    });

    it('should run a single turn', () => {
      expect(turns(s)).toHaveLength(1);
    });
  });

  describe('when the turn goes quiet', () => {
    let s: Scenario;
    let reply: Reply;

    beforeAll(async () => {
      s = scenario({ session: { failures: 1 } });
      reply = await ask(s, { env: { FAKE_CRITIC_MODE: 'silent' }, timing: { idleMs: 400 } });
    }, SPEC_TIMEOUT);

    it('should exit 7', () => {
      expect(reply.exitCode).toBe(7);
      expect(reply.message).toContain('turn timed out');
    });

    it('should not retry', () => {
      expect(turns(s)).toHaveLength(1);
    });

    it('should leave the failure counter alone', () => {
      expect(readSession(s.mailbox)).toMatchObject({ failures: 1, broken: false });
    });

    it('should release the lock', () => {
      expect(fs.existsSync(lockFile(s))).toBe(false);
    });
  });

  describe('when a grandchild leaves the process group and keeps the stdout open', () => {
    let s: Scenario;
    let reply: Reply;

    beforeAll(async () => {
      s = scenario();
      reply = await ask(s, {
        env: { FAKE_CRITIC_MODE: 'detached-grandchild' },
        timing: { idleMs: 400 },
      });
    }, SPEC_TIMEOUT);

    afterAll(() => {
      if (fs.existsSync(s.shims.pidFile)) {
        process.kill(Number(fs.readFileSync(s.shims.pidFile, 'utf8')), 'SIGKILL');
      }
    });

    it('should still exit 7 inside the idle window it was given', () => {
      expect(reply.exitCode).toBe(7);
    });

    it('should release the lock', () => {
      expect(fs.existsSync(lockFile(s))).toBe(false);
    });
  });

  describe('with a credential failure', () => {
    it(
      'should exit 4 without retry and without counting a failure',
      async () => {
        const s = scenario({ session: { failures: 1 } });

        const reply = await ask(s, { env: { FAKE_CRITIC_MODE: 'credential' } });

        expect(reply.exitCode).toBe(4);
        expect(turns(s)).toHaveLength(1);
        expect(readSession(s.mailbox)).toMatchObject({ failures: 1 });
      },
      SPEC_TIMEOUT,
    );

    it(
      'should exit 4 for agy without running the turn when agy is logged out',
      async () => {
        const s = scenario({ tool: 'agy' });

        const reply = await ask(s, { env: { FAKE_CRITIC_LOGGED_OUT: '1' } });

        expect(reply).toEqual({ exitCode: 4, message: 'agy is not logged in' });
        expect(turns(s)).toEqual([]);
      },
      SPEC_TIMEOUT,
    );

    it(
      'should exit 4 for agy when the tool itself reports an authentication failure',
      async () => {
        const s = scenario({ tool: 'agy' });

        const reply = await ask(s, { env: { FAKE_CRITIC_MODE: 'credential' } });

        expect(reply.exitCode).toBe(4);
      },
      SPEC_TIMEOUT,
    );
  });

  it.each(['claude', 'agy'] as const)(
    'should exit 3 when the %s binary is not on the PATH',
    async (tool) => {
      const s = scenario({ tool });

      const reply = await ask(s, { env: { PATH: NO_BINARY } });

      expect(reply.exitCode).toBe(3);
      expect(reply.message).toContain(`${tool} is not available on the PATH`);
    },
    SPEC_TIMEOUT,
  );

  it.each([
    ['a question over 100000 bytes', ['x'.repeat(100_001)], 'question is over 100000 bytes'],
    [
      'an opening prompt over the argv limit',
      ['a'.repeat(80_000), 'b'.repeat(80_000)],
      'prompt is over 131000 bytes',
    ],
  ])(
    'should refuse %s with its own message and exit 8',
    async (_case, questions, message) => {
      const s = scenario({ questions });

      const reply = await ask(s);

      expect(reply.exitCode).toBe(8);
      expect(reply.message).toContain(message);
      expect(turns(s)).toEqual([]);
    },
    SPEC_TIMEOUT,
  );

  it(
    'should not read the opening question when the session is already confirmed',
    async () => {
      const s = scenario({
        questions: ['x'.repeat(100_001), 'SECOND QUESTION'],
        session: { confirmed: true, sessionId: 'sess-9' },
      });

      const reply = await ask(s);

      expect(reply.exitCode).toBe(0);
    },
    SPEC_TIMEOUT,
  );

  it(
    'should exit 3 saying the cwd is gone when the session directory was removed',
    async () => {
      const s = scenario();
      fs.rmSync(s.cwd, { recursive: true });

      const reply = await ask(s);

      expect(reply.exitCode).toBe(3);
      expect(reply.message).toContain(`the session cwd is gone: ${s.cwd}`);
      expect(turns(s)).toEqual([]);
    },
    SPEC_TIMEOUT,
  );

  it(
    'should escape the control characters of the failure detail',
    async () => {
      const s = scenario();

      const reply = await ask(s, {
        env: { FAKE_CRITIC_MODE: 'error', FAKE_CRITIC_ERROR: 'bad \u001b[31mred' },
      });

      expect(reply.message).toContain('bad \\u001b[31mred');
      expect(reply.message).not.toContain('\u001b');
    },
    SPEC_TIMEOUT,
  );

  it(
    'should accept a question of exactly 100000 bytes',
    async () => {
      const s = scenario({ questions: ['x'.repeat(100_000)] });

      const reply = await ask(s);

      expect(reply.exitCode).toBe(0);
    },
    SPEC_TIMEOUT,
  );

  it(
    'should truncate an answer over the text cap and mark the cut',
    async () => {
      const s = scenario();

      await ask(s, { env: { FAKE_CRITIC_REPLY: 'x'.repeat(100) }, timing: { maxTextBytes: 20 } });

      expect(readAnswer(s.mailbox, 1)).toBe(`${'x'.repeat(20)}\n[truncated]`);
    },
    SPEC_TIMEOUT,
  );

  it(
    'should exit 2 when the mailbox does not exist',
    async () => {
      const gone = path.join(createTempDir('critic-box'), 'hexlog-critic-gone');

      const reply = await ask({ shims: installShims(), mailbox: gone, cwd: gone });

      expect(reply.exitCode).toBe(2);
      expect(reply.message).toContain('mailbox not found');
    },
    SPEC_TIMEOUT,
  );

  it(
    'should exit 2 and run no turn when the mailbox has no rules.txt',
    async () => {
      const s = scenario();
      fs.rmSync(path.join(s.mailbox, 'rules.txt'));

      const reply = await ask(s);

      expect(reply).toEqual({
        exitCode: 2,
        message: 'mailbox without rules.txt: run start again',
      });
      expect(turns(s)).toEqual([]);
    },
    SPEC_TIMEOUT,
  );

  it(
    'should exit 1 when the mailbox holds no question',
    async () => {
      const reply = await ask(scenario({ questions: [] }));

      expect(reply.exitCode).toBe(1);
    },
    SPEC_TIMEOUT,
  );
});

describe('closeMailbox', () => {
  it('should remove the mailbox and print its path with exit 0', () => {
    const { mailbox } = makeMailbox();

    const reply = closeMailbox(mailbox);

    expect(reply).toEqual({ exitCode: 0, message: mailbox });
    expect(fs.existsSync(mailbox)).toBe(false);
  });

  it('should succeed again on a mailbox that is already gone', () => {
    const { mailbox } = makeMailbox();
    closeMailbox(mailbox);

    expect(closeMailbox(mailbox).exitCode).toBe(0);
  });

  it('should remove a mailbox left with a stale lock and an answer', () => {
    const { mailbox } = makeMailbox();
    fs.writeFileSync(path.join(mailbox, 'ask.lock'), '{"pid":1}');
    fs.writeFileSync(path.join(mailbox, 'a-1.txt'), 'answer');

    closeMailbox(mailbox);

    expect(fs.existsSync(mailbox)).toBe(false);
  });

  it('should leave the sibling mailboxes alone', () => {
    const { mailbox } = makeMailbox();
    const sibling = makeMailbox().mailbox;

    closeMailbox(mailbox);

    expect(fs.existsSync(sibling)).toBe(true);
  });

  it('should refuse a directory that is not a critic mailbox', () => {
    const dir = createTempDir('not-a-mailbox');
    fs.writeFileSync(path.join(dir, 'keep.txt'), 'x');

    const reply = closeMailbox(dir);

    expect(reply.exitCode).toBe(1);
    expect(fs.existsSync(path.join(dir, 'keep.txt'))).toBe(true);
  });

  it('should refuse a directory with the mailbox prefix but without session.json', () => {
    const dir = createTempDir('critic-bare');

    const reply = closeMailbox(dir);

    expect(reply.exitCode).toBe(1);
    expect(fs.existsSync(dir)).toBe(true);
  });

  it('should refuse a mailbox that is not directly inside the tmpdir', () => {
    const dir = path.join(createTempDir('critic-elsewhere'), 'hexlog-critic-nested');
    fs.mkdirSync(dir);
    fs.writeFileSync(path.join(dir, 'session.json'), '{}');

    const reply = closeMailbox(dir);

    expect(reply.exitCode).toBe(1);
    expect(fs.existsSync(dir)).toBe(true);
  });
});

describe('procStartTime', () => {
  it('should read a finite start time for a live pid', () => {
    expect(procStartTime(process.pid)).toBeGreaterThan(0);
  });

  it('should return undefined for a pid that does not exist', () => {
    expect(procStartTime(2 ** 22 + 1)).toBeUndefined();
  });

  it('should give the same start time for the same process on every read', () => {
    expect(procStartTime(process.pid)).toBe(procStartTime(process.pid));
  });
});
