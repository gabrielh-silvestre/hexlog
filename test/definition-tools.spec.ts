import { afterEach, beforeEach, describe, expect, test } from '@jest/globals';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { Client } from '@modelcontextprotocol/client';
import { InMemoryTransport, McpServer } from '@modelcontextprotocol/server';
import { last } from 'es-toolkit';
import { z } from 'zod';
import { execute } from '../src/mcp.ts';
import type { LogRecord } from '../src/log.ts';
import {
  type Environment,
  createEnvironment,
  expectError,
  parseJson,
  registerCore,
} from './helpers.ts';

const VALID_SCHEMA = {
  type: 'object',
  properties: { note: { type: 'string' } },
  required: ['note'],
  additionalProperties: false,
};

// Forma de schemas/<nome>.json gravado por `register_type` (S1).
const TypeRecordSchema = z.object({ schema: z.record(z.string(), z.unknown()) });

/** Registra vocabulário núcleo, um tipo e um gate custom, depois fixa `process` (setup comum a vários ACs). */
async function prepareProcess(environment: Environment, project: string, process: string) {
  await registerCore(environment, project);
  const type = await environment.call('register_type', {
    project,
    name: 'note',
    schema: VALID_SCHEMA,
  });
  await environment.call('register_gate', {
    project,
    name: 'custom-gate',
    criteria: 'any criteria',
  });
  const created = await environment.call('create_process', { project, process });
  return { type, created };
}

let environment: Environment;

beforeEach(async () => {
  environment = await createEnvironment();
});

afterEach(async () => {
  await environment.close();
});

describe('M2', () => {
  const INVALID_NAMES = ['..', 'a/b', 'A', '', '-a', 'a'.repeat(64)];

  const CASES: { tool: string; field: string; base: Record<string, unknown> }[] = [
    {
      tool: 'create_process',
      field: 'project',
      base: { project: 'valid-project', process: 'valid-process' },
    },
    {
      tool: 'create_process',
      field: 'process',
      base: { project: 'valid-project', process: 'valid-process' },
    },
    {
      tool: 'register_type',
      field: 'project',
      base: { project: 'valid-project', name: 'valid-type', schema: VALID_SCHEMA },
    },
    {
      tool: 'register_type',
      field: 'name',
      base: { project: 'valid-project', name: 'valid-type', schema: VALID_SCHEMA },
    },
    {
      tool: 'register_vocabulary',
      field: 'project',
      base: { project: 'valid-project', owner: 'core' },
    },
    {
      tool: 'register_vocabulary',
      field: 'owner',
      base: { project: 'valid-project', owner: 'core' },
    },
    {
      tool: 'register_gate',
      field: 'project',
      base: { project: 'valid-project', name: 'valid-gate', criteria: 'any criteria' },
    },
    {
      tool: 'register_gate',
      field: 'name',
      base: { project: 'valid-project', name: 'valid-gate', criteria: 'any criteria' },
    },
    { tool: 'list', field: 'project', base: {} },
    { tool: 'list', field: 'process', base: { project: 'valid-project' } },
  ];

  for (const { tool, field, base } of CASES) {
    for (const invalidName of INVALID_NAMES) {
      test(`${tool}({${field}: ${JSON.stringify(invalidName)}}) → Input validation error, árvore intacta`, async () => {
        const before = environment.tree();
        const result = await environment.call(tool, { ...base, [field]: invalidName });
        expect(result.isError).toBe(true);
        expect(result.content?.[0]?.text).toMatch(/^Input validation error/);
        expect(environment.tree()).toEqual(before);
      });
    }
  }
});

