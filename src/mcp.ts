import { McpServer } from '@modelcontextprotocol/server';
import { isNil } from 'es-toolkit';
import { z } from 'zod';
import type { Logger as LoggerAjv } from './definitions.ts';
import { type Detail, HexlogError } from './errors.ts';
import { registerDefinitionTools } from './definition-tools.ts';
import { registerEventTools } from './event-tools.ts';
import { VocabSchema, VocabularySchema } from './state.ts';
import { Agent, Hash, Instant, Name } from './events.ts';
import type { Logger, LogRecord } from './log.ts';
import { VERSAO } from './version.ts';

/** Context compartilhado por todas as tools MCP do hexlog. */
export type Context = {
  dataDir: string;
  clock: () => Date;
  log: Logger;
};

/** Cria um logger de linha JSON para `output` (§4.15): nenhuma linha é filtrada, `debug` incluso. */
export function createStderrLogger(output: NodeJS.WritableStream = process.stderr): Logger {
  return (record: LogRecord) => {
    output.write(`${JSON.stringify({ ts: new Date().toISOString(), ...record })}\n`);
  };
}

/** Adapta o `Logger` de linha (§4.15) para a forma `{log, warn, error}` que o Ajv espera (`definitions.ts`). */
export function adaptAjvLogger(log: Logger): LoggerAjv {
  const emit =
    (level: 'debug' | 'warn' | 'error') =>
    (...args: unknown[]) => {
      log({ level, event: 'ajv', message: args.map(String).join(' ') });
    };
  return { log: emit('debug'), warn: emit('warn'), error: emit('error') };
}

// §4.16: tetos de saída, compartilhados pelas tools de eventos.
export const SECTION_ITEMS_CAP = 100;
export const PAGE_CHARS_CAP = 24_000;

// Esquemas comuns de §4.12, compartilhados pelas tools de definição e de eventos.
export const Warning = z.object({
  code: z.string(),
  message: z.string(),
  details: z.unknown().optional(),
});
// Reexportados de state.ts (fonte única do schema de vocabulário, DE-29).
export const Vocab = VocabSchema;
export const Vocabulary = VocabularySchema;
export const Ref = z.object({ id: z.string(), seq: z.number().int(), timestamp: Instant });
export const Break = z.object({
  index: z.number().int(),
  reason: z.enum(['invalid-line', 'diverging-seq', 'hash-mismatch', 'invalid-data']),
  detail: z.string().optional(),
});
export const ChainSchema = z.object({
  ok: z.boolean(),
  totalLines: z.number().int(),
  head: z.union([z.literal(''), Hash]),
  breaks: z.array(Break).max(100),
  totalBreaks: z.number().int(),
  repairedLines: z.array(z.number().int()).max(100),
});
export const Hashes = z.object({ schemas: Hash, vocabulary: Hash, gates: Hash });
export const Registered = z.object({
  project: Name,
  name: Name,
  hash: Hash,
  replaced: z.boolean(),
});
export const Section = z.enum([
  'active',
  'conflicts',
  'orphans',
  'toReview',
  'invalidReferences',
  'warnings',
  'chain',
]);

// Reexportadas por conveniência: os módulos de tools só precisam importar de `mcp.ts`.
export { Agent, Hash, Instant, Name };

/** Corpo de sucesso ou erro que uma tool devolve ao SDK (§4.13): nunca uma exceção. */
type ToolResult<T> =
  | { structuredContent: T; content: [{ type: 'text'; text: string }] }
  | {
      isError: true;
      structuredContent: { code: string; message: string; details: Detail[] };
      content: [{ type: 'text'; text: string }];
    };

/**
 * Roda `fn` dentro do envelope de erro de domínio (§4.13) e sempre devolve, nunca lança para o SDK.
 * `HexlogError` vira `{code, message, details}`; qualquer outra exceção vira `INTERNAL`, com stack
 * só no log `internal-error`. Emite sempre um log `tool` com `name`, `project`, `process`, `ms` e
 * `code?` (nunca o conteúdo de `data`). `extraLog`, quando informado, é lido depois de `fn()`
 * rodar e mesclado no log `tool` (§4.15: usado por `events` para `mode`/`candidates`/`indexMs`/
 * `combination`, sem alterar `structuredContent` nem os demais chamadores).
 */
export async function execute<T>(
  ctx: Context,
  name: string,
  args: { project?: string; process?: string },
  fn: () => T | Promise<T>,
  extraLog?: () => Record<string, unknown>,
): Promise<ToolResult<T>> {
  const start = Date.now();
  const logTool = (level: 'info' | 'error', code?: string) => {
    ctx.log({
      level,
      event: 'tool',
      name,
      project: args.project,
      process: args.process,
      ms: Date.now() - start,
      ...(isNil(code) ? {} : { code }),
      ...(extraLog?.() ?? {}),
    });
  };

  try {
    const result = await fn();
    logTool('info');
    return {
      structuredContent: result,
      content: [{ type: 'text', text: JSON.stringify(result) }],
    };
  } catch (e) {
    const error = toHexlogError(e, ctx);
    const body = { code: error.code, message: error.message, details: error.details };
    logTool('error', error.code);
    return {
      isError: true,
      structuredContent: body,
      content: [{ type: 'text', text: JSON.stringify(body) }],
    };
  }
}

/** `HexlogError` passa direto; qualquer outra exceção vira `INTERNAL`, logando a stack em `internal-error`. */
function toHexlogError(e: unknown, ctx: Context): HexlogError {
  if (e instanceof HexlogError) return e;
  const stack = e instanceof Error ? e.stack : String(e);
  ctx.log({ level: 'error', event: 'internal-error', stack });
  return new HexlogError('INTERNAL', 'internal error');
}

/** Monta o servidor MCP `hexlog`: nome fixo, versão de `version.ts`, tools de definição e de eventos. */
export function createServer(ctx: Context): McpServer {
  const server = new McpServer({ name: 'hexlog', version: VERSAO });
  registerDefinitionTools(server, ctx);
  registerEventTools(server, ctx);
  ctx.log({ level: 'info', event: 'start', dataDir: ctx.dataDir, version: VERSAO });
  return server;
}
