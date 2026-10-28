import { beforeAll, describe, expect, it } from '@jest/globals';
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
  makeMailbox,
  NO_BINARY,
  readSession,
  readTurns,
  type Reply,
  runDriver,
  SPEC_TIMEOUT,
  waitFor,
  writeCatalogDoc,
  writeClaudeJson,
  type Shims,
} from './critic-helpers.ts';
import { at, createTempDir } from './helpers.ts';

type TurnResult = {
  exitCode: number | null;
  timedOut: boolean;
  spawnError?: string;
  aborted: boolean;
  stderrTail: string;
  elapsedMs: number;
  turn: { sessionId?: string; established: boolean; final?: { text: string; isError: boolean } };
};

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

  describe('when the stream goes quiet for the idle window', () => {
    let result: TurnResult;

    beforeAll(async () => {
      result = await run(scenario(), { FAKE_CRITIC_MODE: 'silent' }, { idleMs: 400 });
    }, SPEC_TIMEOUT);

    it('should time out', () => {
      expect(result.timedOut).toBe(true);
    });

    it('should keep the session id of a stream that timed out after the init event', () => {
      expect(result.turn).toMatchObject({ sessionId: 'sess-1', established: true });
    });
  });

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

    it('should exit 0', () => {
      expect(reply.exitCode).toBe(0);
    });

    it('should print the mailbox path inside the tmpdir', () => {
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

    it('should write session.json with mode 0600', () => {
      const file = path.join(reply.message, 'session.json');

      expect(fs.statSync(file).mode & 0o777).toBe(0o600);
    });

    it('should write the initial session state', () => {
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
      expect(reply.message).toContain('unreadable catalog');
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

      expect(reply).toEqual({
        exitCode: 3,
        message: 'hexlog server not registered in ~/.claude.json',
      });
    },
    SPEC_TIMEOUT,
  );

  const refused: [string, (s: Scenario) => { slug?: string; cwd?: string }][] = [
    ['a slug that is not kebab-case', () => ({ slug: 'Bad Slug' })],
    ['a cwd that is not a directory', ({ home }) => ({ cwd: path.join(home, 'missing-dir') })],
  ];

  it.each(refused)(
    'should exit 1 for %s',
    async (_cause, over) => {
      const s = scenario();

      const reply = await start(s, 'claude', {}, over(s));

      expect(reply.exitCode).toBe(1);
    },
    SPEC_TIMEOUT,
  );

  it.each(refused)(
    'should create nothing for %s',
    async (_cause, over) => {
      const s = scenario();

      await start(s, 'claude', {}, over(s));

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

describe('closeMailbox', () => {
  it('should print the mailbox path with exit 0', () => {
    const { mailbox } = makeMailbox();

    const reply = closeMailbox(mailbox);

    expect(reply).toEqual({ exitCode: 0, message: mailbox });
  });

  it('should remove the mailbox', () => {
    const { mailbox } = makeMailbox();

    closeMailbox(mailbox);

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