describe('M7', () => {
  test('register_type com schema reprovado pelo Ajv → INVALID_SCHEMA estruturado', async () => {
    const result = await environment.call('register_type', {
      project: 'p1',
      name: 'bad',
      schema: { typ: 'object' },
    });
    const body = expectError(result, 'INVALID_SCHEMA');
    expect(body.details.length).toBeGreaterThan(0);
    expect(body.details[0]?.path.startsWith('/')).toBe(true);
    expect(body.message.length).toBeGreaterThan(0);
  });

  test('register_type com schema: [] → Input validation error (forma), sem chegar ao handler', async () => {
    const result = await environment.call('register_type', {
      project: 'p1',
      name: 'bad',
      schema: [],
    });
    expect(result.isError).toBe(true);
    expect(result.content?.[0]?.text).toMatch(/^Input validation error/);
  });

  test('handler que lança exceção interna devolve INTERNAL estruturado, nunca a exceção crua', async () => {
    const [serverTransport, clientTransport] = InMemoryTransport.createLinkedPair();
    const testServer = new McpServer({ name: 'internal-test', version: '0.0.0' });
    const logs: LogRecord[] = [];
    const testCtx = {
      dataDir: environment.dir,
      clock: () => new Date(),
      log: (r: LogRecord) => logs.push(r),
    };

    testServer.registerTool(
      'explode',
      {
        description: 'intentionally throws an internal exception',
        inputSchema: {},
        outputSchema: { ok: z.boolean() },
      },
      async () =>
        execute(testCtx, 'explode', {}, () => {
          throw new Error('boom');
        }),
    );

    const testClient = new Client({ name: 'test-client', version: '0.0.0' });
    await Promise.all([testServer.connect(serverTransport), testClient.connect(clientTransport)]);
    const result = (await testClient.callTool({ name: 'explode', arguments: {} })) as {
      isError?: boolean;
      structuredContent?: { code?: string };
    };

    expect(result.isError).toBe(true);
    expect(result.structuredContent?.code).toBe('INTERNAL');
    expect(
      logs.some((record) => record.event === 'internal-error' && typeof record.stack === 'string'),
    ).toBe(true);
    await testClient.close();
  });
});

describe('M8', () => {
  test('list {processo} não traz schema dos tipos; list {tipo} traz o schema fixado', async () => {
    const { type } = await prepareProcess(environment, 'p1', 'proc1');

    const processResult = await environment.call('list', { project: 'p1', process: 'proc1' });
    const types = (
      processResult.structuredContent as {
        process: { types: { name: string; hash: string; schema?: unknown }[] };
      }
    ).process.types;
    expect(types).toEqual([
      { name: 'note', hash: (type.structuredContent as { hash: string }).hash },
    ]);
    expect(types[0]).not.toHaveProperty('schema');

    const typeResult = await environment.call('list', {
      project: 'p1',
      process: 'proc1',
      type: 'note',
    });
    expect(typeResult.structuredContent).toEqual({
      builtinGates: (typeResult.structuredContent as { builtinGates: unknown }).builtinGates,
      type: {
        name: 'note',
        hash: (type.structuredContent as { hash: string }).hash,
        schema: VALID_SCHEMA,
      },
    });
  });
});

describe('M9', () => {
  test('annotations das 5 tools de definição batem com §4.12', async () => {
    const { tools } = await environment.client.listTools();
    const byName = Object.fromEntries(tools.map((tool) => [tool.name, tool.annotations]));

    expect(byName.list).toMatchObject({
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    });
    for (const name of ['register_type', 'register_vocabulary', 'register_gate']) {
      expect(byName[name]).toMatchObject({
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: true,
        openWorldHint: false,
      });
    }
    expect(byName.create_process).toMatchObject({
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: false,
    });
  });
});

describe('S1', () => {
  test('register_type grava schemas/<nome>/<versão>.json com o schema exato', async () => {
    await environment.call('register_type', { project: 'p1', name: 'note', schema: VALID_SCHEMA });
    const written = parseJson(
      TypeRecordSchema,
      fs.readFileSync(path.join(environment.dir, 'p1', 'schemas', 'note', '1.0.json'), 'utf8'),
    );
    expect(written.schema).toEqual(VALID_SCHEMA);
  });

  test('rejeita schema inválido, $ref externo e nomes reservados, sem gravar', async () => {
    const before = environment.tree();

    const invalid = await environment.call('register_type', {
      project: 'p1',
      name: 'bad',
      schema: { typ: 'object' },
    });
    expectError(invalid, 'INVALID_SCHEMA');

    const externalRef = await environment.call('register_type', {
      project: 'p1',
      name: 'with-ref',
      schema: {
        type: 'object',
        properties: { x: { $ref: 'https://example.invalid/schema.json' } },
      },
    });
    expectError(externalRef, 'INVALID_SCHEMA');

    const milestone = await environment.call('register_type', {
      project: 'p1',
      name: 'milestone',
      schema: VALID_SCHEMA,
    });
    expectError(milestone, 'RESERVED_NAME');

    const verdict = await environment.call('register_type', {
      project: 'p1',
      name: 'verdict',
      schema: VALID_SCHEMA,
    });
    expectError(verdict, 'RESERVED_NAME');

    expect(environment.tree()).toEqual(before);
  });
});

