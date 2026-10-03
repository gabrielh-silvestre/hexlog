import { CLIENT_INFO_META_KEY } from '@modelcontextprotocol/server';
import type { ServerContext, StandardSchemaWithJSON } from '@modelcontextprotocol/server';
import { z } from 'zod';
import type { AttachmentService } from '../commands/attachment.ts';
import type { DefinitionService } from '../commands/definition.ts';
import type { ProcessService } from '../commands/process.ts';
import { type Author, isWellFormed } from '../domain/record.ts';
import { type Detail, HexlogError, issueDetails } from '../errors.ts';
import type { Changes, QueryInput, QueryResult, QueryService } from '../queries/query-service.ts';
import type { Logger } from '../shared/logger.ts';

/** Surrogate solitário não vira UTF-8: o JCS do hash lançaria e a tool devolveria INTERNAL (TM3). */
export const WELL_FORMED = 'must not contain a lone surrogate';
export const wellFormed = (strings: readonly string[]): boolean => strings.every(isWellFormed);

/** D-20: teto de caracteres do JSON de uma página de `query` e de `read_attachment`. */
export const PAGE_CHARS_CAP = 24_000;

/** Itens de `changes.entered` e de `changes.left` que cabem no envelope da tool (M4 da herança do PR-5). */
export const CHANGES_ITEMS_CAP = 100;

/** Comando de arquivamento que `LEGACY_DATA` devolve em `details` (D-13): sem caminho absoluto. */
const ARCHIVE_COMMAND = 'node scripts/install.ts --archive-0x (from the hexlog repository)';

/** Os quatro serviços que `compose.ts#compose` monta; o kernel só os repassa às tools. */
export type Services = {
  definition: DefinitionService;
  attachment: AttachmentService;
  process: ProcessService;
  query: QueryService;
};

/**
 * Tudo que uma tool recebe de `createServer`. `isLegacy` é injetado (D-13) e consultado em toda
 * chamada, para o servidor voltar a funcionar sem reinício depois de arquivar o dado 0.x.
 *
 * Contrato das tools (`src/mcp/tools/<x>.ts`): cada arquivo exporta
 * `register<X>Tools(server: McpServer, deps: ToolDeps): void`, que chama
 * `server.registerTool('<nome literal>', { inputSchema: advertise(Entrada), ... }, (args, ctx) =>
 * execute(deps, { name: '<nome literal>', schema: Entrada, args, ctx }, (input, caller) =>
 * deps.services.<serviço>.<operação>(...)))` e mais nada: nenhuma regra de negócio na tool.
 */
export type ToolDeps = {
  services: Services;
  isLegacy: () => boolean;
  logger: Logger;
};

/** Quem chamou: `client` vem do envelope do MCP (D-21), nunca do agente. */
export type Caller = {
  client: string;
  /** D8: monta o `Author` com o `client` do envelope; `model` só entra quando informado. */
  author(fields: { agent: string; model?: string }): Author;
};

/** O que `execute` precisa de uma chamada: `args` é a entrada crua que o SDK repassou. */
export type ToolCall<Input> = {
  /** Nome literal da tool, o mesmo do `registerTool`. */
  name: string;
  schema: z.ZodType<Input>;
  args: unknown;
  ctx: ServerContext;
};

/** Corpo de sucesso ou erro que uma tool devolve ao SDK (§4.13): nunca uma exceção. */
export type ToolResult<Output> =
  | { structuredContent: Output; content: [{ type: 'text'; text: string }] }
  | {
      isError: true;
      structuredContent: { code: string; message: string; details: Detail[] };
      content: [{ type: 'text'; text: string }];
    };

/**
 * Ponte zod → SDK: anuncia o JSON Schema do próprio zod (`~standard.jsonSchema`), mas troca o
 * `validate` por um que deixa a entrada crua passar. Quem valida de verdade é `execute`, para o erro
 * sair como `INVALID_INPUT` com `details[]` (D-26) e não como "Input validation error" do SDK.
 */
export function advertise(schema: z.ZodType): StandardSchemaWithJSON {
  return { '~standard': { ...schema['~standard'], validate: (value) => ({ value }) } };
}

/** `HexlogError` passa direto; qualquer outra exceção vira `INTERNAL`, com a stack só no log `internal-error`. */
export function toHexlogError(e: unknown, logger: Logger): HexlogError {
  if (e instanceof HexlogError) return e;
  logger({
    level: 'error',
    event: 'internal-error',
    stack: e instanceof Error ? e.stack : String(e),
  });
  return new HexlogError('INTERNAL', 'internal error');
}

