// e2e do passo 8: fala stdio contra o bundle real (`server.mjs`), nunca contra `src/*.ts`
// (§9.3, U-7). O `.ts` já é coberto em processo por `InMemoryTransport` nos passos 7a/7b/7c;
// aqui o alvo é o caminho de produção — o que as sessões realmente executam.
import { afterAll, beforeAll, describe, expect, test } from '@jest/globals';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { isUndefined, omitBy, range } from 'es-toolkit';
import { isEmpty } from 'es-toolkit/compat';
import { dataDir } from '../src/directory.ts';
import type { LogRecord } from '../src/log.ts';

const repoRoot = path.resolve(__dirname, '..');
const buildPath = path.join(repoRoot, 'scripts/build.ts');

// ---- infra compartilhada ----

const temporaryDirs: string[] = [];

function mkdtempOutside(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  temporaryDirs.push(dir);
  return dir;
}

/** `env` de um processo filho isolado: HOME e XDG_DATA_HOME temporários (§9.3); o real nunca é tocado. */
function temporaryEnv(): Record<string, string> {
  const base = omitBy(process.env, isUndefined) as Record<string, string>;
  return {
    ...base,
    HOME: mkdtempOutside('hexlog-e2e-home-'),
    XDG_DATA_HOME: mkdtempOutside('hexlog-e2e-xdg-'),
  };
}

function buildBundle(outdir: string, cwd: string): void {
  const result = spawnSync(process.execPath, [buildPath, '--outdir', outdir], {
    cwd,
    encoding: 'utf8',
  });
  if (result.status !== 0) {
    throw new Error(`e2e build failed (cwd=${cwd}): ${result.stderr}`);
  }
}

function sha256OfFile(file: string): string {
  return createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

/** Acumula os `data` de um stream (stdout/stderr de processo filho ou de `StdioClientTransport`) em texto. */
function lineCollector(source: NodeJS.EventEmitter | null) {
  const state = { text: '' };
  source?.on('data', (chunk: Buffer) => {
    state.text += chunk.toString();
  });
  return {
    lines: () => state.text.split('\n').filter((line) => !isEmpty(line)),
    text: () => state.text,
  };
}

/** Parseia cada linha do stderr estruturado (§4.15) como um `LogRecord`. */
function stderrRecords(text: string): LogRecord[] {
  return text
    .split('\n')
    .filter((line) => !isEmpty(line))
    .map((line) => JSON.parse(line) as LogRecord);
}

function waitFor(condition: () => boolean, intervalMs = 20): Promise<void> {
  return new Promise((resolve) => {
    const check = () => (condition() ? resolve() : setTimeout(check, intervalMs));
    check();
  });
}

async function createClient(serverMjs: string, env: Record<string, string>, cwd: string) {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [serverMjs],
    env,
    cwd,
    stderr: 'pipe',
  });
  const stderr = lineCollector(transport.stderr);
  const client = new Client({ name: 'hexlog-e2e', version: '0.0.0' });
  await client.connect(transport);
  return { client, stderr };
}

// ---- diretório de dados real: nunca tocado por estes e2e ----

let realDirBefore: { exists: boolean; mtimeMs?: number };

beforeAll(() => {
  const realDir = dataDir(process.env);
  realDirBefore = fs.existsSync(realDir)
    ? { exists: true, mtimeMs: fs.statSync(realDir).mtimeMs }
    : { exists: false };
});

