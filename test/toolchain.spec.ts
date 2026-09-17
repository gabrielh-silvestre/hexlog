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
import { dirDados } from '../src/directory.ts';
import { parseJson } from './helpers.ts';

const raizDoRepo = path.resolve(__dirname, '..');
const REGEX_UUID_V7 = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

// Forma esperada de test/fixtures/child-probe.ts, campos usados abaixo.
const SaidaFilhoProbeSchema = z.object({
  uuidV7Valido: z.boolean(),
  mcpServerCarregado: z.boolean(),
  stdioServerTransportCarregado: z.boolean(),
});

// Forma mínima de um envelope JSON-RPC 2.0 recebido do servidor bundlado.
const EnvelopeJsonRpcSchema = z.object({ jsonrpc: z.string() });

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
      properties: { nome: { type: 'string' } },
      required: ['nome'],
    });
    expect(schema.safeParse({ nome: 'a' }).success).toBe(true);
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
    const indice = new MiniSearch<{ id: number; texto: string }>({
      fields: ['texto'],
      processTerm: (termo) => termo.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase(),
    });
    indice.addAll([
      { id: 1, texto: 'evento marco aprovado' },
      { id: 2, texto: 'evento veredito reprovado' },
      { id: 3, texto: 'evento comum' },
    ]);
    expect(indice.search('márco').map((resultado) => resultado.id as number)).toEqual([1]);
  });

  test('path.matchesGlob casa padrão simples', () => {
    expect(matchesGlob('a/b.ts', 'a/*.ts')).toBe(true);
  });

  test('McpServer + Client + InMemoryTransport do mesmo pacote (@modelcontextprotocol/server)', async () => {
    const [transporteServidor, transporteCliente] = InMemoryTransport.createLinkedPair();
    const servidor = new McpServer({ name: 'probe', version: '0.0.0' });
    servidor.registerTool(
      'eco',
      { description: 'eco', inputSchema: { texto: z.string() } },
      ({ texto }) => Promise.resolve({ content: [{ type: 'text', text: texto }] }),
    );
    const cliente = new Client({ name: 'probe-cliente', version: '0.0.0' });

    await Promise.all([servidor.connect(transporteServidor), cliente.connect(transporteCliente)]);
    const resultado = await cliente.callTool({ name: 'eco', arguments: { texto: 'oi' } });
    expect(resultado.content).toEqual([{ type: 'text', text: 'oi' }]);
    await cliente.close();
  });

  test('módulo local importado com extensão .ts resolve (src/directory.ts)', () => {
    expect(dirDados({})).toMatch(/[/\\]hexlog$/);
  });
});

describe('probe no Node ESM real (sub-passo 6, filho-probe)', () => {
  test('spawn de child-probe.ts imprime só JSON no stdout, sem warnings no stderr', () => {
    const resultado = spawnSync(
      process.execPath,
      [path.join(raizDoRepo, 'test/fixtures/child-probe.ts')],
      {
        encoding: 'utf8',
      },
    );

    expect(resultado.status).toBe(0);
    expect(resultado.stderr).toBe('');

    const saida = parseJson(SaidaFilhoProbeSchema, resultado.stdout);
    expect(saida.uuidV7Valido).toBe(true);
    expect(saida.mcpServerCarregado).toBe(true);
    expect(saida.stdioServerTransportCarregado).toBe(true);
  });
});

describe('probe de build com esbuild (sub-passo 6b, U-7)', () => {
  let outdir: string;

  beforeAll(() => {
    // mkdtemp fora do repo: garante que o bundle não alcança node_modules
    // por um caminho relativo acidental.
    outdir = fs.mkdtempSync(path.join(os.tmpdir(), 'hexlog-build-probe-'));
    const resultado = spawnSync(
      process.execPath,
      [path.join(raizDoRepo, 'test/fixtures/build-fixtures.ts'), outdir],
      { encoding: 'utf8', cwd: raizDoRepo },
    );
    if (resultado.status !== 0) {
      throw new Error(`build de probe falhou: ${resultado.stderr}`);
    }
  });

  afterAll(() => {
    fs.rmSync(outdir, { recursive: true, force: true });
  });

  test('nenhum dos dois bundles contém o shim "Dynamic require of"', () => {
    for (const arquivo of ['servidor-probe.mjs', 'hook-probe.mjs']) {
      const bytes = fs.readFileSync(path.join(outdir, arquivo));
      expect(bytes.includes('Dynamic require of')).toBe(false);
    }
  });

  test('servidor-probe.mjs fala só JSON-RPC 2.0 no stdout, sem Dynamic require no stderr', async () => {
    const { linhas, stderr } = await falarComServidor(path.join(outdir, 'servidor-probe.mjs'));

    expect(linhas.length).toBe(3);
    for (const linha of linhas) {
      expect(parseJson(EnvelopeJsonRpcSchema, linha).jsonrpc).toBe('2.0');
    }
    expect(stderr).not.toContain('Dynamic require');
  }, 15000);

  test('hook-probe.mjs sai com o código esperado conforme o comando recebido', () => {
    const reconhecido = spawnSync(
      process.execPath,
      [path.join(outdir, 'hook-probe.mjs'), 'echo hi'],
      {
        encoding: 'utf8',
      },
    );
    expect(reconhecido.status).toBe(0);

    const semComando = spawnSync(process.execPath, [path.join(outdir, 'hook-probe.mjs'), ''], {
      encoding: 'utf8',
    });
    expect(semComando.status).toBe(1);
  });
});

/** Conversa em JSON-RPC 2.0 bruto (initialize, tools/list, tools/call) por stdin/stdout. */
async function falarComServidor(
  caminhoDoBundle: string,
): Promise<{ linhas: string[]; stderr: string }> {
  const filho = spawn(process.execPath, [caminhoDoBundle], { stdio: ['pipe', 'pipe', 'pipe'] });
  const saida = { texto: '' };
  let stderrTexto = '';
  filho.stdout.on('data', (chunk: Buffer) => {
    saida.texto += chunk.toString();
  });
  filho.stderr.on('data', (chunk: Buffer) => {
    stderrTexto += chunk.toString();
  });

  const enviar = (mensagem: unknown) => filho.stdin.write(`${JSON.stringify(mensagem)}\n`);
  const linhasRecebidas = () => saida.texto.split('\n').filter((linha) => !isEmpty(linha));
  const aguardarLinhas = (quantidade: number) =>
    new Promise<void>((resolve) => {
      const verificar = () => {
        if (linhasRecebidas().length >= quantidade) resolve();
        else setTimeout(verificar, 20);
      };
      verificar();
    });

  enviar({
    jsonrpc: '2.0',
    id: 1,
    method: 'initialize',
    params: {
      protocolVersion: '2025-06-18',
      capabilities: {},
      clientInfo: { name: 'probe', version: '0.0.0' },
    },
  });
  await aguardarLinhas(1);

  enviar({ jsonrpc: '2.0', method: 'notifications/initialized' });
  enviar({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} });
  await aguardarLinhas(2);

  enviar({
    jsonrpc: '2.0',
    id: 3,
    method: 'tools/call',
    params: { name: 'eco', arguments: { texto: 'oi' } },
  });
  await aguardarLinhas(3);

  filho.kill();
  return { linhas: linhasRecebidas(), stderr: stderrTexto };
}
