import { afterEach, beforeEach, describe, expect, jest, test } from '@jest/globals';
import MiniSearch from 'minisearch';
import { expectError } from '../helpers.ts';
import { createEnvironment } from './environment.ts';
import type { Environment } from './environment.ts';

const PROJECT = 'alpha';
const PROCESS = 'run-1';
const AGENT = 'executor';
const NOTE = {
  type: 'object',
  properties: { text: { type: 'string' } },
  required: ['text'],
  additionalProperties: false,
};

const TOOLS = [
  'create_process',
  'register',
  'attach',
  'define_type',
  'define_relation',
  'define_gate',
  'query',
  'evaluate_gate',
  'verify_chain',
  'read_attachment',
  'list',
];

const item = (extra: Record<string, unknown> = {}) => ({
  type: 'note',
  target: 'run.step',
  data: { text: 'x' },
  ...extra,
});

const registerInput = (extra: Record<string, unknown> = {}) => ({
  project: PROJECT,
  process: PROCESS,
  agent: AGENT,
  records: [item()],
  ...extra,
});

// Uma entrada válida por tool: o campo desconhecido é a única razão da recusa.
const VALID_INPUT: Record<string, Record<string, unknown>> = {
  create_process: { project: PROJECT, process: PROCESS },
  register: registerInput(),
  attach: { project: PROJECT, text: 'x' },
  define_type: { project: PROJECT, name: 'note', schema: NOTE },
  define_relation: { project: PROJECT, name: 'rel', kind: 'supports' },
  define_gate: {
    project: PROJECT,
    name: 'gate',
    questions: [{ kind: 'occurred', select: { type: 'note' } }],
  },
  query: { project: PROJECT },
  evaluate_gate: { project: PROJECT, process: PROCESS, gate: 'gate' },
  verify_chain: { project: PROJECT, process: PROCESS },
  read_attachment: { project: PROJECT, hash: 'a'.repeat(64) },
  list: {},
};

let environment: Environment;

beforeEach(async () => {
  environment = await createEnvironment();
});

afterEach(async () => {
  await environment.close();
});

describe('TM3: entrada fora do schema em qualquer tool', () => {
  test.each(TOOLS)(
    '%s com project de tipo errado devolve INVALID_INPUT com details[].path',
    async (tool) => {
      const result = await environment.call(tool, { project: 42 });

      const body = expectError(result, 'INVALID_INPUT');
      expect(body.message).not.toBe('');
      expect(body.details.length).toBeGreaterThan(0);
      for (const detail of body.details) expect(typeof detail.path).toBe('string');
      expect(JSON.stringify(result)).not.toContain('Input validation error');
    },
  );

  test.each(Object.entries(VALID_INPUT))(
    '%s com campo desconhecido é recusado com unrecognized_keys',
    async (tool, input) => {
      const result = await environment.call(tool, { ...input, ghost: true });

      const body = expectError(result, 'INVALID_INPUT');
      expect(body.details).toEqual(
        expect.arrayContaining([expect.objectContaining({ code: 'unrecognized_keys' })]),
      );
      expect(JSON.stringify(result)).not.toContain('Input validation error');
    },
  );
});

describe('P3/TM3: register recusa o teto de entrada', () => {
  const cases: [string, Record<string, unknown>, string][] = [
    [
      'target com dois pontos',
      { records: [item({ target: 'hex:target:x' })] },
      '/records/0/target',
    ],
    ['alias A_B fora de Name', { records: [item({ alias: 'A_B' })] }, '/records/0/alias'],
    ['key vazia', { key: '' }, '/key'],
    ['key de 201 caracteres', { key: 'k'.repeat(201) }, '/key'],
    ['agent de 101 caracteres', { agent: 'a'.repeat(101) }, '/agent'],
    ['agent com surrogate solto', { agent: 'a\ud800b' }, '/agent'],
    ['model com surrogate solto', { model: 'a\ud800b' }, '/model'],
    ['key com surrogate solto', { key: 'a\ud800b' }, '/key'],
    [
      'relations[0].as fora de Name',
      { records: [item({ relations: [{ to: '@a', as: 'A_B' }] })] },
      '/records/0/relations/0/as',
    ],
    ['lote de 51 registros', { records: Array.from({ length: 51 }, () => item()) }, '/records'],
    [
      'relations acima de 100',
      {
        records: [
          item({ relations: Array.from({ length: 101 }, () => ({ to: '@a', kind: 'supports' })) }),
        ],
      },
      '/records/0/relations',
    ],
    [
      'data acima de 16.000 caracteres canônicos',
      { records: [item({ data: { text: 'x'.repeat(16_001) } })] },
      '/records/0/data',
    ],
  ];

  test.each(cases)(
    '%s dá INVALID_INPUT com details[].path, nunca INTERNAL',
    async (_title, patch, path) => {
      const result = await environment.call('register', registerInput(patch));

      const body = expectError(result, 'INVALID_INPUT');
      expect(body.details).toEqual(expect.arrayContaining([expect.objectContaining({ path })]));
      expect(JSON.stringify(result)).not.toContain('Input validation error');
    },
  );
});

