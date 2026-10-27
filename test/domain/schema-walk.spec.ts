import { describe, expect, it } from '@jest/globals';
import type { RecordType } from '../../src/domain/definitions.ts';
import {
  FREE_PATTERN_KEYWORDS,
  hasKeywordAt,
  walkSubschemas,
  withoutFreePatterns,
} from '../../src/domain/schema-walk.ts';

function pointersOf(schema: unknown): string[] {
  const pointers: string[] = [];
  walkSubschemas(schema, (_node, pointer) => pointers.push(pointer));
  return pointers;
}

describe('walkSubschemas', () => {
  it('should visit the single subschemas, then the lists, then the maps, nested ones in place', () => {
    const schema = {
      properties: { a: { items: { type: 'string' } }, b: {} },
      allOf: [{}, { not: {} }],
      $defs: { x: {} },
      propertyNames: {},
    };

    expect(pointersOf(schema)).toEqual([
      '',
      '/propertyNames',
      '/allOf/0',
      '/allOf/1',
      '/allOf/1/not',
      '/properties/a',
      '/properties/a/items',
      '/properties/b',
      '/$defs/x',
    ]);
  });

  it('should escape ~ and / in the RFC 6901 pointer', () => {
    const schema = { properties: { 'a/b': {}, 'c~d': {} } };

    expect(pointersOf(schema)).toEqual(['', '/properties/a~1b', '/properties/c~0d']);
  });

  it.each([
    'additionalProperties',
    'items',
    'contains',
    'propertyNames',
    'not',
    'if',
    'then',
    'else',
    'unevaluatedItems',
    'unevaluatedProperties',
    'contentSchema',
  ])('should visit the subschema under the keyword %s', (keyword) => {
    const schema = { [keyword]: {} };

    expect(pointersOf(schema)).toEqual(['', `/${keyword}`]);
  });

  it.each(['allOf', 'anyOf', 'oneOf', 'prefixItems'])(
    'should visit each subschema of the list keyword %s',
    (keyword) => {
      const schema = { [keyword]: [{}, {}] };

      expect(pointersOf(schema)).toEqual(['', `/${keyword}/0`, `/${keyword}/1`]);
    },
  );

  it.each([
    'properties',
    'patternProperties',
    '$defs',
    'definitions',
    'dependentSchemas',
    'dependencies',
  ])('should visit each subschema of the map keyword %s', (keyword) => {
    const schema = { [keyword]: { a: {}, b: {} } };

    expect(pointersOf(schema)).toEqual(['', `/${keyword}/a`, `/${keyword}/b`]);
  });

  it('should ignore a dependencies value that is an array', () => {
    const schema = { dependencies: { a: ['b'], c: { required: ['d'] } } };

    expect(pointersOf(schema)).toEqual(['', '/dependencies/c']);
  });

  it.each(['const', 'enum', 'default', 'examples'])(
    'should not enter %s, which is data',
    (keyword) => {
      const schema = { [keyword]: [{ properties: { x: {} } }], properties: { y: {} } };

      expect(pointersOf(schema)).toEqual(['', '/properties/y']);
    },
  );

  it('should ignore a root that is not an object', () => {
    expect(pointersOf(true)).toEqual([]);
    expect(pointersOf(null)).toEqual([]);
  });

  it('should not walk what the visit callback deletes from the node', () => {
    const schema: Record<string, unknown> = { properties: { x: {} }, items: {} };
    const visited: string[] = [];

    walkSubschemas(schema, (node, pointer) => {
      visited.push(pointer);
      delete node.items;
    });

    expect(visited).toEqual(['', '/properties/x']);
  });
});

describe('FREE_PATTERN_KEYWORDS', () => {
  it('should list the two free regex keywords', () => {
    expect(FREE_PATTERN_KEYWORDS).toEqual(['pattern', 'patternProperties']);
  });
});

describe('withoutFreePatterns', () => {
  it('should remove the free patterns from each subschema without descending into what it removed', () => {
    const schema: RecordType = {
      type: 'object',
      properties: {
        code: { type: 'string', pattern: '^a$', maxLength: 10, format: 'git-sha' },
        list: { type: 'array', items: { pattern: '^b$' } },
      },
      patternProperties: { '^x': { pattern: '^c$' } },
      allOf: [{ propertyNames: { pattern: '^d$' } }],
      $defs: { z: { pattern: '^e$' } },
      required: ['code'],
    };

    expect(withoutFreePatterns(schema)).toEqual({
      type: 'object',
      properties: {
        code: { type: 'string', maxLength: 10, format: 'git-sha' },
        list: { type: 'array', items: {} },
      },
      allOf: [{ propertyNames: {} }],
      $defs: { z: {} },
      required: ['code'],
    });
  });

  it('should remove the pattern from a contentSchema', () => {
    const schema: RecordType = {
      type: 'string',
      contentMediaType: 'application/json',
      contentSchema: { type: 'string', pattern: '^a+$' },
    };

    expect(withoutFreePatterns(schema)).toEqual({
      type: 'string',
      contentMediaType: 'application/json',
      contentSchema: { type: 'string' },
    });
  });

  it('should keep the field named pattern inside properties', () => {
    const schema: RecordType = {
      type: 'object',
      properties: { pattern: { type: 'string' }, patternProperties: { type: 'string' } },
    };

    expect(withoutFreePatterns(schema)).toEqual(schema);
  });

  it('should not mutate the input', () => {
    const schema: RecordType = {
      type: 'object',
      properties: { code: { type: 'string', pattern: '^a$' } },
      patternProperties: { '^x': { type: 'string' } },
    };
    const original = structuredClone(schema);

    const result = withoutFreePatterns(schema);

    expect(schema).toEqual(original);
    expect(result).not.toBe(schema);
  });
});

describe('hasKeywordAt', () => {
  const schema = {
    pattern: '^root$',
    properties: { 'a/b~c': { pattern: '^x$' } },
    examples: [{ pattern: '^y$' }],
    nothing: null,
  };

  it.each(['', '/properties/a~1b~0c', '/examples/0'])(
    'should resolve %j and find pattern',
    (location) => {
      expect(hasKeywordAt(schema, location, 'pattern')).toBe(true);
    },
  );

  it.each([
    ['a missing pointer', '/properties/ghost'],
    ['a pointer with an index out of the array', '/examples/1'],
    ['a keyword absent from the object', '/properties'],
    ['a target that is not an object', '/examples/0/pattern'],
    ['a pointer that goes through null', '/nothing/pattern'],
  ])('should return false for %s', (_label, location) => {
    expect(hasKeywordAt(schema, location, 'pattern')).toBe(false);
  });
});
