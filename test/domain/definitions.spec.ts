import { describe, it, expect } from '@jest/globals';
import canonicalize from 'canonicalize';
import { HexlogError } from '../../src/errors.ts';
import {
  GATE_QUESTIONS_MAX,
  Gate,
  RECORD_TYPE_MAX_CHARS,
  RecordType,
  RelationName,
  attachmentFields,
  bumpVersion,
  classifyRelationChange,
  classifyTypeChange,
  compareVersions,
  parseVersion,
} from '../../src/domain/definitions.ts';
import * as omc from '../fixtures/domains/omc.ts';
import * as rdsc from '../fixtures/domains/rdsc.ts';

/** Mesmo teto de `RelationName` e `Gate` em `domain/definitions.ts`, que não o exporta. */
const RELATION_GATE_MAX_CHARS = 16_000;

const fixtureDomains = { omc, rdsc };
const fixtureTypes = Object.entries(fixtureDomains).flatMap(([domain, { types }]) =>
  Object.entries(types).map(([name, schema]): [string, unknown] => [`${domain}.${name}`, schema]),
);
const fixtureRelations = Object.entries(fixtureDomains).flatMap(([domain, { relations }]) =>
  relations.map((relation): [string, unknown] => [`${domain}.${relation.name}`, relation]),
);
const fixtureGates = Object.entries(fixtureDomains).flatMap(([domain, { gates }]) =>
  gates.map((gate): [string, unknown] => [`${domain}.${gate.name}`, gate]),
);

describe('parseVersion', () => {
  it('should read major and minor as numbers', () => {
    expect(parseVersion('1.10')).toEqual({ major: 1, minor: 10 });
  });

  it.each(['1', '1.0.0', 'a.b', '1.', '.1', '', '01.7', '1.07', '1234567.0', '1.1234567'])(
    'should refuse %j',
    (value) => {
      expect(() => parseVersion(value)).toThrow(HexlogError);
    },
  );

  it.each([
    ['0.0', { major: 0, minor: 0 }],
    ['999999.999999', { major: 999_999, minor: 999_999 }],
  ])('should accept %j', (value, expected) => {
    expect(parseVersion(value)).toEqual(expected);
  });
});

describe('compareVersions', () => {
  it.each([
    ['1.10', '1.9', 1],
    ['1.9', '2.0', -1],
    ['2.3', '2.3', 0],
  ])('should compare %s against %s by number and not by string as %i', (left, right, sign) => {
    expect(Math.sign(compareVersions(left, right))).toBe(sign);
  });
});

describe('bumpVersion', () => {
  it('should add one to the minor on a minor bump', () => {
    expect(bumpVersion('1.9', 'minor')).toBe('1.10');
  });

  it('should carry the major to two digits when bumping 9.9', () => {
    expect(bumpVersion('9.9', 'major')).toBe('10.0');
  });

  it('should add one to the major and reset the minor on a major bump', () => {
    expect(bumpVersion('1.9', 'major')).toBe('2.0');
  });
});

