import { describe, expect, test } from '@jest/globals';
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
  test('visita as palavras-chave de subschema com ponteiro RFC 6901', () => {
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

  test('desce nos valores de patternProperties', () => {
    const schema = { patternProperties: { '^a': { items: {} } } };

    expect(pointersOf(schema)).toEqual([
      '',
      '/patternProperties/^a',
      '/patternProperties/^a/items',
    ]);
  });

  test('desce no contentSchema', () => {
    const schema = { type: 'string', contentSchema: { type: 'string', pattern: '^a+$' } };

    expect(pointersOf(schema)).toEqual(['', '/contentSchema']);
  });

  test('ignora o valor em array de dependencies', () => {
    const schema = { dependencies: { a: ['b'], c: { required: ['d'] } } };

    expect(pointersOf(schema)).toEqual(['', '/dependencies/c']);
  });

  test.each(['const', 'enum', 'default', 'examples'])('não entra em %s, que é dado', (keyword) => {
    const schema = { [keyword]: [{ properties: { x: {} } }], properties: { y: {} } };

    expect(pointersOf(schema)).toEqual(['', '/properties/y']);
  });

  test('ignora raiz que não é objeto', () => {
    expect(pointersOf(true)).toEqual([]);
    expect(pointersOf(null)).toEqual([]);
  });

  test('o que o visit apaga no nó não é percorrido', () => {
    const schema: Record<string, unknown> = { properties: { x: {} }, items: {} };
    const visited: string[] = [];

    walkSubschemas(schema, (node, pointer) => {
      visited.push(pointer);
      delete node.items;
    });

    expect(visited).toEqual(['', '/properties/x']);
  });
});

describe('withoutFreePatterns', () => {
  test('lista as duas palavras-chave de regex livre', () => {
    expect(FREE_PATTERN_KEYWORDS).toEqual(['pattern', 'patternProperties']);
  });

  test('remove pattern e patternProperties de cada subschema, sem descer no que removeu', () => {
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

  test('remove o pattern de um contentSchema', () => {
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

  test('mantém o campo de nome pattern dentro de properties', () => {
    const schema: RecordType = {
      type: 'object',
      properties: { pattern: { type: 'string' }, patternProperties: { type: 'string' } },
    };

    expect(withoutFreePatterns(schema)).toEqual(schema);
  });

  test('não muta a entrada', () => {
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

  test.each([
    ['', 'pattern'],
    ['/properties/a~1b~0c', 'pattern'],
    ['/examples/0', 'pattern'],
  ])('resolve %j e encontra %s', (location, keyword) => {
    expect(hasKeywordAt(schema, location, keyword)).toBe(true);
  });

  test.each([
    ['ponteiro inexistente', '/properties/ghost', 'pattern'],
    ['ponteiro com índice fora do array', '/examples/1', 'pattern'],
    ['palavra-chave ausente no objeto', '/properties', 'pattern'],
    ['destino que não é objeto', '/examples/0/pattern', 'pattern'],
  ])('devolve falso para %s', (_label, location, keyword) => {
    expect(hasKeywordAt(schema, location, keyword)).toBe(false);
  });
});
