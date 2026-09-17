import { afterEach, beforeEach, describe, expect, test } from '@jest/globals';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { Client } from '@modelcontextprotocol/client';
import { InMemoryTransport, McpServer } from '@modelcontextprotocol/server';
import { last } from 'es-toolkit';
import { z } from 'zod';
import { executar } from '../src/mcp.ts';
import type { LogRecord } from '../src/log.ts';
import {
  type Ambiente,
  criarAmbiente,
  esperarErro,
  parseJson,
  registrarNucleo,
} from './helpers.ts';

const SCHEMA_VALIDO = {
  type: 'object',
  properties: { nota: { type: 'string' } },
  required: ['nota'],
  additionalProperties: false,
};

// Forma de schemas/<nome>.json gravado por `registrar_tipo` (S1).
const RegistroTipoSchema = z.object({ schema: z.record(z.string(), z.unknown()) });

/** Registra vocabulário núcleo, um tipo e um gate custom, depois fixa `processo` (setup comum a vários ACs). */
async function prepararProcesso(ambiente: Ambiente, projeto: string, processo: string) {
  await registrarNucleo(ambiente, projeto);
  const tipo = await ambiente.chamar('registrar_tipo', {
    project: projeto,
    name: 'nota',
    schema: SCHEMA_VALIDO,
  });
  await ambiente.chamar('registrar_gate', {
    project: projeto,
    name: 'gate-custom',
    criteria: 'critério qualquer',
  });
  const criado = await ambiente.chamar('criar_processo', { project: projeto, process: processo });
  return { tipo, criado };
}

let ambiente: Ambiente;

beforeEach(async () => {
  ambiente = await criarAmbiente();
});

afterEach(async () => {
  await ambiente.fechar();
});

describe('M2', () => {
  const NOMES_INVALIDOS = ['..', 'a/b', 'A', '', '-a', 'a'.repeat(64)];

  const CASOS: { tool: string; campo: string; base: Record<string, unknown> }[] = [
    {
      tool: 'criar_processo',
      campo: 'project',
      base: { project: 'proj-valido', process: 'proc-valido' },
    },
    {
      tool: 'criar_processo',
      campo: 'process',
      base: { project: 'proj-valido', process: 'proc-valido' },
    },
    {
      tool: 'registrar_tipo',
      campo: 'project',
      base: { project: 'proj-valido', name: 'tipo-valido', schema: SCHEMA_VALIDO },
    },
    {
      tool: 'registrar_tipo',
      campo: 'name',
      base: { project: 'proj-valido', name: 'tipo-valido', schema: SCHEMA_VALIDO },
    },
    {
      tool: 'registrar_vocabulario',
      campo: 'project',
      base: { project: 'proj-valido', owner: 'core' },
    },
    {
      tool: 'registrar_vocabulario',
      campo: 'owner',
      base: { project: 'proj-valido', owner: 'core' },
    },
    {
      tool: 'registrar_gate',
      campo: 'project',
      base: { project: 'proj-valido', name: 'gate-valido', criteria: 'critério qualquer' },
    },
    {
      tool: 'registrar_gate',
      campo: 'name',
      base: { project: 'proj-valido', name: 'gate-valido', criteria: 'critério qualquer' },
    },
    { tool: 'listar', campo: 'project', base: {} },
    { tool: 'listar', campo: 'process', base: { project: 'proj-valido' } },
  ];

  for (const { tool, campo, base } of CASOS) {
    for (const nomeInvalido of NOMES_INVALIDOS) {
      test(`${tool}({${campo}: ${JSON.stringify(nomeInvalido)}}) → Input validation error, árvore intacta`, async () => {
        const antes = ambiente.arvore();
        const resultado = await ambiente.chamar(tool, { ...base, [campo]: nomeInvalido });
        expect(resultado.isError).toBe(true);
        expect(resultado.content?.[0]?.text).toMatch(/^Input validation error/);
        expect(ambiente.arvore()).toEqual(antes);
      });
    }
  }
});

