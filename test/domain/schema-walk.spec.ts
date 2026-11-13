import { describe, expect, it } from '@jest/globals';
import type { RecordType } from '../../src/domain/definitions.ts';
import {
  expandedSize,
  FREE_PATTERN_KEYWORDS,
  hasKeywordAt,
  measureData,
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

const doubling = (levels: number): RecordType => {
  const defs: RecordType = { [`d${levels}`]: { type: 'string' } };
  for (let i = 0; i < levels; i++) {
    defs[`d${i}`] = { allOf: [{ $ref: `#/$defs/d${i + 1}` }, { $ref: `#/$defs/d${i + 1}` }] };
  }
  return { $defs: defs, properties: { x: { $ref: '#/$defs/d0' } } };
};

// Referências que dobram a cada nível e terminam num ciclo de volta à raiz.
const doublingToCycle = (levels: number): RecordType => {
  const schema = doubling(levels);
  (schema.$defs as RecordType)[`d${levels}`] = { properties: { y: { $ref: '#' } } };
  return schema;
};

describe('expandedSize', () => {
  it.each<[string, unknown, number]>([
    ['a schema that is not an object', true, 0],
    ['a leaf schema', { type: 'string' }, 1],
    ['the properties of an object', { properties: { a: {}, b: {} } }, 3],
    ['the branches of an allOf', { allOf: [{}, {}] }, 3],
    [
      'a $ref by the size of its target',
      { $defs: { a: {} }, properties: { x: { $ref: '#/$defs/a' } } },
      3,
    ],
    ['a $defs entry that nothing cites as zero', { $defs: { a: { allOf: [{}, {}] } } }, 1],
  ])('should count %s', (_label, schema, expected) => {
    expect(expandedSize(schema)).toBe(expected);
  });

  it('should count a $ref cited twice twice', () => {
    const schema = { $defs: { a: {} }, allOf: [{ $ref: '#/$defs/a' }, { $ref: '#/$defs/a' }] };

    expect(expandedSize(schema)).toBe(1 + 2 * (1 + 1));
  });

  it.each([
    ['a percent-encoded space', '$defs', 'a b', '#/$defs/a%20b'],
    ['an escaped slash', '$defs', 'a/b', '#/$defs/a~1b'],
    ['an escaped tilde', '$defs', 'a~b', '#/$defs/a~0b'],
    ['the definitions container', 'definitions', 'a', '#/definitions/a'],
  ])('should resolve the target of a $ref with %s', (_label, container, key, ref) => {
    const target = { allOf: [{}, {}, {}] };
    const schema = { [container]: { [key]: target }, properties: { x: { $ref: ref } } };
    const plain = { $defs: { a: target }, properties: { x: { $ref: '#/$defs/a' } } };

    expect(expandedSize(schema)).toBe(expandedSize(plain));
  });

  it('should measure references that double at each level in linear time', () => {
    expect(expandedSize(doubling(40))).toBeGreaterThan(2 ** 40);
  });

  it('should saturate references that double into a cycle in linear time', () => {
    expect(expandedSize(doublingToCycle(40))).toBe(Number.MAX_SAFE_INTEGER);
  });

  it('should saturate instead of growing without bound', () => {
    expect(expandedSize(doubling(80))).toBe(Number.MAX_SAFE_INTEGER);
  });

  it.each([
    ['a $ref that is not a local pointer', { $ref: 'https://example.com/other' }],
    ['a $dynamicRef', { $dynamicRef: '#meta' }],
    [
      'a $ref that points back to itself',
      { $defs: { a: { $ref: '#/$defs/a' } }, $ref: '#/$defs/a' },
    ],
    [
      'a nested $id',
      {
        properties: {
          x: {
            $id: 'http://x.test/n.json',
            $defs: { a: { type: 'string' } },
            allOf: [{ $ref: '#/$defs/a' }],
          },
        },
      },
    ],
  ])('should assume the worst for %s', (_label, schema) => {
    expect(expandedSize(schema)).toBe(Number.MAX_SAFE_INTEGER);
  });

  it('should keep measuring a schema whose $id is on the root', () => {
    const schema = {
      $id: 'http://x.test/root.json',
      $defs: { a: {} },
      properties: { x: { $ref: '#/$defs/a' } },
    };

    expect(expandedSize(schema)).toBe(3);
  });

  it('should saturate a schema nested too deeply for the stack', () => {
    let schema: Record<string, unknown> = { type: 'string' };
    for (let i = 0; i < 100_000; i++) schema = { not: schema };

    expect(expandedSize(schema)).toBe(Number.MAX_SAFE_INTEGER);
  });

  describe('with the cycle unfolded to the data depth', () => {
    const unfold = (depth: number, budget = 25_000) => ({ depth, budget });
    const recursiveUnder = (levels: number): unknown => {
      let inner: Record<string, unknown> = { $ref: '#' };
      for (let i = 0; i < levels; i++) inner = { not: inner };
      return { properties: { a: inner } };
    };
    // Árvore: raiz, `child` e o item do allOf valem 3 por nível; o último nível corta a citação.
    const tree = { type: 'object', properties: { child: { allOf: [{ $ref: '#' }] } } };

    it.each([
      [0, 3],
      [1, 6],
      [2, 9],
    ])('should unfold a tree schema over data of depth %i to %i', (depth, expected) => {
      expect(expandedSize(tree, unfold(depth))).toBe(expected);
    });

    it('should unfold a $ref to a root that carries an $id like one without it', () => {
      expect(expandedSize({ $id: 'https://example.com/tree', ...tree }, unfold(2))).toBe(9);
    });

    it('should stop at the budget for references that double into a cycle', () => {
      expect(expandedSize(doublingToCycle(40), unfold(5, 1_000))).toBe(Number.MAX_SAFE_INTEGER);
    });

    // O ciclo desce por `keyword` e gasta um nível: 2 subschemas por nível, em 4 níveis
    it.each<[string, unknown]>([
      ['properties', { properties: { a: { $ref: '#' } } }],
      ['patternProperties', { patternProperties: { x: { $ref: '#' } } }],
      ['additionalProperties', { additionalProperties: { $ref: '#' } }],
      ['items', { items: { $ref: '#' } }],
      ['prefixItems', { prefixItems: [{ $ref: '#' }] }],
      ['contains', { contains: { $ref: '#' } }],
      ['propertyNames', { propertyNames: { $ref: '#' } }],
      ['unevaluatedItems', { unevaluatedItems: { $ref: '#' } }],
      ['unevaluatedProperties', { unevaluatedProperties: { $ref: '#' } }],
    ])('should spend a data level on the keyword %s', (_keyword, schema) => {
      expect(expandedSize(schema, unfold(3))).toBe(8);
    });

    // O ciclo desce por `properties` e volta por `keyword`, que não gasta nível: 3 por nível, em 4
    it.each<[string, unknown]>([
      ['allOf', { properties: { a: { allOf: [{ $ref: '#' }] } } }],
      ['anyOf', { properties: { a: { anyOf: [{ $ref: '#' }] } } }],
      ['oneOf', { properties: { a: { oneOf: [{ $ref: '#' }] } } }],
      ['not', { properties: { a: { not: { $ref: '#' } } } }],
      ['if', { properties: { a: { if: { $ref: '#' } } } }],
      ['then', { properties: { a: { then: { $ref: '#' } } } }],
      ['else', { properties: { a: { else: { $ref: '#' } } } }],
      ['dependentSchemas', { properties: { a: { dependentSchemas: { b: { $ref: '#' } } } } }],
      ['dependencies', { properties: { a: { dependencies: { b: { $ref: '#' } } } } }],
      ['contentSchema', { properties: { a: { contentSchema: { $ref: '#' } } } }],
    ])('should keep the data level on the keyword %s', (_keyword, schema) => {
      expect(expandedSize(schema, unfold(3))).toBe(12);
    });

    it('should unfold a cycle through $defs, counting the cited target at each level', () => {
      const schema = {
        $defs: { a: { properties: { x: { $ref: '#/$defs/a' } } } },
        $ref: '#/$defs/a',
      };

      expect(expandedSize(schema, unfold(2))).toBe(1 + 2 * (2 + 1));
    });

    it('should not reuse the size of a target that was cut by a cycle in progress', () => {
      const schema = {
        $defs: {
          a: { properties: { x: { $ref: '#/$defs/b' } } },
          b: { properties: { y: { $ref: '#/$defs/a' } } },
        },
        allOf: [{ $ref: '#/$defs/a' }, { $ref: '#/$defs/b' }],
      };

      expect(expandedSize(schema, unfold(1))).toBe(11);
    });

    it('should measure an acyclic schema as without unfold, also for a budget that just fits', () => {
      const schema = { $defs: { a: {} }, allOf: [{ $ref: '#/$defs/a' }, { $ref: '#/$defs/a' }] };

      expect(expandedSize(schema, unfold(7, 4))).toBe(1 + 2 * (1 + 1));
    });

    it('should keep the linear time of references that double with an unfold', () => {
      expect(expandedSize(doubling(40), unfold(5, 1_000))).toBeGreaterThan(2 ** 40);
    });

    it('should measure when the steps equal the budget and saturate one step below', () => {
      const sizes = [9, 8].map((budget) => expandedSize(tree, unfold(2, budget)));

      expect(sizes).toEqual([9, Number.MAX_SAFE_INTEGER]);
    });

    it.each<[string, unknown]>([
      ['a $ref to the root that does not spend a level', { $ref: '#' }],
      ['a root cycle through allOf', { allOf: [{ $ref: '#' }] }],
      [
        'a cycle through $defs that does not spend a level',
        { $defs: { a: { $ref: '#/$defs/a' } }, $ref: '#/$defs/a' },
      ],
      ['a $ref that is not a local pointer', { $ref: 'https://example.com/other' }],
      ['a $ref to an anchor', { properties: { a: { $ref: '#node' } } }],
      ['a $dynamicRef', { $dynamicRef: '#meta' }],
    ])('should still assume the worst for %s', (_label, schema) => {
      expect(expandedSize(schema, unfold(5))).toBe(Number.MAX_SAFE_INTEGER);
    });

    it.each([
      { copies: 100, depth: 60 },
      { copies: 800, depth: 8 },
    ])(
      'should not throw for $copies nested not under a cycle of data depth $depth',
      ({ copies, depth }) => {
        expect(() => expandedSize(recursiveUnder(copies), unfold(depth))).not.toThrow();
      },
    );
  });
});

describe('measureData', () => {
  it('should count every object, array and scalar of the value', () => {
    expect(measureData({ a: [1, 2], b: 'x' }, 100).nodes).toBe(5);
  });

  it('should stop counting once the limit is passed', () => {
    expect(
      measureData(
        Array.from({ length: 1_000 }, () => 1),
        10,
      ).nodes,
    ).toBe(11);
  });

  it.each<[string, unknown, number]>([
    ['a scalar at the root', 'x', 0],
    ['an empty object', {}, 0],
    ['the fields of an object', { a: 1, b: 2 }, 1],
    ['objects nested in objects', { a: 1, b: { c: { d: 1 } } }, 3],
    ['an array of objects', [{ a: 1 }, {}], 2],
    ['an array nested in an array', [[1]], 2],
  ])('should measure the depth of %s', (_label, value, expected) => {
    expect(measureData(value, 100).depth).toBe(expected);
  });
});