describe('classifyTypeChange', () => {
  const base: RecordType = {
    type: 'object',
    properties: {
      title: { type: 'string' },
      level: { type: 'string', enum: ['low', 'high'] },
    },
    required: ['title'],
  };
  const title = { type: 'string' };
  const level = { type: 'string', enum: ['low', 'high'] };
  const withProps = (properties: Record<string, RecordType>): RecordType => ({
    ...base,
    properties,
  });

  const conditional: RecordType = {
    if: { properties: { a: { const: 1 } } },
    then: { properties: { t: { type: 'string' } } },
    else: { properties: { e: { type: 'string' } } },
  };
  const plan = omc.types.plan;

  it('should classify an identical schema as unchanged', () => {
    expect(classifyTypeChange(base, structuredClone(base))).toBe('unchanged');
  });

  // Provado com ajv: nova propriedade em then ou em else recusa o mesmo dado novo que a raiz
  // recusaria, e a raiz já é aceita. Por isso o flag `additive` só cai em if, not e nos arrays.
  it.each<[string, RecordType, RecordType]>([
    ['a new optional property', base, withProps({ title, level, note: title })],
    [
      'a new enum value',
      base,
      withProps({ title, level: { ...level, enum: ['low', 'high', 'mid'] } }),
    ],
    [
      'a new property in then',
      conditional,
      { ...conditional, then: { properties: { t: title, n: title } } },
    ],
    [
      'a new property in else',
      conditional,
      { ...conditional, else: { properties: { e: title, n: title } } },
    ],
    [
      'a widened enum in properties inside then',
      { if: { required: ['a'] }, then: { properties: { l: { enum: ['x'] } } } },
      { if: { required: ['a'] }, then: { properties: { l: { enum: ['x', 'y'] } } } },
    ],
    [
      'a new property in then of the omc fixture plan',
      plan,
      { ...plan, then: { ...plan.then, properties: { diff: title, note: title } } },
    ],
  ])('should classify %s as compatible', (_change, before, after) => {
    expect(classifyTypeChange(before, after)).toBe('compatible');
  });

  // Em `not` e `if` o sentido se inverte: mudança que alarga ali estreita o schema como um todo.
  it.each<[string, RecordType, RecordType]>([
    [
      'a new property that enters required',
      base,
      { ...withProps({ title, level, note: title }), required: ['title', 'note'] },
    ],
    ['a removed required', base, { ...base, required: [] }],
    ['a removed property', base, withProps({ title })],
    ['a removed enum value', base, withProps({ title, level: { ...level, enum: ['low'] } })],
    ['a changed type', base, withProps({ title: { type: 'number' }, level })],
    ['an added format', base, withProps({ title: { ...title, format: 'attachment' }, level })],
    ['a new keyword at the root', base, { ...base, additionalProperties: false }],
    [
      'a new keyword inside a property',
      base,
      withProps({ title: { ...title, minLength: 1 }, level }),
    ],
    [
      'a new keyword in a property named properties',
      { properties: { properties: title } },
      { properties: { properties: { ...title, minLength: 1 } } },
    ],
    ['a widened enum inside not', { not: { enum: [1] } }, { not: { enum: [1, 2] } }],
    [
      'a new property in if.properties, with else',
      {
        if: { properties: { a: { const: 1 } } },
        then: { required: ['t'] },
        else: { required: ['x'] },
      },
      {
        if: { properties: { a: { const: 1 }, b: { const: 1 } } },
        then: { required: ['t'] },
        else: { required: ['x'] },
      },
    ],
    [
      'a widened enum inside if',
      { if: { properties: { a: { enum: [1] } } }, then: { required: ['t'] } },
      { if: { properties: { a: { enum: [1, 2] } } }, then: { required: ['t'] } },
    ],
    ['a widened enum inside anyOf', { anyOf: [{ enum: [1] }] }, { anyOf: [{ enum: [1, 2] }] }],
    ['a widened enum inside allOf', { allOf: [{ enum: [1] }] }, { allOf: [{ enum: [1, 2] }] }],
    ['a widened enum inside oneOf', { oneOf: [{ enum: [1] }] }, { oneOf: [{ enum: [1, 2] }] }],
  ])('should classify %s as breaking', (_change, before, after) => {
    expect(classifyTypeChange(before, after)).toBe('breaking');
  });
});

describe('classifyRelationChange', () => {
  const base: RelationName = { name: 'approves', kind: 'supports', from: ['review'], to: ['doc'] };

  it('should classify an identical definition as unchanged', () => {
    expect(classifyRelationChange(base, { ...base })).toBe('unchanged');
  });

  it('should classify widening from or to as compatible', () => {
    expect(classifyRelationChange(base, { ...base, from: ['review', 'audit'] })).toBe('compatible');
    expect(classifyRelationChange(base, { ...base, to: ['doc', 'spec'] })).toBe('compatible');
  });

  it('should classify removing the list (any type) as widening and compatible', () => {
    expect(classifyRelationChange(base, { name: 'approves', kind: 'supports', to: ['doc'] })).toBe(
      'compatible',
    );
  });

  it('should classify a changed kind as breaking', () => {
    expect(classifyRelationChange(base, { ...base, kind: 'answers' })).toBe('breaking');
  });

  it('should classify narrowing from or to as breaking', () => {
    const wide: RelationName = { ...base, from: ['review', 'audit'], to: ['doc', 'spec'] };

    expect(classifyRelationChange(wide, { ...wide, from: ['review'] })).toBe('breaking');
    expect(classifyRelationChange(wide, { ...wide, to: ['doc'] })).toBe('breaking');
  });

  it('should classify going from no list to a list as breaking', () => {
    const open: RelationName = { name: 'approves', kind: 'supports' };

    expect(classifyRelationChange(open, base)).toBe('breaking');
  });

  it('should classify widening one end and narrowing the other as breaking', () => {
    const next: RelationName = { ...base, from: ['review', 'audit'], to: ['spec'] };

    expect(classifyRelationChange(base, next)).toBe('breaking');
  });
});

