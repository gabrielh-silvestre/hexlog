import { describe, test, expect } from '@jest/globals';
import { omit } from 'es-toolkit';
import { sha256hex } from '../../src/domain/chain.ts';
import {
  CursorPayload,
  decodeCursor,
  encodeCursor,
  filtersHash,
} from '../../src/queries/cursor.ts';
import { HexlogError } from '../../src/errors.ts';

const ID_A = 'alpha:0198f4a0-0000-7000-8000-000000000001';
const ID_B = 'beta:0198f4a0-0000-7000-8000-000000000002';
const HASH_A = 'a'.repeat(64);
const HASH_B = 'b'.repeat(64);

const payload: CursorPayload = {
  scope: 'project',
  project: 'demo',
  marker: { alpha: ID_A, beta: ID_B, gamma: null },
  markerHashes: { alpha: HASH_A, beta: HASH_B, gamma: null },
  filtersHash: HASH_A,
  lastId: ID_A,
};

/** Monta um cursor com o checksum correto para um corpo arbitrário. */
function forge(body: unknown): string {
  const encoded = Buffer.from(JSON.stringify(body), 'utf8').toString('base64url');
  return `${encoded}.${sha256hex(encoded).slice(0, 16)}`;
}

function invalidCursorOf(run: () => unknown): HexlogError {
  try {
    run();
  } catch (error) {
    expect(error).toBeInstanceOf(HexlogError);
    return error as HexlogError;
  }
  throw new Error('expected INVALID_CURSOR');
}

describe('cursor: ida e volta', () => {
  test('decode devolve o payload codificado', () => {
    expect(decodeCursor(encodeCursor(payload))).toEqual(payload);
  });

  test('processo opcional e marcador com várias entradas e null sobrevivem à volta', () => {
    const scoped: CursorPayload = { ...payload, scope: 'process', process: 'alpha' };
    expect(decodeCursor(encodeCursor(scoped))).toEqual(scoped);
    expect(decodeCursor(encodeCursor(payload)).marker.gamma).toBeNull();
  });

  test('a ordem das chaves do payload não muda o cursor', () => {
    const reordered = Object.fromEntries(Object.entries(payload).reverse()) as CursorPayload;
    expect(encodeCursor(reordered)).toBe(encodeCursor(payload));
  });

  test('o cursor é texto opaco de base64url e checksum de 8 bytes em hex', () => {
    expect(encodeCursor(payload)).toMatch(/^[A-Za-z0-9_-]+\.[0-9a-f]{16}$/);
  });
});

