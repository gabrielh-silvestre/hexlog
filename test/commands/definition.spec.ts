import { describe, expect, it } from '@jest/globals';
import canonicalize from 'canonicalize';
import { omit } from 'es-toolkit';
import { createValidator } from '../../src/adapters/validator.ts';
import { createDefinitionService } from '../../src/commands/definition.ts';
import type { DefineGateInput, DefineRelationInput } from '../../src/commands/definition.ts';
import { hashOfJcs } from '../../src/domain/chain.ts';
import type { Gate, RecordType, RelationName } from '../../src/domain/definitions.ts';
import type { DefinitionStore } from '../../src/ports.ts';
import { captureError } from '../helpers.ts';
import { PROJECT, fakeDefinitionStore } from './fakes.ts';

const NAME = 'note';

const BASE_SCHEMA: RecordType = {
  type: 'object',
  properties: { title: { type: 'string' } },
  required: ['title'],
};
const WITH_OPTIONAL: RecordType = {
  ...BASE_SCHEMA,
  properties: { title: { type: 'string' }, body: { type: 'string' } },
};
const WITH_REQUIRED: RecordType = { ...WITH_OPTIONAL, required: ['title', 'body'] };

const QUESTION: Gate['questions'][number] = { kind: 'no_open_contradiction' };
const OTHER_QUESTION: Gate['questions'][number] = {
  kind: 'occurred',
  select: { type: 'approval' },
};

function setup() {
  const fake = fakeDefinitionStore();
  const service = createDefinitionService({ store: fake.store, validator: createValidator() });
  return { ...fake, service };
}

const relation = (overrides: Partial<DefineRelationInput> = {}): DefineRelationInput => ({
  project: PROJECT,
  name: 'backs',
  kind: 'supports',
  from: ['note'],
  to: ['note', 'decision'],
  ...overrides,
});

const gate = (overrides: Partial<DefineGateInput> = {}): DefineGateInput => ({
  project: PROJECT,
  name: 'ready',
  questions: [QUESTION],
  ...overrides,
});

/**
 * Relação de exatamente `chars` caracteres canônicos: `from` de nomes distintos de 40 caracteres
 * (43 canônicos cada) e um `name` que acerta o resto. O `name` de `relation()` tem 5 caracteres e
 * o teto é 63, então o resto vai até 58.
 */
function relationOfLength(chars: number): DefineRelationInput {
  for (let count = 1; ; count += 1) {
    const from = Array.from({ length: count }, (_, i) => `t${i}`.padEnd(40, 'x'));
    const rest = chars - canonicalize(omit(relation({ from }), ['project']))!.length;
    if (rest >= 0 && rest <= 58) return relation({ from, name: 'b'.repeat(5 + rest) });
  }
}