describe('M7', () => {
  test('registrar_tipo com schema reprovado pelo Ajv → SCHEMA_INVALIDO estruturado', async () => {
    const resultado = await ambiente.chamar('registrar_tipo', {
      project: 'p1',
      name: 'ruim',
      schema: { typ: 'object' },
    });
    const corpo = esperarErro(resultado, 'INVALID_SCHEMA');
    expect(corpo.detalhes.length).toBeGreaterThan(0);
    expect(corpo.detalhes[0]?.path.startsWith('/')).toBe(true);
    expect(corpo.mensagem.length).toBeGreaterThan(0);
  });

  test('registrar_tipo com schema: [] → Input validation error (forma), sem chegar ao handler', async () => {
    const resultado = await ambiente.chamar('registrar_tipo', {
      project: 'p1',
      name: 'ruim',
      schema: [],
    });
    expect(resultado.isError).toBe(true);
    expect(resultado.content?.[0]?.text).toMatch(/^Input validation error/);
  });

  test('handler que lança exceção interna devolve INTERNO estruturado, nunca a exceção crua', async () => {
    const [transporteServidor, transporteCliente] = InMemoryTransport.createLinkedPair();
    const servidorTeste = new McpServer({ name: 'teste-interno', version: '0.0.0' });
    const logs: LogRecord[] = [];
    const ctxTeste = {
      dirDados: ambiente.dir,
      relogio: () => new Date(),
      log: (r: LogRecord) => logs.push(r),
    };

    servidorTeste.registerTool(
      'explode',
      {
        description: 'lança exceção interna de propósito',
        inputSchema: {},
        outputSchema: { ok: z.boolean() },
      },
      async () =>
        executar(ctxTeste, 'explode', {}, () => {
          throw new Error('boom');
        }),
    );

    const clienteTeste = new Client({ name: 'cliente-teste', version: '0.0.0' });
    await Promise.all([
      servidorTeste.connect(transporteServidor),
      clienteTeste.connect(transporteCliente),
    ]);
    const resultado = (await clienteTeste.callTool({ name: 'explode', arguments: {} })) as {
      isError?: boolean;
      structuredContent?: { codigo?: string };
    };

    expect(resultado.isError).toBe(true);
    expect(resultado.structuredContent?.codigo).toBe('INTERNAL');
    expect(
      logs.some(
        (registro) => registro.event === 'erro-interno' && typeof registro.stack === 'string',
      ),
    ).toBe(true);
    await clienteTeste.close();
  });
});

describe('M8', () => {
  test('listar {processo} não traz schema dos tipos; listar {tipo} traz o schema fixado', async () => {
    const { tipo } = await prepararProcesso(ambiente, 'p1', 'proc1');

    const processo = await ambiente.chamar('listar', { project: 'p1', process: 'proc1' });
    const tipos = (
      processo.structuredContent as {
        process: { types: { name: string; hash: string; schema?: unknown }[] };
      }
    ).process.types;
    expect(tipos).toEqual([
      { name: 'nota', hash: (tipo.structuredContent as { hash: string }).hash },
    ]);
    expect(tipos[0]).not.toHaveProperty('schema');

    const doTipo = await ambiente.chamar('listar', {
      project: 'p1',
      process: 'proc1',
      type: 'nota',
    });
    expect(doTipo.structuredContent).toEqual({
      builtinGates: (doTipo.structuredContent as { builtinGates: unknown }).builtinGates,
      type: {
        name: 'nota',
        hash: (tipo.structuredContent as { hash: string }).hash,
        schema: SCHEMA_VALIDO,
      },
    });
  });
});

describe('M9', () => {
  test('annotations das 5 tools de definição batem com §4.12', async () => {
    const { tools } = await ambiente.cliente.listTools();
    const porNome = Object.fromEntries(tools.map((tool) => [tool.name, tool.annotations]));

    expect(porNome.listar).toMatchObject({
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    });
    for (const nome of ['registrar_tipo', 'registrar_vocabulario', 'registrar_gate']) {
      expect(porNome[nome]).toMatchObject({
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: true,
        openWorldHint: false,
      });
    }
    expect(porNome.criar_processo).toMatchObject({
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: false,
    });
  });
});

describe('S1', () => {
  test('registrar_tipo grava schemas/<nome>.json com o schema exato', async () => {
    await ambiente.chamar('registrar_tipo', { project: 'p1', name: 'nota', schema: SCHEMA_VALIDO });
    const gravado = parseJson(
      RegistroTipoSchema,
      fs.readFileSync(path.join(ambiente.dir, 'p1', 'schemas', 'nota.json'), 'utf8'),
    );
    expect(gravado.schema).toEqual(SCHEMA_VALIDO);
  });

  test('rejeita schema inválido, $ref externo e nomes reservados, sem gravar', async () => {
    const antes = ambiente.arvore();

    const invalido = await ambiente.chamar('registrar_tipo', {
      project: 'p1',
      name: 'ruim',
      schema: { typ: 'object' },
    });
    esperarErro(invalido, 'INVALID_SCHEMA');

    const refExterno = await ambiente.chamar('registrar_tipo', {
      project: 'p1',
      name: 'comref',
      schema: {
        type: 'object',
        properties: { x: { $ref: 'https://exemplo.invalido/schema.json' } },
      },
    });
    esperarErro(refExterno, 'INVALID_SCHEMA');

    const marco = await ambiente.chamar('registrar_tipo', {
      project: 'p1',
      name: 'milestone',
      schema: SCHEMA_VALIDO,
    });
    esperarErro(marco, 'RESERVED_NAME');

    const veredito = await ambiente.chamar('registrar_tipo', {
      project: 'p1',
      name: 'verdict',
      schema: SCHEMA_VALIDO,
    });
    esperarErro(veredito, 'RESERVED_NAME');

    expect(ambiente.arvore()).toEqual(antes);
  });
});

