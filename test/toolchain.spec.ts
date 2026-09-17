import { describe, test, expect, beforeAll, afterAll } from '@jest/globals';
import { spawn, spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { matchesGlob } from 'node:path';
import { randomUUIDv7 } from 'node:crypto';
import { z } from 'zod';
import Ajv2020 from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';
import * as jsonc from 'jsonc-parser';
import { quote } from 'shell-quote';
import canonicalize from 'canonicalize';
import { pick } from 'es-toolkit';
import { get, isEmpty } from 'es-toolkit/compat';
import MiniSearch from 'minisearch';
import { McpServer, InMemoryTransport } from '@modelcontextprotocol/server';
import { Client } from '@modelcontextprotocol/client';
import { dataDir } from '../src/directory.ts';
import { parseJson } from './helpers.ts';

const repoRoot = path.resolve(__dirname, '..');
const REGEX_UUID_V7 = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

// Forma esperada de test/fixtures/child-probe.ts, campos usados abaixo.
const ChildProbeOutputSchema = z.object({
  uuidV7Valid: z.boolean(),
  mcpServerLoaded: z.boolean(),
  stdioServerTransportLoaded: z.boolean(),
});

// Forma mínima de um envelope JSON-RPC 2.0 recebido do servidor bundlado.
const JsonRpcEnvelopeSchema = z.object({ jsonrpc: z.string() });

describe('probe de dependências no jest (sub-passo 5)', () => {
  test('canonicalize produz JSON canônico (RFC 8785)', () => {
    expect(canonicalize({ b: 1, a: 2 })).toBe('{"a":2,"b":1}');
  });

  test('randomUUIDv7 de node:crypto gera uuid v7 válido', () => {
    expect(randomUUIDv7()).toMatch(REGEX_UUID_V7);
  });

  test('z.fromJSONSchema converte schema JSON em schema zod', () => {
    const schema = z.fromJSONSchema({
      type: 'object',
      properties: { name: { type: 'string' } },
      required: ['name'],
    });
    expect(schema.safeParse({ name: 'a' }).success).toBe(true);
    expect(schema.safeParse({}).success).toBe(false);
  });

  test('Ajv2020 (ajv/dist/2020.js) valida schema com ajv-formats registrado', () => {
    const ajv = new Ajv2020.default({ strict: true });
    addFormats.default(ajv);
    expect(ajv.validateSchema({ type: 'object' })).toBe(true);
  });

  test('shell-quote tokeniza e quota comandos', () => {
    expect(quote(['echo', 'a b'])).toBe("echo 'a b'");
  });

  test('jsonc-parser lê JSON com comentários', () => {
    expect(jsonc.parse('{"a":1} // comentário')).toEqual({ a: 1 });
  });

  test('es-toolkit (core) pick e es-toolkit/compat get', () => {
    expect(pick({ a: 1, b: 2, c: 3 }, ['a', 'c'])).toEqual({ a: 1, c: 3 });
    expect(get({ a: { b: 42 } }, 'a.b')).toBe(42);
  });

  test('minisearch busca com acento normalizado via processTerm', () => {
    const index = new MiniSearch<{ id: number; text: string }>({
      fields: ['text'],
      processTerm: (term) => term.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase(),
    });
    index.addAll([
      { id: 1, text: 'cafe order approved' },
      { id: 2, text: 'tea order rejected' },
      { id: 3, text: 'plain event' },
    ]);
    expect(index.search('café').map((result) => result.id as number)).toEqual([1]);
  });

  test('path.matchesGlob casa padrão simples', () => {
    expect(matchesGlob('a/b.ts', 'a/*.ts')).toBe(true);
  });

  test('McpServer + Client + InMemoryTransport do mesmo pacote (@modelcontextprotocol/server)', async () => {
    const [serverTransport, clientTransport] = InMemoryTransport.createLinkedPair();
    const server = new McpServer({ name: 'probe', version: '0.0.0' });
    server.registerTool(
      'echo',
      { description: 'echo', inputSchema: { text: z.string() } },
      ({ text }) => Promise.resolve({ content: [{ type: 'text', text }] }),
    );
    const client = new Client({ name: 'probe-client', version: '0.0.0' });

    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
    const result = await client.callTool({ name: 'echo', arguments: { text: 'oi' } });
    expect(result.content).toEqual([{ type: 'text', text: 'oi' }]);
    await client.close();
  });

  test('módulo local importado com extensão .ts resolve (src/directory.ts)', () => {
    expect(dataDir({})).toMatch(/[/\\]hexlog$/);
  });
});

describe('probe no Node ESM real (sub-passo 6, filho-probe)', () => {
  test('spawn de child-probe.ts imprime só JSON no stdout, sem warnings no stderr', () => {
    const result = spawnSync(
      process.execPath,
      [path.join(repoRoot, 'test/fixtures/child-probe.ts')],
      {
        encoding: 'utf8',
      },
    );

    expect(result.status).toBe(0);
    expect(result.stderr).toBe('');

    const output = parseJson(ChildProbeOutputSchema, result.stdout);
    expect(output.uuidV7Valid).toBe(true);
    expect(output.mcpServerLoaded).toBe(true);
    expect(output.stdioServerTransportLoaded).toBe(true);
  });
});

describe('probe de build com esbuild (sub-passo 6b, U-7)', () => {
  let outdir: string;

  beforeAll(() => {
    // mkdtemp fora do repo: garante que o bundle não alcança node_modules
    // por um caminho relativo acidental.
    outdir = fs.mkdtempSync(path.join(os.tmpdir(), 'hexlog-build-probe-'));
    const result = spawnSync(
      process.execPath,
      [path.join(repoRoot, 'test/fixtures/build-fixtures.ts'), outdir],
      { encoding: 'utf8', cwd: repoRoot },
    );
    if (result.status !== 0) {
      throw new Error(`build de probe falhou: ${result.stderr}`);
    }
  });

  afterAll(() => {
    fs.rmSync(outdir, { recursive: true, force: true });
  });

  test('nenhum dos dois bundles contém o shim "Dynamic require of"', () => {
    for (const file of ['server-probe.mjs', 'hook-probe.mjs']) {
      const bytes = fs.readFileSync(path.join(outdir, file));
      expect(bytes.includes('Dynamic require of')).toBe(false);
    }
  });

  test('server-probe.mjs fala só JSON-RPC 2.0 no stdout, sem Dynamic require no stderr', async () => {
    const { lines, stderr } = await talkToServer(path.join(outdir, 'server-probe.mjs'));

    expect(lines.length).toBe(3);
    for (const line of lines) {
      expect(parseJson(JsonRpcEnvelopeSchema, line).jsonrpc).toBe('2.0');
    }
    expect(stderr).not.toContain('Dynamic require');
  }, 15000);

  test('hook-probe.mjs sai com o código esperado conforme o comando recebido', () => {
    const recognized = spawnSync(
      process.execPath,
      [path.join(outdir, 'hook-probe.mjs'), 'echo hi'],
      {
        encoding: 'utf8',
      },
    );
    expect(recognized.status).toBe(0);

    const noCommand = spawnSync(process.execPath, [path.join(outdir, 'hook-probe.mjs'), ''], {
      encoding: 'utf8',
    });
    expect(noCommand.status).toBe(1);
  });
});

/** Conversa em JSON-RPC 2.0 bruto (initialize, tools/list, tools/call) por stdin/stdout. */
async function talkToServer(bundlePath: string): Promise<{ lines: string[]; stderr: string }> {
  const child = spawn(process.execPath, [bundlePath], { stdio: ['pipe', 'pipe', 'pipe'] });
  const output = { text: '' };
  let stderrText = '';
  child.stdout.on('data', (chunk: Buffer) => {
    output.text += chunk.toString();
  });
  child.stderr.on('data', (chunk: Buffer) => {
    stderrText += chunk.toString();
  });

  const send = (message: unknown) => child.stdin.write(`${JSON.stringify(message)}\n`);
  const receivedLines = () => output.text.split('\n').filter((line) => !isEmpty(line));
  const waitForLines = (count: number) =>
    new Promise<void>((resolve) => {
      const check = () => {
        if (receivedLines().length >= count) resolve();
        else setTimeout(check, 20);
      };
      check();
    });

  send({
    jsonrpc: '2.0',
    id: 1,
    method: 'initialize',
    params: {
      protocolVersion: '2025-06-18',
      capabilities: {},
      clientInfo: { name: 'probe', version: '0.0.0' },
    },
  });
  await waitForLines(1);

  send({ jsonrpc: '2.0', method: 'notifications/initialized' });
  send({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} });
  await waitForLines(2);

  send({
    jsonrpc: '2.0',
    id: 3,
    method: 'tools/call',
    params: { name: 'echo', arguments: { text: 'oi' } },
  });
  await waitForLines(3);

  child.kill();
  return { lines: receivedLines(), stderr: stderrText };
}