describe('cursor: adulteração', () => {
  const tampered: Record<string, unknown> = {
    scope: 'process',
    project: 'other',
    process: 'alpha',
    marker: { alpha: ID_B },
    markerHashes: { alpha: HASH_B },
    filtersHash: HASH_B,
    lastId: ID_B,
  };

  test.each(Object.keys(tampered))(
    'campo %s alterado sem refazer o checksum dá checksum-mismatch',
    (field) => {
      const checksum = encodeCursor(payload).split('.')[1] ?? '';
      const changed = { ...payload, [field]: tampered[field] };
      const forged = `${Buffer.from(JSON.stringify(changed)).toString('base64url')}.${checksum}`;

      const error = invalidCursorOf(() => decodeCursor(forged));
      expect(error.code).toBe('INVALID_CURSOR');
      expect(error.details).toEqual([
        { path: '/cursor', code: 'checksum-mismatch', message: expect.any(String) },
      ]);
    },
  );

  test.each([
    ['scope', { scope: 'global' }],
    ['project', { project: 'Not A Name' }],
    ['process', { process: 42 }],
    ['marker', { marker: { alpha: 'not-an-id' } }],
    ['markerHashes', { markerHashes: { alpha: 'abc' } }],
    ['filtersHash', { filtersHash: 'abc' }],
    ['lastId', { lastId: null }],
  ])(
    'campo %s de tipo ou formato errado, com checksum válido, é apontado em details',
    (field, bad) => {
      const error = invalidCursorOf(() => decodeCursor(forge({ ...payload, ...bad })));

      expect(error.code).toBe('INVALID_CURSOR');
      expect(error.details.map(({ path }) => path.split('/')[2])).toContain(field);
      expect(error.details[0]).toEqual({
        path: expect.stringMatching(/^\/cursor\//),
        code: expect.any(String),
        message: expect.any(String),
      });
    },
  );

  test.each(['scope', 'project', 'marker', 'markerHashes', 'filtersHash', 'lastId'])(
    'campo obrigatório %s ausente é apontado em details',
    (field) => {
      const error = invalidCursorOf(() =>
        decodeCursor(forge(omit(payload, [field as keyof CursorPayload]))),
      );

      expect(error.code).toBe('INVALID_CURSOR');
      expect(error.details).toEqual([
        { path: `/cursor/${field}`, code: expect.any(String), message: expect.any(String) },
      ]);
    },
  );

  test('campo desconhecido é recusado', () => {
    const error = invalidCursorOf(() => decodeCursor(forge({ ...payload, extra: true })));
    expect(error.code).toBe('INVALID_CURSOR');
  });

  test('corpo que não é objeto JSON é recusado', () => {
    expect(invalidCursorOf(() => decodeCursor(forge([payload]))).code).toBe('INVALID_CURSOR');
    expect(invalidCursorOf(() => decodeCursor(forge(null))).code).toBe('INVALID_CURSOR');
  });

  test('base64url com checksum válido mas JSON inválido dá malformed', () => {
    const body = Buffer.from('{not json', 'utf8').toString('base64url');
    const error = invalidCursorOf(() => decodeCursor(`${body}.${sha256hex(body).slice(0, 16)}`));

    expect(error.details).toEqual([
      { path: '/cursor', code: 'malformed', message: expect.any(String) },
    ]);
  });

  test.each([
    ['vazio', ''],
    ['sem checksum', 'abc'],
    ['checksum curto', 'abc.0123'],
    ['checksum não hex', `abc.${'z'.repeat(16)}`],
    ['três partes', 'a.b.c'],
  ])('formato inválido (%s) dá malformed', (_label, text) => {
    const error = invalidCursorOf(() => decodeCursor(text));

    expect(error.details).toEqual([
      { path: '/cursor', code: 'malformed', message: expect.any(String) },
    ]);
  });

  test('o erro não traz stack nem caminho absoluto nos details', () => {
    const error = invalidCursorOf(() => decodeCursor('x.0123456789abcdef'));
    expect(JSON.stringify(error.details)).not.toMatch(/\/home|\.ts/);
  });
});

describe('filtersHash', () => {
  test('a ordem das chaves, em qualquer nível, não muda o hash', () => {
    expect(filtersHash({ types: ['note'], where: { a: 1, b: 2 } })).toBe(
      filtersHash({ where: { b: 2, a: 1 }, types: ['note'] }),
    );
  });

  test('é um sha256 hex de 64 caracteres', () => {
    expect(filtersHash({})).toMatch(/^[0-9a-f]{64}$/);
  });

  test.each([
    ['valor de filtro', { types: ['note'] }, { types: ['decision'] }],
    ['filtro a mais', { types: ['note'] }, { types: ['note'], text: 'x' }],
    ['ordem de uma lista', { types: ['a', 'b'] }, { types: ['b', 'a'] }],
    ['null contra ausente', { target: null }, {}],
  ])('muda quando muda: %s', (_label, left, right) => {
    expect(filtersHash(left)).not.toBe(filtersHash(right));
  });

  test('chave com undefined equivale a chave ausente', () => {
    expect(filtersHash({ text: undefined, types: ['note'] })).toBe(
      filtersHash({ types: ['note'] }),
    );
  });
});