describe('defineType', () => {
  describe('with immutable versions', () => {
    it('should create version 1.0 with the hash of the canonical schema', () => {
      const { service, stored } = setup();

      const defined = service.defineType({ project: PROJECT, name: NAME, schema: BASE_SCHEMA });

      expect(defined).toEqual({
        name: NAME,
        version: '1.0',
        hash: hashOfJcs(BASE_SCHEMA),
        created: true,
      });
      expect(stored('types', NAME, '1.0')).toEqual(BASE_SCHEMA);
    });

    it('should bump the minor on a new optional property and keep the previous version', () => {
      const { service, versions } = setup();
      service.defineType({ project: PROJECT, name: NAME, schema: BASE_SCHEMA });

      const defined = service.defineType({ project: PROJECT, name: NAME, schema: WITH_OPTIONAL });

      expect(defined).toMatchObject({ version: '1.1', created: true, previousVersion: '1.0' });
      expect(versions('types', NAME)).toEqual(['1.0', '1.1']);
    });

    it('should refuse a breaking change without breaking: true and write nothing', () => {
      const { service, writes } = setup();
      service.defineType({ project: PROJECT, name: NAME, schema: WITH_OPTIONAL });
      writes.length = 0;

      const error = captureError(() =>
        service.defineType({ project: PROJECT, name: NAME, schema: WITH_REQUIRED }),
      );

      expect(error).toMatchObject({
        code: 'BREAKING_CHANGE',
        details: [{ path: '/schema', code: 'breaking-change' }],
      });
      expect(writes).toEqual([]);
    });

    it('should bump the major and reset the minor with breaking: true', () => {
      const { service, versions } = setup();
      service.defineType({ project: PROJECT, name: NAME, schema: BASE_SCHEMA });
      service.defineType({ project: PROJECT, name: NAME, schema: WITH_OPTIONAL });

      const defined = service.defineType({
        project: PROJECT,
        name: NAME,
        schema: WITH_REQUIRED,
        breaking: true,
      });

      expect(defined).toMatchObject({ version: '2.0', previousVersion: '1.1' });
      expect(versions('types', NAME)).toEqual(['1.0', '1.1', '2.0']);
    });

    it('should bump the major with breaking: true even without a breaking change, with no warning', () => {
      const { service } = setup();
      service.defineType({ project: PROJECT, name: NAME, schema: BASE_SCHEMA });

      const defined = service.defineType({
        project: PROJECT,
        name: NAME,
        schema: WITH_OPTIONAL,
        breaking: true,
      });

      expect(defined).toMatchObject({ version: '2.0', created: true });
    });
  });

  describe('when the same definition is sent again', () => {
    it('should return the current version without writing', () => {
      const { service, writes } = setup();
      const first = service.defineType({ project: PROJECT, name: NAME, schema: BASE_SCHEMA });
      writes.length = 0;

      const replay = service.defineType({ project: PROJECT, name: NAME, schema: BASE_SCHEMA });

      expect(replay).toEqual({ ...first, created: false });
      expect(writes).toEqual([]);
    });

    it('should be a replay, without bumping the major, when breaking: true comes with a definition identical to the current one', () => {
      const { service, writes, versions } = setup();
      const define = () =>
        service.defineType({ project: PROJECT, name: NAME, schema: BASE_SCHEMA, breaking: true });
      const first = define();
      writes.length = 0;

      const replay = define();

      expect(replay).toEqual({ ...first, created: false });
      expect(replay.version).toBe('1.0');
      expect(writes).toEqual([]);
      expect(versions('types', NAME)).toEqual(['1.0']);
    });
  });

  describe('when another writer takes the target version', () => {
    it('should converge to 1.0 as a replay on the first version of a new name with breaking: true', () => {
      const { service, add, racing, versions } = setup();
      racing(() => add('types', NAME, '1.0', BASE_SCHEMA));

      const defined = service.defineType({
        project: PROJECT,
        name: NAME,
        schema: BASE_SCHEMA,
        breaking: true,
      });

      expect(defined).toEqual({
        name: NAME,
        version: '1.0',
        hash: hashOfJcs(BASE_SCHEMA),
        created: false,
      });
      expect(versions('types', NAME)).toEqual(['1.0']);
    });

    it('should turn the same definition written by another writer into a replay', () => {
      const { service, add, racing, versions } = setup();
      service.defineType({ project: PROJECT, name: NAME, schema: BASE_SCHEMA });
      racing(() => add('types', NAME, '1.1', WITH_OPTIONAL));

      const defined = service.defineType({ project: PROJECT, name: NAME, schema: WITH_OPTIONAL });

      expect(defined).toEqual({
        name: NAME,
        version: '1.1',
        hash: hashOfJcs(WITH_OPTIONAL),
        created: false,
      });
      expect(versions('types', NAME)).toEqual(['1.0', '1.1']);
    });

    it('should refuse as a breaking change when what the other writer wrote makes the change one', () => {
      const { service, add, racing } = setup();
      service.defineType({ project: PROJECT, name: NAME, schema: BASE_SCHEMA });
      racing(() => add('types', NAME, '1.1', WITH_REQUIRED));

      const error = captureError(() =>
        service.defineType({ project: PROJECT, name: NAME, schema: WITH_OPTIONAL }),
      );

      expect(error).toMatchObject({ code: 'BREAKING_CHANGE' });
    });
  });

  describe('with a definition above the cap or the wrong shape', () => {
    it('should refuse a schema of 16,001 canonical characters', () => {
      const { service, writes } = setup();
      // 34 caracteres de moldura canônica + o texto: 15.967 fecha em 16.001.
      const schema: RecordType = { type: 'object', description: 'x'.repeat(15_967) };

      expect(canonicalize(schema)).toHaveLength(16_001);

      const error = captureError(() =>
        service.defineType({ project: PROJECT, name: NAME, schema }),
      );

      expect(error).toMatchObject({ code: 'INVALID_SCHEMA', details: [{ path: '/schema' }] });
      expect(writes).toEqual([]);
    });

    it('should still write a schema of 16,000 canonical characters', () => {
      const { service } = setup();
      const schema: RecordType = { type: 'object', description: 'x'.repeat(15_966) };

      expect(canonicalize(schema)).toHaveLength(16_000);

      const defined = service.defineType({ project: PROJECT, name: NAME, schema });

      expect(defined).toMatchObject({ version: '1.0', created: true });
    });

    it.each([
      ['array', { type: 'array', items: { type: 'string' } }],
      ['without type', { description: 'no type at the root' }],
    ])('should refuse a root that is %s', (_root, schema) => {
      const { service, writes } = setup();

      const error = captureError(() =>
        service.defineType({ project: PROJECT, name: NAME, schema }),
      );

      expect(error).toMatchObject({
        code: 'INVALID_SCHEMA',
        details: [{ path: '/schema/type', code: 'invalid-type' }],
      });
      expect(writes).toEqual([]);
    });
  });

  describe('with a schema the validator checks', () => {
    it.each([
      [
        'a free pattern',
        { code: { type: 'string', maxLength: 10, pattern: '^[a-z]+$' } },
        '/schema/properties/code/pattern',
        'pattern-not-allowed',
      ],
      [
        'a free pattern that does not compile as a regex',
        { code: { type: 'string', pattern: '(' } },
        '/schema/properties/code/pattern',
        'pattern-not-allowed',
      ],
      [
        'patternProperties',
        { code: { type: 'object', patternProperties: { '^x-': { type: 'string' } } } },
        '/schema/properties/code/patternProperties',
        'pattern-not-allowed',
      ],
      [
        'a value that violates the metaschema',
        { code: { minLength: -1 } },
        '/schema/properties/code/minLength',
        'minimum',
      ],
    ])(
      'should return invalid-schema for %s with the path prefixed with /schema and write nothing',
      (_name, properties, path, code) => {
        const { service, writes } = setup();
        const schema = { type: 'object', properties } as RecordType;

        const error = captureError(() =>
          service.defineType({ project: PROJECT, name: NAME, schema }),
        );

        expect(error).toMatchObject({ code: 'INVALID_SCHEMA', details: [{ path, code }] });
        expect(writes).toEqual([]);
      },
    );

    it('should refuse the resent schema of a legacy type with pattern instead of treating it as a replay', () => {
      const { service, add, versions, writes } = setup();
      const legacy: RecordType = {
        type: 'object',
        properties: { code: { type: 'string', maxLength: 10, pattern: '^[a-z]+$' } },
      };
      add('types', NAME, '1.0', legacy);

      const error = captureError(() =>
        service.defineType({ project: PROJECT, name: NAME, schema: legacy }),
      );

      expect(error).toMatchObject({
        code: 'INVALID_SCHEMA',
        details: [{ path: '/schema/properties/code/pattern', code: 'pattern-not-allowed' }],
      });
      expect(versions('types', NAME)).toEqual(['1.0']);
      expect(writes).toEqual([]);
    });

    it('should point at exactly /schema, never /schema/schema, on an ajv exception', () => {
      const { service, writes } = setup();
      const schema: RecordType = { type: 'object', bogus: true };

      const error = captureError(() =>
        service.defineType({ project: PROJECT, name: NAME, schema }),
      );

      expect(error).toMatchObject({
        code: 'INVALID_SCHEMA',
        details: [{ path: '/schema', code: 'invalid-schema' }],
      });
      expect(writes).toEqual([]);
    });

    it('should prefix the validator details with /schema, without a new cut', () => {
      const { store, writes } = setup();
      const details = Array.from({ length: 51 }, (_, index) => ({
        path: `/properties/p${index}`,
        code: 'type',
        message: 'must be valid',
      }));
      const service = createDefinitionService({
        store,
        validator: { checkSchema: () => details, validate: () => [] },
      });

      const error = captureError(() =>
        service.defineType({ project: PROJECT, name: NAME, schema: { type: 'object' } }),
      );

      expect(error).toMatchObject({
        code: 'INVALID_SCHEMA',
        details: details.map((detail) => ({ ...detail, path: `/schema${detail.path}` })),
      });
      expect(writes).toEqual([]);
    });
  });
});