describe('S8', () => {
  test('create_process com processo reservado → RESERVED_NAME', async () => {
    for (const processName of ['schemas', 'vocabulary', 'gates']) {
      const result = await environment.call('create_process', {
        project: 'p1',
        process: processName,
      });
      expectError(result, 'RESERVED_NAME');
    }
  });

  test('register_gate com nome de gate embutido → RESERVED_NAME', async () => {
    for (const name of ['no-orphans', 'no-conflicts', 'chain-intact', 'no-invalid-references']) {
      const result = await environment.call('register_gate', {
        project: 'p1',
        name,
        criteria: 'x',
      });
      expectError(result, 'RESERVED_NAME');
    }
  });
});

describe('N14', () => {
  test('2 create_process concorrentes → exatamente um PROCESS_ALREADY_EXISTS e um process.json', async () => {
    await environment.call('register_vocabulary', { project: 'p1', owner: 'core' });

    const [a, b] = await Promise.all([
      environment.call('create_process', { project: 'p1', process: 'proc1' }),
      environment.call('create_process', { project: 'p1', process: 'proc1' }),
    ]);

    const errors = [a, b].filter((r) => r.isError === true);
    const successes = [a, b].filter((r) => r.isError !== true);
    expect(errors).toHaveLength(1);
    expect(successes).toHaveLength(1);
    expect((errors[0]?.structuredContent as { code: string }).code).toBe('PROCESS_ALREADY_EXISTS');
    expect(fs.existsSync(path.join(environment.dir, 'p1', 'proc1', 'process.json'))).toBe(true);
  });

  test('create_process sem nenhum vocabulário registrado → VOCABULARY_MISSING', async () => {
    const result = await environment.call('create_process', {
      project: 'no-vocab',
      process: 'proc1',
    });
    expectError(result, 'VOCABULARY_MISSING');
  });
});

describe('list', () => {
  test('sem parâmetros: projetos existentes com a contagem de processos, e builtinGates sempre presente', async () => {
    await prepareProcess(environment, 'p1', 'proc1');

    const result = await environment.call('list', {});
    const body = result.structuredContent as {
      projects: { name: string; processes: number }[];
      builtinGates: unknown[];
    };
    expect(body.projects).toEqual(expect.arrayContaining([{ name: 'p1', processes: 1 }]));
    expect(body.builtinGates).toHaveLength(4);
  });

  test('processo sem projeto, ou tipo sem processo → INVALID_INPUT', async () => {
    expectError(await environment.call('list', { process: 'proc1' }), 'INVALID_INPUT');
    expectError(await environment.call('list', { project: 'p1', type: 'note' }), 'INVALID_INPUT');
  });

  test('projeto inexistente → PROJECT_NOT_FOUND', async () => {
    expectError(await environment.call('list', { project: 'ghost' }), 'PROJECT_NOT_FOUND');
  });

  test('processo inexistente → PROCESS_NOT_FOUND', async () => {
    await environment.call('register_vocabulary', { project: 'p1', owner: 'core' });
    expectError(
      await environment.call('list', { project: 'p1', process: 'ghost' }),
      'PROCESS_NOT_FOUND',
    );
  });

  test('tipo fora do snapshot do processo → TYPE_NOT_FOUND', async () => {
    await prepareProcess(environment, 'p1', 'proc1');
    expectError(
      await environment.call('list', { project: 'p1', process: 'proc1', type: 'ghost' }),
      'TYPE_NOT_FOUND',
    );
  });

  test('ignora diretórios reservados e diretórios de processo sem manifesto', async () => {
    await prepareProcess(environment, 'p1', 'proc1');
    fs.mkdirSync(path.join(environment.dir, 'p1', 'process-without-manifest'));

    const result = await environment.call('list', { project: 'p1' });
    const processes = (result.structuredContent as { project: { processes: { name: string }[] } })
      .project.processes;
    expect(processes.map((p) => p.name)).toEqual(['proc1']);
  });
});

