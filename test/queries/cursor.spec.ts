import { describe, it, expect } from '@jest/globals';
import { omit } from 'es-toolkit';
import { hashOfJcs } from '../../src/domain/chain.ts';
import {
  CURSOR_MAX_CHARS,
  CursorPayload,
  decodeCursor,
  encodeCursor,
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

/** Monta um cursor para um corpo arbitrário. */
function forge(body: unknown): string {
  return Buffer.from(JSON.stringify(body), 'utf8').toString('base64url');
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

describe('encodeCursor', () => {
  it('should produce opaque base64url text, with no separator or checksum', () => {
    expect(encodeCursor(payload)).toMatch(/^[A-Za-z0-9_-]+$/);
  });
});

describe('decodeCursor', () => {
  describe('with an encoded cursor', () => {
    it('should return the encoded payload', () => {
      const cursor = encodeCursor(payload);

      expect(decodeCursor(cursor)).toEqual(payload);
    });

    it('should keep the optional process on a round trip', () => {
      const scoped: CursorPayload = { ...payload, scope: 'process', process: 'alpha' };
      const cursor = encodeCursor(scoped);

      expect(decodeCursor(cursor)).toEqual(scoped);
    });

    it('should keep a null entry of a marker with several entries on a round trip', () => {
      const cursor = encodeCursor(payload);

      expect(decodeCursor(cursor).marker.gamma).toBeNull();
    });
  });

  describe('with input ceilings', () => {
    it('should refuse text above CURSOR_MAX_CHARS as too-long before decoding', () => {
      const error = invalidCursorOf(() => decodeCursor('a'.repeat(CURSOR_MAX_CHARS + 1)));

      expect(error.details).toEqual([
        { path: '/cursor', code: 'too-long', message: expect.any(String) },
      ]);
    });

    it('should let text of exactly CURSOR_MAX_CHARS pass the ceiling and fall into malformed', () => {
      const error = invalidCursorOf(() => decodeCursor('a'.repeat(CURSOR_MAX_CHARS)));

      expect(error.details).toEqual([
        { path: '/cursor', code: 'malformed', message: expect.any(String) },
      ]);
    });

    it('should give at most 51 details, the last too-many-errors, for a thousand invalid fields', () => {
      const marker = Object.fromEntries(Array.from({ length: 1_000 }, (_, n) => [`p${n}`, 'x']));
      const cursor = forge({ ...payload, marker });

      const error = invalidCursorOf(() => decodeCursor(cursor));

      expect(error.details).toHaveLength(51);
      expect(error.details.at(-1)).toMatchObject({ code: 'too-many-errors' });
    });
  });

  describe('with a tampered or malformed cursor', () => {
    const tampered: Record<string, unknown> = {
      scope: 'process',
      project: 'other',
      process: 'alpha',
      marker: { alpha: ID_B },
      markerHashes: { alpha: HASH_B },
      filtersHash: HASH_B,
      lastId: ID_B,
    };

    it.each(Object.keys(tampered))(
      'should decode what was edited in field %s when the rest is valid',
      (field) => {
        const changed = { ...payload, [field]: tampered[field] };

        expect(decodeCursor(forge(changed))).toEqual(changed);
      },
    );

    it('should give malformed for a truncated cursor', () => {
      const truncated = encodeCursor(payload).slice(0, -8);

      const error = invalidCursorOf(() => decodeCursor(truncated));

      expect(error.details).toEqual([
        { path: '/cursor', code: 'malformed', message: expect.any(String) },
      ]);
    });

    it('should tell to rerun the query without cursor in every INVALID_CURSOR message', () => {
      const malformed = invalidCursorOf(() => decodeCursor('x.y'));
      const badField = invalidCursorOf(() => decodeCursor(forge({ ...payload, scope: 'global' })));

      expect(malformed.details[0]?.message).toContain('rerun the query without cursor');
      expect(badField.details[0]?.message).toContain('rerun the query without cursor');
    });

    it.each([
      ['scope', { scope: 'global' }],
      ['project', { project: 'Not A Name' }],
      ['process', { process: 42 }],
      ['marker', { marker: { alpha: 'not-an-id' } }],
      ['markerHashes', { markerHashes: { alpha: 'abc' } }],
      ['filtersHash', { filtersHash: 'abc' }],
      ['lastId', { lastId: null }],
    ])('should point the field %s of a wrong type or format in details', (field, bad) => {
      const cursor = forge({ ...payload, ...bad });

      const error = invalidCursorOf(() => decodeCursor(cursor));

      expect(error.code).toBe('INVALID_CURSOR');
      expect(error.details.map(({ path }) => path.split('/')[2])).toContain(field);
      expect(error.details[0]).toEqual({
        path: expect.stringMatching(/^\/cursor\//),
        code: expect.any(String),
        message: expect.any(String),
      });
    });

    it.each(['scope', 'project', 'marker', 'markerHashes', 'filtersHash', 'lastId'])(
      'should point the missing required field %s in details',
      (field) => {
        const cursor = forge(omit(payload, [field as keyof CursorPayload]));

        const error = invalidCursorOf(() => decodeCursor(cursor));

        expect(error.code).toBe('INVALID_CURSOR');
        expect(error.details).toEqual([
          { path: `/cursor/${field}`, code: expect.any(String), message: expect.any(String) },
        ]);
      },
    );

    it('should refuse an unknown field', () => {
      const cursor = forge({ ...payload, extra: true });

      const error = invalidCursorOf(() => decodeCursor(cursor));

      expect(error.code).toBe('INVALID_CURSOR');
    });

    it('should refuse a body that is not a JSON object', () => {
      expect(invalidCursorOf(() => decodeCursor(forge([payload]))).code).toBe('INVALID_CURSOR');
      expect(invalidCursorOf(() => decodeCursor(forge(null))).code).toBe('INVALID_CURSOR');
    });

    it('should give malformed for base64url with invalid JSON', () => {
      const body = Buffer.from('{not json', 'utf8').toString('base64url');

      const error = invalidCursorOf(() => decodeCursor(body));

      expect(error.details).toEqual([
        { path: '/cursor', code: 'malformed', message: expect.any(String) },
      ]);
    });

    it.each([
      ['empty', ''],
      ['not base64url of JSON', 'abc'],
      ['with a separator', 'a.b.c'],
    ])('should give malformed for an invalid format (%s)', (_label, text) => {
      const error = invalidCursorOf(() => decodeCursor(text));

      expect(error.details).toEqual([
        { path: '/cursor', code: 'malformed', message: expect.any(String) },
      ]);
    });

    it('should carry no stack and no absolute path in details', () => {
      const error = invalidCursorOf(() => decodeCursor('x.y'));

      expect(JSON.stringify(error.details)).not.toMatch(/\/home|\.ts/);
    });
  });
});

describe('hashOfJcs', () => {
  it('should ignore the order of the keys, at any level', () => {
    expect(hashOfJcs({ types: ['note'], where: { a: 1, b: 2 } })).toBe(
      hashOfJcs({ where: { b: 2, a: 1 }, types: ['note'] }),
    );
  });

  it('should be a sha256 hex of 64 characters', () => {
    expect(hashOfJcs({})).toMatch(/^[0-9a-f]{64}$/);
  });

  it.each([
    ['a filter value', { types: ['note'] }, { types: ['decision'] }],
    ['an extra filter', { types: ['note'] }, { types: ['note'], text: 'x' }],
    ['the order of a list', { types: ['a', 'b'] }, { types: ['b', 'a'] }],
    ['null against absent', { target: null }, {}],
  ])('should give a different hash for %s', (_label, left, right) => {
    expect(hashOfJcs(left)).not.toBe(hashOfJcs(right));
  });

  it('should treat a key with undefined as an absent key', () => {
    expect(hashOfJcs({ text: undefined, types: ['note'] })).toBe(hashOfJcs({ types: ['note'] }));
  });
});