afterAll(() => {
  const realDir = dataDir(process.env);
  expect(fs.existsSync(realDir)).toBe(realDirBefore.exists);
  if (realDirBefore.exists) {
    expect(fs.statSync(realDir).mtimeMs).toBe(realDirBefore.mtimeMs);
  }
  for (const dir of temporaryDirs) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ---- bundle principal: compartilhado por M6, B1(a), B1(c) e C1 ----

let mainBundle: string;

beforeAll(() => {
  mainBundle = mkdtempOutside('hexlog-e2e-bundle-');
  buildBundle(mainBundle, repoRoot);
}, 30_000);

describe('M6', () => {
  test('bundle fala só JSON-RPC 2.0 no stdout e JSON estruturado (evento) no stderr', async () => {
    const child = spawn(process.execPath, [path.join(mainBundle, 'server.mjs')], {
      cwd: mainBundle,
      env: temporaryEnv(),
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    const stdout = lineCollector(child.stdout);
    const stderr = lineCollector(child.stderr);
    const send = (message: unknown) => child.stdin.write(`${JSON.stringify(message)}\n`);

    send({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {
        protocolVersion: '2025-06-18',
        capabilities: {},
        clientInfo: { name: 'hexlog-e2e', version: '0.0.0' },
      },
    });
    await waitFor(() => stdout.lines().length >= 1);

    send({ jsonrpc: '2.0', method: 'notifications/initialized' });
    send({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} });
    await waitFor(() => stdout.lines().length >= 2);

    send({
      jsonrpc: '2.0',
      id: 3,
      method: 'tools/call',
      params: { name: 'list', arguments: {} },
    });
    await waitFor(() => stdout.lines().length >= 3);

    // Erro de domínio: continua uma resposta JSON-RPC normal, com `result.isError`.
    send({
      jsonrpc: '2.0',
      id: 4,
      method: 'tools/call',
      params: { name: 'chain', arguments: { project: 'ghost', process: 'ghost' } },
    });
    await waitFor(() => stdout.lines().length >= 4);

    const lines = stdout.lines();
    expect(lines).toHaveLength(4);
    for (const line of lines) {
      const message = JSON.parse(line) as { jsonrpc: string; id?: unknown; method?: unknown };
      expect(message.jsonrpc).toBe('2.0');
      expect(message.id !== undefined || message.method !== undefined).toBe(true);
    }
    expect((JSON.parse(lines[3]) as { result: { isError?: boolean } }).result.isError).toBe(true);

    for (const record of stderrRecords(stderr.text())) {
      expect(record.event).toBeDefined();
    }

    child.kill();
  }, 15_000);
});

describe('B1', () => {
  describe('(a)', () => {
    test('uma chamada de cada uma das 10 tools contra o bundle, sem erro, sem INTERNO, sem Dynamic require', async () => {
      const projectName = 'e2e-proj';
      const processName = 'e2e-proc';
      const { client, stderr } = await createClient(
        path.join(mainBundle, 'server.mjs'),
        temporaryEnv(),
        mainBundle,
      );

      try {
        const call = async (name: string, args: Record<string, unknown> = {}) => {
          const result = (await client.callTool({ name, arguments: args })) as {
            isError?: boolean;
          };
          expect(result.isError).not.toBe(true);
          return result;
        };

        await call('register_vocabulary', {
          project: projectName,
          owner: 'core',
          milestoneType: ['approved'],
          result: ['ok'],
          action: ['follow'],
        });
        await call('register_type', {
          project: projectName,
          name: 'note-e2e',
          schema: {
            type: 'object',
            properties: { when: { type: 'string', format: 'date-time' } },
            required: ['when'],
            additionalProperties: false,
          },
        });
        await call('register_gate', {
          project: projectName,
          name: 'gate-e2e',
          criteria: 'any e2e criteria',
        });
        await call('create_process', { project: projectName, process: processName });
        await call('register', {
          project: projectName,
          process: processName,
          id: `${projectName}:${processName}:milestone`,
          agent: 'e2e-agent',
          data: { milestoneType: 'approved', target: 'hex:target:e2e1' },
        });
        await call('register', {
          project: projectName,
          process: processName,
          id: `${projectName}:${processName}:verdict`,
          agent: 'e2e-agent',
          data: {
            claim: 'a',
            source: 'f',
            result: 'ok',
            evidence: 'p',
            target: 'hex:target:e2e1',
            origin: 'o',
            trace: 'r',
          },
        });
        await call('register', {
          project: projectName,
          process: processName,
          id: `${projectName}:${processName}:note-e2e`,
          agent: 'e2e-agent',
          data: { when: new Date().toISOString() },
        });
        await call('evaluate_gate', {
          project: projectName,
          process: processName,
          gate: 'no-conflicts',
          agent: 'e2e-agent',
          target: 'hex:target:e2e1',
        });
        await call('state', { project: projectName, process: processName });
        await call('events', { project: projectName, process: processName });
        await call('events', { project: projectName, process: processName, search: 'approved' });
        await call('chain', { project: projectName, process: processName });
        await call('list', {});
      } finally {
        await client.close();
      }

      const stderrText = stderr.text();
      expect(stderrText).not.toContain('"code":"INTERNAL"');
      expect(stderrText).not.toContain('Dynamic require');
    }, 20_000);
  });

  test('(c) server.mjs e bash-guard.mjs não contêm o shim "Dynamic require of"', () => {
    for (const file of ['server.mjs', 'bash-guard.mjs']) {
      const content = fs.readFileSync(path.join(mainBundle, file), 'utf8');
      expect(content.includes('Dynamic require of')).toBe(false);
    }
  });

  describe('(d)', () => {
    let rootBundle: string;
    let tmpBundle: string;

    beforeAll(() => {
      rootBundle = mkdtempOutside('hexlog-e2e-b1d-root-');
      tmpBundle = mkdtempOutside('hexlog-e2e-b1d-tmp-');
      buildBundle(rootBundle, repoRoot);
      buildBundle(tmpBundle, os.tmpdir());
    }, 30_000);

    test('build com cwd na raiz e com cwd em os.tmpdir() geram sha256 idênticos', () => {
      for (const file of ['server.mjs', 'bash-guard.mjs']) {
        expect(sha256OfFile(path.join(rootBundle, file))).toBe(
          sha256OfFile(path.join(tmpBundle, file)),
        );
      }
    });
  });
});

// Fluxo ponta a ponta de uma rodada de voto e de uma transição de fase, via cliente MCP stdio
// real — mesmo padrão de client de B1(a), contra o bundle já compilado.
describe('E2E — voto e transição de fase', () => {
  test('rodada de voto com 3 votantes: os 2 primeiros saem redigidos em events, o 3º revela todos', async () => {
    const projectName = 'e2e-vote-proj';
    const processName = 'e2e-vote-proc';
    const { client, stderr } = await createClient(
      path.join(mainBundle, 'server.mjs'),
      temporaryEnv(),
      mainBundle,
    );

    try {
      await client.callTool({
        name: 'register_vocabulary',
        arguments: {
          project: projectName,
          owner: 'core',
          milestoneType: [],
          result: [],
          action: [],
        },
      });
      await client.callTool({
        name: 'create_process',
        arguments: { project: projectName, process: processName },
      });

      const voteData = (overrides: Record<string, unknown> = {}) => ({
        target: 'hex:target:jury-e2e',
        round: 'r1',
        votersExpected: 3,
        position: 'ok',
        changed: false,
        ...overrides,
      });
      const castVote = (agent: string, overrides: Record<string, unknown> = {}) =>
        client.callTool({
          name: 'register',
          arguments: {
            project: projectName,
            process: processName,
            id: `${projectName}:${processName}:vote`,
            agent,
            data: voteData(overrides),
          },
        }) as Promise<{ structuredContent?: { event: { id: string } } }>;
      const readEventsById = async () => {
        const result = (await client.callTool({
          name: 'events',
          arguments: { project: projectName, process: processName },
        })) as {
          structuredContent?: {
            events: { id: string; redacted?: boolean; data: { position: unknown } }[];
          };
        };
        return Object.fromEntries((result.structuredContent?.events ?? []).map((e) => [e.id, e]));
      };

      const first = await castVote('voter-1');
      const firstId = first.structuredContent?.event.id as string;
      const second = await castVote('voter-2');
      const secondId = second.structuredContent?.event.id as string;

      const afterTwo = await readEventsById();
      expect(afterTwo[firstId].redacted).toBe(true);
      expect(afterTwo[firstId].data.position).toBeNull();
      expect(afterTwo[secondId].redacted).toBe(true);

      const third = await castVote('voter-3', { position: 'not-ok' });
      const thirdId = third.structuredContent?.event.id as string;

      const afterThree = await readEventsById();
      expect(afterThree[firstId].redacted).toBeUndefined();
      expect(afterThree[firstId].data.position).toBe('ok');
      expect(afterThree[secondId].redacted).toBeUndefined();
      expect(afterThree[secondId].data.position).toBe('ok');
      expect(afterThree[thirdId].redacted).toBeUndefined();
      expect(afterThree[thirdId].data.position).toBe('not-ok');

      expect(stderr.text()).not.toContain('"code":"INTERNAL"');
    } finally {
      await client.close();
    }
  }, 20_000);

  test('transição de fase: primeira fase (from: null) aceita; fora de ordem rejeita com INVALID_TRANSITION', async () => {
    const projectName = 'e2e-transition-proj';
    const processName = 'e2e-transition-proc';
    const { client, stderr } = await createClient(
      path.join(mainBundle, 'server.mjs'),
      temporaryEnv(),
      mainBundle,
    );

    try {
      await client.callTool({
        name: 'register_vocabulary',
        arguments: {
          project: projectName,
          owner: 'core',
          milestoneType: ['draft', 'review', 'done'],
          result: [],
          action: [],
          transitions: [
            { from: null, to: 'draft' },
            { from: 'draft', to: 'review' },
            { from: 'review', to: 'done' },
          ],
        },
      });
      await client.callTool({
        name: 'create_process',
        arguments: { project: projectName, process: processName },
      });

      const registerMilestone = (milestoneType: string) =>
        client.callTool({
          name: 'register',
          arguments: {
            project: projectName,
            process: processName,
            id: `${projectName}:${processName}:milestone`,
            agent: 'e2e-agent',
            data: { milestoneType, target: 'hex:target:phase-e2e' },
          },
        }) as Promise<{ isError?: boolean; structuredContent?: { code?: string } }>;

      const draft = await registerMilestone('draft');
      expect(draft.isError).not.toBe(true);

      const outOfOrder = await registerMilestone('done');
      expect(outOfOrder.isError).toBe(true);
      expect(outOfOrder.structuredContent?.code).toBe('INVALID_TRANSITION');

      expect(stderr.text()).not.toContain('"code":"INTERNAL"');
    } finally {
      await client.close();
    }
  }, 20_000);
});

describe('C1', () => {
  type SeedEvent = { id: string; agent: string; data: Record<string, unknown> };
  type RegisterResponse = {
    isError?: boolean;
    structuredContent?: { deduplicated: boolean; event: { seq: number; id: string } };
  };

  /** 20 `register` com prefixo + 5 retentativas por id completo de elos semeados, todos em paralelo. */
  function fireRound(
    client: Client,
    projectName: string,
    processName: string,
    serverIndex: number,
    seeds: SeedEvent[],
  ) {
    const writes = Array.from({ length: 20 }, (_, index) =>
      client.callTool({
        name: 'register',
        arguments: {
          project: projectName,
          process: processName,
          id: `${projectName}:${processName}:milestone`,
          agent: `server${serverIndex}`,
          data: { milestoneType: 'approved', target: `hex:target:s${serverIndex}-${index}` },
        },
      }),
    );
    const retries = seeds.slice(0, 5).map((seed) =>
      client.callTool({
        name: 'register',
        arguments: {
          project: projectName,
          process: processName,
          id: seed.id,
          agent: seed.agent,
          data: seed.data,
        },
      }),
    );
    return Promise.all([...writes, ...retries]) as Promise<RegisterResponse[]>;
  }

  test('4 servidores concorrentes, barreira por lock artificial: 100 linhas, seq 0..99, cadeia íntegra, 20 deduplicados, zero timeouts', async () => {
    const projectName = 'c1-proj';
    const processName = 'c1-proc';
    const env = temporaryEnv();
    const serverMjs = path.join(mainBundle, 'server.mjs');

    // 1) semeadura: um servidor à parte, fechado antes da concorrência começar.
    const seedClient = await createClient(serverMjs, env, mainBundle);
    await seedClient.client.callTool({
      name: 'register_vocabulary',
      arguments: {
        project: projectName,
        owner: 'core',
        milestoneType: ['approved'],
        result: [],
        action: [],
      },
    });
    await seedClient.client.callTool({
      name: 'create_process',
      arguments: { project: projectName, process: processName },
    });

    const seeds: SeedEvent[] = [];
    for (let index = 0; index < 20; index++) {
      const agent = 'seed';
      const data = { milestoneType: 'approved', target: `hex:target:seed${index}` };
      const result = await seedClient.client.callTool({
        name: 'register',
        arguments: {
          project: projectName,
          process: processName,
          id: `${projectName}:${processName}:milestone`,
          agent,
          data,
        },
      });
      const body = result.structuredContent as { event: { id: string } };
      seeds.push({ id: body.event.id, agent, data });
    }
    await seedClient.client.close();

    // 2) lock artificial: qualquer `append` real colide já na primeira tentativa.
    const eventsFile = path.join(dataDir(env), projectName, processName, 'events.jsonl');
    const lockDir = `${eventsFile}.lock`;
    fs.mkdirSync(lockDir);
    fs.writeFileSync(path.join(lockDir, 'holder'), 'foreign-token');

    // 3) 4 servidores concorrentes, mesmo `env`.
    const clients = await Promise.all(
      Array.from({ length: 4 }, () => createClient(serverMjs, env, mainBundle)),
    );
    const countLockWaits = () =>
      clients
        .flatMap((c) => stderrRecords(c.stderr.text()))
        .filter((record) => record.event === 'lock-wait').length;

    const barrierStart = Date.now();
    const rounds = clients.map((client, index) =>
      fireRound(client.client, projectName, processName, index, seeds),
    );

    // A espera pela aquisição do lock em `acquireLock` (src/log.ts) é assíncrona: o handler de
    // uma tool devolve o controle ao laço de mensagens do SDK entre uma tentativa e outra, então
    // as 20 chamadas de `register` com prefixo de cada um dos 4 servidores despacham e colidem
    // com o lock artificial, gerando os 80 `lock-wait` que o AC C1 exige antes da soltura.
    await waitFor(() => countLockWaits() >= 80, 5);
    const barrierMs = Date.now() - barrierStart;
    fs.rmSync(lockDir, { recursive: true, force: true });

    const responses = (await Promise.all(rounds)).flat();
    const chainResult = (
      await clients[0].client.callTool({
        name: 'chain',
        arguments: { project: projectName, process: processName },
      })
    ).structuredContent as {
      ok: boolean;
    };

    await Promise.all(clients.map((c) => c.client.close()));

    // ---- verificações ----
    expect(barrierMs).toBeLessThan(3_000);
    expect(responses.every((response) => response.isError !== true)).toBe(true);

    const fileLines = fs
      .readFileSync(eventsFile, 'utf8')
      .split('\n')
      .filter((line) => !isEmpty(line));
    expect(fileLines).toHaveLength(100);
    const links = fileLines.map((line) => JSON.parse(line) as { seq: number; id: string });
    expect(links.map((link) => link.seq).sort((a, b) => a - b)).toEqual(range(100));
    expect(new Set(links.map((link) => link.id)).size).toBe(100);
    expect(chainResult.ok).toBe(true);

    const totalDeduplicated = responses.filter(
      (response) => response.structuredContent?.deduplicated === true,
    ).length;
    expect(totalDeduplicated).toBe(20);

    const allRecords = clients.flatMap((c) => stderrRecords(c.stderr.text()));
    expect(allRecords.some((record) => record.event === 'lock-orphan-removed')).toBe(false);
    expect(allRecords.some((record) => record.code === 'LOCK_TIMEOUT')).toBe(false);
    expect(allRecords.some((record) => record.code === 'LOCK_LOST')).toBe(false);

    const registerMs = allRecords
      .filter((record) => record.event === 'tool' && record.name === 'register')
      .map((record) => record.ms as number);
    const totalLockWaits = allRecords.filter((record) => record.event === 'lock-wait').length;
    process.stdout.write(
      `C1: barrier=${barrierMs}ms maxRegisterMs=${Math.max(...registerMs)}ms totalLockWaits=${totalLockWaits} (guaranteed min 80)\n`,
    );
  }, 60_000);
});
