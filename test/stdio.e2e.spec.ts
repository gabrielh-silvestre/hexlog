// e2e por stdio contra o bundle real (`server.mjs`, entry `src/server.ts`), construído pelo mesmo
// `scripts/build.ts#build` dos bundles de produção (P8): é o caminho que as sessões executam, e o
// `.ts` já é coberto em processo por `test/mcp/`.
import { afterAll, beforeAll, describe, expect, test } from '@jest/globals';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { CLIENT_INFO_META_KEY } from '@modelcontextprotocol/server';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { isUndefined, omitBy } from 'es-toolkit';
import type { QueryResult } from '../src/queries/query-service.ts';
import { VERSION } from '../src/version.ts';
import { at, createTempDir } from './helpers.ts';
import { errorBodyOf } from './mcp/environment.ts';

const repoRoot = path.resolve(__dirname, '..');
const LEGACY_FIXTURE = path.join(repoRoot, 'test/fixtures/legacy-0x');
const PROJECT = 'alpha';
const PROCESS = 'run-1';

type CallResult = {
  isError?: boolean;
  structuredContent?: unknown;
  content?: { type: string; text?: string }[];
};

let bundleDir: string;

beforeAll(() => {
  bundleDir = createTempDir('e2e-bundle');
  const result = spawnSync(
    process.execPath,
    [path.join(repoRoot, 'test/fixtures/build-entry.ts'), bundleDir, 'server=src/server.ts'],
    { cwd: repoRoot, encoding: 'utf8' },
  );
  if (result.status !== 0) throw new Error(`e2e build failed: ${result.stderr}`);
}, 30_000);

afterAll(() => {
  fs.rmSync(bundleDir, { recursive: true, force: true });
});

/** Cliente stdio sobre o bundle; `HOME` e `XDG_DATA_HOME` temporários, o `<D>` real nunca é tocado. */
async function connect(options: { xdg?: string; clientName?: string } = {}) {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [path.join(bundleDir, 'server.mjs')],
    env: {
      ...(omitBy(process.env, isUndefined) as Record<string, string>),
      HOME: createTempDir('e2e-home'),
      XDG_DATA_HOME: options.xdg ?? createTempDir('e2e-xdg'),
    },
    cwd: bundleDir,
    stderr: 'pipe',
  });
  let stderr = '';
  transport.stderr?.on('data', (chunk: Buffer) => {
    stderr += chunk.toString();
  });
  const clientName = options.clientName ?? 'hexlog-e2e';
  const client = new Client({ name: clientName, version: '0.0.0' });
  const transportErrors: Error[] = [];
  client.onerror = (error) => transportErrors.push(error);
  await client.connect(transport);
  // O envelope vai por `_meta` em cada chamada: é de onde o servidor lê o `client` do autor (D-21).
  const _meta = { [CLIENT_INFO_META_KEY]: { name: clientName, version: '0.0.0' } };
  const call = async (name: string, args: Record<string, unknown> = {}) =>
    (await client.callTool({ name, arguments: args, _meta })) as CallResult;
  return { client, call, stderr: () => stderr, transportErrors };
}

/** Define o tipo `note`, cria o processo e grava `count` notas pelo `call` do cliente. */
async function seedNotes(call: Awaited<ReturnType<typeof connect>>['call'], count: number) {
  await call('define_type', {
    project: PROJECT,
    name: 'note',
    schema: { type: 'object', additionalProperties: true },
  });
  await call('create_process', { project: PROJECT, process: PROCESS });
  const registered = await call('register', {
    project: PROJECT,
    process: PROCESS,
    agent: 'e2e-agent',
    records: Array.from({ length: count }, (_, n) => ({
      type: 'note',
      target: 'run.step',
      data: { text: `nota ${n}` },
    })),
  });
  expect(registered.isError).not.toBe(true);
}

