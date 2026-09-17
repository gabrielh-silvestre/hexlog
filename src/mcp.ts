import { McpServer } from '@modelcontextprotocol/server';
import { isNil } from 'es-toolkit';
import { z } from 'zod';
import type { Logger as LoggerAjv } from './definicoes.ts';
import { type Detalhe, ErroHexlog } from './erros.ts';
import { registrarFerramentasDefinicoes } from './ferramentas-definicoes.ts';
import { registrarFerramentasEventos } from './ferramentas-eventos.ts';
import { VocabSchema, VocabularioSchema } from './estado.ts';
import { Agente, Hash, Instante, Nome } from './eventos.ts';
import type { Logger, Registro } from './log.ts';
import { VERSAO } from './versao.ts';

/** Contexto compartilhado por todas as tools MCP do hexlog. */
export type Contexto = {
  dirDados: string;
  relogio: () => Date;
  log: Logger;
};

/** Cria um logger de linha JSON para `saida` (§4.15): nenhuma linha é filtrada, `debug` incluso. */
export function criarLoggerStderr(saida: NodeJS.WritableStream = process.stderr): Logger {
  return (registro: Registro) => {
    saida.write(`${JSON.stringify({ ts: new Date().toISOString(), ...registro })}\n`);
  };
}

/** Adapta o `Logger` de linha (§4.15) para a forma `{log, warn, error}` que o Ajv espera (`definicoes.ts`). */
export function adaptarLoggerAjv(log: Logger): LoggerAjv {
  const emitir =
    (nivel: 'debug' | 'aviso' | 'erro') =>
    (...args: unknown[]) => {
      log({ nivel, evento: 'ajv', mensagem: args.map(String).join(' ') });
    };
  return { log: emitir('debug'), warn: emitir('aviso'), error: emitir('erro') };
}

// §4.16: tetos de saída, compartilhados pelas tools de eventos.
export const TETO_ITENS_SECAO = 100;
export const TETO_PAGINA_CHARS = 24_000;

// Esquemas comuns de §4.12, compartilhados pelas tools de definição e de eventos.
export const Aviso = z.object({ codigo: z.string(), mensagem: z.string(), detalhes: z.unknown().optional() });
// Reexportados de estado.ts (fonte única do schema de vocabulário, DE-29).
export const Vocab = VocabSchema;
export const Vocabulario = VocabularioSchema;
export const Ref = z.object({ id: z.string(), seq: z.number().int(), timestamp: Instante });
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
export const Definida = z.object({ projeto: Nome, nome: Nome, hash: Hash, substituiu: z.boolean() });
export const Secao = z.enum(['vigentes', 'conflitos', 'orfaos', 'aRevisar', 'referenciasInvalidas', 'avisos', 'cadeia']);

// Reexportadas por conveniência: os módulos de tools só precisam importar de `mcp.ts`.
export { Agente, Hash, Instante, Nome };

/** Corpo de sucesso ou erro que uma tool devolve ao SDK (§4.13): nunca uma exceção. */
type ResultadoTool<T> =
  | { structuredContent: T; content: [{ type: 'text'; text: string }] }
  | {
      isError: true;
      structuredContent: { codigo: string; mensagem: string; detalhes: Detalhe[] };
      content: [{ type: 'text'; text: string }];
    };

/**
 * Roda `fn` dentro do envelope de erro de domínio (§4.13) e sempre devolve, nunca lança para o SDK.
 * `ErroHexlog` vira `{codigo, mensagem, detalhes}`; qualquer outra exceção vira `INTERNO`, com stack
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
  const logTool = (nivel: 'info' | 'erro', codigo?: string) => {
    ctx.log({
      nivel,
      evento: 'tool',
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
    return { structuredContent: resultado, content: [{ type: 'text', text: JSON.stringify(resultado) }] };
  } catch (e) {
    const erro = paraErroHexlog(e, ctx);
    const corpo = { codigo: erro.codigo, mensagem: erro.message, detalhes: erro.detalhes };
    logTool('erro', erro.codigo);
    return { isError: true, structuredContent: corpo, content: [{ type: 'text', text: JSON.stringify(corpo) }] };
  }
}

/** `ErroHexlog` passa direto; qualquer outra exceção vira `INTERNO`, logando a stack em `erro-interno`. */
function paraErroHexlog(e: unknown, ctx: Contexto): ErroHexlog {
  if (e instanceof ErroHexlog) return e;
  const stack = e instanceof Error ? e.stack : String(e);
  ctx.log({ nivel: 'erro', evento: 'erro-interno', stack });
  return new ErroHexlog('INTERNO', 'erro interno');
}

/** Monta o servidor MCP `hexlog`: nome fixo, versão de `versao.ts`, tools de definição e de eventos. */
export function criarServidor(ctx: Contexto): McpServer {
  const servidor = new McpServer({ name: 'hexlog', version: VERSAO });
  registrarFerramentasDefinicoes(servidor, ctx);
  registrarFerramentasEventos(servidor, ctx);
  ctx.log({ nivel: 'info', evento: 'inicio', dirDados: ctx.dirDados, versao: VERSAO });
  return servidor;
}