describe('defineRelation', () => {
  describe('with immutable versions', () => {
    it('should bump the minor when from or to is widened', () => {
      const { service, versions } = setup();
      service.defineRelation(relation());

      const widened = service.defineRelation(relation({ to: ['note', 'decision', 'review'] }));

      expect(widened).toMatchObject({ version: '1.1', previousVersion: '1.0' });
      expect(versions('relations', 'backs')).toEqual(['1.0', '1.1']);
    });

    it('should refuse as a breaking change when from or to is narrowed', () => {
      const { service, versions } = setup();
      service.defineRelation(relation());
      service.defineRelation(relation({ to: ['note', 'decision', 'review'] }));

      const error = captureError(() => service.defineRelation(relation({ to: ['note'] })));

      expect(error).toMatchObject({ code: 'BREAKING_CHANGE' });
      expect(versions('relations', 'backs')).toEqual(['1.0', '1.1']);
    });
  });

  describe('when the same definition is sent again', () => {
    it('should return the current version without writing', () => {
      const { service, writes } = setup();
      const first = service.defineRelation(relation());
      writes.length = 0;

      const replay = service.defineRelation(relation());

      expect(replay).toEqual({ ...first, created: false });
      expect(writes).toEqual([]);
    });
  });

  describe('with a definition above the cap or the wrong shape', () => {
    it('should refuse a relation of 16,001 canonical characters', () => {
      const { service, writes } = setup();
      const input = relationOfLength(16_001);

      expect(canonicalize(omit(input, ['project']))).toHaveLength(16_001);

      const error = captureError(() => service.defineRelation(input));

      expect(error).toMatchObject({
        code: 'INVALID_INPUT',
        details: [{ message: expect.stringContaining('relation exceeds 16000') }],
      });
      expect(writes).toEqual([]);
    });

    it('should refuse an empty from', () => {
      const { service, writes } = setup();

      const error = captureError(() => service.defineRelation(relation({ from: [] })));

      expect(error).toMatchObject({ code: 'INVALID_INPUT', details: [{ path: '/from' }] });
      expect(writes).toEqual([]);
    });

    it('should refuse an unknown kind', () => {
      const { service, writes } = setup();
      const unknown = relation({ kind: 'invented' as RelationName['kind'] });

      const error = captureError(() => service.defineRelation(unknown));

      expect(error).toMatchObject({ code: 'INVALID_INPUT', details: [{ path: '/kind' }] });
      expect(writes).toEqual([]);
    });
  });

  it('should store only what came, without an undefined key, when from and to are absent', () => {
    const { service, stored } = setup();

    service.defineRelation({ project: PROJECT, name: 'backs', kind: 'supports' });

    expect(stored('relations', 'backs', '1.0')).toStrictEqual({ name: 'backs', kind: 'supports' });
  });
});

