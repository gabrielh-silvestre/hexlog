import * as fs from 'node:fs';
import * as path from 'node:path';
import { expect } from '@jest/globals';
import { Client } from '@modelcontextprotocol/client';
import { CLIENT_INFO_META_KEY, InMemoryTransport } from '@modelcontextprotocol/server';
import type { RegisterResult } from '../../src/commands/process.ts';
import { compose } from '../../src/compose.ts';
import { BATCH_MAX } from '../../src/domain/record.ts';
import type { Detail, ErrorCode } from '../../src/errors.ts';
import { createServer } from '../../src/mcp/server.ts';
import type { LogRecord } from '../../src/shared/logger.ts';
import { createTempDir } from '../helpers.ts';

export const PROJECT = 'alpha';

/** Esquema do tipo `note`, o único que os specs de tool registram. */
export const NOTE_SCHEMA = {
  type: 'object',
  properties: { text: { type: 'string' } },
  required: ['text'],
  additionalProperties: false,
};

/** As 12 tools do catálogo; tipar por `ToolName` obriga o spec com uma entrada por tool a cobrir todas. */
export const TOOL_NAMES = [
  'create_process',
  'register',
  'attach',
  'define_type',
  'define_relation',
  'define_gate',
  'query',
  'evaluate_gate',
  'verify_chain',
  'read_attachment',
  'list',
  'describe_type',
] as const;

export type ToolName = (typeof TOOL_NAMES)[number];

/** Relógio fixo do servidor sob teste e dos serviços de referência de `servicesOver`. */
const FIXED_NOW = new Date('2026-01-01T00:00:00.000Z');

/** Identidade que o cliente declara no envelope por requisição. */
type ClientInfo = { name: string; version: string };

type ErrorBody = { code: ErrorCode; message: string; details: Detail[] };

/** Resultado cru de `tools/call`: `structuredContent` é o corpo de sucesso; o erro vem em `content[0].text`. */
type CallResult = {
  isError?: boolean;
  structuredContent?: unknown;
  content?: { type: string; text?: string }[];
};

/**
 * Corpo `{ code, message, details }` de um resultado com `isError`. Trava a forma: erro nunca leva
 * `structuredContent`, que descreveria o erro como saída do `outputSchema` de sucesso; o
 * `validateToolOutput` do SDK 2.x (conferido na 2.3.1) já retorna cedo com `isError`, e o teste
 * guarda a invariante.
 */
export function errorBodyOf(result: CallResult): ErrorBody {
  expect(result.isError).toBe(true);
  expect(result).not.toHaveProperty('structuredContent');
  return JSON.parse(result.content?.[0]?.text ?? '') as ErrorBody;
}

/** Afirma que `result` é um erro de domínio com o `code` esperado e devolve o corpo. */
export function expectError(result: CallResult, code: ErrorCode): ErrorBody {
  const body = errorBodyOf(result);
  expect(body.code).toBe(code);
  return body;
}

export type Environment = {
  /** `<D>`: a área de dados do servidor sob teste. */
  dataDir: string;
  client: Client;
  call: (name: string, args?: Record<string, unknown>) => Promise<CallResult>;
  /** Chama a tool, afirma sucesso e devolve o `structuredContent` tipado. */
  ok: <T>(name: string, args?: Record<string, unknown>) => Promise<T>;
  /** Chama a tool, afirma erro de domínio (com `code`, esse código) e devolve o corpo `{ code, message, details }` de `content[0].text`. */
  fail: (name: string, args?: Record<string, unknown>, code?: ErrorCode) => Promise<ErrorBody>;
  /** Cria em `<D>` uma entrada de nome minúsculo, o que a detecção do dado 0.x enxerga. */
  seedLegacy: (name?: string) => void;
  close: () => Promise<void>;
};

type EnvironmentOptions = {
  /** Raiz do `path` do `attach`; sem ela vale o `cwd` do processo de teste. */
  cwd?: string;
  /** Sem ela as chamadas vão sem envelope de cliente (o servidor grava `unknown`). */
  clientInfo?: ClientInfo;
};

