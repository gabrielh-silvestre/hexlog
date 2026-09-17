import type { McpServer } from '@modelcontextprotocol/server';
import canonicalize from 'canonicalize';
import { isNil, isNotNil } from 'es-toolkit';
import { z } from 'zod';
import { sha256hex } from './chain.ts';
import {
  carregarProcesso,
  criarProcesso,
  lerProjeto,
  listarProjetos,
  registrarGate,
  registrarTipo,
  registrarVocabulario,
} from './definitions.ts';
import { ErroHexlog } from './errors.ts';
import { listarGatesEmbutidos, TETO_CRITERIO_CHARS } from './gates.ts';
import {
  adaptarLoggerAjv,
  type Contexto,
  Definida,
  executar,
  Hash,
  Hashes,
  Instante,
  Nome,
  Vocabulario,
} from './mcp.ts';

const Rotulo = z.string().min(1).max(100);
const ListaRotulos = z.array(Rotulo).max(100).default([]);

/** Registra as 5 tools de definição (`listar`, `registrar_tipo`, `registrar_vocabulario`, `registrar_gate`, `criar_processo`). */
export function registrarFerramentasDefinicoes(servidor: McpServer, ctx: Contexto): void {
  servidor.registerTool(
    'listar',
    {
      title: 'Listar',
      description:
        'Lista projetos, ou o detalhe de um projeto, processo ou tipo fixado, conforme os parâmetros informados. ' +
        'Sem parâmetros, lista os projetos existentes. Sempre traz os gates embutidos disponíveis.',
      inputSchema: { projeto: Nome.optional(), processo: Nome.optional(), tipo: Nome.optional() },
      outputSchema: {
        projetos: z.array(z.object({ nome: Nome, processos: z.number().int() })).optional(),
        projeto: z
          .object({
            nome: Nome,
            processos: z.array(z.object({ nome: Nome, criadoEm: Instante })),
            tipos: z.array(z.object({ nome: Nome, hash: Hash })),
            vocabulario: z.array(z.object({ dono: Nome, hash: Hash })),
            gates: z.array(z.object({ nome: Nome, hash: Hash })),
          })
          .optional(),
        processo: z
          .object({
            nome: Nome,
            criadoEm: Instante,
            hashes: Hashes,
            tipos: z.array(z.object({ nome: Nome, hash: Hash })),
            vocabulario: Vocabulario,
            gates: z.record(z.string(), z.object({ criterio: z.string() })),
          })
          .optional(),
        tipo: z
          .object({ nome: Nome, hash: Hash, schema: z.record(z.string(), z.unknown()) })
          .optional(),
        gatesEmbutidos: z.array(z.object({ nome: Nome, criterio: z.string() })),
      },
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async ({ projeto, processo, tipo }) =>
      executar(ctx, 'listar', { projeto, processo }, () =>
        resolverListar(ctx, { projeto, processo, tipo }),
      ),
  );

  servidor.registerTool(
    'registrar_tipo',
    {
      title: 'Registrar tipo',
      description:
        'Registra (ou substitui) o schema JSON de um tipo de evento custom do projeto, gravando `schemas/<nome>.json`.',
      inputSchema: { projeto: Nome, nome: Nome, schema: z.record(z.string(), z.unknown()) },
      outputSchema: Definida.shape,
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async ({ projeto, nome, schema }) =>
      executar(ctx, 'registrar_tipo', { projeto }, () =>
        registrarTipo(ctx.dirDados, projeto, nome, schema, { log: adaptarLoggerAjv(ctx.log) }),
      ),
  );

  servidor.registerTool(
    'registrar_vocabulario',
    {
      title: 'Registrar vocabulário',
      description:
        'Registra (ou substitui) o vocabulário de um dono do projeto (`"nucleo"` ou uma extensão), gravando `vocabulario/<dono>.json`.',
      inputSchema: {
        projeto: Nome,
        dono: Nome,
        marcoTipo: ListaRotulos,
        resultado: ListaRotulos,
        acao: ListaRotulos,
      },
      outputSchema: { projeto: Nome, dono: Nome, hash: Hash, substituiu: z.boolean() },
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async ({ projeto, dono, marcoTipo, resultado, acao }) =>
      executar(ctx, 'registrar_vocabulario', { projeto }, () =>
        registrarVocabulario(ctx.dirDados, projeto, dono, { marcoTipo, resultado, acao }),
      ),
  );

  servidor.registerTool(
    'registrar_gate',
    {
      title: 'Registrar gate',
      description:
        'Registra (ou substitui) o critério de um gate custom do projeto, gravando `gates/<nome>.json`.',
      inputSchema: {
        projeto: Nome,
        nome: Nome,
        criterio: z.string().min(1).max(TETO_CRITERIO_CHARS),
      },
      outputSchema: Definida.shape,
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async ({ projeto, nome, criterio }) =>
      executar(ctx, 'registrar_gate', { projeto }, () =>
        registrarGate(ctx.dirDados, projeto, nome, criterio),
      ),
  );

  servidor.registerTool(
    'criar_processo',
    {
      title: 'Criar processo',
      description:
        'Cria um novo processo, fixando o snapshot atual de tipos, vocabulário e gates do projeto em `processo.json`. ' +
        'Falha se o processo já existir ou se o projeto não tiver nenhum vocabulário registrado.',
      inputSchema: { projeto: Nome, processo: Nome },
      outputSchema: {
        projeto: Nome,
        processo: Nome,
        criadoEm: Instante,
        hashes: z.object({ schemas: Hash, vocabulario: Hash, gates: Hash }),
        tipos: z.array(Nome),
        donos: z.array(Nome),
        gates: z.array(Nome),
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: false,
      },
    },
    async ({ projeto, processo }) =>
      executar(ctx, 'criar_processo', { projeto, processo }, () =>
        criarProcesso(ctx.dirDados, projeto, processo, ctx.relogio),
      ),
  );
}

/** Hash do mesmo formato de `Definida` (§4.10): sha256 do JSON canônico (JCS) do schema. */
function hashSchema(schema: object): string {
  return sha256hex(canonicalize(schema) ?? '');
}

/** Lógica dos 4 níveis de `listar` (§4.12): projetos → projeto → processo → tipo. */
function resolverListar(
  ctx: Contexto,
  { projeto, processo, tipo }: { projeto?: string; processo?: string; tipo?: string },
) {
  if (isNil(projeto) && isNotNil(processo)) {
    throw new ErroHexlog('ENTRADA_INVALIDA', 'processo requer projeto', [
      {
        caminho: '/processo',
        codigo: 'requer_projeto',
        mensagem: 'processo informado sem projeto',
      },
    ]);
  }
  if (isNil(processo) && isNotNil(tipo)) {
    throw new ErroHexlog('ENTRADA_INVALIDA', 'tipo requer processo', [
      { caminho: '/tipo', codigo: 'requer_processo', mensagem: 'tipo informado sem processo' },
    ]);
  }

  const gatesEmbutidos = listarGatesEmbutidos();

  if (isNil(projeto)) {
    return {
      gatesEmbutidos,
      projetos: listarProjetos(ctx.dirDados).map((p) => ({
        nome: p.nome,
        processos: p.processos.length,
      })),
    };
  }

  if (isNil(processo)) {
    return { gatesEmbutidos, projeto: lerProjeto(ctx.dirDados, projeto) };
  }

  const carregado = carregarProcesso(ctx.dirDados, projeto, processo);

  if (isNil(tipo)) {
    return {
      gatesEmbutidos,
      processo: {
        nome: processo,
        criadoEm: carregado.manifesto.criadoEm,
        hashes: carregado.manifesto.hashes,
        tipos: Object.entries(carregado.manifesto.fixado.tipos).map(([nomeTipo, schema]) => ({
          nome: nomeTipo,
          hash: hashSchema(schema),
        })),
        vocabulario: carregado.manifesto.fixado.vocabulario,
        gates: carregado.manifesto.fixado.gates,
      },
    };
  }

  const schema = carregado.manifesto.fixado.tipos[tipo];
  if (isNil(schema)) {
    throw new ErroHexlog(
      'TIPO_INEXISTENTE',
      `tipo '${tipo}' não está fixado no processo '${processo}'`,
    );
  }
  return { gatesEmbutidos, tipo: { nome: tipo, hash: hashSchema(schema), schema } };
}
