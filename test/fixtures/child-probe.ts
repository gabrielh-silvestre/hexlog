// Probe de import real sob Node ESM (type stripping), fora do transform do jest.
// Importa todas as deps de runtime do manifesto (§2.2) e exercita uma amostra
// de cada uma. Só imprime JSON no stdout; qualquer warning apareceria no stderr.
import { McpServer } from '@modelcontextprotocol/server';
import { StdioServerTransport } from '@modelcontextprotocol/server/stdio';
import { z } from 'zod';
import Ajv2020 from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';
import * as jsonc from 'jsonc-parser';
import { quote } from 'shell-quote';
import canonicalize from 'canonicalize';
import { pick } from 'es-toolkit';
import { get } from 'es-toolkit/compat';
import MiniSearch from 'minisearch';
import { randomUUIDv7 } from 'node:crypto';
import { matchesGlob } from 'node:path';

const ajv = new Ajv2020.default({ strict: true });
addFormats.default(ajv);

const uuid = randomUUIDv7();
const uuidV7Valid = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
  uuid,
);

const index = new MiniSearch({ fields: ['text'] });
index.addAll([
  { id: 1, text: 'approved milestone event' },
  { id: 2, text: 'rejected verdict event' },
  { id: 3, text: 'registered common event' },
]);

const output = {
  ajvSchemaValid: ajv.validateSchema({ type: 'object' }),
  uuid,
  uuidV7Valid,
  globOk: matchesGlob('a/b.ts', 'a/*.ts'),
  minisearchResults: index.search('milestone').map((result) => result.id as number),
  pick: pick({ a: 1, b: 2, c: 3 }, ['a', 'c']),
  get: get({ a: { b: 42 } }, 'a.b'),
  canon: canonicalize({ b: 1, a: 2 }),
  jsonc: jsonc.parse('{"a":1} // comment') as { a: number },
  shellQuote: quote(['echo', 'a b']),
  zodOk: z.string().safeParse('ok').success,
  mcpServerLoaded: typeof McpServer === 'function',
  stdioServerTransportLoaded: typeof StdioServerTransport === 'function',
};

console.log(JSON.stringify(output));
