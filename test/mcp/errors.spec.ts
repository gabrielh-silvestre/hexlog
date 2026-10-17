import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';
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

const HASH = 'a'.repeat(64);

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
  read_attachment: { project: PROJECT, hash: HASH },
  list: {},
  describe_type: { project: PROJECT, type: 'note' },
};

// JSON.parse cria `__proto__` como chave própria, o que um literal de objeto não faz.
const hostile = (json: string): unknown => JSON.parse(json);

const nest = (levels: number): Record<string, unknown> =>
  Array.from({ length: levels }).reduce<Record<string, unknown>>((inner) => ({ a: inner }), {});

let environment: Environment;

// Cada describe de topo liga estas funções aos hooks: `jest/require-top-level-describe` barra hook fora de describe.
const openEnvironment = async () => {
  environment = await createEnvironment();
};

const closeEnvironment = async () => {
  await environment.close();
};

describe('tools/call', () => {
  beforeEach(openEnvironment);
  afterEach(closeEnvironment);

  it.each(TOOLS.map((name) => ({ name })))(
    'should refuse a project of the wrong type for $name with INVALID_INPUT and details[].path (TM3)',
    async ({ name }) => {
      const result = await environment.call(name, { project: 42 });

      const body = expectError(result, 'INVALID_INPUT');

      expect(body.message).not.toBe('');
      expect(body.details.length).toBeGreaterThan(0);

      for (const detail of body.details) expect(typeof detail.path).toBe('string');

      expect(JSON.stringify(result)).not.toContain('Input validation error');
    },
  );

  it.each(Object.entries(VALID_INPUT).map(([name, input]) => ({ name, input })))(
    'should refuse an unknown field for $name with unrecognized_keys (TM3)',
    async ({ name, input }) => {
      const result = await environment.call(name, { ...input, ghost: true });

      const body = expectError(result, 'INVALID_INPUT');

      expect(body.details).toEqual(
        expect.arrayContaining([expect.objectContaining({ code: 'unrecognized_keys' })]),
      );
      expect(JSON.stringify(result)).not.toContain('Input validation error');
    },
  );
});

describe('register', () => {
  beforeEach(openEnvironment);
  afterEach(closeEnvironment);

  it.each([
    {
      scenario: 'a target with colons',
      patch: { records: [item({ target: 'hex:target:x' })] },
      path: '/records/0/target',
    },
    { scenario: 'a key of 201 characters', patch: { key: 'k'.repeat(201) }, path: '/key' },
    {
      scenario: 'a batch of 51 records',
      patch: { records: Array.from({ length: 51 }, () => item()) },
      path: '/records',
    },
  ])(
    'should refuse $scenario with INVALID_INPUT and details[].path, never INTERNAL (P3, TM3)',
    async ({ patch, path }) => {
      const result = await environment.call('register', registerInput(patch));

      const body = expectError(result, 'INVALID_INPUT');

      expect(body.details).toEqual(expect.arrayContaining([expect.objectContaining({ path })]));
      expect(JSON.stringify(result)).not.toContain('Input validation error');
    },
  );

  it('should refuse an own __proto__ key in the record data with INVALID_INPUT and reserved-key (N5)', async () => {
    const args = registerInput({
      records: [item({ data: hostile('{"__proto__":{"a":1},"text":"x"}') })],
    });

    const result = await environment.call('register', args);

    const body = expectError(result, 'INVALID_INPUT');

    expect(body.details).toEqual([
      expect.objectContaining({ path: '/records/0/data/__proto__', code: 'reserved-key' }),
    ]);
  });

  it('should write nothing when register is refused for an own __proto__ key (N5)', async () => {
    await environment.call('define_type', { project: PROJECT, name: 'note', schema: NOTE });
    await environment.call('create_process', { project: PROJECT, process: PROCESS });
    const args = registerInput({
      records: [item({ data: hostile('{"__proto__":{"a":1},"text":"x"}') })],
    });

    await environment.call('register', args);

    const page = await environment.ok<{ records: unknown[] }>('query', {
      project: PROJECT,
      process: PROCESS,
    });

    expect(page.records).toEqual([]);
  });

  it('should refuse 2,000 levels in the record data with INVALID_INPUT too-deep, not INTERNAL (M7)', async () => {
    const result = await environment.call(
      'register',
      registerInput({ records: [item({ data: nest(2000) })] }),
    );

    const body = expectError(result, 'INVALID_INPUT');

    expect(body.details).toEqual([expect.objectContaining({ code: 'too-deep' })]);
  });
});

describe('define_type', () => {
  beforeEach(openEnvironment);
  afterEach(closeEnvironment);

  it('should refuse 2,000 levels in the schema with INVALID_INPUT too-deep, not INTERNAL (M7)', async () => {
    const result = await environment.call('define_type', {
      project: PROJECT,
      name: 'deep',
      schema: nest(2000),
    });

    const body = expectError(result, 'INVALID_INPUT');

    expect(body.details).toEqual([expect.objectContaining({ code: 'too-deep' })]);
  });
});

describe('define_gate', () => {
  beforeEach(openEnvironment);
  afterEach(closeEnvironment);

  it('should refuse an own __proto__ key in the select where with INVALID_INPUT and reserved-key (N5)', async () => {
    const result = await environment.call('define_gate', {
      project: PROJECT,
      name: 'gate',
      questions: [{ kind: 'occurred', select: { where: hostile('{"__proto__":"x"}') } }],
    });

    const body = expectError(result, 'INVALID_INPUT');

    expect(body.details).toEqual([
      expect.objectContaining({
        path: '/questions/0/select/where/__proto__',
        code: 'reserved-key',
      }),
    ]);
  });
});