describe('attachmentFields', () => {
  it('should find a string field and a list of strings marked with format attachment', () => {
    const schema: RecordType = {
      type: 'object',
      properties: {
        body: { type: 'string', format: 'attachment' },
        extras: { type: 'array', items: { type: 'string', format: 'attachment' } },
        title: { type: 'string' },
        other: { type: 'string', format: 'uri' },
      },
    };

    expect(attachmentFields(schema)).toEqual(['body', 'extras']);
  });

  it('should ignore a list whose items lack the mark', () => {
    const schema: RecordType = {
      properties: { tags: { type: 'array', items: { type: 'string' } } },
    };

    expect(attachmentFields(schema)).toEqual([]);
  });

  it.each([
    ['no properties', { type: 'object' }],
    ['properties that is not an object', { properties: 'x' }],
  ])('should find no attachment field in a schema with %s', (_label, schema) => {
    expect(attachmentFields(schema)).toEqual([]);
  });

  it('should look only at the first level of properties', () => {
    const schema: RecordType = {
      properties: {
        nested: { type: 'object', properties: { body: { type: 'string', format: 'attachment' } } },
      },
    };

    expect(attachmentFields(schema)).toEqual([]);
  });
});

describe('RECORD_TYPE_MAX_CHARS', () => {
  it('should be 16,000', () => {
    expect(RECORD_TYPE_MAX_CHARS).toBe(16_000);
  });
});

describe('GATE_QUESTIONS_MAX', () => {
  it('should be 50', () => {
    expect(GATE_QUESTIONS_MAX).toBe(50);
  });
});

describe('RecordType', () => {
  /** Objeto cujo JCS tem exatamente `chars` caracteres. */
  function withCanonicalLength(chars: number) {
    const overhead = (canonicalize({ k: '' }) ?? '').length;
    return { k: 'x'.repeat(chars - overhead) };
  }

  it('should accept a JSON object', () => {
    expect(RecordType.safeParse({ type: 'object' }).success).toBe(true);
  });

  it('should refuse a value that is not a JSON object', () => {
    expect(RecordType.safeParse('x').success).toBe(false);
  });

  it.each([
    { chars: RECORD_TYPE_MAX_CHARS, accepted: true },
    { chars: RECORD_TYPE_MAX_CHARS + 1, accepted: false },
  ])(
    'should return success $accepted for a type of $chars canonical characters',
    ({ chars, accepted }) => {
      const value = withCanonicalLength(chars);

      expect((canonicalize(value) ?? '').length).toBe(chars);

      expect(RecordType.safeParse(value).success).toBe(accepted);
    },
  );

  it('should refuse a lone surrogate without throwing', () => {
    expect(RecordType.safeParse({ description: '\ud800' }).success).toBe(false);
  });

  it.each(fixtureTypes)('should accept the type %s of the fixture domains', (_name, schema) => {
    expect(RecordType.safeParse(schema).success).toBe(true);
  });
});

