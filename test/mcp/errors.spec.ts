import { afterEach, beforeEach, describe, expect, jest, test } from '@jest/globals';
import MiniSearch from 'minisearch';
import { createEnvironment, expectError } from './environment.ts';
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
  'describe_type',
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
  describe_type: { project: PROJECT, type: 'note' },
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
    ['key de 201 caracteres', { key: 'k'.repeat(201) }, '/key'],
    ['lote de 51 registros', { records: Array.from({ length: 51 }, () => item()) }, '/records'],
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
    ['fields com 51 nomes', { fields: Array.from({ length: 51 }, (_, i) => `f${i}`) }, '/fields'],
    ['fields com nome vazio', { fields: [''] }, '/fields/0'],
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

describe('N5: chave própria __proto__ nos args crus', () => {
  // JSON.parse cria `__proto__` como chave própria, o que um literal de objeto não faz.
  const hostile = (json: string): unknown => JSON.parse(json);
  const cases: [string, Record<string, unknown>, string][] = [
    [
      'register',
      registerInput({ records: [item({ data: hostile('{"__proto__":{"a":1},"text":"x"}') })] }),
      '/records/0/data/__proto__',
    ],
    [
      'query',
      { project: PROJECT, process: PROCESS, where: hostile('{"__proto__":"x"}') },
      '/where/__proto__',
    ],
    [
      'define_gate',
      {
        project: PROJECT,
        name: 'gate',
        questions: [{ kind: 'occurred', select: { where: hostile('{"__proto__":"x"}') } }],
      },
      '/questions/0/select/where/__proto__',
    ],
  ];

  test.each(cases)(
    '%s recusa a chave com INVALID_INPUT e reserved-key',
    async (tool, args, path) => {
      const result = await environment.call(tool, args);

      const body = expectError(result, 'INVALID_INPUT');
      expect(body.details).toEqual([expect.objectContaining({ path, code: 'reserved-key' })]);
    },
  );

  test('register recusado não grava nada', async () => {
    await environment.call('define_type', { project: PROJECT, name: 'note', schema: NOTE });
    await environment.call('create_process', { project: PROJECT, process: PROCESS });

    await environment.call('register', cases[0]![1]);

    const page = await environment.ok<{ records: unknown[] }>('query', {
      project: PROJECT,
      process: PROCESS,
    });
    expect(page.records).toEqual([]);
  });
});

describe('M7: aninhamento acima de 64 níveis nos args crus', () => {
  const nest = (levels: number): Record<string, unknown> =>
    Array.from({ length: levels }).reduce<Record<string, unknown>>((inner) => ({ a: inner }), {});

  test('data de register com 2.000 níveis é INVALID_INPUT too-deep, não INTERNAL', async () => {
    const result = await environment.call(
      'register',
      registerInput({ records: [item({ data: nest(2000) })] }),
    );

    const body = expectError(result, 'INVALID_INPUT');
    expect(body.details).toEqual([expect.objectContaining({ code: 'too-deep' })]);
  });

  test('schema de define_type com 2.000 níveis é INVALID_INPUT too-deep, não INTERNAL', async () => {
    const result = await environment.call('define_type', {
      project: PROJECT,
      name: 'deep',
      schema: nest(2000),
    });

    const body = expectError(result, 'INVALID_INPUT');
    expect(body.details).toEqual([expect.objectContaining({ code: 'too-deep' })]);
  });
});

describe('exceção que não é HexlogError', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  test('vira INTERNAL sem stack nem texto da exceção na resposta', async () => {
    await environment.call('define_type', { project: PROJECT, name: 'note', schema: NOTE });
    await environment.call('create_process', { project: PROJECT, process: PROCESS });
    await environment.call('register', registerInput());
    jest.spyOn(MiniSearch.prototype, 'addAll').mockImplementation(() => {
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
