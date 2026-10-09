import { CLIENT_INFO_META_KEY } from '@modelcontextprotocol/server';
import type {
  McpServer,
  StandardSchemaWithJSON,
  ToolAnnotations,
} from '@modelcontextprotocol/server';
import { isUndefined } from 'es-toolkit';
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
import { PAGE_CHARS_CAP, type QueryService } from '../queries/query-service.ts';
import type { Logger, LogRecord } from '../shared/logger.ts';

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
 * `register<X>Tools(server: McpServer, deps: ToolDeps): void`, que chama `defineTool` uma vez por tool,
 * com o nome e o schema de entrada declarados uma só vez, e um `run` que repassa a entrada validada ao
 * serviço. Nenhuma regra de negócio na tool; a exceção é a montagem de página e o corte do envelope
 * (decisão 12), que moram na própria tool (`tools/query.ts#queryPage`, `gatePage`, `capChanges` e
 * `capEvidence`).
 */
export type ToolDeps = {
  services: Services;
  isLegacy: () => boolean;
  logger: Logger;
};

/** O que o kernel lê do `ServerContext` do SDK: só o envelope da requisição. */
export type CallContext = { mcpReq: { envelope?: Record<string, unknown> } };

/** O que `execute` precisa de uma chamada: `args` é a entrada crua que o SDK repassou. */
type ToolCall<Input> = {
  /** Nome literal da tool, o mesmo do `registerTool`. */
  name: string;
  schema: z.ZodType<Input>;
  args: unknown;
  ctx: CallContext;
};

/**
 * Corpo de sucesso ou erro que uma tool devolve ao SDK: nunca uma exceção. O erro leva o JSON
 * `{code, message, details}` só em `content[0].text`, sem `structuredContent`, porque o `outputSchema`
 * descreve só o sucesso: o `validateToolOutput` do SDK 2.0 já retorna cedo com `isError`, e a
 * invariante fica travada em `test/mcp/environment.ts#errorBodyOf`. "Nunca uma exceção" vale
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
 * Teto de aninhamento dos args crus: a raiz dos args é o nível 1, e objeto ou array no nível 65 é
 * recusado (`too-deep`). Palpite da issue #93: o `z.json()` estoura a pilha perto de 2.000 níveis, e
 * nenhum dado real do hexlog passa de uma dezena.
 */
const MAX_ARGS_DEPTH = 64;

/**
 * O `z.record` do zod 4 descarta em silêncio a chave própria `__proto__` (`register` selaria no log um
 * registro diferente do enviado; `query.where` falharia aberto), e nenhum refine a enxerga depois do
 * parse. Por isso a recusa varre os args crus, em profundidade, antes do `safeParse`. A mesma varredura
 * recusa o aninhamento acima de `MAX_ARGS_DEPTH` sem descer nele, para o zod não estourar a pilha.
 */
function reservedKeyDetails(args: unknown): Detail[] {
  const found: Detail[] = [];
  const pending: { value: unknown; path: string; depth: number }[] = [
    { value: args, path: '', depth: 1 },
  ];
  for (let item = pending.pop(); !isUndefined(item); item = pending.pop()) {
    const { value, path, depth } = item;
    if (typeof value !== 'object' || value === null) continue;
    if (depth > MAX_ARGS_DEPTH) {
      found.push({
        path,
        code: 'too-deep',
        message: `nesting deeper than ${MAX_ARGS_DEPTH} levels`,
      });
      continue;
    }
    for (const [key, child] of Object.entries(value)) {
      const childPath = path + pointer([key]);
      if (key === '__proto__') {
        found.push({
          path: childPath,
          code: 'reserved-key',
          message: 'must not use the key __proto__',
        });
      }
      pending.push({ value: child, path: childPath, depth: depth + 1 });
    }
  }
  return capDetails(found);
}