describe('defineGate', () => {
  describe('with immutable versions', () => {
    it('should bump the minor on any change', () => {
      const { service } = setup();
      service.defineGate(gate());

      const changed = service.defineGate(gate({ questions: [QUESTION, OTHER_QUESTION] }));

      expect(changed).toMatchObject({ version: '1.1', previousVersion: '1.0' });
    });

    it('should bump the major only with breaking: true', () => {
      const { service } = setup();
      service.defineGate(gate());
      service.defineGate(gate({ questions: [QUESTION, OTHER_QUESTION] }));

      const flagged = service.defineGate(gate({ questions: [OTHER_QUESTION], breaking: true }));

      expect(flagged).toMatchObject({ version: '2.0', previousVersion: '1.1' });
    });
  });

  describe('when the same definition is sent again', () => {
    it('should return the current version without writing', () => {
      const { service, writes } = setup();
      const first = service.defineGate(gate());
      writes.length = 0;

      const replay = service.defineGate(gate());

      expect(replay).toEqual({ ...first, created: false });
      expect(writes).toEqual([]);
    });

    it('should be a replay, without bumping the major, when breaking: true comes with a definition identical to the current one', () => {
      const { service, writes, versions } = setup();
      const first = service.defineGate(gate({ breaking: true }));
      writes.length = 0;

      const replay = service.defineGate(gate({ breaking: true }));

      expect(replay).toEqual({ ...first, created: false });
      expect(replay.version).toBe('1.0');
      expect(writes).toEqual([]);
      expect(versions('gates', 'ready')).toEqual(['1.0']);
    });
  });

  describe('when another writer takes the target version', () => {
    it('should decide a different definition again and never overwrite the one of the other writer', () => {
      const { service, add, racing, stored } = setup();
      service.defineGate(gate());
      racing(() => add('gates', 'ready', '1.1', { name: 'ready', questions: [OTHER_QUESTION] }));

      const defined = service.defineGate(gate({ questions: [QUESTION, OTHER_QUESTION] }));

      expect(defined).toMatchObject({
        version: '1.2',
        created: true,
        previousVersion: '1.1',
        divergentVersions: ['1.1'],
      });
      expect(stored('gates', 'ready', '1.1')).toEqual({
        name: 'ready',
        questions: [OTHER_QUESTION],
      });
    });

    it('should exhaust the attempts, without overwriting, when the target version never frees up', () => {
      const { store, add } = setup();
      add('gates', 'ready', '1.0', { name: 'ready', questions: [QUESTION] });
      // `write` sempre acha a versão alvo ocupada, e a leitura nunca vê o que o outro escritor gravou.
      let writes = 0;
      const stuck: DefinitionStore = {
        ...store,
        write: () => {
          writes += 1;
          return false;
        },
      };

      const error = captureError(() =>
        createDefinitionService({ store: stuck, validator: createValidator() }).defineGate(
          gate({ questions: [OTHER_QUESTION] }),
        ),
      );

      expect(error).toMatchObject({
        code: 'INTERNAL',
        details: [{ code: 'exclusive-write-exhausted' }],
      });
      expect(writes).toBe(10);
    });
  });

  describe('with a definition above the cap or the wrong shape', () => {
    it.each([
      ['0 questions', []],
      ['51 questions', Array.from({ length: 51 }, () => QUESTION)],
    ])('should refuse a gate with %s', (_name, questions) => {
      const { service, writes } = setup();

      const error = captureError(() => service.defineGate(gate({ questions })));

      expect(error).toMatchObject({ code: 'INVALID_INPUT', details: [{ path: '/questions' }] });
      expect(writes).toEqual([]);
    });

    it('should still write a gate with 50 questions', () => {
      const { service } = setup();

      const defined = service.defineGate(
        gate({ questions: Array.from({ length: 50 }, () => QUESTION) }),
      );

      expect(defined).toMatchObject({ version: '1.0', created: true });
    });

    it('should refuse a gate of 16,001 canonical characters', () => {
      const { service, writes } = setup();
      const withText = (text: string) =>
        gate({ questions: [{ kind: 'occurred', select: { where: { text } } }] });
      const base = canonicalize(omit(withText(''), ['project']))!.length;
      const input = withText('x'.repeat(16_001 - base));

      expect(canonicalize(omit(input, ['project']))).toHaveLength(16_001);

      const error = captureError(() => service.defineGate(input));

      expect(error).toMatchObject({
        code: 'INVALID_INPUT',
        details: [{ message: expect.stringContaining('gate exceeds 16000') }],
      });
      expect(writes).toEqual([]);
    });
  });

  it('should keep the type and relation of the same name apart when defining a gate', () => {
    const { service, versions } = setup();
    service.defineType({ project: PROJECT, name: 'same', schema: BASE_SCHEMA });
    service.defineRelation(relation({ name: 'same' }));

    service.defineGate(gate({ name: 'same' }));

    expect(versions('types', 'same')).toEqual(['1.0']);
    expect(versions('relations', 'same')).toEqual(['1.0']);
    expect(versions('gates', 'same')).toEqual(['1.0']);
  });
});
