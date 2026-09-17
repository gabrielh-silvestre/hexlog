import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { expect } from '@jest/globals';
import { Client } from '@modelcontextprotocol/client';
import { InMemoryTransport } from '@modelcontextprotocol/server';
import { parse as parseJsonBruto } from 'jsonc-parser';
import { z } from 'zod';
import type { ErrorCode, Detail } from '../src/errors.ts';
import type { Logger, LogRecord } from '../src/log.ts';
import { criarServidor } from '../src/mcp.ts';

/** Ambiente de teste: servidor `hexlog` real ligado a um `Client` MCP via transporte em memória. */
export type Ambiente = {
  dir: string;
  cliente: Client;
  registros: LogRecord[];
  chamar: (nome: string, args?: Record<string, unknown>) => Promise<ResultadoChamada>;
  arvore: (raiz?: string) => string[];
  definirRelogio: (data: Date) => void;
  fechar: () => Promise<void>;
};

type ResultadoChamada = {
  isError?: boolean;
  structuredContent?: unknown;
  content?: { type: string; text?: string }[];
};

/** Lista recursivamente os caminhos relativos a `raiz`, em ordem estável, para comparar árvores de diretório (M2). */
function arvore(raiz: string): string[] {
  if (!fs.existsSync(raiz)) return [];
  return fs
    .readdirSync(raiz, { withFileTypes: true })
    .flatMap((entrada) => {
      const caminho = path.join(raiz, entrada.name);
      const relativo = path.relative(raiz, caminho);
      return entrada.isDirectory()
        ? [relativo, ...arvore(caminho).map((f) => path.join(relativo, f))]
        : [relativo];
    })
    .sort();
}

/** Cria um `dir` de dados temporário, um servidor `hexlog` real e um `Client` MCP conectados em memória. */
export async function criarAmbiente(): Promise<Ambiente> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hexlog-'));
  const registros: LogRecord[] = [];
  const log: Logger = (registro) => {
    registros.push(registro);
  };
  let agora = new Date('2026-01-01T00:00:00.000Z');

  const [transporteServidor, transporteCliente] = InMemoryTransport.createLinkedPair();
  const servidor = criarServidor({ dirDados: dir, relogio: () => agora, log });
  const cliente = new Client({ name: 'hexlog-teste', version: '0.0.0' });
  await Promise.all([servidor.connect(transporteServidor), cliente.connect(transporteCliente)]);

  async function chamar(
    nome: string,
    args: Record<string, unknown> = {},
  ): Promise<ResultadoChamada> {
    const resultado = (await cliente.callTool({ name: nome, arguments: args })) as ResultadoChamada;
    // M7: nenhuma chamada, em toda a suíte, pode devolver um erro de forma de saída — só bug no handler produziria isso.
    for (const item of resultado.content ?? []) {
      if (item.type === 'text' && item.text !== undefined) {
        expect(item.text.startsWith('Output validation error')).toBe(false);
      }
    }
    return resultado;
  }

  return {
    dir,
    cliente,
    registros,
    chamar,
    arvore: (raiz = dir) => arvore(raiz),
    definirRelogio: (data: Date) => {
      agora = data;
    },
    fechar: async () => {
      await cliente.close();
      fs.rmSync(dir, { recursive: true, force: true });
    },
  };
}

/** Vocabulário núcleo mínimo (`aprovado`/`ok`/`seguir`), base de quase todo processo de teste. */
export async function registrarNucleo(ambiente: Ambiente, projeto: string): Promise<void> {
  await ambiente.chamar('registrar_vocabulario', {
    projeto,
    dono: 'nucleo',
    marcoTipo: ['aprovado'],
    resultado: ['ok'],
    acao: ['seguir'],
  });
}

/** Parseia `texto` (JSON ou JSONC) e valida o formato com `schema`, lançando erro claro se não bater. */
export function parseJson<T extends z.ZodType>(schema: T, texto: string): z.infer<T> {
  const resultado = schema.safeParse(parseJsonBruto(texto));
  if (!resultado.success) {
    throw new Error(
      `JSON não corresponde ao schema esperado:\n${z.prettifyError(resultado.error)}`,
    );
  }
  return resultado.data;
}

/** Afirma que `resultado` é um erro de domínio (§4.13) com o `codigo` esperado, e devolve o corpo estruturado. */
export function esperarErro(
  resultado: ResultadoChamada,
  codigo: ErrorCode,
): { codigo: ErrorCode; mensagem: string; detalhes: Detail[] } {
  expect(resultado.isError).toBe(true);
  const corpo = resultado.structuredContent as {
    codigo: ErrorCode;
    mensagem: string;
    detalhes: Detail[];
  };
  expect(corpo.codigo).toBe(codigo);
  return corpo;
}
