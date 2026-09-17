import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { expect } from '@jest/globals';
import { Client } from '@modelcontextprotocol/client';
import { InMemoryTransport } from '@modelcontextprotocol/server';
import { parse as parseRawJson } from 'jsonc-parser';
import { z } from 'zod';
import type { ErrorCode, Detail } from '../src/errors.ts';
import type { Logger, LogRecord } from '../src/log.ts';
import { createServer } from '../src/mcp.ts';

/** Environment de teste: servidor `hexlog` real ligado a um `Client` MCP via transporte em memória. */
export type Environment = {
  dir: string;
  client: Client;
  records: LogRecord[];
  call: (name: string, args?: Record<string, unknown>) => Promise<CallResult>;
  tree: (root?: string) => string[];
  setClock: (date: Date) => void;
  close: () => Promise<void>;
};

type CallResult = {
  isError?: boolean;
  structuredContent?: unknown;
  content?: { type: string; text?: string }[];
};

/** Lista recursivamente os caminhos relativos a `root`, em ordem estável, para comparar árvores de diretório (M2). */
function tree(root: string): string[] {
  if (!fs.existsSync(root)) return [];
  return fs
    .readdirSync(root, { withFileTypes: true })
    .flatMap((entry) => {
      const entryPath = path.join(root, entry.name);
      const relativePath = path.relative(root, entryPath);
      return entry.isDirectory()
        ? [relativePath, ...tree(entryPath).map((f) => path.join(relativePath, f))]
        : [relativePath];
    })
    .sort();
}

/** Cria um `dir` de dados temporário, um servidor `hexlog` real e um `Client` MCP conectados em memória. */
export async function createEnvironment(): Promise<Environment> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hexlog-'));
  const records: LogRecord[] = [];
  const log: Logger = (record) => {
    records.push(record);
  };
  let now = new Date('2026-01-01T00:00:00.000Z');

  const [serverTransport, clientTransport] = InMemoryTransport.createLinkedPair();
  const server = createServer({ dataDir: dir, clock: () => now, log });
  const client = new Client({ name: 'hexlog-test', version: '0.0.0' });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);

  async function call(name: string, args: Record<string, unknown> = {}): Promise<CallResult> {
    const result = (await client.callTool({ name, arguments: args })) as CallResult;
    // M7: nenhuma chamada, em toda a suíte, pode devolver um erro de forma de saída — só bug no handler produziria isso.
    for (const item of result.content ?? []) {
      if (item.type === 'text' && item.text !== undefined) {
        expect(item.text.startsWith('Output validation error')).toBe(false);
      }
    }
    return result;
  }

  return {
    dir,
    client,
    records,
    call,
    tree: (root = dir) => tree(root),
    setClock: (date: Date) => {
      now = date;
    },
    close: async () => {
      await client.close();
      fs.rmSync(dir, { recursive: true, force: true });
    },
  };
}

/** Vocabulário núcleo mínimo (`approved`/`ok`/`follow`), base de quase todo processo de teste. */
export async function registerCore(environment: Environment, project: string): Promise<void> {
  await environment.call('register_vocabulary', {
    project,
    owner: 'core',
    milestoneType: ['approved'],
    result: ['ok'],
    action: ['follow'],
  });
}

/** Parseia `text` (JSON ou JSONC) e valida o formato com `schema`, lançando erro claro se não bater. */
export function parseJson<T extends z.ZodType>(schema: T, text: string): z.infer<T> {
  const result = schema.safeParse(parseRawJson(text));
  if (!result.success) {
    throw new Error(`JSON does not match the expected schema:\n${z.prettifyError(result.error)}`);
  }
  return result.data;
}

/** Afirma que `result` é um erro de domínio (§4.13) com o `code` esperado, e devolve o corpo estruturado. */
export function expectError(
  result: CallResult,
  code: ErrorCode,
): { code: ErrorCode; message: string; details: Detail[] } {
  expect(result.isError).toBe(true);
  const body = result.structuredContent as {
    code: ErrorCode;
    message: string;
    details: Detail[];
  };
  expect(body.code).toBe(code);
  return body;
}