describe('RelationName', () => {
  it('should accept a valid name and kind', () => {
    expect(RelationName.safeParse({ name: 'approves', kind: 'supports' }).success).toBe(true);
  });

  it.each([
    ['an unknown kind', { name: 'approves', kind: 'nope' }],
    ['a name with an uppercase letter', { name: 'Approves', kind: 'supports' }],
    ['an unknown field', { name: 'a', kind: 'supports', extra: 1 }],
  ])('should refuse %s', (_label, raw) => {
    expect(RelationName.safeParse(raw).success).toBe(false);
  });

  // Omitida a ponta aceita qualquer tipo; lista vazia nunca quer dizer "nenhum tipo".
  it.each([
    ['an empty from', { from: [] }],
    ['an empty to', { to: [] }],
    ['a duplicate in from', { from: ['review', 'review'] }],
    ['a duplicate in to', { to: ['doc', 'spec', 'doc'] }],
  ])('should refuse %s', (_label, ends) => {
    expect(RelationName.safeParse({ name: 'approves', kind: 'supports', ...ends }).success).toBe(
      false,
    );
  });

  it.each([
    ['from with distinct names', { from: ['x', 'y'] }],
    ['to with one name', { to: ['x'] }],
  ])('should accept %s', (_label, ends) => {
    expect(RelationName.safeParse({ name: 'a', kind: 'supports', ...ends }).success).toBe(true);
  });

  // Definição é imutável: sem teto, `from`/`to`/`where` gigantes incham o process.json de todo processo novo.
  // Name tem no máximo 63 caracteres: 200 nomes cabem nos 16.000 canônicos e 260 não.
  it.each([
    { count: 200, accepted: true },
    { count: 260, accepted: false },
  ])(
    'should return success $accepted for $count names of 63 characters in from',
    ({ count, accepted }) => {
      const from = Array.from({ length: count }, (_, i) => String(i).padStart(63, 'a'));

      expect(RelationName.safeParse({ name: 'approves', kind: 'supports', from }).success).toBe(
        accepted,
      );
    },
  );

  it.each(fixtureRelations)(
    'should accept the relation %s of the fixture domains',
    (_name, relation) => {
      expect(RelationName.safeParse(relation).success).toBe(true);
    },
  );
});

describe('Gate', () => {
  const question = { kind: 'occurred', select: { type: 'review' } };

  /** Gate cujo JCS tem exatamente `chars` caracteres, com o excesso no valor de um `where`. */
  function gateWithCanonicalLength(chars: number) {
    const gate = (padding: string) => ({
      name: 'ready',
      questions: [{ kind: 'occurred', select: { type: 'review', where: { k: padding } } }],
    });
    const overhead = (canonicalize(gate('')) ?? '').length;
    return gate('x'.repeat(chars - overhead));
  }

  it('should refuse a where with 100,000 keys', () => {
    const where = Object.fromEntries(Array.from({ length: 100_000 }, (_, i) => [`k${i}`, i]));
    const heavy = { kind: 'occurred', select: { type: 'review', where } };

    expect(Gate.safeParse({ name: 'ready', questions: [heavy] }).success).toBe(false);
  });

  it('should accept a small gate with a real where', () => {
    const light = { kind: 'occurred', select: { type: 'review', where: { verdict: 'approved' } } };

    expect(Gate.safeParse({ name: 'ready', questions: [light] }).success).toBe(true);
  });

  it.each([
    { chars: RELATION_GATE_MAX_CHARS, accepted: true },
    { chars: RELATION_GATE_MAX_CHARS + 1, accepted: false },
  ])(
    'should return success $accepted for a gate of $chars canonical characters',
    ({ chars, accepted }) => {
      const gate = gateWithCanonicalLength(chars);

      expect((canonicalize(gate) ?? '').length).toBe(chars);

      expect(Gate.safeParse(gate).success).toBe(accepted);
    },
  );

  it('should accept a name and questions with a kind', () => {
    expect(Gate.safeParse({ name: 'ready', questions: [question] }).success).toBe(true);
  });

  it.each([
    ['a question without kind', { name: 'ready', questions: [{}] }],
    ['no questions field', { name: 'ready' }],
    // Gate vazio nunca barra, e toda mudança de gate é minor: a definição não o admite.
    ['empty questions', { name: 'ready', questions: [] }],
  ])('should refuse %s', (_label, raw) => {
    expect(Gate.safeParse(raw).success).toBe(false);
  });

  it.each([
    { count: GATE_QUESTIONS_MAX, accepted: true },
    { count: GATE_QUESTIONS_MAX + 1, accepted: false },
  ])('should return success $accepted for a gate of $count questions', ({ count, accepted }) => {
    const questions = Array.from({ length: count }, () => question);

    expect(Gate.safeParse({ name: 'ready', questions }).success).toBe(accepted);
  });

  it.each(fixtureGates)('should accept the gate %s of the fixture domains', (_name, gate) => {
    expect(Gate.safeParse(gate).success).toBe(true);
  });
});
