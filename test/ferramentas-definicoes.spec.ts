import { afterEach, beforeEach, describe, expect, test } from '@jest/globals';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { Client } from '@modelcontextprotocol/client';
import { InMemoryTransport, McpServer } from '@modelcontextprotocol/server';
import { last } from 'es-toolkit';
import { z } from 'zod';
import { executar } from '../src/mcp.ts';
import type { Registro } from '../src/log.ts';
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
    projeto,
    nome: 'nota',
    schema: SCHEMA_VALIDO,
  });
  await ambiente.chamar('registrar_gate', {
    projeto,
    nome: 'gate-custom',
    criterio: 'critério qualquer',
  });
  const criado = await ambiente.chamar('criar_processo', { projeto, processo });
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
      campo: 'projeto',
      base: { projeto: 'proj-valido', processo: 'proc-valido' },
    },
    {
      tool: 'criar_processo',
      campo: 'processo',
      base: { projeto: 'proj-valido', processo: 'proc-valido' },
    },
    {
      tool: 'registrar_tipo',
      campo: 'projeto',
      base: { projeto: 'proj-valido', nome: 'tipo-valido', schema: SCHEMA_VALIDO },
    },
    {
      tool: 'registrar_tipo',
      campo: 'nome',
      base: { projeto: 'proj-valido', nome: 'tipo-valido', schema: SCHEMA_VALIDO },
    },
    {
      tool: 'registrar_vocabulario',
      campo: 'projeto',
      base: { projeto: 'proj-valido', dono: 'nucleo' },
    },
    {
      tool: 'registrar_vocabulario',
      campo: 'dono',
      base: { projeto: 'proj-valido', dono: 'nucleo' },
    },
    {
      tool: 'registrar_gate',
      campo: 'projeto',
      base: { projeto: 'proj-valido', nome: 'gate-valido', criterio: 'critério qualquer' },
    },
    {
      tool: 'registrar_gate',
      campo: 'nome',
      base: { projeto: 'proj-valido', nome: 'gate-valido', criterio: 'critério qualquer' },
    },
    { tool: 'listar', campo: 'projeto', base: {} },
    { tool: 'listar', campo: 'processo', base: { projeto: 'proj-valido' } },
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
      projeto: 'p1',
      nome: 'ruim',
      schema: { typ: 'object' },
    });
    const corpo = esperarErro(resultado, 'SCHEMA_INVALIDO');
    expect(corpo.detalhes.length).toBeGreaterThan(0);
    expect(corpo.detalhes[0]?.caminho.startsWith('/')).toBe(true);
    expect(corpo.mensagem.length).toBeGreaterThan(0);
  });

  test('registrar_tipo com schema: [] → Input validation error (forma), sem chegar ao handler', async () => {
    const resultado = await ambiente.chamar('registrar_tipo', {
      projeto: 'p1',
      nome: 'ruim',
      schema: [],
    });
    expect(resultado.isError).toBe(true);
    expect(resultado.content?.[0]?.text).toMatch(/^Input validation error/);
  });

  test('handler que lança exceção interna devolve INTERNO estruturado, nunca a exceção crua', async () => {
    const [transporteServidor, transporteCliente] = InMemoryTransport.createLinkedPair();
    const servidorTeste = new McpServer({ name: 'teste-interno', version: '0.0.0' });
    const logs: Registro[] = [];
    const ctxTeste = {
      dirDados: ambiente.dir,
      relogio: () => new Date(),
      log: (r: Registro) => logs.push(r),
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
    expect(resultado.structuredContent?.codigo).toBe('INTERNO');
    expect(
      logs.some(
        (registro) => registro.evento === 'erro-interno' && typeof registro.stack === 'string',
      ),
    ).toBe(true);
    await clienteTeste.close();
  });
});