/** Cada linha do stderr tem de ser um registro JSON do logger; só vale depois do `client.close()`. */
function stderrRecords(
  stderr: string,
): { level: string; event: string; [field: string]: unknown }[] {
  return stderr
    .split('\n')
    .filter((line) => line !== '')
    .map((line) => JSON.parse(line) as { level: string; event: string });
}

describe('P8 e TM1: bundle real por stdio', () => {
  test('o bundle não contém o shim "Dynamic require of"', () => {
    expect(fs.readFileSync(path.join(bundleDir, 'server.mjs'), 'utf8')).not.toContain(
      'Dynamic require of',
    );
  });

  test('<D> com a fixture de dado 0.x responde LEGACY_DATA com o comando em details', async () => {
    const xdg = createTempDir('e2e-xdg');
    fs.cpSync(LEGACY_FIXTURE, path.join(xdg, 'hexlog'), { recursive: true });
    const { client, call } = await connect({ xdg });
    try {
      const body = errorBodyOf(await call('list'));

      expect(body.code).toBe('LEGACY_DATA');
      expect(body.details).toEqual([expect.objectContaining({ code: 'run' })]);
    } finally {
      await client.close();
    }
  }, 20_000);

  test('entrada fora do schema dá INVALID_INPUT estruturado, sem INTERNAL no stderr', async () => {
    const { client, call, stderr } = await connect();
    try {
      const body = errorBodyOf(
        await call('query', { project: PROJECT, process: PROCESS, limit: 0 }),
      );

      expect(body.code).toBe('INVALID_INPUT');
      expect(body.details).toEqual([expect.objectContaining({ path: '/limit' })]);
    } finally {
      await client.close();
    }
    expect(stderr()).not.toContain('"code":"INTERNAL"');
  }, 20_000);

  test('o client do autor é gravado a partir do clientInfo do envelope', async () => {
    const { client, call } = await connect({ clientName: 'claude-code' });
    try {
      await seedNotes(call, 1);

      const page = (await call('query', { project: PROJECT, process: PROCESS }))
        .structuredContent as QueryResult;

      expect(at(page.records, 0).author).toEqual({ agent: 'e2e-agent', client: 'claude-code' });
    } finally {
      await client.close();
    }
  }, 20_000);

  test('uma chamada de cada tool no bundle: stdout só JSON-RPC e stderr JSON estruturado', async () => {
    const xdg = createTempDir('e2e-xdg');
    const { client, call, stderr, transportErrors } = await connect({ xdg });
    try {
      // `create_process` fixa os gates do projeto: o gate vem antes dele
      const gate = await call('define_gate', {
        project: PROJECT,
        name: 'has-note',
        questions: [{ kind: 'occurred', select: { type: 'note' } }],
      });
      await seedNotes(call, 1);
      const attached = await call('attach', { project: PROJECT, text: 'relatório do e2e' });
      const { hash } = attached.structuredContent as { hash: string };
      const results = [
        gate,
        attached,
        await call('read_attachment', { project: PROJECT, hash }),
        await call('define_relation', { project: PROJECT, name: 'rel', kind: 'supports' }),
        await call('evaluate_gate', { project: PROJECT, process: PROCESS, gate: 'has-note' }),
        await call('verify_chain', { project: PROJECT, process: PROCESS }),
      ];

      expect(results.filter((result) => result.isError === true)).toEqual([]);
    } finally {
      await client.close();
    }

    const records = stderrRecords(stderr());
    expect(transportErrors).toEqual([]);
    expect(stderr()).not.toContain('"code":"INTERNAL"');
    for (const record of records) {
      expect(['debug', 'info', 'warn', 'error']).toContain(record.level);
      expect(typeof record.event).toBe('string');
    }
    expect(records).toContainEqual(
      expect.objectContaining({
        event: 'start',
        dataDir: path.join(xdg, 'hexlog'),
        version: VERSION,
      }),
    );
    expect(records.filter(({ event }) => event === 'tool').length).toBeGreaterThanOrEqual(9);
  }, 20_000);
});
