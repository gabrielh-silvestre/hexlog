import { describe, expect, test } from '@jest/globals';
import { createValidator } from '../../src/adapters/validator.ts';
import type { RecordType } from '../../src/domain/definitions.ts';

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
  ])('recusa %s com um detalhe invalid-schema em /schema', (_name, schema) => {
    expect(validator.checkSchema(schema)).toEqual([
      { path: '/schema', code: 'invalid-schema', message: expect.any(String) },
    ]);
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
      { path: '/schema', code: 'invalid-schema', message: expect.stringContaining('already') },
    ]);
    expect(validator.checkSchema(good)).toEqual([]);
    expect(validator.validate(good, {})).toEqual([]);
  });

  test('$id repetido depois de uma compilação que lançou segue limpo', () => {
    const $id = 'https://example.com/dangling';

    expect(validator.checkSchema({ $id, $ref: 'https://nowhere/x' })).toHaveLength(1);
    expect(validator.checkSchema({ $id, type: 'object' })).toEqual([]);
  });

  test('recusa schema $async com um detalhe invalid-schema em /schema', () => {
    expect(validator.checkSchema({ $async: true, type: 'string' })).toEqual([
      { path: '/schema', code: 'invalid-schema', message: expect.stringMatching(/async/) },
    ]);
  });

  test('aceita $async: false', () => {
    expect(validator.checkSchema({ $async: false, type: 'string' })).toEqual([]);
  });

  test('lista curta de erros do metaschema sai sem repetição', () => {
    expect(validator.checkSchema({ items: [{ type: 'string' }] })).toHaveLength(1);
  });
});

describe('validate', () => {
  test('devolve lista vazia para dado conforme', () => {
    expect(validator.validate(noteSchema, { text: 'ok', count: 1 })).toEqual([]);
  });

  test('aponta a propriedade ausente, a sobressalente e a de tipo errado, em kebab-case', () => {
    expect(validator.validate(noteSchema, { count: 'x', extra: 1 })).toEqual(
      expect.arrayContaining([
        { path: '/text', code: 'required', message: expect.any(String) },
        { path: '/extra', code: 'additional-properties', message: expect.any(String) },
        { path: '/count', code: 'type', message: expect.any(String) },
      ]),
    );
    expect(validator.validate(noteSchema, { text: 'x' })).toEqual([
      { path: '/text', code: 'min-length', message: expect.any(String) },
    ]);
  });

  test('reúne todos os erros, não só o primeiro', () => {
    expect(validator.validate(noteSchema, { text: 1, count: 'x' })).toHaveLength(2);
  });

  test('corta em 50 detalhes e avisa quantos ficaram de fora no último', () => {
    const schema = {
      type: 'object',
      properties: { items: { type: 'array', items: { type: 'string' } } },
    };
    const details = validator.validate(schema, {
      items: Array.from({ length: 7_000 }, (_, i) => i),
    });

    expect(details).toHaveLength(51);
    expect(details.at(-1)).toEqual({
      path: '',
      code: 'too-many-errors',
      message: '6950 more errors omitted',
    });
  });

  test('lança com schema $async, em vez de aprovar o dado', () => {
    expect(() => validator.validate({ $async: true, type: 'string' }, {})).toThrow(/async/);
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