describe('S8', () => {
  test('criar_processo com processo reservado → NOME_RESERVADO', async () => {
    for (const processo of ['schemas', 'vocabulary', 'gates']) {
      const resultado = await ambiente.chamar('criar_processo', {
        project: 'p1',
        process: processo,
      });
      esperarErro(resultado, 'RESERVED_NAME');
    }
  });

  test('registrar_gate com nome de gate embutido → NOME_RESERVADO', async () => {
    for (const nome of ['no-orphans', 'no-conflicts', 'chain-intact', 'no-invalid-references']) {
      const resultado = await ambiente.chamar('registrar_gate', {
        project: 'p1',
        name: nome,
        criteria: 'x',
      });
      esperarErro(resultado, 'RESERVED_NAME');
    }
  });
});

describe('N14', () => {
  test('2 criar_processo concorrentes → exatamente um PROCESSO_JA_EXISTE e um process.json', async () => {
    await ambiente.chamar('registrar_vocabulario', { project: 'p1', owner: 'core' });

    const [a, b] = await Promise.all([
      ambiente.chamar('criar_processo', { project: 'p1', process: 'proc1' }),
      ambiente.chamar('criar_processo', { project: 'p1', process: 'proc1' }),
    ]);

    const erros = [a, b].filter((r) => r.isError === true);
    const sucessos = [a, b].filter((r) => r.isError !== true);
    expect(erros).toHaveLength(1);
    expect(sucessos).toHaveLength(1);
    expect((erros[0]?.structuredContent as { codigo: string }).codigo).toBe(
      'PROCESS_ALREADY_EXISTS',
    );
    expect(fs.existsSync(path.join(ambiente.dir, 'p1', 'proc1', 'process.json'))).toBe(true);
  });

  test('criar_processo sem nenhum vocabulário registrado → VOCABULARIO_AUSENTE', async () => {
    const resultado = await ambiente.chamar('criar_processo', {
      project: 'sem-vocab',
      process: 'proc1',
    });
    esperarErro(resultado, 'VOCABULARY_MISSING');
  });
});

describe('listar', () => {
  test('sem parâmetros: projetos existentes com a contagem de processos, e builtinGates sempre presente', async () => {
    await prepararProcesso(ambiente, 'p1', 'proc1');

    const resultado = await ambiente.chamar('listar', {});
    const corpo = resultado.structuredContent as {
      projects: { name: string; processes: number }[];
      builtinGates: unknown[];
    };
    expect(corpo.projects).toEqual(expect.arrayContaining([{ name: 'p1', processes: 1 }]));
    expect(corpo.builtinGates).toHaveLength(4);
  });

  test('processo sem projeto, ou tipo sem processo → ENTRADA_INVALIDA', async () => {
    esperarErro(await ambiente.chamar('listar', { process: 'proc1' }), 'INVALID_INPUT');
    esperarErro(await ambiente.chamar('listar', { project: 'p1', type: 'nota' }), 'INVALID_INPUT');
  });

  test('projeto inexistente → PROJETO_INEXISTENTE', async () => {
    esperarErro(await ambiente.chamar('listar', { project: 'fantasma' }), 'PROJECT_NOT_FOUND');
  });

  test('processo inexistente → PROCESSO_INEXISTENTE', async () => {
    await ambiente.chamar('registrar_vocabulario', { project: 'p1', owner: 'core' });
    esperarErro(
      await ambiente.chamar('listar', { project: 'p1', process: 'fantasma' }),
      'PROCESS_NOT_FOUND',
    );
  });

  test('tipo fora do snapshot do processo → TIPO_INEXISTENTE', async () => {
    await prepararProcesso(ambiente, 'p1', 'proc1');
    esperarErro(
      await ambiente.chamar('listar', { project: 'p1', process: 'proc1', type: 'fantasma' }),
      'TYPE_NOT_FOUND',
    );
  });

  test('ignora diretórios reservados e diretórios de processo sem manifesto', async () => {
    await prepararProcesso(ambiente, 'p1', 'proc1');
    fs.mkdirSync(path.join(ambiente.dir, 'p1', 'processo-sem-manifesto'));

    const resultado = await ambiente.chamar('listar', { project: 'p1' });
    const processos = (
      resultado.structuredContent as { project: { processes: { name: string }[] } }
    ).project.processes;
    expect(processos.map((p) => p.name)).toEqual(['proc1']);
  });
});

describe('logger', () => {
  test('toda chamada gera um registro tool com nome e ms; erro também traz codigo', async () => {
    await ambiente.chamar('listar', {});
    const registroSucesso = ambiente.registros.find(
      (r) => r.event === 'tool' && r.nome === 'listar',
    );
    expect(registroSucesso).toBeDefined();
    expect(typeof registroSucesso?.ms).toBe('number');
    expect(registroSucesso?.codigo).toBeUndefined();

    await ambiente.chamar('listar', { project: 'fantasma' });
    const chamadasListar = ambiente.registros.filter(
      (r) => r.event === 'tool' && r.nome === 'listar',
    );
    expect(last(chamadasListar)?.codigo).toBe('PROJECT_NOT_FOUND');
  });
});