describe('query', () => {
  beforeEach(openEnvironment);
  afterEach(closeEnvironment);

  const UUID = '0190a000-0000-7000-8000-000000000000';
  const manyKeys = (count: number, value: string | null) =>
    Object.fromEntries(Array.from({ length: count }, (_, i) => [`k${i}`, value]));

  it.each([
    { scenario: 'a limit above 200', patch: { limit: 201 }, path: '/limit' },
    { scenario: 'a text above 200 characters', patch: { text: 't'.repeat(201) }, path: '/text' },
    { scenario: 'a text with a lone surrogate', patch: { text: 'a\ud800b' }, path: '/text' },
    {
      scenario: 'a where with a lone surrogate value',
      patch: { where: { k: 'a\ud800b' } },
      path: '/where',
    },
    {
      scenario: 'a where with a lone surrogate key',
      patch: { where: { 'a\ud800b': 'v' } },
      path: '/where',
    },
    {
      scenario: 'a changesSince with a lone surrogate key',
      patch: { changesSince: { 'a\ud800b': null } },
      path: '/changesSince',
    },
    {
      scenario: 'ids above 200',
      patch: { ids: Array.from({ length: 201 }, () => `${PROCESS}:${UUID}`) },
      path: '/ids',
    },
    {
      scenario: 'a where with more than 50 keys',
      patch: { where: manyKeys(51, 'v') },
      path: '/where',
    },
    {
      scenario: 'fields with 51 names',
      patch: { fields: Array.from({ length: 51 }, (_, i) => `f${i}`) },
      path: '/fields',
    },
    { scenario: 'fields with an empty name', patch: { fields: [''] }, path: '/fields/0' },
    {
      scenario: 'a changesSince with more than 200 keys',
      patch: { changesSince: manyKeys(201, null) },
      path: '/changesSince',
    },
  ])(
    'should refuse $scenario with INVALID_INPUT and details[].path (N11)',
    async ({ patch, path }) => {
      const result = await environment.call('query', {
        project: PROJECT,
        process: PROCESS,
        ...patch,
      });

      const body = expectError(result, 'INVALID_INPUT');

      expect(body.details).toEqual(expect.arrayContaining([expect.objectContaining({ path })]));
    },
  );

  // Entrada exatamente no teto passa do zod: o erro vem do serviço, não de INVALID_INPUT.
  it.each([
    { scenario: 'a limit of 200', patch: { limit: 200 } },
    { scenario: 'a text of 200 characters', patch: { text: 't'.repeat(200) } },
    {
      scenario: 'ids with 200 items',
      patch: { ids: Array.from({ length: 200 }, () => `${PROCESS}:${UUID}`) },
    },
    { scenario: 'a where with 50 keys', patch: { where: manyKeys(50, 'v') } },
    {
      scenario: 'fields with 50 names',
      patch: { fields: Array.from({ length: 50 }, (_, i) => `f${i}`) },
    },
    { scenario: 'a changesSince with 200 keys', patch: { changesSince: manyKeys(200, null) } },
  ])('should let $scenario through to the service (N11)', async ({ patch }) => {
    const result = await environment.call('query', {
      project: PROJECT,
      process: PROCESS,
      ...patch,
    });

    expectError(result, 'PROCESS_NOT_FOUND');
  });

  it('should refuse an own __proto__ key in where with INVALID_INPUT and reserved-key (N5)', async () => {
    const result = await environment.call('query', {
      project: PROJECT,
      process: PROCESS,
      where: hostile('{"__proto__":"x"}'),
    });

    const body = expectError(result, 'INVALID_INPUT');

    expect(body.details).toEqual([
      expect.objectContaining({ path: '/where/__proto__', code: 'reserved-key' }),
    ]);
  });

  describe('with an exception that is not a HexlogError', () => {
    afterEach(() => {
      jest.restoreAllMocks();
    });

    it('should turn it into INTERNAL without stack or exception text in the response', async () => {
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
});

describe('read_attachment', () => {
  beforeEach(openEnvironment);
  afterEach(closeEnvironment);

  it.each([
    { scenario: 'a negative offset', patch: { offset: -1 }, path: '/offset' },
    { scenario: 'a non-integer offset', patch: { offset: 1.5 }, path: '/offset' },
    { scenario: 'a zero maxChars', patch: { maxChars: 0 }, path: '/maxChars' },
    { scenario: 'a negative maxChars', patch: { maxChars: -5 }, path: '/maxChars' },
    { scenario: 'a non-integer maxChars', patch: { maxChars: 2.5 }, path: '/maxChars' },
    { scenario: 'a maxChars above 24,000', patch: { maxChars: 24_001 }, path: '/maxChars' },
  ])(
    'should refuse $scenario with INVALID_INPUT and details[].path (N11)',
    async ({ patch, path }) => {
      const result = await environment.call('read_attachment', {
        project: PROJECT,
        hash: HASH,
        ...patch,
      });

      const body = expectError(result, 'INVALID_INPUT');

      expect(body.details).toEqual(expect.arrayContaining([expect.objectContaining({ path })]));
    },
  );

  it('should let a maxChars of 24,000 through to the service (N11)', async () => {
    const result = await environment.call('read_attachment', {
      project: PROJECT,
      hash: HASH,
      maxChars: 24_000,
    });

    expectError(result, 'ATTACHMENT_NOT_FOUND');
  });
});