describe('N11: tetos de read_attachment e de query', () => {
  const HASH = 'a'.repeat(64);
  const UUID = '0190a000-0000-7000-8000-000000000000';
  const manyKeys = (count: number, value: string | null) =>
    Object.fromEntries(Array.from({ length: count }, (_, i) => [`k${i}`, value]));

  test.each([
    ['offset negativo', { offset: -1 }, '/offset'],
    ['offset não inteiro', { offset: 1.5 }, '/offset'],
    ['maxChars zero', { maxChars: 0 }, '/maxChars'],
    ['maxChars negativo', { maxChars: -5 }, '/maxChars'],
    ['maxChars não inteiro', { maxChars: 2.5 }, '/maxChars'],
    ['maxChars acima de 24.000', { maxChars: 24_001 }, '/maxChars'],
  ])('read_attachment com %s dá INVALID_INPUT com details[].path', async (_title, patch, path) => {
    const result = await environment.call('read_attachment', {
      project: PROJECT,
      hash: HASH,
      ...patch,
    });

    const body = expectError(result, 'INVALID_INPUT');
    expect(body.details).toEqual(expect.arrayContaining([expect.objectContaining({ path })]));
  });

  test.each([
    ['limit acima de 200', { limit: 201 }, '/limit'],
    ['text acima de 200 caracteres', { text: 't'.repeat(201) }, '/text'],
    ['text com surrogate solto', { text: 'a\ud800b' }, '/text'],
    ['where com valor de surrogate solto', { where: { k: 'a\ud800b' } }, '/where'],
    ['where com chave de surrogate solto', { where: { 'a\ud800b': 'v' } }, '/where'],
    [
      'changesSince com chave de surrogate solto',
      { changesSince: { 'a\ud800b': null } },
      '/changesSince',
    ],
    ['ids acima de 200', { ids: Array.from({ length: 201 }, () => `${PROCESS}:${UUID}`) }, '/ids'],
    ['where com mais de 50 chaves', { where: manyKeys(51, 'v') }, '/where'],
    ['changesSince com mais de 200 chaves', { changesSince: manyKeys(201, null) }, '/changesSince'],
  ])('query com %s dá INVALID_INPUT com details[].path', async (_title, patch, path) => {
    const result = await environment.call('query', {
      project: PROJECT,
      process: PROCESS,
      ...patch,
    });

    const body = expectError(result, 'INVALID_INPUT');
    expect(body.details).toEqual(expect.arrayContaining([expect.objectContaining({ path })]));
  });
});

describe('A-M3: surrogate solto nunca vira INTERNAL', () => {
  const LONE = 'a\ud800b';

  test.each<[string, string, Record<string, unknown>]>([
    ['data do register', 'register', registerInput({ records: [item({ data: { text: LONE } })] })],
    [
      'schema do define_type',
      'define_type',
      { project: PROJECT, name: 'note', schema: { title: LONE } },
    ],
    [
      'where do define_gate',
      'define_gate',
      {
        project: PROJECT,
        name: 'gate',
        questions: [{ kind: 'occurred', select: { type: 'note', where: { k: LONE } } }],
      },
    ],
    [
      'marker do evaluate_gate',
      'evaluate_gate',
      { project: PROJECT, process: PROCESS, gate: 'gate', marker: { [LONE]: null } },
    ],
  ])('%s dá INVALID_INPUT', async (_title, tool, input) => {
    const result = await environment.call(tool, input);

    expectError(result, 'INVALID_INPUT');
  });
});

describe('D5: definições recusam o teto de 16.000 caracteres canônicos', () => {
  test.each<[string, string, Record<string, unknown>]>([
    [
      'define_relation',
      'define_relation',
      {
        name: 'rel',
        kind: 'supports',
        from: Array.from({ length: 300 }, (_, i) => `${'t'.repeat(50)}-${i}`),
      },
    ],
    [
      'define_gate',
      'define_gate',
      {
        name: 'gate',
        questions: Array.from({ length: 50 }, () => ({
          kind: 'occurred',
          select: { type: 'note', where: { k: 'x'.repeat(400) } },
        })),
      },
    ],
  ])('%s acima do teto dá INVALID_INPUT, nunca INTERNAL', async (_title, tool, patch) => {
    const result = await environment.call(tool, { project: PROJECT, ...patch });

    expectError(result, 'INVALID_INPUT');
  });
});

describe('N5: nome herdado de Object.prototype', () => {
  test('processo `constructor` é um nome válido e a consulta não vira INTERNAL', async () => {
    await environment.call('define_type', { project: PROJECT, name: 'note', schema: NOTE });
    await environment.call('create_process', { project: PROJECT, process: 'constructor' });

    const result = await environment.call('query', { project: PROJECT, process: 'constructor' });

    expect(result.isError).toBeFalsy();
    expect(result.structuredContent).toEqual(expect.objectContaining({ records: [] }));
  });

  test('gate `constructor` não fixado dá GATE_NOT_FOUND, não INTERNAL', async () => {
    await environment.call('define_type', { project: PROJECT, name: 'note', schema: NOTE });
    await environment.call('create_process', { project: PROJECT, process: PROCESS });

    const result = await environment.call('evaluate_gate', {
      project: PROJECT,
      process: PROCESS,
      gate: 'constructor',
    });

    expectError(result, 'GATE_NOT_FOUND');
  });
});

describe('exceção que não é HexlogError', () => {
  const addAll = jest.spyOn(MiniSearch.prototype, 'addAll');

  afterEach(() => {
    addAll.mockReset();
    addAll.mockRestore();
  });

  test('vira INTERNAL sem stack nem texto da exceção na resposta', async () => {
    await environment.call('define_type', { project: PROJECT, name: 'note', schema: NOTE });
    await environment.call('create_process', { project: PROJECT, process: PROCESS });
    await environment.call('register', registerInput());
    addAll.mockImplementation(() => {
      throw new Error('boom');
    });

    const result = await environment.call('query', {
      project: PROJECT,
      process: PROCESS,
      text: 'x',
    });

    const body = expectError(result, 'INTERNAL');
    expect(body.details).toEqual([]);
    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain('boom');
    expect(serialized).not.toMatch(/\n\s+at |\.ts:\d+/);
  });
});
