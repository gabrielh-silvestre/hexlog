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
  it('should visit the subschema keywords with an RFC 6901 pointer', () => {
    const schema = {
      properties: { 'a/b': { items: { type: 'string' } }, 'c~d': {} },
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
      '/properties/a~1b',
      '/properties/a~1b/items',
      '/properties/c~0d',
      '/$defs/x',
    ]);
  });

  it('should descend into the patternProperties values', () => {
    const schema = { patternProperties: { '^a': { items: {} } } };

    expect(pointersOf(schema)).toEqual([
      '',
      '/patternProperties/^a',
      '/patternProperties/^a/items',
    ]);
  });

  it('should descend into contentSchema', () => {
    const schema = { type: 'string', contentSchema: { type: 'string', pattern: '^a+$' } };

    expect(pointersOf(schema)).toEqual(['', '/contentSchema']);
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
  it('should remove pattern and patternProperties from each subschema without descending into what it removed', () => {
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
  };

  it.each([
    ['', 'pattern'],
    ['/properties/a~1b~0c', 'pattern'],
    ['/examples/0', 'pattern'],
  ])('should resolve %j and find %s', (location, keyword) => {
    expect(hasKeywordAt(schema, location, keyword)).toBe(true);
  });

  it.each([
    ['a missing pointer', '/properties/ghost', 'pattern'],
    ['a pointer with an index out of the array', '/examples/1', 'pattern'],
    ['a keyword absent from the object', '/properties', 'pattern'],
    ['a target that is not an object', '/examples/0/pattern', 'pattern'],
  ])('should return false for %s', (_label, location, keyword) => {
    expect(hasKeywordAt(schema, location, keyword)).toBe(false);
  });
});
