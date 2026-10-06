import { afterEach, describe, expect, jest, test } from '@jest/globals';
import Ajv2020 from 'ajv/dist/2020.js';
import { sortBy } from 'es-toolkit';
import {
  boundedRegExp,
  createValidator,
  PATTERN_MAX_LENGTH,
} from '../../src/adapters/validator.ts';
import { attachmentFields, type RecordType } from '../../src/domain/definitions.ts';

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

  describe('regex (ReDoS)', () => {
    const unsafe = '^(\\w+\\s?)*$';
    const invalidSchema = (path: string) => [
      { path, code: 'invalid-schema', message: expect.any(String) },
    ];

    test('aceita pattern seguro com maxLength até o teto', () => {
      expect(
        validator.checkSchema({ type: 'string', pattern: '^[0-9a-f]{64}$', maxLength: 64 }),
      ).toEqual([]);
      expect(
        validator.checkSchema({
          type: 'string',
          pattern: '^[0-9a-f]+$',
          maxLength: PATTERN_MAX_LENGTH,
        }),
      ).toEqual([]);
    });

    test('recusa pattern perigoso mesmo com maxLength', () => {
      expect(validator.checkSchema({ type: 'string', pattern: unsafe, maxLength: 64 })).toEqual(
        invalidSchema('/pattern'),
      );
    });

    test('recusa pattern sem maxLength', () => {
      expect(validator.checkSchema({ type: 'string', pattern: '^[a-z]+$' })).toEqual(
        invalidSchema('/pattern'),
      );
    });

    test('recusa maxLength acima do teto', () => {
      expect(
        validator.checkSchema({
          type: 'string',
          pattern: '^[a-z]+$',
          maxLength: PATTERN_MAX_LENGTH + 1,
        }),
      ).toEqual(invalidSchema('/pattern'));
    });

    // Um schema mínimo aceito pelo ajv estrito para cada palavra-chave aplicadora do 2020-12 que
    // carrega subschema. O modo estrito pede: `if` junto de `then`/`else`; `minItems` e `maxItems`
    // no `prefixItems`; `type` no pai das que miram objeto ou array. `dependentSchemas` e
    // `dependencies` valem para o próprio objeto, então o `pattern` vai um nível abaixo, em
    // `properties`.
    const keywordCases: [string, (child: RecordType) => RecordType, string][] = [
      ['properties', (c) => ({ type: 'object', properties: { a: c } }), '/properties/a'],
      [
        'patternProperties',
        (c) => ({
          type: 'object',
          propertyNames: { maxLength: PATTERN_MAX_LENGTH },
          patternProperties: { '^a': c },
        }),
        '/patternProperties/^a',
      ],
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
      test('recusa pattern perigoso, com o ponteiro do pattern', () => {
        const schema = wrap({ type: 'string', pattern: unsafe, maxLength: 64 });

        expect(validator.checkSchema(schema)).toEqual(invalidSchema(`${base}/pattern`));
      });

      test('recusa pattern seguro sem maxLength', () => {
        const schema = wrap({ type: 'string', pattern: '^[a-z]+$' });

        expect(validator.checkSchema(schema)).toEqual(invalidSchema(`${base}/pattern`));
      });

      test('aceita pattern seguro com maxLength 64', () => {
        const schema = wrap({ type: 'string', pattern: '^[a-z]+$', maxLength: 64 });

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
      const bad = { type: 'string', pattern: unsafe, maxLength: 10 };

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

    test('recusa chave perigosa de patternProperties, sem exigir maxLength no valor', () => {
      expect(
        validator.checkSchema({
          type: 'object',
          propertyNames: { maxLength: 64 },
          patternProperties: { [unsafe]: { type: 'string' } },
        }),
      ).toEqual(invalidSchema(`/patternProperties/${unsafe.replace(/\//g, '~1')}`));
      expect(
        validator.checkSchema({
          type: 'object',
          propertyNames: { maxLength: 64 },
          patternProperties: { '^x-': { type: 'string' } },
        }),
      ).toEqual([]);
    });

    test('patternProperties aceita com propertyNames.maxLength no teto, recusa sem ele ou acima', () => {
      const withNames = (propertyNames?: RecordType): RecordType => ({
        type: 'object',
        ...(propertyNames && { propertyNames }),
        patternProperties: { '^x-': { type: 'string' } },
      });

      expect(validator.checkSchema(withNames({ maxLength: PATTERN_MAX_LENGTH }))).toEqual([]);
      expect(validator.checkSchema(withNames())).toEqual(invalidSchema('/patternProperties'));
      expect(validator.checkSchema(withNames({ maxLength: PATTERN_MAX_LENGTH + 1 }))).toEqual(
        invalidSchema('/patternProperties'),
      );
    });

    test('não trata dado (const, enum, default) como subschema', () => {
      expect(
        validator.checkSchema({
          type: 'object',
          properties: { pattern: { type: 'string', maxLength: 5, default: 'x' } },
          const: { pattern: unsafe },
        }),
      ).toEqual([]);
    });

    // Limite conhecido: a safe-regex2 é heurística (altura de
    // estrela e contagem de repetições), então esta alternância sobreposta, que é exponencial,
    // passa. O validate não roda o regex acima do maxLength, mas dentro do teto ela segue custosa.
    // Se uma versão futura da safe-regex2 passar a recusá-la, este teste quebra de propósito: é o
    // sinal para trocar a expectativa por `invalidSchema('/pattern')` e atualizar o JSDoc do validator.
    test('limite conhecido: alternância sobreposta (a|aa)+ não é detectada', () => {
      expect(
        validator.checkSchema({ type: 'string', pattern: '^(a|aa)+$', maxLength: 64 }),
      ).toEqual([]);
    });

    // Limite conhecido (falso positivo): a safe-regex2 recusa regex linear com repetição dentro de
    // grupo repetido. Se uma versão futura da lib passar a aceitá-la, este teste quebra de propósito:
    // troque a expectativa por `[]` e revise a mensagem de recusa e o JSDoc do validator.
    test('limite conhecido: kebab-case com grupo repetido é recusado, mesmo linear', () => {
      expect(
        validator.checkSchema({
          type: 'string',
          pattern: '^[a-z]+(?:-[a-z]+)*$',
          maxLength: 64,
        }),
      ).toEqual(invalidSchema('/pattern'));
    });

    test('a saída sugerida na mensagem, classe única, é aceita', () => {
      expect(
        validator.checkSchema({ type: 'string', pattern: '^[a-z0-9-]+$', maxLength: 64 }),
      ).toEqual([]);
    });

    test('a mesma mensagem vale para pattern e para chave de patternProperties', () => {
      const unsafeKey = '^[a-z]+(?:-[a-z]+)*$';
      const [fromPattern] = validator.checkSchema({
        type: 'string',
        pattern: unsafeKey,
        maxLength: 64,
      });
      const [fromKey] = validator.checkSchema({
        type: 'object',
        propertyNames: { maxLength: 64 },
        patternProperties: { [unsafeKey]: { type: 'string' } },
      });

      expect(fromPattern?.message).toMatch(/single character class/);
      expect(fromKey?.message).toBe(fromPattern?.message);
    });

    // Limite conhecido e aceito: o percurso do checkSchema não segue $ref, então o pattern que está
    // dentro de dado (const, default, enum, examples) e é alcançado por ponteiro fica sem a
    // safe-regex2 e sem o teto de maxLength. Este teste registra o comportamento observado hoje, não
    // uma proteção. Se o limite for fechado (allowlist de $ref), ele quebra de propósito: troque a
    // expectativa por um erro invalid-schema.
    describe('limite conhecido: $ref por ponteiro para dentro de dado', () => {
      test.each([
        ['#/const', { const: { type: 'string', pattern: '^b$' } }],
        ['#/default', { default: { type: 'string', pattern: '^b$' } }],
        ['#/enum/0', { enum: [{ type: 'string', pattern: '^b$' }] }],
        ['#/examples/0', { examples: [{ type: 'string', pattern: '^b$' }] }],
      ])('%s compila e não é recusado', (ref, data) => {
        expect(validator.checkSchema({ $ref: ref, ...data })).toEqual([]);
      });
    });
  });
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
        { type: 'string', maxLength: 10, pattern: '^(a|aa)+$' },
        { type: 'string', maxLength: 5 },
      ],
    };

    expect(validator.validate(schema, `${'a'.repeat(60)}b` as never)).toEqual([
      { path: '', code: 'max-length', message: expect.any(String) },
      { path: '', code: 'max-length', message: expect.any(String) },
      { path: '', code: 'any-of', message: expect.any(String) },
    ]);
  });

  test('não roda o pattern sobre string acima do maxLength: devolve só max-length', () => {
    // Com allErrors o ajv rodaria o regex também sobre o texto longo e este teste nunca terminaria.
    const schema = {
      type: 'object',
      properties: { text: { type: 'string', maxLength: 10, pattern: '^(a|aa)+$' } },
    };

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

describe('report', () => {
  // O relatório só roda depois de o `validate` falhar: cada schema falha também em `/b`.
  // Ordem do ajv não é contrato: ordena por path e code para fixar o conjunto exato.
  const shapes = (schema: RecordType, data: Record<string, unknown>) =>
    sortBy(
      validator.report(schema, data as never).map(({ path, code }) => ({ path, code })),
      ['path', 'code'],
    );
  const typeOfB = { path: '/b', code: 'type' };
  const withB = (properties: Record<string, unknown>): RecordType => ({
    type: 'object',
    properties: { ...properties, b: { type: 'string' } },
  });

  test('devolve required, enum e campo extra de uma vez', () => {
    const schema: RecordType = {
      type: 'object',
      properties: { name: { type: 'string' }, kind: { enum: ['a', 'b'] } },
      required: ['name', 'kind'],
      additionalProperties: false,
    };

    expect(shapes(schema, { kind: 'z', extra: 1 })).toEqual([
      { path: '/extra', code: 'additional-properties' },
      { path: '/kind', code: 'enum' },
      { path: '/name', code: 'required' },
    ]);
  });

  test('não corta a lista: o teto é do agregador', () => {
    const schema = withB({ items: { type: 'array', items: { type: 'string' } } });

    const found = shapes(schema, { items: Array.from({ length: 60 }, (_, i) => i), b: 1 });

    expect(found).toHaveLength(61);
    expect(found.some(({ code }) => code === 'too-many-errors')).toBe(false);
  });

  test('not com pattern e valor válido não gera violação', () => {
    const schema = withB({ a: { not: { type: 'string', pattern: '^a+$', maxLength: 10 } } });

    expect(shapes(schema, { a: 'bbb', b: 1 })).toEqual([typeOfB]);
  });

  test.each([
    ['pattern', 'aaa', { pattern: '^a+$', maxLength: 5 }, { pattern: '^b+$', maxLength: 5 }],
    ['pattern', 'bbb', { pattern: '^a+$', maxLength: 5 }, { pattern: '^b+$', maxLength: 5 }],
    ['format', '2020-01-31', { format: 'date' }, { format: 'email' }],
    ['format', 'a@b.co', { format: 'date' }, { format: 'email' }],
  ])(
    'oneOf com dois %s distintos e valor que casa um só não gera violação (%s)',
    (_keyword, value, first, second) => {
      const schema = withB({ a: { type: 'string', oneOf: [first, second] } });

      expect(shapes(schema, { a: value, b: 1 })).toEqual([typeOfB]);
    },
  );

  test('oneOf com dois pattern distintos reprova valor que não casa nenhum', () => {
    const schema = withB({
      a: {
        type: 'string',
        oneOf: [
          { pattern: '^a+$', maxLength: 5 },
          { pattern: '^b+$', maxLength: 5 },
        ],
      },
    });

    expect(shapes(schema, { a: 'ccc', b: 1 })).toEqual([
      { path: '/a', code: 'one-of' },
      { path: '/a', code: 'pattern' },
      { path: '/a', code: 'pattern' },
      typeOfB,
    ]);
  });

  test('if com pattern escolhe o ramo certo, sem violação do if', () => {
    const schema: RecordType = {
      ...withB({ a: { type: 'string' } }),
      if: { properties: { a: { type: 'string', pattern: '^a+$', maxLength: 5 } }, required: ['a'] },
      then: { properties: { onThen: { type: 'string' } }, required: ['onThen'] },
      else: { properties: { onElse: { type: 'string' } }, required: ['onElse'] },
    };

    expect(shapes(schema, { a: 'aaa', b: 1 })).toEqual([
      { path: '', code: 'if' },
      { path: '/b', code: 'type' },
      { path: '/onThen', code: 'required' },
    ]);
    expect(shapes(schema, { a: 'bbb', b: 1 })).toEqual([
      { path: '', code: 'if' },
      { path: '/b', code: 'type' },
      { path: '/onElse', code: 'required' },
    ]);
  });

  test('contains com pattern e item válido não gera violação', () => {
    const schema = withB({
      a: { type: 'array', contains: { type: 'string', pattern: '^a+$', maxLength: 5 } },
    });

    expect(shapes(schema, { a: ['bbb', 'aaa'], b: 1 })).toEqual([typeOfB]);
  });

  test('contains sem item que case traz também o erro interno do ramo', () => {
    const schema = withB({
      a: { type: 'array', contains: { type: 'string', pattern: '^a+$', maxLength: 5 } },
    });

    expect(shapes(schema, { a: ['bbb'], b: 1 })).toEqual([
      { path: '/a', code: 'contains' },
      { path: '/a/0', code: 'pattern' },
      typeOfB,
    ]);
  });

  test('patternProperties devolve todas as violações, não só a primeira', () => {
    const schema: RecordType = {
      type: 'object',
      propertyNames: { maxLength: 5 },
      patternProperties: { '^a': { type: 'string' }, '^b': { type: 'number' } },
      additionalProperties: false,
    };

    expect(shapes(schema, { a1: 1, b1: 'x', cc: 1 })).toEqual([
      { path: '/a1', code: 'type' },
      { path: '/b1', code: 'type' },
      { path: '/cc', code: 'additional-properties' },
    ]);
  });

  test('conta pontos de código, não unidades UTF-16', () => {
    // 200 pontos de código = 400 unidades: abaixo do teto de 256 na conta do `maxLength` do ajv.
    const schema = withB({ a: { type: 'string', maxLength: 256, pattern: '^.+$' } });

    expect(shapes(schema, { a: '😀'.repeat(200), b: 1 })).toEqual([typeOfB]);
  });

  test('texto acima de 256 com pattern traz max-length e o pattern como violado sem avaliação', () => {
    const schema = withB({ a: { type: 'string', maxLength: 256, pattern: '^a+$' } });

    expect(shapes(schema, { a: 'a'.repeat(300), b: 1 })).toEqual([
      { path: '/a', code: 'max-length' },
      { path: '/a', code: 'pattern' },
      typeOfB,
    ]);
  });

  describe('boundedRegExp', () => {
    test('não consulta o regex acima do teto e o consulta até ele', () => {
      const regex = boundedRegExp('^a+$', 'u');

      expect(regex.test('a'.repeat(300))).toBe(false);
      expect(regex.test('a'.repeat(200))).toBe(true);
      expect(regex.test('😀'.repeat(300))).toBe(false);
    });

    test('tem toString único por regex', () => {
      expect(boundedRegExp('^a+$', 'u').toString()).not.toBe(boundedRegExp('^b+$', 'u').toString());
    });
  });
});
