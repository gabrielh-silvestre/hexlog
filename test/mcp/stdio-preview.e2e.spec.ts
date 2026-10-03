// e2e da prévia da F5: fala stdio contra o bundle da `test/fixtures/preview-server.ts`, construído
// pelo mesmo `scripts/build.ts#build` dos bundles reais (P8), nunca contra `src/*.ts`.
import { afterAll, beforeAll, describe, expect, test } from '@jest/globals';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { isUndefined, omitBy } from 'es-toolkit';
import { createTempDir } from '../helpers.ts';

const repoRoot = path.resolve(__dirname, '..', '..');
const PROJECT = 'preview';
const PROCESS = 'run-1';

const TOOLS = [
  'attach',
  'create_process',
  'define_gate',
  'define_relation',
  'define_type',
  'evaluate_gate',
  'list',
  'query',
  'read_attachment',
  'register',
  'verify_chain',
];
const READ_ONLY = ['evaluate_gate', 'list', 'query', 'read_attachment', 'verify_chain'];

let bundleDir: string;

beforeAll(() => {
  bundleDir = createTempDir('preview-bundle');
  const result = spawnSync(
    process.execPath,
    [
      path.join(repoRoot, 'test/fixtures/build-entry.ts'),
      bundleDir,
      'server=test/fixtures/preview-server.ts',
    ],
    { cwd: repoRoot, encoding: 'utf8' },
  );
  if (result.status !== 0) throw new Error(`preview build failed: ${result.stderr}`);
}, 30_000);

afterAll(() => {
  fs.rmSync(bundleDir, { recursive: true, force: true });
});

/** Cliente stdio sobre o bundle, com `XDG_DATA_HOME` temporário: o `<D>` real nunca é tocado. */
async function connect(xdg: string) {
  const env = {
    ...(omitBy(process.env, isUndefined) as Record<string, string>),
    HOME: createTempDir('preview-home'),
    XDG_DATA_HOME: xdg,
  };
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [path.join(bundleDir, 'server.mjs')],
    env,
    cwd: bundleDir,
    stderr: 'pipe',
  });
  let stderr = '';
  transport.stderr?.on('data', (chunk: Buffer) => {
    stderr += chunk.toString();
  });
  const client = new Client({ name: 'hexlog-e2e', version: '0.0.0' });
  await client.connect(transport);
  const call = async (name: string, args: Record<string, unknown> = {}) =>
    (await client.callTool({ name, arguments: args })) as {
      isError?: boolean;
      structuredContent?: Record<string, unknown>;
    };
  return { client, call, stderr: () => stderr };
}

describe('P8 e TM1: bundle da prévia por stdio', () => {
  test('o bundle não contém o shim "Dynamic require of"', () => {
    expect(fs.readFileSync(path.join(bundleDir, 'server.mjs'), 'utf8')).not.toContain(
      'Dynamic require of',
    );
  });

  test('tools/list devolve as 11 tools, readOnlyHint nas de leitura e alwaysLoad no register', async () => {
    const { client, stderr } = await connect(createTempDir('preview-xdg'));
    try {
      const { tools } = await client.listTools();

      expect(tools.map((tool) => tool.name).sort()).toEqual(TOOLS);
      expect(
        tools.filter((tool) => tool.annotations?.readOnlyHint === true).map((tool) => tool.name),
      ).toEqual(expect.arrayContaining(READ_ONLY));
      expect(tools.find((tool) => tool.name === 'register')?._meta).toMatchObject({
        'anthropic/alwaysLoad': true,
      });
    } finally {
      await client.close();
    }
    expect(stderr()).not.toContain('Dynamic require of');
  }, 20_000);

  test('um register e uma query ponta a ponta, e entrada fora do schema dá INVALID_INPUT', async () => {
    const { client, call, stderr } = await connect(createTempDir('preview-xdg'));
    try {
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
        records: [{ type: 'note', target: 'run.step', data: { text: 'ola' } }],
      });
      const queried = await call('query', { project: PROJECT, process: PROCESS });
      const invalid = await call('query', { project: PROJECT, process: PROCESS, limit: 0 });

      expect(registered.isError).not.toBe(true);
      expect(queried.structuredContent).toMatchObject({
        records: [{ type: 'note', target: 'run.step' }],
      });
      expect(invalid.isError).toBe(true);
      expect(invalid.structuredContent).toMatchObject({
        code: 'INVALID_INPUT',
        details: [{ path: '/limit' }],
      });
    } finally {
      await client.close();
    }
    expect(stderr()).not.toContain('"code":"INTERNAL"');
    expect(stderr()).not.toContain('Dynamic require of');
  }, 20_000);

  test('<D> com dado 0.x responde LEGACY_DATA com o comando em details', async () => {
    const xdg = createTempDir('preview-xdg');
    fs.mkdirSync(path.join(xdg, 'hexlog', 'old-project'), { recursive: true });
    const { client, call } = await connect(xdg);
    try {
      const refused = await call('list');

      expect(refused.isError).toBe(true);
      expect(refused.structuredContent).toMatchObject({
        code: 'LEGACY_DATA',
        details: [{ code: 'run' }],
      });
    } finally {
      await client.close();
    }
  }, 20_000);
});
