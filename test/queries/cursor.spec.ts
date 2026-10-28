import { describe, it, expect } from '@jest/globals';
import { omit } from 'es-toolkit';
import {
  CURSOR_MAX_CHARS,
  CursorPayload,
  decodeCursor,
  encodeCursor,
} from '../../src/queries/cursor.ts';
import { idAt } from '../fixtures/chain-line.ts';
import { captureError, detail } from '../helpers.ts';

const ID_A = idAt('alpha', 1);
const ID_B = idAt('beta', 2);
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
  });

  it.each([
    ['too long', 'a'.repeat(CURSOR_MAX_CHARS + 1)],
    ['not valid JSON', 'x.y'],
    ['invalid in a field', forge({ ...payload, scope: 'global' })],
  ])(
    'should name the cursor and tell to rerun without it when the cursor is %s',
    (_label, text) => {
      const error = captureError(() => decodeCursor(text));

      expect(error.message).toMatch(/cursor/i);
      expect(error.details[0]?.message).toContain('rerun the query without cursor');
    },
  );

  describe('with input ceilings', () => {
    it('should refuse text above CURSOR_MAX_CHARS as too-long before decoding, stating the ceiling', () => {
      const error = captureError(() => decodeCursor('a'.repeat(CURSOR_MAX_CHARS + 1)));

      expect(error.details).toEqual([
        {
          ...detail('/cursor', 'too-long'),
          message: expect.stringContaining(String(CURSOR_MAX_CHARS)),
        },
      ]);
    });

    it('should let text of exactly CURSOR_MAX_CHARS pass the ceiling and fall into malformed', () => {
      const error = captureError(() => decodeCursor('a'.repeat(CURSOR_MAX_CHARS)));

      expect(error.details).toEqual([detail('/cursor', 'malformed')]);
    });

    it('should give at most 51 details, the last too-many-errors, for a thousand invalid fields', () => {
      const marker = Object.fromEntries(Array.from({ length: 1_000 }, (_, n) => [`p${n}`, 'x']));
      const cursor = forge({ ...payload, marker });

      const error = captureError(() => decodeCursor(cursor));

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

    it('should say that the payload is not valid JSON, with no stack or absolute path, in the detail of a malformed cursor', () => {
      const error = captureError(() => decodeCursor('x.y'));

      expect(error.details).toEqual([
        { ...detail('/cursor', 'malformed'), message: expect.stringContaining('not valid JSON') },
      ]);
      expect(JSON.stringify(error.details)).not.toMatch(/\/home|\.ts/);
    });

    it('should give malformed for a truncated cursor', () => {
      const truncated = encodeCursor(payload).slice(0, -8);

      const error = captureError(() => decodeCursor(truncated));

      expect(error.details).toEqual([detail('/cursor', 'malformed')]);
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

      const error = captureError(() => decodeCursor(cursor));

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

        const error = captureError(() => decodeCursor(cursor));

        expect(error.code).toBe('INVALID_CURSOR');
        expect(error.details).toEqual([
          { path: `/cursor/${field}`, code: expect.any(String), message: expect.any(String) },
        ]);
      },
    );

    it('should refuse an unknown field', () => {
      const cursor = forge({ ...payload, extra: true });

      const error = captureError(() => decodeCursor(cursor));

      expect(error.code).toBe('INVALID_CURSOR');
    });

    it('should refuse a body that is not a JSON object', () => {
      expect(captureError(() => decodeCursor(forge([payload]))).code).toBe('INVALID_CURSOR');
      expect(captureError(() => decodeCursor(forge(null))).code).toBe('INVALID_CURSOR');
    });

    it('should give malformed for base64url with invalid JSON', () => {
      const body = Buffer.from('{not json', 'utf8').toString('base64url');

      const error = captureError(() => decodeCursor(body));

      expect(error.details).toEqual([detail('/cursor', 'malformed')]);
    });

    it.each([
      ['empty', ''],
      ['not base64url of JSON', 'abc'],
      ['with a separator', 'a.b.c'],
    ])('should give malformed for an invalid format (%s)', (_label, text) => {
      const error = captureError(() => decodeCursor(text));

      expect(error.details).toEqual([detail('/cursor', 'malformed')]);
    });
  });
});
