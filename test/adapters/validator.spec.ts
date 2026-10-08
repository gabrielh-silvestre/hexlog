import { afterEach, describe, expect, jest, test } from '@jest/globals';
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

describe('checkSchema', () => {
  test('aceita um schema válido, inclusive com o formato attachment', () => {
    expect(validator.checkSchema(noteSchema)).toEqual([]);
    expect(
      validator.checkSchema({
        type: 'object',
        properties: { file: { type: 'string', format: 'attachment' } },
      }),
    ).toEqual([]);
  });

  test('recusa valor de palavra-chave que viola o metaschema, com o path do ponto', () => {
    const details = validator.checkSchema({ type: 'object', properties: { a: { type: 5 } } });

    expect(details.length).toBeGreaterThan(0);
    expect(details.map((detail) => detail.path)).toEqual(details.map(() => '/properties/a/type'));
  });

  test.each([
    ['palavra-chave desconhecida', { type: 'object', bogus: true }],
    ['formato desconhecido', { type: 'string', format: 'not-a-format' }],
    ['$ref externo', { $ref: 'https://example.com/schema.json' }],
    ['$schema de outro rascunho', { $schema: 'http://json-schema.org/draft-07/schema#' }],
  ])('recusa %s com um detalhe invalid-schema na raiz do schema', (_name, schema) => {
    expect(validator.checkSchema(schema)).toEqual([
      { path: '', code: 'invalid-schema', message: expect.any(String) },
    ]);
  });

  test('recusa $ref cíclico com uma mensagem legível e segue funcionando', () => {
    const cyclic = {
      $defs: { a: { $ref: '#/$defs/b' }, b: { $ref: '#/$defs/a' } },
      $ref: '#/$defs/a',
    };

    expect(validator.checkSchema(cyclic)).toEqual([
      { path: '', code: 'invalid-schema', message: expect.stringContaining('cyclic $ref') },
    ]);
    expect(validator.checkSchema({ type: 'object' })).toEqual([]);
  });

  test('a mensagem de recusa não vaza caminho absoluto', () => {
    const messages = validator
      .checkSchema({ $ref: 'file:///etc/passwd' })
      .map((detail) => detail.message);

    expect(messages.join('\n')).not.toMatch(process.cwd());
  });

  test('não guarda o $id: duas versões do mesmo tipo passam em sequência', () => {
    const first = { $id: 'https://example.com/note', type: 'object' };
    const second = {
      $id: 'https://example.com/note',
      type: 'object',
      properties: { text: { type: 'string' } },
      required: ['text'],
    };

    expect(validator.checkSchema(first)).toEqual([]);
    expect(validator.checkSchema(second)).toEqual([]);
    expect(validator.validate(first, {})).toEqual([]);
    expect(validator.validate(second, {})).toHaveLength(1);
  });

  test.each([
    'https://json-schema.org/draft/2020-12/schema',
    'https://json-schema.org/draft/2020-12/meta/core',
    'https://json-schema.org/draft/2020-12/meta/validation',
  ])('recusa o $id do metaschema %s sem derrubar o ajv', (id) => {
    const good = { type: 'object' };

    expect(validator.checkSchema({ $id: id, type: 'object' })).toEqual([
      { path: '', code: 'invalid-schema', message: expect.stringContaining('already') },
    ]);
    expect(validator.checkSchema(good)).toEqual([]);
    expect(validator.validate(good, {})).toEqual([]);
  });

  test('$id repetido depois de uma compilação que lançou segue limpo', () => {
    const $id = 'https://example.com/dangling';

    expect(validator.checkSchema({ $id, $ref: 'https://nowhere/x' })).toHaveLength(1);
    expect(validator.checkSchema({ $id, type: 'object' })).toEqual([]);
  });

  test.each(['', '#'])(
    '$id %j não nomeia schema: passa mesmo depois de um schema sem $id',
    (id) => {
      const fresh = createValidator();
      const schema = { $id: id, type: 'object' };

      expect(fresh.checkSchema({ type: 'object' })).toEqual([]);
      expect(fresh.validate({ type: 'object' }, {})).toEqual([]);
      expect(fresh.checkSchema(schema)).toEqual([]);
      expect(fresh.validate(schema, {})).toEqual([]);
    },
  );

  test('recusa schema $async com um detalhe invalid-schema na raiz do schema', () => {
    expect(validator.checkSchema({ $async: true, type: 'string' })).toEqual([
      { path: '', code: 'invalid-schema', message: expect.stringMatching(/async/) },
    ]);
  });

  test('aceita $async: false', () => {
    expect(validator.checkSchema({ $async: false, type: 'string' })).toEqual([]);
  });

  test('lista curta de erros do metaschema sai sem repetição', () => {
    expect(validator.checkSchema({ items: [{ type: 'string' }] })).toHaveLength(1);
  });

  test('corta em 50 detalhes e avisa quantos ficaram de fora no último', () => {
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

  describe('format attachment (D-16)', () => {
    const mark = { type: 'string', format: 'attachment' };
    const misplaced = (path: string) => [
      { path, code: 'invalid-schema', message: expect.stringContaining('["string","null"]') },
    ];

    test('aceita a marca no campo de primeiro nível e nos itens da lista', () => {
      expect(
        validator.checkSchema({
          type: 'object',
          properties: { file: mark, files: { type: 'array', items: mark } },
        }),
      ).toEqual([]);
    });

    test('aceita a marca em campo opcional escrito como type ["string","null"]', () => {
      expect(
        validator.checkSchema({
          type: 'object',
          properties: { file: { type: ['string', 'null'], format: 'attachment' } },
        }),
      ).toEqual([]);
    });

    test('recusa a marca em objeto aninhado, com o path do campo e a saída na mensagem', () => {
      const schema = {
        type: 'object',
        properties: { outer: { type: 'object', properties: { file: mark } } },
      };

      expect(validator.checkSchema(schema)).toEqual(
        misplaced('/properties/outer/properties/file/format'),
      );
    });

    test('recusa a marca em anyOf dentro de campo de primeiro nível', () => {
      const schema = {
        type: 'object',
        properties: { file: { anyOf: [mark, { type: 'null' }] } },
      };

      expect(validator.checkSchema(schema)).toEqual(misplaced('/properties/file/anyOf/0/format'));
    });

    // As marcas que o checkSchema aceita têm de ser as que attachmentFields devolve: marca aceita e
    // ignorada nunca seria conferida pelo register.
    test.each<[string, RecordType, boolean]>([
      ['campo', { type: 'object', properties: { a: mark } }, true],
      [
        'itens do campo',
        { type: 'object', properties: { a: { type: 'array', items: mark } } },
        true,
      ],
      [
        'campo anulável',
        { type: 'object', properties: { a: { type: ['string', 'null'], format: 'attachment' } } },
        true,
      ],
      [
        'objeto aninhado',
        { type: 'object', properties: { b: { type: 'object', properties: { a: mark } } } },
        false,
      ],
      ['anyOf do campo', { type: 'object', properties: { a: { anyOf: [mark] } } }, false],
      ['oneOf do campo', { type: 'object', properties: { a: { oneOf: [mark] } } }, false],
      ['allOf do campo', { type: 'object', properties: { a: { allOf: [mark] } } }, false],
      [
        '$defs',
        { type: 'object', properties: { a: { type: 'string' } }, $defs: { a: mark } },
        false,
      ],
      ['additionalProperties', { type: 'object', additionalProperties: mark }, false],
    ])('marca em %s: aceita só se attachmentFields a reconhece', (_position, schema, accepted) => {
      expect(validator.checkSchema(schema)).toHaveLength(accepted ? 0 : 1);
      expect(attachmentFields(schema)).toEqual(accepted ? ['a'] : []);
    });
  });

  describe('pattern livre', () => {
    const SENTINEL = 'SENT_check';
    const hostile = `^${SENTINEL}(a|aa)+$`;
    const invalidSchema = (path: string) => [
      { path, code: 'invalid-schema', message: expect.any(String) },
    ];
    const notAllowed = (path: string) => [
      { path, code: 'pattern-not-allowed', message: expect.stringContaining('git-sha') },
    ];

    test('recusa pattern mesmo seguro e com maxLength, com o ponteiro do pattern', () => {
      expect(
        validator.checkSchema({ type: 'string', pattern: '^[0-9a-f]+$', maxLength: 64 }),
      ).toEqual(notAllowed('/pattern'));
    });

    test('recusa pattern que não compila como regex, sem lançar', () => {
      expect(validator.checkSchema({ type: 'string', pattern: '(' })).toEqual(
        notAllowed('/pattern'),
      );
    });

    test('a mensagem cita o catálogo e o caminho sem pattern', () => {
      const [detail] = validator.checkSchema({ type: 'string', pattern: '^a$' });

      expect(detail?.message).toBe(
        'pattern is not allowed in a type schema; use a catalog format (git-sha) or plain minLength/maxLength',
      );
    });

    test('recusa patternProperties, com as propriedades irmãs e o additionalProperties', () => {
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

    test('recusa o pattern dentro do valor de patternProperties, além do próprio patternProperties', () => {
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
    ];

    describe.each(keywordCases)('dentro de %s', (_keyword, wrap, base) => {
      test('recusa pattern, com o ponteiro do pattern', () => {
        const schema = wrap({ type: 'string', pattern: '^[a-z]+$', maxLength: 64 });

        expect(validator.checkSchema(schema)).toEqual(notAllowed(`${base}/pattern`));
      });

      test('aceita o mesmo subschema sem pattern', () => {
        const schema = wrap({ type: 'string', minLength: 1, maxLength: 64 });

        expect(validator.checkSchema(schema)).toEqual([]);
      });
    });

    describe.each(keywordCases.filter(([keyword]) => keyword !== 'properties'))(
      'format attachment dentro de %s',
      (_keyword, wrap, base) => {
        test('recusa a marca, com o ponteiro do format', () => {
          const schema = wrap({ type: 'string', format: 'attachment' });

          expect(validator.checkSchema(schema)).toEqual(invalidSchema(`${base}/format`));
        });
      },
    );

    test('ignora os valores em array de dependencies, que não são subschema', () => {
      expect(validator.checkSchema({ type: 'object', dependencies: { a: ['b'] } })).toEqual([]);
    });

    test('recusa pattern aninhado, com o ponteiro do campo', () => {
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

    test('não recusa o campo de nome pattern nem trata dado (const, enum, default) como subschema', () => {
      expect(
        validator.checkSchema({
          type: 'object',
          properties: { pattern: { type: 'string', maxLength: 5, default: 'x' } },
          const: { pattern: '^a$' },
        }),
      ).toEqual([]);
    });

    test('aceita format do catálogo e do ajv-formats, recusa format fora deles', () => {
      const withFormat = (format: string) => ({
        type: 'object',
        properties: { a: { type: 'string', format } },
      });

      expect(validator.checkSchema(withFormat('git-sha'))).toEqual([]);
      expect(validator.checkSchema(withFormat('uri'))).toEqual([]);
      expect(validator.checkSchema(withFormat('not-a-format'))).toEqual(invalidSchema(''));
    });

    // O pattern que um `$ref` alcança dentro de dado não é subschema para a varredura; quem o grava
    // é o compilador neutro, sem construir o regex.
    describe('pattern alcançado por $ref para dado', () => {
      const pattern = { type: 'string', pattern: `^${SENTINEL}$` };

      test.each([
        ['#/examples/0', { examples: [pattern] }, '/examples/0/pattern'],
        ['#/const', { const: pattern }, '/const/pattern'],
        ['#/default', { default: pattern }, '/default/pattern'],
        ['#/enum/0', { enum: [pattern] }, '/enum/0/pattern'],
        ['#/const/a~1b~0c%25d', { const: { 'a/b~c%d': pattern } }, '/const/a~1b~0c%d/pattern'],
      ])('%s é recusado com o path do pattern, sem construir o regex', (ref, data, path) => {
        const usage = withRegExpSpy(SENTINEL, () =>
          createValidator().checkSchema({ $ref: ref, ...data }),
        );

        expect(usage).toEqual({ result: notAllowed(path), constructions: 0, executions: 0 });
      });

      test('patternProperties hostil, direto e via $ref, volta rápido sem tocar no regex', () => {
        const schema = {
          type: 'object',
          properties: { k: { type: 'string' } },
          patternProperties: { [hostile]: { type: 'integer' } },
          additionalProperties: false,
        };
        const startedAt = Date.now();

        const direct = withRegExpSpy(SENTINEL, () => createValidator().checkSchema(schema));
        const viaRef = withRegExpSpy(SENTINEL, () =>
          createValidator().checkSchema({ $ref: '#/examples/0', examples: [schema] }),
        );

        expect(direct).toEqual({
          result: notAllowed('/patternProperties'),
          constructions: 0,
          executions: 0,
        });
        expect(viaRef).toEqual({
          result: notAllowed('/examples/0/patternProperties'),
          constructions: 0,
          executions: 0,
        });
        expect(Date.now() - startedAt).toBeLessThan(5_000);
      });

      test.each([
        ['pattern', { type: 'string', pattern: '(' }],
        ['chave de patternProperties', { type: 'object', patternProperties: { '(': {} } }],
      ])('%s que não compila como regex não lança no $ref', (_name, schema) => {
        expect(() => new Ajv2020.default({ strict: true, logger: false }).compile(schema)).toThrow(
          /Invalid regular expression/,
        );
        expect(validator.checkSchema({ $ref: '#/examples/0', examples: [schema] })).toHaveLength(1);
      });

      test('$ref para o metaschema do JSON Schema não é recusado', () => {
        expect(
          validator.checkSchema({
            type: 'object',
            properties: { a: { $ref: 'https://json-schema.org/draft/2020-12/schema' } },
          }),
        ).toEqual([]);
      });

      test('$ref para o metaschema junto de $ref para dado recusa só o pattern do dado', () => {
        expect(
          validator.checkSchema({
            allOf: [
              { $ref: 'https://json-schema.org/draft/2020-12/schema' },
              { $ref: '#/examples/0' },
            ],
            examples: [pattern],
          }),
        ).toEqual(notAllowed('/examples/0/pattern'));
      });

      test('$id aninhado: o ponteiro não resolve no documento e o path fica vazio', () => {
        expect(
          validator.checkSchema({
            $ref: 'https://example.com/nested.json#/examples/0',
            $defs: { nested: { $id: 'https://example.com/nested.json', examples: [pattern] } },
          }),
        ).toEqual(notAllowed(''));
      });
    });
  });
});

describe('format git-sha', () => {
  const schema = { type: 'object', properties: { commit: { type: 'string', format: 'git-sha' } } };

  test('checkSchema aceita o formato do catálogo', () => {
    expect(validator.checkSchema(schema)).toEqual([]);
  });

  test.each(['abcdef1', 'a'.repeat(40)])('validate aceita %s', (commit) => {
    expect(validator.validate(schema, { commit })).toEqual([]);
  });

  test.each(['HEAD', 'abcdef', 'a'.repeat(41), 'ABCDEF1', 'abcdef1\n', 'texto livre'])(
    'validate recusa %j com code format',
    (commit) => {
      expect(validator.validate(schema, { commit })).toEqual([
        { path: '/commit', code: 'format', message: expect.any(String) },
      ]);
    },
  );
});

describe('validate', () => {
  test('devolve lista vazia para dado conforme', () => {
    expect(validator.validate(noteSchema, { text: 'ok', count: 1 })).toEqual([]);
  });

  test.each([
    ['a propriedade ausente', { count: 1 }, '/text', 'required'],
    ['a propriedade sobressalente', { text: 'ok', extra: 1 }, '/extra', 'additional-properties'],
    ['a de tipo errado', { text: 'ok', count: 'x' }, '/count', 'type'],
    ['a de tamanho curto', { text: 'x' }, '/text', 'min-length'],
  ])('aponta %s, em kebab-case', (_name, data, path, code) => {
    expect(validator.validate(noteSchema, data)).toEqual([
      { path, code, message: expect.any(String) },
    ]);
  });

  test('devolve um erro por subschema avaliado, não um por campo', () => {
    expect(validator.validate(noteSchema, { text: 1, count: 'x' })).toHaveLength(1);
  });

  test('em anyOf devolve o erro de cada ramo, mais o do anyOf', () => {
    // O allErrors: false do ajv para no primeiro erro de CADA ramo, não no primeiro da chamada.
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

  test('ignora o pattern e mantém o maxLength do mesmo subschema', () => {
    const schema = {
      type: 'object',
      properties: { text: { type: 'string', maxLength: 10, pattern: '^(a|aa)+$' } },
    };

    expect(validator.validate(schema, { text: 'zzz' })).toEqual([]);
    expect(validator.validate(schema, { text: `${'a'.repeat(60)}b` })).toEqual([
      { path: '/text', code: 'max-length', message: expect.any(String) },
    ]);
  });

  test('um erro por chamada mesmo com 7 mil itens inválidos', () => {
    const schema = {
      type: 'object',
      properties: { items: { type: 'array', items: { type: 'string' } } },
    };
    const details = validator.validate(schema, {
      items: Array.from({ length: 7_000 }, (_, i) => i),
    });

    expect(details).toEqual([{ path: '/items/0', code: 'type', message: expect.any(String) }]);
  });

  describe('compilação por objeto de schema', () => {
    const compileSpy = () => jest.spyOn(Ajv2020.default.prototype, 'compile');

    afterEach(() => {
      jest.restoreAllMocks();
    });

    test('compila uma vez para o mesmo objeto e duas para objetos iguais mas distintos', () => {
      const spy = compileSpy();
      const schema = { type: 'object', properties: { text: { type: 'string' } } };

      validator.validate(schema, {});
      validator.validate(schema, {});
      expect(spy).toHaveBeenCalledTimes(1);

      validator.validate({ ...schema }, {});
      expect(spy).toHaveBeenCalledTimes(2);
    });

    test('o segundo validate, já compilado, segue correto para dado válido e inválido', () => {
      const schema = { type: 'object', properties: { text: {} }, required: ['text'] };

      expect(validator.validate(schema, { text: 'ok' })).toEqual([]);
      expect(validator.validate(schema, {})).toEqual([
        { path: '/text', code: 'required', message: expect.any(String) },
      ]);
      expect(validator.validate(schema, { text: 'ok' })).toEqual([]);
    });

    test('dois schemas com o mesmo $id em objetos distintos não colidem', () => {
      const $id = 'https://example.com/shared-id';
      const open = { $id, type: 'object' };
      const strict = { $id, type: 'object', properties: { text: {} }, required: ['text'] };

      expect(validator.validate(open, {})).toEqual([]);
      expect(validator.validate(strict, {})).toHaveLength(1);
      expect(validator.validate(open, {})).toEqual([]);
      expect(validator.validate(strict, { text: 'ok' })).toEqual([]);
    });
  });

  test('recusa $id que o ajv já conhece, como o checkSchema', () => {
    const schema = { $id: 'https://json-schema.org/draft/2020-12/schema', type: 'object' };

    expect(() => validator.validate(schema, {})).toThrow(/already/);
  });

  test('lança com schema $async, em vez de aprovar o dado', () => {
    expect(() => validator.validate({ $async: true, type: 'string' }, {})).toThrow(/async/);
  });

  test('aponta o nome da propriedade que o propertyNames recusa', () => {
    const schema = { type: 'object', propertyNames: { maxLength: 3 } };

    expect(validator.validate(schema, { abcd: 1 })).toEqual([
      expect.objectContaining({ path: '/abcd', code: 'max-length' }),
      expect.objectContaining({ path: '/abcd', code: 'property-names' }),
    ]);
  });

  test('escapa ~ e / no JSON Pointer', () => {
    const schema = {
      type: 'object',
      properties: { 'a/b~c': { type: 'string' } },
      required: ['a/b~c'],
    };

    expect(validator.validate(schema, {})).toEqual([
      expect.objectContaining({ path: '/a~1b~0c', code: 'required' }),
    ]);
    expect(validator.validate(schema, { 'a/b~c': 1 })).toEqual([
      expect.objectContaining({ path: '/a~1b~0c', code: 'type' }),
    ]);
  });

  describe('formato attachment', () => {
    const schema: RecordType = {
      type: 'object',
      properties: {
        file: { type: 'string', format: 'attachment' },
        files: { type: 'array', items: { type: 'string', format: 'attachment' } },
      },
    };

    test('aceita sha256 em hexadecimal minúsculo de 64 caracteres', () => {
      expect(
        validator.validate(schema, { file: HASH, files: [HASH, '0123456789'.repeat(6) + 'abcd'] }),
      ).toEqual([]);
    });

    test.each([
      ['maiúsculas', 'A'.repeat(64)],
      ['curto', 'a'.repeat(63)],
      ['longo', 'a'.repeat(65)],
      ['fora do hexadecimal', 'g'.repeat(64)],
      ['com quebra de linha no fim', `${HASH}\n`],
    ])('recusa hash %s', (_name, value) => {
      expect(validator.validate(schema, { file: value })).toEqual([
        { path: '/file', code: 'format', message: expect.any(String) },
      ]);
    });

    test('aponta o item da lista que não é um hash', () => {
      expect(validator.validate(schema, { files: [HASH, 'nope'] })).toEqual([
        { path: '/files/1', code: 'format', message: expect.any(String) },
      ]);
    });
  });
});

describe('validate ignora pattern e patternProperties', () => {
  const SENTINEL = 'SENT_free';
  const unsafe = `^${SENTINEL}$`;

  // O dado é aceito porque a regra de regex é ignorada: o pattern o recusaria.
  const ignoredCases: [string, RecordType, Parameters<typeof validator.validate>[1]][] = [
    [
      'pattern direto',
      { type: 'object', properties: { a: { type: 'string', pattern: unsafe } } },
      { a: 'other' },
    ],
    [
      'pattern via $ref para dado',
      {
        type: 'object',
        properties: { a: { $ref: '#/examples/0' } },
        examples: [{ type: 'string', pattern: unsafe }],
      },
      { a: 'other' },
    ],
    [
      'pattern via $ref para $defs',
      {
        type: 'object',
        properties: { a: { $ref: '#/$defs/p' } },
        $defs: { p: { type: 'string', pattern: unsafe } },
      },
      { a: 'other' },
    ],
    [
      'pattern em propertyNames',
      { type: 'object', propertyNames: { pattern: unsafe } },
      { other: 1 },
    ],
    [
      'patternProperties com valor de tipo errado',
      { type: 'object', patternProperties: { [`^${SENTINEL}-`]: { type: 'integer' } } },
      { [`${SENTINEL}-a`]: 'text' },
    ],
  ];

  test.each(ignoredCases)('aceita o dado que o regex recusaria: %s', (_name, schema, data) => {
    const usage = withRegExpSpy(SENTINEL, () => createValidator().validate(schema, data));

    expect(usage).toEqual({ result: [], constructions: 0, executions: 0 });
  });

  test.each(ignoredCases)('o ajv plain executa o regex que o validate ignora: %s', (_n, schema) => {
    // Controle: sem ele a espia que nunca dispara também daria zero.
    const usage = withRegExpSpy(SENTINEL, () =>
      new Ajv2020.default({ strict: true, logger: false }).compile(schema),
    );

    expect(usage.constructions).toBeGreaterThan(0);
  });

  const invalidRegexCases: [string, RecordType][] = [
    ['pattern direto', { type: 'object', properties: { a: { type: 'string', pattern: '(' } } }],
    [
      'pattern via $ref para dado',
      {
        type: 'object',
        properties: { a: { $ref: '#/examples/0' } },
        examples: [{ type: 'string', pattern: '(' }],
      },
    ],
    [
      'chave de patternProperties com properties irmãs',
      {
        type: 'object',
        properties: { k: { type: 'string' } },
        patternProperties: { '(': { type: 'integer' } },
      },
    ],
    [
      'chave de patternProperties com additionalProperties false',
      {
        type: 'object',
        properties: { k: { type: 'string' } },
        patternProperties: { '(': { type: 'integer' } },
        additionalProperties: false,
      },
    ],
  ];

  test.each(invalidRegexCases)('compila regex inválido sem lançar: %s', (_name, schema) => {
    expect(() => new Ajv2020.default({ strict: true, logger: false }).compile(schema)).toThrow(
      /Invalid regular expression/,
    );
    expect(() => createValidator().validate(schema, { k: 'a' })).not.toThrow();
  });

  test.each([
    ['additionalProperties', 'additional-properties'],
    ['unevaluatedProperties', 'unevaluated-properties'],
  ])(
    'com %s false, patternProperties conta como ausente e a propriedade é recusada',
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

  test('termina rápido com patternProperties hostil, onde o regex levaria dezenas de segundos', () => {
    const schema = {
      type: 'object',
      properties: { k: { type: 'string' } },
      patternProperties: { '^(a|aa)+$': { type: 'integer' } },
      additionalProperties: false,
    };
    const startedAt = Date.now();

    expect(validator.validate(schema, { [`${'a'.repeat(40)}!`]: 1 })).toHaveLength(1);
    expect(Date.now() - startedAt).toBeLessThan(5_000);
  });

  test('mantém o campo de nome pattern e o format que usa regex próprio', () => {
    const schema = {
      type: 'object',
      properties: {
        pattern: { type: 'string', maxLength: 3 },
        site: { type: 'string', format: 'uri' },
      },
    };

    expect(validator.validate(schema, { pattern: 'long value' })).toEqual([
      { path: '/pattern', code: 'max-length', message: expect.any(String) },
    ]);
    expect(validator.validate(schema, { site: 'not a uri' })).toEqual([
      { path: '/site', code: 'format', message: expect.any(String) },
    ]);
  });

  // Resíduo aceito: o `format: "regex"` do ajv-formats constrói um RegExp sobre o dado, nunca o executa.
  test('format regex constrói o regex do dado uma vez e não o executa', () => {
    const schema = { type: 'object', properties: { r: { type: 'string', format: 'regex' } } };

    const usage = withRegExpSpy(SENTINEL, () =>
      createValidator().validate(schema, { r: `${SENTINEL}(a+)+$` }),
    );

    expect(usage).toEqual({ result: [], constructions: 1, executions: 0 });
  });
});