/**
 * Limiar do aviso `tool-over-cap`: o dobro de `PAGE_CHARS_CAP`. O teto de página conta só os registros
 * da `query` e o `text` do `read_attachment`; o envelope (`marker`, `cursor`, `in`/`out`, escapes do
 * JSON) soma por cima, então uma página cheia e cortada passa de `PAGE_CHARS_CAP`. O aviso existe para a
 * tool sem corte nenhum, que foge do teto por ordens de grandeza.
 */
const OVER_CAP_CHARS = 2 * PAGE_CHARS_CAP;

const ClientInfo = z.object({ name: Author.shape.client });

/** D-21: `io.modelcontextprotocol/clientInfo.name` do envelope, ou `unknown` (cliente sem envelope). */
function clientOf(ctx: CallContext): string {
  const parsed = ClientInfo.safeParse(ctx.mcpReq.envelope?.[CLIENT_INFO_META_KEY]);
  return parsed.success ? parsed.data.name : 'unknown';
}

/**
 * Toda tool passa por aqui e `execute` nunca lança para o SDK. Ordem: `isLegacy()` antes de qualquer
 * outra coisa (`LEGACY_DATA` com o comando de arquivamento em `details`), recusa a chave `__proto__`
 * em qualquer nível dos args crus (`INVALID_INPUT`, `reserved-key`) e o aninhamento acima de
 * `MAX_ARGS_DEPTH` (`INVALID_INPUT`, `too-deep`), depois valida a entrada crua com
 * `schema` (`INVALID_INPUT` com `details[{path,code,message}]`), depois `run`.
 * `HexlogError` vira `{code, message, details}`; qualquer outra exceção vira `INTERNAL`, sem stack.
 * Emite um log `tool` com `name`, `ms` e `code?`, nunca o conteúdo da entrada. Um sucesso cujo texto
 * passa de `OVER_CAP_CHARS` emite também o log `tool-over-cap` (`name` e `chars`); a resposta não é cortada.
 */
export async function execute<Input, Output>(
  deps: ToolDeps,
  call: ToolCall<Input>,
  run: (input: Input, client: string) => Output | Promise<Output>,
): Promise<ToolResult<Output>> {
  const start = Date.now();
  const log = (level: 'info' | 'error', code?: string) => {
    logSafely(deps.logger, {
      level,
      event: 'tool',
      name: call.name,
      ms: Date.now() - start,
      ...(isUndefined(code) ? {} : { code }),
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
    const result = await run(parsed.data, clientOf(call.ctx));
    log('info');
    const text = JSON.stringify(result);
    if (text.length > OVER_CAP_CHARS) {
      logSafely(deps.logger, {
        level: 'warn',
        event: 'tool-over-cap',
        name: call.name,
        chars: text.length,
      });
    }
    return { structuredContent: result, content: [{ type: 'text', text }] };
  } catch (e) {
    const error = toHexlogError(e, deps.logger);
    const body = { code: error.code, message: error.message, details: error.details };
    log('error', error.code);
    return { isError: true, content: [{ type: 'text', text: JSON.stringify(body) }] };
  }
}

/** O que cada tool declara além de `name` e `schema`: a config do `registerTool`, sem o `inputSchema`. */
type ToolConfig = {
  title: string;
  description: string;
  outputSchema: StandardSchemaWithJSON;
  annotations: ToolAnnotations;
  _meta?: Record<string, unknown>;
};

/**
 * Registra uma tool no SDK: anuncia `schema` por `advertise` e roda a chamada por `execute`, de modo
 * que `name` e `schema` são declarados uma só vez. `run` recebe a entrada validada e o `client` do envelope.
 */
export function defineTool<Input, Output>(
  server: McpServer,
  deps: ToolDeps,
  { name, schema, ...config }: ToolConfig & { name: string; schema: z.ZodType<Input> },
  run: (input: Input, client: string) => Output | Promise<Output>,
): void {
  server.registerTool(name, { ...config, inputSchema: advertise(schema) }, (args, ctx) =>
    execute(deps, { name, schema, args, ctx }, run),
  );
}
