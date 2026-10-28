import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';
import MiniSearch from 'minisearch';
import { NOTE_SCHEMA, PROJECT, createEnvironment, expectError, nest } from './environment.ts';
import type { Environment, ToolName } from './environment.ts';

const PROCESS = 'run-1';
const AGENT = 'executor';

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
const VALID_INPUT: Record<ToolName, Record<string, unknown>> = {
  create_process: { project: PROJECT, process: PROCESS },
  register: registerInput(),
  attach: { project: PROJECT, text: 'x' },
  define_type: { project: PROJECT, name: 'note', schema: NOTE_SCHEMA },
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

const TOOLS = Object.keys(VALID_INPUT);

let environment: Environment;

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
    'should refuse a project of the wrong type for $name with INVALID_INPUT and details[].path',
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
    'should refuse an unknown field for $name with unrecognized_keys',
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
    'should refuse $scenario with INVALID_INPUT and details[].path, never INTERNAL',
    async ({ patch, path }) => {
      const result = await environment.call('register', registerInput(patch));

      const body = expectError(result, 'INVALID_INPUT');

      expect(body.details).toEqual(expect.arrayContaining([expect.objectContaining({ path })]));
      expect(JSON.stringify(result)).not.toContain('Input validation error');
    },
  );

  it('should refuse an own __proto__ key in the record data with INVALID_INPUT and reserved-key', async () => {
    const args = registerInput({
      records: [item({ data: hostile('{"__proto__":{"a":1},"text":"x"}') })],
    });

    const body = await environment.fail('register', args, 'INVALID_INPUT');

    expect(body.details).toEqual([
      expect.objectContaining({ path: '/records/0/data/__proto__', code: 'reserved-key' }),
    ]);
  });

  it('should write nothing when register is refused for an own __proto__ key', async () => {
    await environment.ok('define_type', { project: PROJECT, name: 'note', schema: NOTE_SCHEMA });
    await environment.ok('create_process', { project: PROJECT, process: PROCESS });
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

  it('should refuse 2,000 levels in the record data with INVALID_INPUT too-deep, not INTERNAL', async () => {
    const body = await environment.fail(
      'register',
      registerInput({ records: [item({ data: nest(2000) })] }),
      'INVALID_INPUT',
    );

    expect(body.details).toEqual([expect.objectContaining({ code: 'too-deep' })]);
  });

  describe('with data at the 64-level cap of the raw args', () => {
    // A raiz dos args é o nível 1, `records` o 2 e o registro o 3: o `data` de 61 níveis chega ao 64.
    beforeEach(async () => {
      await environment.ok('define_type', {
        project: PROJECT,
        name: 'free',
        schema: { type: 'object' },
      });
      await environment.ok('create_process', { project: PROJECT, process: PROCESS });
    });

    it('should accept data nested 61 levels deep', async () => {
      const result = await environment.call(
        'register',
        registerInput({ records: [item({ type: 'free', data: nest(61) })] }),
      );

      expect(result.isError).not.toBe(true);
    });

    it('should reject data nested 62 levels deep with too-deep', async () => {
      const body = await environment.fail(
        'register',
        registerInput({ records: [item({ type: 'free', data: nest(62) })] }),
        'INVALID_INPUT',
      );

      expect(body.details).toEqual([expect.objectContaining({ code: 'too-deep' })]);
    });
  });
});

describe('define_type', () => {
  beforeEach(openEnvironment);
  afterEach(closeEnvironment);

  it('should refuse 2,000 levels in the schema with INVALID_INPUT too-deep, not INTERNAL', async () => {
    const body = await environment.fail(
      'define_type',
      {
        project: PROJECT,
        name: 'deep',
        schema: nest(2000),
      },
      'INVALID_INPUT',
    );

    expect(body.details).toEqual([expect.objectContaining({ code: 'too-deep' })]);
  });
});

describe('define_gate', () => {
  beforeEach(openEnvironment);
  afterEach(closeEnvironment);

  it('should refuse an own __proto__ key in the select where with INVALID_INPUT and reserved-key', async () => {
    const body = await environment.fail(
      'define_gate',
      {
        project: PROJECT,
        name: 'gate',
        questions: [{ kind: 'occurred', select: { where: hostile('{"__proto__":"x"}') } }],
      },
      'INVALID_INPUT',
    );

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

  it('should refuse an own __proto__ key in where with INVALID_INPUT and reserved-key', async () => {
    const body = await environment.fail(
      'query',
      {
        project: PROJECT,
        process: PROCESS,
        where: hostile('{"__proto__":"x"}'),
      },
      'INVALID_INPUT',
    );

    expect(body.details).toEqual([
      expect.objectContaining({ path: '/where/__proto__', code: 'reserved-key' }),
    ]);
  });

  describe('with an exception that is not a HexlogError', () => {
    afterEach(() => {
      jest.restoreAllMocks();
    });

    it('should turn it into INTERNAL without stack or exception text in the response', async () => {
      await environment.ok('define_type', { project: PROJECT, name: 'note', schema: NOTE_SCHEMA });
      await environment.ok('create_process', { project: PROJECT, process: PROCESS });
      await environment.ok('register', registerInput());
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
  ])('should refuse $scenario with INVALID_INPUT and details[].path', async ({ patch, path }) => {
    const body = await environment.fail(
      'read_attachment',
      {
        project: PROJECT,
        hash: HASH,
        ...patch,
      },
      'INVALID_INPUT',
    );

    expect(body.details).toEqual(expect.arrayContaining([expect.objectContaining({ path })]));
  });

  it('should let a maxChars of 24,000 through to the service', async () => {
    const result = await environment.call('read_attachment', {
      project: PROJECT,
      hash: HASH,
      maxChars: 24_000,
    });

    expectError(result, 'ATTACHMENT_NOT_FOUND');
  });
});