const ClientInfo = z.object({
  name: z
    .string()
    .min(1)
    .max(100)
    .refine((name) => wellFormed([name]), WELL_FORMED),
});

/** D-21: `io.modelcontextprotocol/clientInfo.name` do envelope, ou `unknown` (cliente sem envelope). */
function clientOf(ctx: ServerContext): string {
  const envelope: Record<string, unknown> | undefined = ctx.mcpReq.envelope;
  const parsed = ClientInfo.safeParse(envelope?.[CLIENT_INFO_META_KEY]);
  return parsed.success ? parsed.data.name : 'unknown';
}

function callerOf(ctx: ServerContext): Caller {
  const client = clientOf(ctx);
  return {
    client,
    author: ({ agent, model }) => ({ agent, client, ...(model === undefined ? {} : { model }) }),
  };
}

/**
 * Toda tool passa por aqui e `execute` nunca lança para o SDK. Ordem: `isLegacy()` antes de qualquer
 * outra coisa (`LEGACY_DATA` com o comando de arquivamento em `details`), depois valida a entrada
 * crua com `schema` (`INVALID_INPUT` com `details[{path,code,message}]`), depois `run`.
 * `HexlogError` vira `{code, message, details}`; qualquer outra exceção vira `INTERNAL`, sem stack.
 * Emite um log `tool` com `name`, `ms` e `code?`, nunca o conteúdo da entrada.
 */
export async function execute<Input, Output>(
  deps: ToolDeps,
  call: ToolCall<Input>,
  run: (input: Input, caller: Caller) => Output | Promise<Output>,
): Promise<ToolResult<Output>> {
  const start = Date.now();
  const log = (level: 'info' | 'error', code?: string) => {
    deps.logger({
      level,
      event: 'tool',
      name: call.name,
      ms: Date.now() - start,
      ...(code === undefined ? {} : { code }),
    });
  };

  try {
    if (deps.isLegacy()) {
      throw new HexlogError('LEGACY_DATA', 'legacy 0.x data found; archive it first', [
        { path: '', code: 'run', message: ARCHIVE_COMMAND },
      ]);
    }
    const parsed = call.schema.safeParse(call.args ?? {});
    if (!parsed.success) {
      throw new HexlogError(
        'INVALID_INPUT',
        'invalid input',
        issueDetails(parsed.error.issues, ''),
      );
    }
    const result = await run(parsed.data, callerOf(call.ctx));
    log('info');
    return { structuredContent: result, content: [{ type: 'text', text: JSON.stringify(result) }] };
  } catch (e) {
    const error = toHexlogError(e, deps.logger);
    const body = { code: error.code, message: error.message, details: error.details };
    log('error', error.code);
    return {
      isError: true,
      structuredContent: body,
      content: [{ type: 'text', text: JSON.stringify(body) }],
    };
  }
}

type PagedChanges = Changes & { omitted?: { entered: number; left: number } };

/** M4: corta `entered` e `left` em `CHANGES_ITEMS_CAP` e conta o que ficou de fora em `omitted`. */
function capChanges(changes: Changes): PagedChanges {
  const entered = changes.entered.length - CHANGES_ITEMS_CAP;
  const left = changes.left.length - CHANGES_ITEMS_CAP;
  if (entered <= 0 && left <= 0) return changes;
  return {
    ...changes,
    entered: changes.entered.slice(0, CHANGES_ITEMS_CAP),
    left: changes.left.slice(0, CHANGES_ITEMS_CAP),
    omitted: { entered: Math.max(entered, 0), left: Math.max(left, 0) },
  };
}

/**
 * Única porta de `query` para as tools: passa `maxChars` (`PAGE_CHARS_CAP`) em toda chamada, porque o
 * serviço usa `Infinity` sem ele (D-20), e corta `changes` no envelope, que fica fora do teto de página.
 */
export function queryPage(
  query: QueryService,
  input: Omit<QueryInput, 'maxChars'>,
): Omit<QueryResult, 'changes'> & { changes?: PagedChanges } {
  const { changes, ...page } = query.queryRecords({ ...input, maxChars: PAGE_CHARS_CAP });
  return changes === undefined ? page : { ...page, changes: capChanges(changes) };
}