describe('leva 7', () => {
  test('register_vocabulary aceita breaking: true e bumpa major numa remoção de termo fechado', async () => {
    await environment.call('register_vocabulary', {
      project: 'p1',
      owner: 'owner-x',
      milestoneType: ['a', 'b'],
    });

    const result = await environment.call('register_vocabulary', {
      project: 'p1',
      owner: 'owner-x',
      milestoneType: ['a'],
      breaking: true,
    });

    expect(result.isError).not.toBe(true);
    expect(result.structuredContent).toMatchObject({ version: '2.0', previousVersion: '1.0' });
  });

  test('register_gate aceita breaking: true (gate nunca quebra, mas o campo é aceito e vira aviso)', async () => {
    await environment.call('register_gate', { project: 'p1', name: 'g1', criteria: 'v1' });

    const result = await environment.call('register_gate', {
      project: 'p1',
      name: 'g1',
      criteria: 'v2',
      breaking: true,
    });

    expect(result.isError).not.toBe(true);
    const body = result.structuredContent as { version: string; warnings: { code: string }[] };
    expect(body.version).toBe('1.1');
    expect(body.warnings).toContainEqual(expect.objectContaining({ code: 'NO_BREAKING_CHANGE' }));
  });

  test('list nível projeto: version/versions para um nome com múltiplas versões e um nome só-legado', async () => {
    await environment.call('register_gate', { project: 'p1', name: 'g-multi', criteria: 'v1' });
    await environment.call('register_gate', { project: 'p1', name: 'g-multi', criteria: 'v2' });

    const gatesDir = path.join(environment.dir, 'p1', 'gates');
    fs.mkdirSync(gatesDir, { recursive: true });
    fs.writeFileSync(
      path.join(gatesDir, 'g-legacy.json'),
      JSON.stringify({ name: 'g-legacy', criteria: 'legacy', hash: 'a'.repeat(64) }),
    );

    const result = await environment.call('list', { project: 'p1' });
    const gates = (
      result.structuredContent as {
        project: { gates: { name: string; version: string; versions: string[] }[] };
      }
    ).project.gates;

    expect(gates).toContainEqual(
      expect.objectContaining({ name: 'g-multi', version: '1.1', versions: ['1.0', '1.1'] }),
    );
    expect(gates).toContainEqual(
      expect.objectContaining({ name: 'g-legacy', version: '1.0', versions: ['1.0'] }),
    );
  });

  test('list nível processo: traz versions do manifesto; processo legado (sem o campo) não traz o bloco', async () => {
    await prepareProcess(environment, 'p1', 'proc1');

    const withVersions = await environment.call('list', { project: 'p1', process: 'proc1' });
    const body = withVersions.structuredContent as {
      process: { versions?: { types: Record<string, string> } };
    };
    expect(body.process.versions).toMatchObject({ types: { note: '1.0' } });

    const manifestPath = path.join(environment.dir, 'p1', 'proc1', 'process.json');
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8')) as Record<string, unknown>;
    delete manifest.versions;
    fs.writeFileSync(manifestPath, JSON.stringify(manifest));

    const legacyResult = await environment.call('list', { project: 'p1', process: 'proc1' });
    const legacyBody = legacyResult.structuredContent as { process: Record<string, unknown> };
    expect(legacyBody.process).not.toHaveProperty('versions');
  });
});

describe('logger', () => {
  test('toda chamada gera um registro tool com nome e ms; erro também traz code', async () => {
    await environment.call('list', {});
    const successRecord = environment.records.find((r) => r.event === 'tool' && r.name === 'list');
    expect(successRecord).toBeDefined();
    expect(typeof successRecord?.ms).toBe('number');
    expect(successRecord?.code).toBeUndefined();

    await environment.call('list', { project: 'ghost' });
    const listCalls = environment.records.filter((r) => r.event === 'tool' && r.name === 'list');
    expect(last(listCalls)?.code).toBe('PROJECT_NOT_FOUND');
  });
});