describe('M8', () => {
  test('listar {processo} não traz schema dos tipos; listar {tipo} traz o schema fixado', async () => {
    const { tipo } = await prepararProcesso(ambiente, 'p1', 'proc1');

    const processo = await ambiente.chamar('listar', { projeto: 'p1', processo: 'proc1' });
    const tipos = (
      processo.structuredContent as {
        processo: { tipos: { nome: string; hash: string; schema?: unknown }[] };
      }
    ).processo.tipos;
    expect(tipos).toEqual([
      { nome: 'nota', hash: (tipo.structuredContent as { hash: string }).hash },
    ]);
    expect(tipos[0]).not.toHaveProperty('schema');

    const doTipo = await ambiente.chamar('listar', {
      projeto: 'p1',
      processo: 'proc1',
      tipo: 'nota',
    });
    expect(doTipo.structuredContent).toEqual({
      gatesEmbutidos: (doTipo.structuredContent as { gatesEmbutidos: unknown }).gatesEmbutidos,
      tipo: {
        nome: 'nota',
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
    await ambiente.chamar('registrar_tipo', { projeto: 'p1', nome: 'nota', schema: SCHEMA_VALIDO });
    const gravado = parseJson(
      RegistroTipoSchema,
      fs.readFileSync(path.join(ambiente.dir, 'p1', 'schemas', 'nota.json'), 'utf8'),
    );
    expect(gravado.schema).toEqual(SCHEMA_VALIDO);
  });

  test('rejeita schema inválido, $ref externo e nomes reservados, sem gravar', async () => {
    const antes = ambiente.arvore();

    const invalido = await ambiente.chamar('registrar_tipo', {
      projeto: 'p1',
      nome: 'ruim',
      schema: { typ: 'object' },
    });
    esperarErro(invalido, 'SCHEMA_INVALIDO');

    const refExterno = await ambiente.chamar('registrar_tipo', {
      projeto: 'p1',
      nome: 'comref',
      schema: {
        type: 'object',
        properties: { x: { $ref: 'https://exemplo.invalido/schema.json' } },
      },
    });
    esperarErro(refExterno, 'SCHEMA_INVALIDO');

    const marco = await ambiente.chamar('registrar_tipo', {
      projeto: 'p1',
      nome: 'marco',
      schema: SCHEMA_VALIDO,
    });
    esperarErro(marco, 'NOME_RESERVADO');

    const veredito = await ambiente.chamar('registrar_tipo', {
      projeto: 'p1',
      nome: 'veredito',
      schema: SCHEMA_VALIDO,
    });
    esperarErro(veredito, 'NOME_RESERVADO');

    expect(ambiente.arvore()).toEqual(antes);
  });
});

describe('S8', () => {
  test('criar_processo com processo reservado → NOME_RESERVADO', async () => {
    for (const processo of ['schemas', 'vocabulario', 'gates']) {
      const resultado = await ambiente.chamar('criar_processo', { projeto: 'p1', processo });
      esperarErro(resultado, 'NOME_RESERVADO');
    }
  });

  test('registrar_gate com nome de gate embutido → NOME_RESERVADO', async () => {
    for (const nome of [
      'sem-orfaos',
      'sem-conflitos',
      'cadeia-integra',
      'sem-referencias-invalidas',
    ]) {
      const resultado = await ambiente.chamar('registrar_gate', {
        projeto: 'p1',
        nome,
        criterio: 'x',
      });
      esperarErro(resultado, 'NOME_RESERVADO');
    }
  });
});

describe('N14', () => {
  test('2 criar_processo concorrentes → exatamente um PROCESSO_JA_EXISTE e um processo.json', async () => {
    await ambiente.chamar('registrar_vocabulario', { projeto: 'p1', dono: 'nucleo' });

    const [a, b] = await Promise.all([
      ambiente.chamar('criar_processo', { projeto: 'p1', processo: 'proc1' }),
      ambiente.chamar('criar_processo', { projeto: 'p1', processo: 'proc1' }),
    ]);

    const erros = [a, b].filter((r) => r.isError === true);
    const sucessos = [a, b].filter((r) => r.isError !== true);
    expect(erros).toHaveLength(1);
    expect(sucessos).toHaveLength(1);
    expect((erros[0]?.structuredContent as { codigo: string }).codigo).toBe('PROCESSO_JA_EXISTE');
    expect(fs.existsSync(path.join(ambiente.dir, 'p1', 'proc1', 'processo.json'))).toBe(true);
  });

  test('criar_processo sem nenhum vocabulário registrado → VOCABULARIO_AUSENTE', async () => {
    const resultado = await ambiente.chamar('criar_processo', {
      projeto: 'sem-vocab',
      processo: 'proc1',
    });
    esperarErro(resultado, 'VOCABULARIO_AUSENTE');
  });
});

describe('listar', () => {
  test('sem parâmetros: projetos existentes com a contagem de processos, e gatesEmbutidos sempre presente', async () => {
    await prepararProcesso(ambiente, 'p1', 'proc1');

    const resultado = await ambiente.chamar('listar', {});
    const corpo = resultado.structuredContent as {
      projetos: { nome: string; processos: number }[];
      gatesEmbutidos: unknown[];
    };
    expect(corpo.projetos).toEqual(expect.arrayContaining([{ nome: 'p1', processos: 1 }]));
    expect(corpo.gatesEmbutidos).toHaveLength(4);
  });

  test('processo sem projeto, ou tipo sem processo → ENTRADA_INVALIDA', async () => {
    esperarErro(await ambiente.chamar('listar', { processo: 'proc1' }), 'ENTRADA_INVALIDA');
    esperarErro(
      await ambiente.chamar('listar', { projeto: 'p1', tipo: 'nota' }),
      'ENTRADA_INVALIDA',
    );
  });

  test('projeto inexistente → PROJETO_INEXISTENTE', async () => {
    esperarErro(await ambiente.chamar('listar', { projeto: 'fantasma' }), 'PROJETO_INEXISTENTE');
  });

  test('processo inexistente → PROCESSO_INEXISTENTE', async () => {
    await ambiente.chamar('registrar_vocabulario', { projeto: 'p1', dono: 'nucleo' });
    esperarErro(
      await ambiente.chamar('listar', { projeto: 'p1', processo: 'fantasma' }),
      'PROCESSO_INEXISTENTE',
    );
  });

  test('tipo fora do snapshot do processo → TIPO_INEXISTENTE', async () => {
    await prepararProcesso(ambiente, 'p1', 'proc1');
    esperarErro(
      await ambiente.chamar('listar', { projeto: 'p1', processo: 'proc1', tipo: 'fantasma' }),
      'TIPO_INEXISTENTE',
    );
  });

  test('ignora diretórios reservados e diretórios de processo sem manifesto', async () => {
    await prepararProcesso(ambiente, 'p1', 'proc1');
    fs.mkdirSync(path.join(ambiente.dir, 'p1', 'processo-sem-manifesto'));

    const resultado = await ambiente.chamar('listar', { projeto: 'p1' });
    const processos = (
      resultado.structuredContent as { projeto: { processos: { nome: string }[] } }
    ).projeto.processos;
    expect(processos.map((p) => p.nome)).toEqual(['proc1']);
  });
});

describe('logger', () => {
  test('toda chamada gera um registro tool com nome e ms; erro também traz codigo', async () => {
    await ambiente.chamar('listar', {});
    const registroSucesso = ambiente.registros.find(
      (r) => r.evento === 'tool' && r.nome === 'listar',
    );
    expect(registroSucesso).toBeDefined();
    expect(typeof registroSucesso?.ms).toBe('number');
    expect(registroSucesso?.codigo).toBeUndefined();

    await ambiente.chamar('listar', { projeto: 'fantasma' });
    const chamadasListar = ambiente.registros.filter(
      (r) => r.evento === 'tool' && r.nome === 'listar',
    );
    expect(last(chamadasListar)?.codigo).toBe('PROJETO_INEXISTENTE');
  });
});