/**
 * Servidor `hexlog` 1.0 sobre o `compose.ts` real (adaptadores de disco em `createTempDir`, relógio
 * fixo, `isLegacy` real), ligado a um `Client` MCP por transporte em memória. O índice de busca
 * é o que o próprio `compose` cria.
 */
export async function createEnvironment(options: EnvironmentOptions = {}): Promise<Environment> {
  const dataDir = createTempDir('mcp');
  const logs: LogRecord[] = [];

  const { services, isLegacy } = compose({
    dataDir,
    cwd: options.cwd ?? process.cwd(),
    clock: () => FIXED_NOW,
    logger: (record) => void logs.push(record),
  });
  const server = createServer({ services, isLegacy, logger: (record) => void logs.push(record) });
  const [serverTransport, clientTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'hexlog-test', version: '0.0.0' });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);

  // O envelope vai por `_meta` em cada chamada: o transporte em memória fica na era 2025, sem envelope automático.
  const _meta = options.clientInfo && { [CLIENT_INFO_META_KEY]: options.clientInfo };

  async function call(name: string, args: Record<string, unknown> = {}): Promise<CallResult> {
    const logged = logs.length;
    const result = (await client.callTool({ name, arguments: args, _meta })) as CallResult;
    // Erro de forma de saída só nasce de bug no handler; nenhuma chamada da suíte pode devolvê-lo.
    for (const item of result.content ?? []) {
      expect(item.text?.startsWith('Output validation error')).not.toBe(true);
    }
    // Resposta acima do dobro de `PAGE_CHARS_CAP` é bug de teto na tool; nenhuma chamada da suíte pode causá-la.
    expect(logs.slice(logged).filter(({ event }) => event === 'tool-over-cap')).toEqual([]);
    return result;
  }

  return {
    dataDir,
    client,
    call,
    ok: async <T>(name: string, args?: Record<string, unknown>) => {
      const result = await call(name, args);
      expect(result.isError).not.toBe(true);
      return result.structuredContent as T;
    },
    fail: async (name, args, code) => {
      const result = await call(name, args);
      return code ? expectError(result, code) : errorBodyOf(result);
    },
    seedLegacy: (name = 'legacy-project') => {
      fs.mkdirSync(path.join(dataDir, name), { recursive: true });
    },
    close: async () => {
      await client.close();
      fs.rmSync(dataDir, { recursive: true, force: true });
    },
  };
}

/**
 * Serviços reais sobre o `<D>` do servidor sob teste, com o relógio dele e o `cwd` do processo de
 * teste (o padrão de `createEnvironment`): a referência com que o spec compara a resposta da tool.
 */
export const servicesOver = (environment: Environment) =>
  compose({
    dataDir: environment.dataDir,
    cwd: process.cwd(),
    clock: () => FIXED_NOW,
    logger: () => undefined,
  }).services;

type NoteInput = { process: string; target?: string; text?: string; relations?: object[] };

/** Registra uma nota em `process` (`target` e `text` com padrão) e devolve o resultado do `register`. */
export const registerNote = (
  environment: Environment,
  { process, target = 'run.step', text = 'x', relations }: NoteInput,
) =>
  environment.ok<RegisterResult>('register', {
    project: PROJECT,
    process,
    agent: 'executor',
    records: [{ type: 'note', target, data: { text }, relations }],
  });

/** Registra `count` notas iguais em lotes de `BATCH_MAX` e devolve os ids, na ordem gravada. */
export async function registerBulk(
  environment: Environment,
  count: number,
  { process, target = 'run.step', text = 'x', relations }: NoteInput,
): Promise<string[]> {
  const ids: string[] = [];
  for (let done = 0; done < count; done += BATCH_MAX) {
    const { records } = await environment.ok<RegisterResult>('register', {
      project: PROJECT,
      process,
      agent: 'executor',
      records: Array.from({ length: Math.min(BATCH_MAX, count - done) }, () => ({
        type: 'note',
        target,
        data: { text },
        relations,
      })),
    });
    ids.push(...records.map(({ id }) => id));
  }
  return ids;
}

/** Objeto com `levels` níveis de aninhamento, contando a raiz dos args crus como o nível 1. */
export const nest = (levels: number): Record<string, unknown> =>
  Array.from({ length: levels - 1 }).reduce<Record<string, unknown>>((inner) => ({ a: inner }), {});
