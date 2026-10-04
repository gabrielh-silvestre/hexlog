import * as fs from 'node:fs';
import * as path from 'node:path';
import { expect } from '@jest/globals';
import { Client } from '@modelcontextprotocol/client';
import { CLIENT_INFO_META_KEY, InMemoryTransport } from '@modelcontextprotocol/server';
import { compose } from '../../src/compose.ts';
import type { Detail, ErrorCode } from '../../src/errors.ts';
import { createServer } from '../../src/mcp/server.ts';
import type { LogRecord } from '../../src/shared/logger.ts';
import { createTempDir } from '../helpers.ts';

/** Identidade que o cliente declara no envelope por requisição (TM6). */
export type ClientInfo = { name: string; version: string };

export type ErrorBody = { code: ErrorCode; message: string; details: Detail[] };

/** Resultado cru de `tools/call`: `structuredContent` é o corpo de sucesso; o erro vem em `content[0].text`. */
export type CallResult = {
  isError?: boolean;
  structuredContent?: unknown;
  content?: { type: string; text?: string }[];
};

/**
 * Corpo `{ code, message, details }` de um resultado com `isError`. Trava a forma: erro nunca leva
 * `structuredContent`, que o SDK 1.x validaria contra o `outputSchema` de sucesso (`-32602`).
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
  /** Registros que o servidor mandou ao logger, na ordem. */
  logs: LogRecord[];
  call: (name: string, args?: Record<string, unknown>) => Promise<CallResult>;
  /** Chama a tool, afirma sucesso e devolve o `structuredContent` tipado. */
  ok: <T>(name: string, args?: Record<string, unknown>) => Promise<T>;
  /** Chama a tool, afirma erro de domínio e devolve o corpo `{ code, message, details }` de `content[0].text`. */
  fail: (name: string, args?: Record<string, unknown>) => Promise<ErrorBody>;
  /** Cria em `<D>` uma entrada de nome minúsculo, o que a detecção do dado 0.x enxerga (D-13). */
  seedLegacy: (name?: string) => void;
  setClock: (date: Date) => void;
  close: () => Promise<void>;
};

export type EnvironmentOptions = {
  /** Raiz do `path` do `attach`; sem ela vale o `cwd` do processo de teste. */
  cwd?: string;
  /** Sem ela as chamadas vão sem envelope de cliente (o servidor grava `unknown`). */
  clientInfo?: ClientInfo;
};

/**
 * Servidor `hexlog` 1.0 sobre o `compose.ts` real (adaptadores de disco em `createTempDir`, relógio
 * injetável, `isLegacy` real), ligado a um `Client` MCP por transporte em memória. O índice de busca
 * é o que o próprio `compose` cria.
 */
export async function createEnvironment(options: EnvironmentOptions = {}): Promise<Environment> {
  const dataDir = createTempDir('mcp');
  const logs: LogRecord[] = [];
  let now = new Date('2026-01-01T00:00:00.000Z');

  const { services, isLegacy } = compose({
    dataDir,
    cwd: options.cwd ?? process.cwd(),
    clock: () => now,
    logger: (record) => void logs.push(record),
  });
  const server = createServer({ services, isLegacy, logger: (record) => void logs.push(record) });
  const [serverTransport, clientTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'hexlog-test', version: '0.0.0' });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);

  // O envelope vai por `_meta` em cada chamada: o transporte em memória fica na era 2025, sem envelope automático.
  const _meta = options.clientInfo && { [CLIENT_INFO_META_KEY]: options.clientInfo };

  async function call(name: string, args: Record<string, unknown> = {}): Promise<CallResult> {
    const result = (await client.callTool({ name, arguments: args, _meta })) as CallResult;
    // Erro de forma de saída só nasce de bug no handler; nenhuma chamada da suíte pode devolvê-lo.
    for (const item of result.content ?? []) {
      expect(item.text?.startsWith('Output validation error')).not.toBe(true);
    }
    return result;
  }

  return {
    dataDir,
    client,
    logs,
    call,
    ok: async <T>(name: string, args?: Record<string, unknown>) => {
      const result = await call(name, args);
      expect(result.isError).not.toBe(true);
      return result.structuredContent as T;
    },
    fail: async (name, args) => {
      const result = await call(name, args);
      return errorBodyOf(result);
    },
    seedLegacy: (name = 'legacy-project') => {
      fs.mkdirSync(path.join(dataDir, name), { recursive: true });
    },
    setClock: (date) => {
      now = date;
    },
    close: async () => {
      await client.close();
      fs.rmSync(dataDir, { recursive: true, force: true });
    },
  };
}
