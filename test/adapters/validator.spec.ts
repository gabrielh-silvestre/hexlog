import { afterEach, describe, expect, it, jest } from '@jest/globals';
import Ajv2020 from 'ajv/dist/2020.js';
import { createValidator } from '../../src/adapters/validator.ts';
import { attachmentFields, type RecordType } from '../../src/domain/definitions.ts';
import { withRegExpSpy } from './regexp-spy.ts';

const validator = createValidator();

const HASH = 'a'.repeat(64);

const noteSchema: RecordType = {
  type: 'object',
  properties: { text: { type: 'string', minLength: 2 }, count: { type: 'integer' } },
  required: ['text'],
  additionalProperties: false,
};

const METASCHEMA_IDS = [
  'https://json-schema.org/draft/2020-12/schema',
  'https://json-schema.org/draft/2020-12/meta/core',
  'https://json-schema.org/draft/2020-12/meta/validation',
];

/** Compila com o ajv estrito sem o `createValidator`: o controle que prova o que o validador evita. */
const compileWithPlainAjv = (schema: object) =>
  new Ajv2020.default({ strict: true, logger: false }).compile(schema);

const gitShaSchema = {
  type: 'object',
  properties: { commit: { type: 'string', format: 'git-sha' } },
};

describe('checkSchema', () => {
  it.each([
    ['a valid schema', noteSchema],
    [
      'a schema with the attachment format',
      { type: 'object', properties: { file: { type: 'string', format: 'attachment' } } },
    ],
  ])(
    'should find no problem in %s, which the metaschema and the format catalog allow',
    (_name, schema) => {
      expect(validator.checkSchema(schema)).toEqual([]);
    },
  );

  it('should refuse a keyword value that violates the metaschema, with the path of the point', () => {
    const details = validator.checkSchema({ type: 'object', properties: { a: { type: 5 } } });

    expect(details.map(({ path, code }) => ({ path, code }))).toEqual([
      { path: '/properties/a/type', code: 'enum' },
      { path: '/properties/a/type', code: 'type' },
      { path: '/properties/a/type', code: 'any-of' },
    ]);
  });

  it.each([
    ['an unknown keyword', { type: 'object', bogus: true }],
    ['an unknown format', { type: 'string', format: 'not-a-format' }],
    ['an external $ref', { $ref: 'https://example.com/schema.json' }],
    ['a $schema of another draft', { $schema: 'http://json-schema.org/draft-07/schema#' }],
  ])(
    'should refuse %s with an invalid-schema detail at the root of the schema',
    (_name, schema) => {
      expect(validator.checkSchema(schema)).toEqual([
        { path: '', code: 'invalid-schema', message: expect.any(String) },
      ]);
    },
  );

  const cyclic = {
    $defs: { a: { $ref: '#/$defs/b' }, b: { $ref: '#/$defs/a' } },
    $ref: '#/$defs/a',
  };

  it('should refuse a cyclic $ref with a readable message', () => {
    expect(validator.checkSchema(cyclic)).toEqual([
      { path: '', code: 'invalid-schema', message: expect.stringContaining('cyclic $ref') },
    ]);
  });

  it('should keep working after refusing a cyclic $ref', () => {
    validator.checkSchema(cyclic);

    expect(validator.checkSchema({ type: 'object' })).toEqual([]);
  });

  it('should not leak an absolute path in the refusal message', () => {
    const messages = validator
      .checkSchema({ $ref: 'file:///etc/passwd' })
      .map((detail) => detail.message);

    expect(messages.join('\n')).not.toMatch(process.cwd());
  });

  it.each(METASCHEMA_IDS)('should refuse the $id of the metaschema %s', (id) => {
    expect(validator.checkSchema({ $id: id, type: 'object' })).toEqual([
      { path: '', code: 'invalid-schema', message: expect.stringContaining('already') },
    ]);
  });

  it('should refuse a schema with an $id and an unresolvable $ref with a single detail', () => {
    const $id = 'https://example.com/unresolvable';

    expect(validator.checkSchema({ $id, $ref: 'https://nowhere/x' })).toEqual([
      { path: '', code: 'invalid-schema', message: expect.stringContaining('nowhere') },
    ]);
  });

  it('should accept a repeated $id after a compilation that threw', () => {
    const $id = 'https://example.com/dangling';
    validator.checkSchema({ $id, $ref: 'https://nowhere/x' });

    expect(validator.checkSchema({ $id, type: 'object' })).toEqual([]);
  });

  it('should refuse a $async schema with an invalid-schema detail at the root of the schema', () => {
    expect(validator.checkSchema({ $async: true, type: 'string' })).toEqual([
      { path: '', code: 'invalid-schema', message: expect.stringMatching(/async/) },
    ]);
  });

  it('should accept $async: false', () => {
    expect(validator.checkSchema({ $async: false, type: 'string' })).toEqual([]);
  });

  it('should list the short metaschema errors without repeats', () => {
    expect(validator.checkSchema({ items: [{ type: 'string' }] })).toEqual([
      { path: '/items', code: 'type', message: expect.any(String) },
    ]);
  });

  it('should cut at 50 details and report in the last one how many were left out', () => {
    const properties = Object.fromEntries(
      Array.from({ length: 70 }, (_, i) => [`p${i}`, { type: 5 }]),
    );

    const details = validator.checkSchema({ type: 'object', properties });

    expect(details).toHaveLength(51);
    expect(details.at(-1)).toEqual({
      path: '',
      code: 'too-many-errors',
      message: expect.stringMatching(/^\d+ more errors omitted$/),
    });
  });

  describe('with an attachment mark in the schema', () => {
    const mark = { type: 'string', format: 'attachment' };
    const misplaced = (path: string) => [
      { path, code: 'invalid-schema', message: expect.stringContaining('["string","null"]') },
    ];

    it('should accept the mark in a first-level field and in the items of a list', () => {
      expect(
        validator.checkSchema({
          type: 'object',
          properties: { file: mark, files: { type: 'array', items: mark } },
        }),
      ).toEqual([]);
    });

    it('should accept the mark in an optional field written as type ["string","null"]', () => {
      expect(
        validator.checkSchema({
          type: 'object',
          properties: { file: { type: ['string', 'null'], format: 'attachment' } },
        }),
      ).toEqual([]);
    });

    it('should refuse the mark in a nested object, with the path of the field and the way out in the message', () => {
      const schema = {
        type: 'object',
        properties: { outer: { type: 'object', properties: { file: mark } } },
      };

      expect(validator.checkSchema(schema)).toEqual(
        misplaced('/properties/outer/properties/file/format'),
      );
    });

    it('should refuse the mark in an anyOf inside a first-level field', () => {
      const schema = {
        type: 'object',
        properties: { file: { anyOf: [mark, { type: 'null' }] } },
      };

      expect(validator.checkSchema(schema)).toEqual(misplaced('/properties/file/anyOf/0/format'));
    });

    // As marcas que o checkSchema aceita têm de ser as que attachmentFields devolve: marca aceita e
    // ignorada nunca seria conferida pelo register.
    it.each<[string, RecordType, boolean]>([
      ['a field', { type: 'object', properties: { a: mark } }, true],
      [
        'the items of a field',
        { type: 'object', properties: { a: { type: 'array', items: mark } } },
        true,
      ],
      [
        'a nullable field',
        { type: 'object', properties: { a: { type: ['string', 'null'], format: 'attachment' } } },
        true,
      ],
      [
        'a nested object',
        { type: 'object', properties: { b: { type: 'object', properties: { a: mark } } } },
        false,
      ],
      ['the anyOf of a field', { type: 'object', properties: { a: { anyOf: [mark] } } }, false],
      ['the oneOf of a field', { type: 'object', properties: { a: { oneOf: [mark] } } }, false],
      ['the allOf of a field', { type: 'object', properties: { a: { allOf: [mark] } } }, false],
      [
        '$defs',
        { type: 'object', properties: { a: { type: 'string' } }, $defs: { a: mark } },
        false,
      ],
      ['additionalProperties', { type: 'object', additionalProperties: mark }, false],
    ])(
      'should accept a mark in %s only when attachmentFields recognizes it',
      (_position, schema, accepted) => {
        const recognized = attachmentFields(schema);

        const details = validator.checkSchema(schema);

        expect(details).toHaveLength(accepted ? 0 : 1);
        expect(recognized).toEqual(accepted ? ['a'] : []);
      },
    );
  });

  const SENTINEL = 'SENT_check';
  const hostile = `^${SENTINEL}(a|aa)+$`;
  const invalidSchema = (path: string) => [
    { path, code: 'invalid-schema', message: expect.any(String) },
  ];
  const notAllowed = (path: string) => [
    { path, code: 'pattern-not-allowed', message: expect.stringContaining('git-sha') },
  ];

  it('should refuse a pattern even when it is safe and has maxLength, with the pointer of the pattern', () => {
    expect(
      validator.checkSchema({ type: 'string', pattern: '^[0-9a-f]+$', maxLength: 64 }),
    ).toEqual(notAllowed('/pattern'));
  });

  it('should refuse a pattern that does not compile as a regex without throwing', () => {
    expect(validator.checkSchema({ type: 'string', pattern: '(' })).toEqual(notAllowed('/pattern'));
  });

  it('should cite the catalog and the path without pattern in the message', () => {
    const [detail] = validator.checkSchema({ type: 'string', pattern: '^a$' });

    expect(detail?.message).toBe(
      'pattern is not allowed in a type schema; use a catalog format (git-sha) or plain minLength/maxLength',
    );
  });

  it('should refuse patternProperties, with the sibling properties and the additionalProperties', () => {
    expect(
      validator.checkSchema({
        type: 'object',
        properties: { k: { type: 'string' } },
        patternProperties: { '^x-': { type: 'string' } },
        additionalProperties: false,
      }),
    ).toEqual([
      {
        path: '/patternProperties',
        code: 'pattern-not-allowed',
        message: expect.stringMatching(/^patternProperties is not allowed/),
      },
    ]);
  });

  it('should refuse the pattern inside the value of patternProperties, besides patternProperties itself', () => {
    const details = validator.checkSchema({
      type: 'object',
      patternProperties: { 'a/b': { type: 'string', pattern: '^a$' } },
    });

    expect(details.map((detail) => detail.path).sort()).toEqual([
      '/patternProperties',
      '/patternProperties/a~1b/pattern',
    ]);
  });

  // Um schema mínimo aceito pelo ajv estrito para cada palavra-chave aplicadora do 2020-12 que
  // carrega subschema. O modo estrito pede: `if` junto de `then`/`else`; `minItems` e `maxItems`
  // no `prefixItems`; `type` no pai das que miram objeto ou array. `dependentSchemas` e
  // `dependencies` valem para o próprio objeto, então o `pattern` vai um nível abaixo, em
  // `properties`. `patternProperties` não entra: ele próprio é recusado.
  const keywordCases: [string, (child: RecordType) => RecordType, string][] = [
    ['properties', (c) => ({ type: 'object', properties: { a: c } }), '/properties/a'],
    ['$defs', (c) => ({ $defs: { a: c } }), '/$defs/a'],
    ['definitions', (c) => ({ definitions: { a: c } }), '/definitions/a'],
    [
      'dependentSchemas',
      (c) => ({ type: 'object', dependentSchemas: { a: { properties: { b: c } } } }),
      '/dependentSchemas/a/properties/b',
    ],
    [
      'dependencies',
      (c) => ({ type: 'object', dependencies: { a: { properties: { b: c } } } }),
      '/dependencies/a/properties/b',
    ],
    ['allOf', (c) => ({ allOf: [c] }), '/allOf/0'],
    ['anyOf', (c) => ({ anyOf: [c] }), '/anyOf/0'],
    ['oneOf', (c) => ({ oneOf: [c] }), '/oneOf/0'],
    ['not', (c) => ({ not: c }), '/not'],
    ['if', (c) => ({ if: c, then: {} }), '/if'],
    ['then', (c) => ({ if: {}, then: c }), '/then'],
    ['else', (c) => ({ if: {}, else: c }), '/else'],
    ['contains', (c) => ({ type: 'array', contains: c }), '/contains'],
    ['items', (c) => ({ type: 'array', items: c }), '/items'],
    [
      'prefixItems',
      (c) => ({ type: 'array', prefixItems: [c], minItems: 1, maxItems: 1 }),
      '/prefixItems/0',
    ],
    [
      'additionalProperties',
      (c) => ({ type: 'object', additionalProperties: c }),
      '/additionalProperties',
    ],
    ['unevaluatedItems', (c) => ({ type: 'array', unevaluatedItems: c }), '/unevaluatedItems'],
    [
      'unevaluatedProperties',
      (c) => ({ type: 'object', unevaluatedProperties: c }),
      '/unevaluatedProperties',
    ],
    ['propertyNames', (c) => ({ type: 'object', propertyNames: c }), '/propertyNames'],
    [
      'contentSchema',
      (c) => ({ type: 'string', contentMediaType: 'application/json', contentSchema: c }),
      '/contentSchema',
    ],
  ];

  describe.each(keywordCases)('with a subschema inside %s', (_keyword, wrap, base) => {
    it('should refuse a pattern, with the pointer of the pattern', () => {
      const schema = wrap({ type: 'string', pattern: '^[a-z]+$', maxLength: 64 });

      expect(validator.checkSchema(schema)).toEqual(notAllowed(`${base}/pattern`));
    });

    it('should accept the same subschema without a pattern', () => {
      const schema = wrap({ type: 'string', minLength: 1, maxLength: 64 });

      expect(validator.checkSchema(schema)).toEqual([]);
    });
  });

  describe.each(keywordCases.filter(([keyword]) => keyword !== 'properties'))(
    'with an attachment mark inside %s',
    (_keyword, wrap, base) => {
      it('should refuse the mark, with the pointer of the format', () => {
        const schema = wrap({ type: 'string', format: 'attachment' });

        expect(validator.checkSchema(schema)).toEqual(invalidSchema(`${base}/format`));
      });
    },
  );

  it('should ignore the array values of dependencies, which are not subschemas', () => {
    expect(validator.checkSchema({ type: 'object', dependencies: { a: ['b'] } })).toEqual([]);
  });

  it('should refuse a nested pattern, with the pointer of the field', () => {
    const bad = { type: 'string', pattern: '^a$', maxLength: 10 };

    const details = validator.checkSchema({
      type: 'object',
      properties: { 'a/b': bad },
      $defs: { d: bad },
      allOf: [{ type: 'object' }, { type: 'object', properties: { c: bad } }],
      propertyNames: bad,
      additionalProperties: { type: 'array', items: bad },
    });

    expect(details.map((detail) => detail.path).sort()).toEqual([
      '/$defs/d/pattern',
      '/additionalProperties/items/pattern',
      '/allOf/1/properties/c/pattern',
      '/properties/a~1b/pattern',
      '/propertyNames/pattern',
    ]);
  });

  it('should not refuse a field named pattern nor treat data (const, enum, default) as a subschema', () => {
    expect(
      validator.checkSchema({
        type: 'object',
        properties: { pattern: { type: 'string', maxLength: 5, default: 'x' } },
        const: { pattern: '^a$' },
      }),
    ).toEqual([]);
  });

  const withFormat = (format: string) => ({
    type: 'object',
    properties: { a: { type: 'string', format } },
  });

  it.each([
    ['the catalog', 'git-sha'],
    ['ajv-formats', 'uri'],
  ])('should accept a format from %s', (_source, format) => {
    expect(validator.checkSchema(withFormat(format))).toEqual([]);
  });

  it('should refuse a format outside the catalog and ajv-formats', () => {
    expect(validator.checkSchema(withFormat('not-a-format'))).toEqual(invalidSchema(''));
  });

  // O pattern que um `$ref` alcança dentro de dado não é subschema para a varredura; quem o grava
  // é o compilador neutro, sem construir o regex.
  describe('with a pattern reached through a $ref to data', () => {
    const pattern = { type: 'string', pattern: `^${SENTINEL}$` };

    it.each([
      ['#/examples/0', { examples: [pattern] }, '/examples/0/pattern'],
      ['#/const', { const: pattern }, '/const/pattern'],
      ['#/default', { default: pattern }, '/default/pattern'],
      ['#/enum/0', { enum: [pattern] }, '/enum/0/pattern'],
      ['#/const/a~1b~0c%25d', { const: { 'a/b~c%d': pattern } }, '/const/a~1b~0c%d/pattern'],
    ])(
      'should refuse a $ref to %s with the path of the pattern, without building the regex',
      (ref, data, path) => {
        const usage = withRegExpSpy(SENTINEL, () =>
          createValidator().checkSchema({ $ref: ref, ...data }),
        );

        expect(usage).toEqual({ result: notAllowed(path), constructions: 0, executions: 0 });
      },
    );

    // Guarda de complexidade, não orçamento: o teto de 5 s tem margem larga sobre o custo real
    // (milissegundos), e só um regex executado sobre o padrão hostil o estoura.
    it.each<[string, (schema: RecordType) => RecordType, string]>([
      ['direct', (schema) => schema, '/patternProperties'],
      [
        'through a $ref',
        (schema) => ({ $ref: '#/examples/0', examples: [schema] }),
        '/examples/0/patternProperties',
      ],
    ])(
      'should return fast without touching the regex for a hostile patternProperties, %s',
      (_how, wrap, path) => {
        const schema = wrap({
          type: 'object',
          properties: { k: { type: 'string' } },
          patternProperties: { [hostile]: { type: 'integer' } },
          additionalProperties: false,
        });
        const startedAt = Date.now();

        const usage = withRegExpSpy(SENTINEL, () => createValidator().checkSchema(schema));
        const elapsedMs = Date.now() - startedAt;

        expect(usage).toEqual({ result: notAllowed(path), constructions: 0, executions: 0 });
        expect(elapsedMs).toBeLessThan(5_000);
      },
    );

    it.each([
      ['pattern', { type: 'string', pattern: '(' }],
      ['key of patternProperties', { type: 'object', patternProperties: { '(': {} } }],
    ])('should not throw on a $ref to a %s that does not compile as a regex', (_name, schema) => {
      expect(() => compileWithPlainAjv(schema)).toThrow(/Invalid regular expression/);

      const details = validator.checkSchema({ $ref: '#/examples/0', examples: [schema] });

      expect(details).toEqual([
        {
          path: expect.stringMatching(/^\/examples\/0\//),
          code: 'pattern-not-allowed',
          message: expect.any(String),
        },
      ]);
    });

    it('should not refuse a $ref to the metaschema of JSON Schema', () => {
      // validador novo: o compartilhado já tem o cache quente e esconderia a guarda do metaschema
      expect(
        createValidator().checkSchema({
          type: 'object',
          properties: { a: { $ref: 'https://json-schema.org/draft/2020-12/schema' } },
        }),
      ).toEqual([]);
    });

    it('should refuse only the pattern of the data when a $ref to the metaschema comes with a $ref to data', () => {
      // validador novo: o compartilhado já tem o cache quente e esconderia a guarda do metaschema
      expect(
        createValidator().checkSchema({
          allOf: [
            { $ref: 'https://json-schema.org/draft/2020-12/schema' },
            { $ref: '#/examples/0' },
          ],
          examples: [pattern],
        }),
      ).toEqual(notAllowed('/examples/0/pattern'));
    });

    it('should leave the path empty when a nested $id makes the pointer not resolve in the document', () => {
      expect(
        validator.checkSchema({
          $ref: 'https://example.com/nested.json#/examples/0',
          $defs: { nested: { $id: 'https://example.com/nested.json', examples: [pattern] } },
        }),
      ).toEqual(notAllowed(''));
    });
  });
});

describe('validate', () => {
  it('should return an empty list for conforming data', () => {
    expect(validator.validate(noteSchema, { text: 'ok', count: 1 })).toEqual([]);
  });

  it.each([
    ['the missing property', { count: 1 }, '/text', 'required'],
    ['the extra property', { text: 'ok', extra: 1 }, '/extra', 'additional-properties'],
    ['the one of the wrong type', { text: 'ok', count: 'x' }, '/count', 'type'],
    ['the one that is too short', { text: 'x' }, '/text', 'min-length'],
  ])('should point at %s, in kebab-case', (_name, data, path, code) => {
    expect(validator.validate(noteSchema, data)).toEqual([
      { path, code, message: expect.any(String) },
    ]);
  });

  it('should return every violation of an object in a single call', () => {
    const details = validator.validate(noteSchema, { text: 1, count: 'x', extra: true });

    expect(details).toHaveLength(3);
    expect(details).toEqual(
      expect.arrayContaining([
        { path: '/text', code: 'type', message: expect.any(String) },
        { path: '/count', code: 'type', message: expect.any(String) },
        { path: '/extra', code: 'additional-properties', message: expect.any(String) },
      ]),
    );
  });

  it.each<[string, RecordType, unknown, string, string]>([
    ['maxLength', { type: 'string', maxLength: 300 }, 'a'.repeat(312), 'max-length', 'got 312'],
    ['minLength', { type: 'string', minLength: 5 }, 'abc', 'min-length', 'got 3'],
    ['maximum', { type: 'number', maximum: 10 }, 12.5, 'maximum', 'got 12.5'],
    ['minimum', { type: 'integer', minimum: 10 }, 3, 'minimum', 'got 3'],
  ])('should report the measured value of a %s violation', (_keyword, schema, data, code, got) => {
    expect(validator.validate(schema, data as never)).toEqual([
      { path: '', code, message: expect.stringContaining(`(${got})`) },
    ]);
  });

  it('should count an emoji as a single code point in the measured length', () => {
    const schema: RecordType = { type: 'string', maxLength: 3 };

    expect(validator.validate(schema, '😀😀😀😀' as never)).toEqual([
      { path: '', code: 'max-length', message: expect.stringContaining('(got 4)') },
    ]);
  });

  it('should keep the ajv message of a violation without a measured value', () => {
    const [detail] = validator.validate(noteSchema, { count: 1 });

    expect(detail?.message).toBe("must have required property 'text'");
  });

  it('should return the error of each branch of an anyOf, plus the one of the anyOf', () => {
    const schema: RecordType = {
      anyOf: [
        { type: 'string', maxLength: 10 },
        { type: 'string', maxLength: 5 },
      ],
    };

    expect(validator.validate(schema, `${'a'.repeat(60)}b` as never)).toEqual([
      { path: '', code: 'max-length', message: expect.any(String) },
      { path: '', code: 'max-length', message: expect.any(String) },
      { path: '', code: 'any-of', message: expect.any(String) },
    ]);
  });

  const patternAndMaxLength = {
    type: 'object',
    properties: { text: { type: 'string', maxLength: 10, pattern: '^(a|aa)+$' } },
  };

  it('should ignore the pattern of a subschema', () => {
    expect(validator.validate(patternAndMaxLength, { text: 'zzz' })).toEqual([]);
  });

  it('should keep the maxLength of the subschema that also has a pattern', () => {
    expect(validator.validate(patternAndMaxLength, { text: `${'a'.repeat(60)}b` })).toEqual([
      { path: '/text', code: 'max-length', message: expect.any(String) },
    ]);
  });

  it('should cut at 50 details and count the rest with 7 thousand invalid items', () => {
    const schema = {
      type: 'object',
      properties: { items: { type: 'array', items: { type: 'string' } } },
    };
    const data = { items: Array.from({ length: 7_000 }, (_, i) => i) };

    const details = validator.validate(schema, data);

    expect(details).toHaveLength(51);
    expect(details.at(-1)).toEqual({
      path: '',
      code: 'too-many-errors',
      message: expect.stringContaining('6950'),
    });
  }, 15_000);

  it('should count a lone surrogate as one code point in the measured length', () => {
    const schema: RecordType = { type: 'string', maxLength: 1 };

    expect(validator.validate(schema, '😀a\ud83d' as never)).toEqual([
      { path: '', code: 'max-length', message: expect.stringContaining('(got 3)') },
    ]);
  });

  it('should cut at 50 and count the rest with a long string that fails 600 maxLength limits', () => {
    const schema: RecordType = {
      type: 'string',
      allOf: Array.from({ length: 600 }, (_, i) => ({ maxLength: i + 1 })),
    };

    const details = validator.validate(schema, 'a'.repeat(16_000) as never);

    expect(details).toHaveLength(51);
    expect(details[0]?.message).toContain('(got 16000)');
    expect(details.at(-1)).toEqual({
      path: '',
      code: 'too-many-errors',
      message: '550 more errors omitted',
    });
  }, 15_000);

  describe('with a schema and data of high estimated cost', () => {
    const compileSpy = () => jest.spyOn(Ajv2020.default.prototype, 'compile');
    const chained = (levels: number): RecordType => {
      const defs: RecordType = { [`d${levels}`]: { type: 'string' } };
      for (let i = 0; i < levels; i++) {
        defs[`d${i}`] = { allOf: [{ $ref: `#/$defs/d${i + 1}` }, { $ref: `#/$defs/d${i + 1}` }] };
      }
      return { type: 'object', $defs: defs, properties: { x: { $ref: '#/$defs/d0' } } };
    };
    const manyChecks = (checks: number, itemLimit: Record<string, unknown> = {}): RecordType => ({
      type: 'object',
      properties: {
        a: {
          type: 'array',
          items: {
            ...itemLimit,
            allOf: Array.from({ length: checks }, () => ({ type: 'string' })),
          },
        },
      },
    });

    const capped = {
      path: '',
      code: 'violations-capped',
      message: expect.stringContaining('describe_type'),
    };

    afterEach(() => {
      jest.restoreAllMocks();
    });

    it('should finish fast with one violation for $defs that double 26 times over failing data', () => {
      const details = validator.validate(chained(26), { x: 1 });

      expect(details).toEqual([{ path: '/x', code: 'type', message: 'must be string' }, capped]);
    }, 15_000);

    it('should finish fast with one violation for 900 checks over thousands of failing items', () => {
      const data = { a: Array.from({ length: 8_000 }, () => 1) };

      const details = validator.validate(manyChecks(900), data);

      expect(details).toEqual([{ path: '/a/0', code: 'type', message: 'must be string' }, capped]);
    }, 15_000);

    it('should keep the measured value of the violation it reports above the ceiling', () => {
      const data = { a: Array.from({ length: 40 }, () => 'abcdef') };

      const details = validator.validate(manyChecks(900, { type: 'string', maxLength: 3 }), data);

      expect(details).toEqual([
        {
          path: '/a/0',
          code: 'max-length',
          message: 'must NOT have more than 3 characters (got 6)',
        },
        capped,
      ]);
    });

    it('should return every violation below the ceiling', () => {
      const data = { a: Array.from({ length: 40 }, () => 1) };

      const details = validator.validate(manyChecks(2), data);

      expect(details).toHaveLength(40);
    });

    it('should not add the violations-capped detail below the ceiling', () => {
      const data = { a: Array.from({ length: 40 }, () => 1) };

      const details = validator.validate(manyChecks(2), data);

      expect(details.map(({ code }) => code)).not.toContain('violations-capped');
    });

    it('should not add the violations-capped detail for valid data of a costly schema', () => {
      const data = { a: Array.from({ length: 40 }, () => 's') };

      expect(validator.validate(manyChecks(900), data)).toEqual([]);
    });

    it.each([
      { name: 'valid data', schema: chained(3), data: { x: 's' }, compiles: 1 },
      { name: 'invalid data below the ceiling', schema: chained(3), data: { x: 1 }, compiles: 2 },
      { name: 'invalid data above the ceiling', schema: chained(26), data: { x: 1 }, compiles: 1 },
    ])('should compile the schema $compiles time(s) for $name', ({ schema, data, compiles }) => {
      const spy = compileSpy();

      validator.validate(schema, data);

      expect(spy).toHaveBeenCalledTimes(compiles);
    });

    it('should compile the full pass once for several invalid records of the same schema', () => {
      const schema = chained(3);
      const spy = compileSpy();

      validator.validate(schema, { x: 1 });
      validator.validate(schema, { x: 2 });

      expect(spy).toHaveBeenCalledTimes(2);
    });
  });

  describe('with a string far above maxLength', () => {
    const hostile = 'a@'.repeat(8_000);

    it.each([
      'date-time',
      'time',
      'date',
      'duration',
      'uri',
      'uri-reference',
      'uri-template',
      'url',
      'email',
      'hostname',
      'ipv4',
      'ipv6',
      'regex',
      'uuid',
      'json-pointer',
      'relative-json-pointer',
      'git-sha',
      'attachment',
    ])(
      'should finish fast and report maxLength against the format %s',
      (format) => {
        const schema: RecordType = {
          type: 'object',
          properties: { text: { type: 'string', maxLength: 10, format } },
        };

        const details = validator.validate(schema, { text: hostile });

        expect(details).toContainEqual({
          path: '/text',
          code: 'max-length',
          message: expect.stringContaining('(got 16000)'),
        });
      },
      15_000,
    );
  });

  describe('with repeated validation of a schema', () => {
    const compileSpy = () => jest.spyOn(Ajv2020.default.prototype, 'compile');
    const requiredTextSchema = () => ({
      type: 'object',
      properties: { text: {} },
      required: ['text'],
    });

    afterEach(() => {
      jest.restoreAllMocks();
    });

    it('should compile once for the same object', () => {
      const spy = compileSpy();
      const schema = { type: 'object', properties: { text: { type: 'string' } } };
      validator.validate(schema, {});

      validator.validate(schema, {});

      expect(spy).toHaveBeenCalledTimes(1);
    });

    it('should compile again for an object that is equal but distinct', () => {
      const spy = compileSpy();
      const schema = { type: 'object', properties: { text: { type: 'string' } } };
      validator.validate(schema, {});

      validator.validate({ ...schema }, {});

      expect(spy).toHaveBeenCalledTimes(2);
    });

    it.each([
      ['valid data', { text: 'ok' }, []],
      ['invalid data', {}, [{ path: '/text', code: 'required', message: expect.any(String) }]],
    ])('should stay correct on an already compiled schema for %s', (_name, data, expected) => {
      const schema = requiredTextSchema();
      const first = validator.validate(schema, { text: 'ok' });

      expect(first).toEqual([]);

      const second = validator.validate(schema, data);

      expect(second).toEqual(expected);
    });

    it('should accept valid data again after rejecting invalid data on an already compiled schema', () => {
      const schema = requiredTextSchema();
      validator.validate(schema, { text: 'ok' });
      validator.validate(schema, {});

      const result = validator.validate(schema, { text: 'ok' });

      expect(result).toEqual([]);
    });

    it('should keep apart two schemas with the same $id in distinct objects', () => {
      const $id = 'https://example.com/shared-id';
      const open = { $id, type: 'object' };
      const strict = { $id, ...requiredTextSchema() };
      const openFirst = validator.validate(open, {});
      const strictFirst = validator.validate(strict, {});
      const openAgain = validator.validate(open, {});

      expect(openFirst).toEqual([]);
      expect(strictFirst).toEqual([
        { path: '/text', code: 'required', message: expect.any(String) },
      ]);
      expect(openAgain).toEqual([]);

      const strictAgain = validator.validate(strict, { text: 'ok' });

      expect(strictAgain).toEqual([]);
    });
  });

  it('should validate against the second of two versions of a type that share an $id after both were checked', () => {
    const first = { $id: 'https://example.com/note', type: 'object' };
    const second = {
      $id: 'https://example.com/note',
      type: 'object',
      properties: { text: { type: 'string' } },
      required: ['text'],
    };
    const checkedFirst = validator.checkSchema(first);
    const checkedSecond = validator.checkSchema(second);
    const validatedFirst = validator.validate(first, {});

    expect(checkedFirst).toEqual([]);
    expect(checkedSecond).toEqual([]);
    expect(validatedFirst).toEqual([]);

    const validatedSecond = validator.validate(second, {});

    expect(validatedSecond).toEqual([
      { path: '/text', code: 'required', message: expect.any(String) },
    ]);
  });

  it.each(METASCHEMA_IDS)(
    'should keep validating after checkSchema refused the metaschema $id %s',
    (id) => {
      const good = { type: 'object' };
      validator.checkSchema({ $id: id, type: 'object' });
      const checked = validator.checkSchema(good);

      expect(checked).toEqual([]);

      const validated = validator.validate(good, {});

      expect(validated).toEqual([]);
    },
  );

  it.each(['', '#'])(
    'should validate against a schema whose $id is %j even after a schema without $id',
    (id) => {
      const fresh = createValidator();
      const schema = { $id: id, type: 'object' };
      const checkedPlain = fresh.checkSchema({ type: 'object' });
      const validatedPlain = fresh.validate({ type: 'object' }, {});
      const checked = fresh.checkSchema(schema);

      expect(checkedPlain).toEqual([]);
      expect(validatedPlain).toEqual([]);
      expect(checked).toEqual([]);

      const validated = fresh.validate(schema, {});

      expect(validated).toEqual([]);
    },
  );

  it('should throw for an $id that ajv already knows, like checkSchema', () => {
    const schema = { $id: 'https://json-schema.org/draft/2020-12/schema', type: 'object' };

    expect(() => validator.validate(schema, {})).toThrow(/already/);
  });

  it('should throw for a $async schema instead of approving the data', () => {
    expect(() => validator.validate({ $async: true, type: 'string' }, {})).toThrow(/async/);
  });

  it('should point at the name of the property that propertyNames refuses', () => {
    const schema = { type: 'object', propertyNames: { maxLength: 3 } };

    expect(validator.validate(schema, { abcd: 1 })).toEqual([
      expect.objectContaining({ path: '/abcd', code: 'max-length' }),
      expect.objectContaining({ path: '/abcd', code: 'property-names' }),
    ]);
  });

  it.each([
    ['a missing property', {}, 'required'],
    ['a property of the wrong type', { 'a/b~c': 1 }, 'type'],
  ])('should escape ~ and / in the JSON Pointer for %s', (_name, data, code) => {
    const schema = {
      type: 'object',
      properties: { 'a/b~c': { type: 'string' } },
      required: ['a/b~c'],
    };

    expect(validator.validate(schema, data)).toEqual([
      expect.objectContaining({ path: '/a~1b~0c', code }),
    ]);
  });

  describe('with fields marked with the attachment format', () => {
    const schema: RecordType = {
      type: 'object',
      properties: {
        file: { type: 'string', format: 'attachment' },
        files: { type: 'array', items: { type: 'string', format: 'attachment' } },
      },
    };

    it('should accept a sha256 in lowercase hexadecimal with 64 characters', () => {
      expect(
        validator.validate(schema, { file: HASH, files: [HASH, '0123456789'.repeat(6) + 'abcd'] }),
      ).toEqual([]);
    });

    it.each([
      ['in uppercase', 'A'.repeat(64)],
      ['that is too short', 'a'.repeat(63)],
      ['that is too long', 'a'.repeat(65)],
      ['outside hexadecimal', 'g'.repeat(64)],
      ['with a line break at the end', `${HASH}\n`],
    ])('should refuse a hash %s', (_name, value) => {
      expect(validator.validate(schema, { file: value })).toEqual([
        { path: '/file', code: 'format', message: expect.any(String) },
      ]);
    });

    it('should point at the item of the list that is not a hash', () => {
      expect(validator.validate(schema, { files: [HASH, 'nope'] })).toEqual([
        { path: '/files/1', code: 'format', message: expect.any(String) },
      ]);
    });
  });

  describe('with the git-sha format', () => {
    it.each(['abcdef1', 'a'.repeat(40)])(
      'should accept %s as a git sha of 7 to 40 characters',
      (commit) => {
        expect(validator.validate(gitShaSchema, { commit })).toEqual([]);
      },
    );

    it.each(['HEAD', 'abcdef', 'a'.repeat(41), 'ABCDEF1', 'abcdef1\n', 'free text'])(
      'should refuse %j as a git sha with code format',
      (commit) => {
        expect(validator.validate(gitShaSchema, { commit })).toEqual([
          { path: '/commit', code: 'format', message: expect.any(String) },
        ]);
      },
    );
  });

  describe('with a pattern or patternProperties in the schema', () => {
    const SENTINEL = 'SENT_free';
    const unsafe = `^${SENTINEL}$`;

    // O dado é aceito porque a regra de regex é ignorada: o pattern o recusaria.
    const ignoredCases: [string, RecordType, Parameters<typeof validator.validate>[1]][] = [
      [
        'a direct pattern',
        { type: 'object', properties: { a: { type: 'string', pattern: unsafe } } },
        { a: 'other' },
      ],
      [
        'a pattern through a $ref to data',
        {
          type: 'object',
          properties: { a: { $ref: '#/examples/0' } },
          examples: [{ type: 'string', pattern: unsafe }],
        },
        { a: 'other' },
      ],
      [
        'a pattern through a $ref to $defs',
        {
          type: 'object',
          properties: { a: { $ref: '#/$defs/p' } },
          $defs: { p: { type: 'string', pattern: unsafe } },
        },
        { a: 'other' },
      ],
      [
        'a pattern in propertyNames',
        { type: 'object', propertyNames: { pattern: unsafe } },
        { other: 1 },
      ],
      [
        'a patternProperties with a value of the wrong type',
        { type: 'object', patternProperties: { [`^${SENTINEL}-`]: { type: 'integer' } } },
        { [`${SENTINEL}-a`]: 'text' },
      ],
    ];

    it.each(ignoredCases)(
      'should accept the data that the regex would refuse for %s',
      (_name, schema, data) => {
        const usage = withRegExpSpy(SENTINEL, () => createValidator().validate(schema, data));

        expect(usage).toEqual({ result: [], constructions: 0, executions: 0 });
      },
    );

    it.each(ignoredCases)(
      'should have plain ajv run the regex that validate ignores for %s',
      (_n, schema) => {
        // Controle: sem ele a espia que nunca dispara também daria zero.
        const usage = withRegExpSpy(SENTINEL, () => compileWithPlainAjv(schema));

        expect(usage.constructions).toBeGreaterThan(0);
      },
    );

    const invalidRegexCases: [string, RecordType][] = [
      ['a direct pattern', { type: 'object', properties: { a: { type: 'string', pattern: '(' } } }],
      [
        'a pattern through a $ref to data',
        {
          type: 'object',
          properties: { a: { $ref: '#/examples/0' } },
          examples: [{ type: 'string', pattern: '(' }],
        },
      ],
      [
        'a patternProperties key with sibling properties',
        {
          type: 'object',
          properties: { k: { type: 'string' } },
          patternProperties: { '(': { type: 'integer' } },
        },
      ],
      [
        'a patternProperties key with additionalProperties false',
        {
          type: 'object',
          properties: { k: { type: 'string' } },
          patternProperties: { '(': { type: 'integer' } },
          additionalProperties: false,
        },
      ],
    ];

    it.each(invalidRegexCases)(
      'should compile an invalid regex without throwing for %s',
      (_name, schema) => {
        expect(() => compileWithPlainAjv(schema)).toThrow(/Invalid regular expression/);

        expect(() => createValidator().validate(schema, { k: 'a' })).not.toThrow();
      },
    );

    it.each([
      ['additionalProperties', 'additional-properties'],
      ['unevaluatedProperties', 'unevaluated-properties'],
    ])(
      'should count patternProperties as absent with %s false and refuse the property',
      (key, code) => {
        const schema = {
          type: 'object',
          patternProperties: { '^x-': { type: 'string' } },
          [key]: false,
        };

        expect(validator.validate(schema, { 'x-a': 's' })).toEqual([
          { path: '/x-a', code, message: expect.any(String) },
        ]);
      },
    );

    it.each(['additionalProperties', 'unevaluatedProperties'])(
      'should count patternProperties as absent with a schema-valued %s and check the value against it',
      (key) => {
        const schema: RecordType = {
          type: 'object',
          patternProperties: { '^x-': { type: 'string' } },
          [key]: { type: 'integer' },
        };

        expect(validator.validate(schema, { 'x-a': 's' })).toEqual([
          { path: '/x-a', code: 'type', message: expect.any(String) },
        ]);
      },
    );

    // Guarda de complexidade, não orçamento: o regex levaria dezenas de segundos; o teto de 5 s
    // tem margem larga sobre o custo real (milissegundos).
    it('should finish fast with a hostile patternProperties, where the regex would take tens of seconds', () => {
      const schema = {
        type: 'object',
        properties: { k: { type: 'string' } },
        patternProperties: { '^(a|aa)+$': { type: 'integer' } },
        additionalProperties: false,
      };
      const startedAt = Date.now();

      const details = validator.validate(schema, { [`${'a'.repeat(40)}!`]: 1 });
      const elapsedMs = Date.now() - startedAt;

      expect(details).toEqual([
        { path: `/${'a'.repeat(40)}!`, code: 'additional-properties', message: expect.any(String) },
      ]);
      expect(elapsedMs).toBeLessThan(5_000);
    });

    const fieldAndFormatSchema = {
      type: 'object',
      properties: {
        pattern: { type: 'string', maxLength: 3 },
        site: { type: 'string', format: 'uri' },
      },
    };

    it('should keep the field named pattern', () => {
      expect(validator.validate(fieldAndFormatSchema, { pattern: 'long value' })).toEqual([
        { path: '/pattern', code: 'max-length', message: expect.any(String) },
      ]);
    });

    it('should keep the format that uses its own regex', () => {
      expect(validator.validate(fieldAndFormatSchema, { site: 'not a uri' })).toEqual([
        { path: '/site', code: 'format', message: expect.any(String) },
      ]);
    });

    // Resíduo aceito: o `format: "regex"` do ajv-formats constrói um RegExp sobre o dado, nunca o executa.
    it('should build the regex of the data once with format regex and not run it', () => {
      const schema = { type: 'object', properties: { r: { type: 'string', format: 'regex' } } };

      const usage = withRegExpSpy(SENTINEL, () =>
        createValidator().validate(schema, { r: `${SENTINEL}(a+)+$` }),
      );

      expect(usage).toEqual({ result: [], constructions: 1, executions: 0 });
    });
  });
});
