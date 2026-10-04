import { CLIENT_INFO_META_KEY } from '@modelcontextprotocol/server';
import type { StandardSchemaWithJSON } from '@modelcontextprotocol/server';
import { z } from 'zod';
import type { AttachmentService } from '../commands/attachment.ts';
import type { DefinitionService } from '../commands/definition.ts';
import type { ProcessService } from '../commands/process.ts';
import { Author } from '../domain/record.ts';
import {
  capDetails,
  type Detail,
  HexlogError,
  issueDetails,
  legacyDataError,
  pointer,
} from '../errors.ts';
import { ATTACHMENT_PAGE_CHARS, type QueryService } from '../queries/query-service.ts';
import type { Logger, LogRecord } from '../shared/logger.ts';

/** D-20: teto de caracteres do JSON de uma página de `query` e de `read_attachment`; o mesmo padrão do serviço. */
export const PAGE_CHARS_CAP = ATTACHMENT_PAGE_CHARS;

/** Marcador no fio: uma entrada por processo lido, `null` para processo vazio (D-24). */
export const MarkerRecord = z.record(z.string(), z.string().nullable());

/** Tool que grava: não destrói, repetir a chamada não muda o resultado, não fala com nada fora do hexlog. */
export const WRITE_ANNOTATIONS = {
  readOnlyHint: false,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false,
};

/** Tool de leitura; `destructiveHint` e `idempotentHint` só valem com `readOnlyHint` falso. */
export const READ_ANNOTATIONS = { readOnlyHint: true, openWorldHint: false };

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

/** O que o kernel lê do `ServerContext` do SDK: só o envelope da requisição. */
export type CallContext = { mcpReq: { envelope?: Record<string, unknown> } };

/** O que `execute` precisa de uma chamada: `args` é a entrada crua que o SDK repassou. */
export type ToolCall<Input> = {
  /** Nome literal da tool, o mesmo do `registerTool`. */
  name: string;
  schema: z.ZodType<Input>;
  args: unknown;
  ctx: CallContext;
};

/**
 * Corpo de sucesso ou erro que uma tool devolve ao SDK: nunca uma exceção. O erro leva o JSON
 * `{code, message, details}` só em `content[0].text`: o SDK 1.x valida `structuredContent` contra o
 * `outputSchema` de sucesso mesmo com `isError` e lançaria `-32602` no cliente. "Nunca uma exceção" vale
 * para o handler: o SDK valida o `outputSchema` depois dele, e saída fora do schema volta como `isError`
 * com o texto livre `Output validation error: ...`, sem `code` (risco aceito, ADR 0009).
 */
export type ToolResult<Output> =
  | { structuredContent: Output; content: [{ type: 'text'; text: string }] }
  | { isError: true; content: [{ type: 'text'; text: string }] };

/**
 * Ponte zod → SDK: anuncia o JSON Schema do próprio zod (`~standard.jsonSchema`), mas troca o
 * `validate` por um que deixa a entrada crua passar. Quem valida de verdade é `execute`, para o erro
 * sair como `INVALID_INPUT` com `details[]` (D-26) e não como "Input validation error" do SDK.
 * Depende de `schema['~standard']` trazer `jsonSchema` (zod 4.6.5) e de o SDK 2.0.0 exigir
 * `StandardSchemaWithJSON`: bump de zod ou do SDK exige rodar `test/mcp/kernel.spec.ts`.
 */
export function advertise(schema: z.ZodType): StandardSchemaWithJSON {
  return { '~standard': { ...schema['~standard'], validate: (value) => ({ value }) } };
}

/** O log não pode derrubar a chamada: um `register` já gravado não volta `INTERNAL` porque o logger lançou. */
function logSafely(logger: Logger, record: LogRecord): void {
  try {
    logger(record);
  } catch {
    // Sem canal melhor: o próprio logger falhou.
  }
}

/** `HexlogError` passa direto; qualquer outra exceção vira `INTERNAL`, com a stack só no log `internal-error`. */
export function toHexlogError(e: unknown, logger: Logger): HexlogError {
  if (e instanceof HexlogError) return e;
  logSafely(logger, {
    level: 'error',
    event: 'internal-error',
    stack: e instanceof Error ? e.stack : String(e),
  });
  return new HexlogError('INTERNAL', 'internal error');
}

/**
 * O `z.record` do zod 4 descarta em silêncio a chave própria `__proto__` (`register` selaria no log um
 * registro diferente do enviado; `query.where` falharia aberto), e nenhum refine a enxerga depois do
 * parse. Por isso a recusa varre os args crus, em profundidade, antes do `safeParse`.
 */
function reservedKeyDetails(args: unknown): Detail[] {
  const found: Detail[] = [];
  const pending: { value: unknown; path: string }[] = [{ value: args, path: '' }];
  for (let item = pending.pop(); item !== undefined; item = pending.pop()) {
    const { value, path } = item;
    if (typeof value !== 'object' || value === null) continue;
    for (const [key, child] of Object.entries(value)) {
      const childPath = path + pointer([key]);
      if (key === '__proto__') {
        found.push({
          path: childPath,
          code: 'reserved-key',
          message: 'must not use the key __proto__',
        });
      }
      pending.push({ value: child, path: childPath });
    }
  }
  return capDetails(found);
}

const ClientInfo = z.object({ name: Author.shape.client });

/** D-21: `io.modelcontextprotocol/clientInfo.name` do envelope, ou `unknown` (cliente sem envelope). */
function clientOf(ctx: CallContext): string {
  const parsed = ClientInfo.safeParse(ctx.mcpReq.envelope?.[CLIENT_INFO_META_KEY]);
  return parsed.success ? parsed.data.name : 'unknown';
}

function callerOf(ctx: CallContext): Caller {
  const client = clientOf(ctx);
  return {
    client,
    author: ({ agent, model }) => ({ agent, client, ...(model === undefined ? {} : { model }) }),
  };
}

/**
 * Toda tool passa por aqui e `execute` nunca lança para o SDK. Ordem: `isLegacy()` antes de qualquer
 * outra coisa (`LEGACY_DATA` com o comando de arquivamento em `details`), recusa a chave `__proto__`
 * em qualquer nível dos args crus (`INVALID_INPUT`, `reserved-key`), depois valida a entrada crua com
 * `schema` (`INVALID_INPUT` com `details[{path,code,message}]`), depois `run`.
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
    logSafely(deps.logger, {
      level,
      event: 'tool',
      name: call.name,
      ms: Date.now() - start,
      ...(code === undefined ? {} : { code }),
    });
  };

  try {
    if (deps.isLegacy()) throw legacyDataError();
    const reserved = reservedKeyDetails(call.args);
    if (reserved.length > 0) throw new HexlogError('INVALID_INPUT', 'invalid input', reserved);
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
    return { isError: true, content: [{ type: 'text', text: JSON.stringify(body) }] };
  }
}
