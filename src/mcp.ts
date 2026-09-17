import { McpServer } from '@modelcontextprotocol/server';
import { isNil } from 'es-toolkit';
import { z } from 'zod';
import type { Logger as LoggerAjv } from './definitions.ts';
import { type Detail, HexlogError } from './errors.ts';
import { registrarFerramentasDefinicoes } from './definition-tools.ts';
import { registrarFerramentasEventos } from './event-tools.ts';
import { VocabSchema, VocabularySchema } from './state.ts';
import { Agent, Hash, Instant, Name } from './events.ts';
import type { Logger, LogRecord } from './log.ts';
import { VERSAO } from './version.ts';

/** Contexto compartilhado por todas as tools MCP do hexlog. */
export type Contexto = {
  dirDados: string;
  relogio: () => Date;
  log: Logger;
};

/** Cria um logger de linha JSON para `saida` (§4.15): nenhuma linha é filtrada, `debug` incluso. */
export function criarLoggerStderr(saida: NodeJS.WritableStream = process.stderr): Logger {
  return (record: LogRecord) => {
    saida.write(`${JSON.stringify({ ts: new Date().toISOString(), ...record })}\n`);
  };
}

/** Adapta o `Logger` de linha (§4.15) para a forma `{log, warn, error}` que o Ajv espera (`definitions.ts`). */
export function adaptarLoggerAjv(log: Logger): LoggerAjv {
  const emitir =
    (level: 'debug' | 'warn' | 'error') =>
    (...args: unknown[]) => {
      log({ level, event: 'ajv', message: args.map(String).join(' ') });
    };
  return { log: emitir('debug'), warn: emitir('warn'), error: emitir('error') };
}

// §4.16: tetos de saída, compartilhados pelas tools de eventos.
export const TETO_ITENS_SECAO = 100;
export const TETO_PAGINA_CHARS = 24_000;

// Esquemas comuns de §4.12, compartilhados pelas tools de definição e de eventos.
export const Aviso = z.object({
  codigo: z.string(),
  mensagem: z.string(),
  detalhes: z.unknown().optional(),
});
// Reexportados de state.ts (fonte única do schema de vocabulário, DE-29).
export const Vocab = VocabSchema;
export const Vocabulary = VocabularySchema;
export const Ref = z.object({ id: z.string(), seq: z.number().int(), timestamp: Instant });
export const Quebra = z.object({
  indice: z.number().int(),
  motivo: z.enum(['linha-invalida', 'seq-divergente', 'hash-nao-bate', 'dados-invalidos']),
  detalhe: z.string().optional(),
});
export const Cadeia = z.object({
  ok: z.boolean(),
  totalLinhas: z.number().int(),
  cabeca: z.union([z.literal(''), Hash]),
  quebras: z.array(Quebra).max(100),
  totalQuebras: z.number().int(),
  linhasReparadas: z.array(z.number().int()).max(100),
});
export const Hashes = z.object({ schemas: Hash, vocabulario: Hash, gates: Hash });
export const Definida = z.object({
  projeto: Name,
  nome: Name,
  hash: Hash,
  substituiu: z.boolean(),
});
export const Secao = z.enum([
  'vigentes',
  'conflitos',
  'orfaos',
  'aRevisar',
  'referenciasInvalidas',
  'avisos',
  'cadeia',
]);

// Reexportadas por conveniência: os módulos de tools só precisam importar de `mcp.ts`.
export { Agent, Hash, Instant, Name };

/** Corpo de sucesso ou erro que uma tool devolve ao SDK (§4.13): nunca uma exceção. */
type ResultadoTool<T> =
  | { structuredContent: T; content: [{ type: 'text'; text: string }] }
  | {
      isError: true;
      structuredContent: { codigo: string; mensagem: string; detalhes: Detail[] };
      content: [{ type: 'text'; text: string }];
    };

/**
 * Roda `fn` dentro do envelope de erro de domínio (§4.13) e sempre devolve, nunca lança para o SDK.
 * `HexlogError` vira `{codigo, mensagem, detalhes}`; qualquer outra exceção vira `INTERNAL`, com stack
 * só no log `erro-interno`. Emite sempre um log `tool` com `nome`, `projeto`, `processo`, `ms` e
 * `codigo?` (nunca o conteúdo de `dados`). `extraLog`, quando informado, é lido depois de `fn()`
 * rodar e mesclado no log `tool` (§4.15: usado por `eventos` para `modo`/`candidatos`/`msIndice`/
 * `combinacao`, sem alterar `structuredContent` nem os demais chamadores).
 */
export async function executar<T>(
  ctx: Contexto,
  nome: string,
  args: { projeto?: string; processo?: string },
  fn: () => T | Promise<T>,
  extraLog?: () => Record<string, unknown>,
): Promise<ResultadoTool<T>> {
  const inicio = Date.now();
  const logTool = (level: 'info' | 'error', codigo?: string) => {
    ctx.log({
      level,
      event: 'tool',
      nome,
      projeto: args.projeto,
      processo: args.processo,
      ms: Date.now() - inicio,
      ...(isNil(codigo) ? {} : { codigo }),
      ...(extraLog?.() ?? {}),
    });
  };

  try {
    const resultado = await fn();
    logTool('info');
    return {
      structuredContent: resultado,
      content: [{ type: 'text', text: JSON.stringify(resultado) }],
    };
  } catch (e) {
    const erro = paraErroHexlog(e, ctx);
    const corpo = { codigo: erro.code, mensagem: erro.message, detalhes: erro.details };
    logTool('error', erro.code);
    return {
      isError: true,
      structuredContent: corpo,
      content: [{ type: 'text', text: JSON.stringify(corpo) }],
    };
  }
}

/** `HexlogError` passa direto; qualquer outra exceção vira `INTERNAL`, logando a stack em `erro-interno`. */
function paraErroHexlog(e: unknown, ctx: Contexto): HexlogError {
  if (e instanceof HexlogError) return e;
  const stack = e instanceof Error ? e.stack : String(e);
  ctx.log({ level: 'error', event: 'erro-interno', stack });
  return new HexlogError('INTERNAL', 'erro interno');
}

/** Monta o servidor MCP `hexlog`: nome fixo, versão de `version.ts`, tools de definição e de eventos. */
export function criarServidor(ctx: Contexto): McpServer {
  const servidor = new McpServer({ name: 'hexlog', version: VERSAO });
  registrarFerramentasDefinicoes(servidor, ctx);
  registrarFerramentasEventos(servidor, ctx);
  ctx.log({ level: 'info', event: 'inicio', dirDados: ctx.dirDados, versao: VERSAO });
  return servidor;
}
