import { describe, it, expect } from '@jest/globals';
import { randomUUIDv7 } from 'node:crypto';
import canonicalize from 'canonicalize';
import { z } from 'zod';
import {
  Author,
  BATCH_MAX,
  BatchItem,
  DATA_MAX_CHARS,
  HexRecord,
  RELATIONS_MAX,
  Relation,
  RelationInput,
  RelationKind,
  withCanonicalLimit,
} from '../../src/domain/record.ts';

const id = () => `proc-1:${randomUUIDv7()}`;
const author = { agent: 'naruto', client: 'claude-code' };

/** Objeto cujo JCS tem exatamente `chars` caracteres. */
function dataWithCanonicalLength(chars: number) {
  const overhead = (canonicalize({ k: '' }) ?? '').length;
  return { k: 'x'.repeat(chars - overhead) };
}

describe('DATA_MAX_CHARS', () => {
  it('should be 16,000', () => {
    expect(DATA_MAX_CHARS).toBe(16_000);
  });
});

describe('BATCH_MAX', () => {
  it('should be 50', () => {
    expect(BATCH_MAX).toBe(50);
  });
});

describe('RELATIONS_MAX', () => {
  it('should be 100', () => {
    expect(RELATIONS_MAX).toBe(100);
  });
});

describe('withCanonicalLimit', () => {
  it('should accept a value that has no canonical form, such as undefined', () => {
    const schema = withCanonicalLimit(z.unknown(), 1, 'value');

    expect(schema.safeParse(undefined).success).toBe(true);
  });

  it('should name what was limited, the ceiling and the measured size when the value exceeds it', () => {
    const schema = withCanonicalLimit(z.string(), 3, 'name');

    const result = schema.safeParse('abcd');

    expect(result.error?.issues).toEqual([
      expect.objectContaining({
        message: 'name exceeds 3 canonical characters or is not canonicalizable (got 6)',
      }),
    ]);
  });

  it('should leave the measured size out when the value is not canonicalizable', () => {
    const schema = withCanonicalLimit(z.string(), 3, 'name');

    const result = schema.safeParse('\ud800');

    expect(result.error?.issues).toEqual([
      expect.objectContaining({
        message: 'name exceeds 3 canonical characters or is not canonicalizable',
      }),
    ]);
  });
});

describe('RelationKind', () => {
  it('should list the eight relation kinds', () => {
    expect(RelationKind.options).toEqual([
      'supersedes',
      'revokes',
      'supports',
      'contradicts',
      'answers',
      'derivesFrom',
      'complements',
      'reopens',
    ]);
  });
});

describe('Author', () => {
  it.each([
    ['without model', author],
    ['with model', { ...author, model: 'opus' }],
  ])('should accept an author %s', (_label, value) => {
    expect(Author.safeParse(value).success).toBe(true);
  });

  it.each([{ client: 'c' }, { agent: 'a' }, { ...author, agent: '' }, { ...author, extra: 1 }])(
    'should reject %j',
    (value) => {
      expect(Author.safeParse(value).success).toBe(false);
    },
  );

  it.each(['agent', 'model', 'client'])('should reject a lone surrogate in %s', (field) => {
    expect(Author.safeParse({ ...author, [field]: 'x\ud800' }).success).toBe(false);
  });

  it('should say the field must not contain a lone surrogate', () => {
    const result = Author.safeParse({ ...author, agent: 'x\ud800' });

    expect(result.error?.issues).toEqual([
      expect.objectContaining({
        path: ['agent'],
        message: 'must not contain a lone surrogate',
      }),
    ]);
  });
});

describe('Relation', () => {
  it('should accept a relation with kind and to', () => {
    expect(Relation.safeParse({ kind: 'supports', to: id() }).success).toBe(true);
  });

  it('should accept a relation with kind, to and as', () => {
    expect(Relation.safeParse({ kind: 'supports', to: id(), as: 'approves' }).success).toBe(true);
  });

  it.each([
    ['a relation without kind', { to: id() }],
    ['an unknown key', { kind: 'supports', to: id(), extra: 1 }],
    ['an alias in the stored to', { kind: 'supports', to: '@a' }],
  ])('should reject %s', (_label, value) => {
    expect(Relation.safeParse(value).success).toBe(false);
  });
});

describe('RelationInput', () => {
  it.each(['@a', '@plan-1', `@${'x'.repeat(63)}`])('should accept the alias %s in to', (value) => {
    expect(RelationInput.safeParse({ to: value, kind: 'supports' }).success).toBe(true);
  });

  it.each(['plan-1', '', '@', '@A', '@-a', `@${'x'.repeat(64)}`])(
    'should reject %s in to',
    (value) => {
      expect(RelationInput.safeParse({ to: value, kind: 'supports' }).success).toBe(false);
    },
  );

  it.each([
    ['an id with kind', { to: id(), kind: 'supports' }],
    ['an @alias with kind', { to: '@plan-1', kind: 'supports' }],
    ['an @alias with as', { to: '@plan-1', as: 'approves' }],
    ['an @alias with kind and as', { to: '@plan-1', kind: 'supports', as: 'approves' }],
  ])('should accept %s', (_label, value) => {
    expect(RelationInput.safeParse(value).success).toBe(true);
  });

  it('should reject a relation without kind and without as', () => {
    const result = RelationInput.safeParse({ to: id() });

    expect(result.success).toBe(false);
    expect(result.error?.issues).toEqual([
      expect.objectContaining({
        path: ['kind'],
        message: expect.stringContaining('or as (a relation name pinned in the process)'),
      }),
    ]);
  });

  it('should list the eight kinds and point relation names to as when kind is not one of them', () => {
    const result = RelationInput.safeParse({ to: id(), kind: 'approves' });

    expect(result.error?.issues).toEqual([
      expect.objectContaining({
        code: 'invalid_value',
        path: ['kind'],
        message: `kind must be one of ${RelationKind.options.join(', ')}; a relation name goes in as`,
      }),
    ]);
  });

  it.each([{}, { to: id(), kind: 'likes' }])('should reject %j', (value) => {
    expect(RelationInput.safeParse(value).success).toBe(false);
  });
});

describe('BatchItem', () => {
  const item = { type: 'note', target: 'a.b', data: { text: 'oi' } };
  const emojis = (count: number) => ({ k: '😀'.repeat(count) });
  const relations = (count: number) =>
    Array.from({ length: count }, () => ({ to: id(), kind: 'supports' }));

  it('should accept an item with or without alias and relations', () => {
    expect(BatchItem.safeParse(item).success).toBe(true);
    expect(
      BatchItem.safeParse({
        ...item,
        alias: 'first',
        relations: [{ to: '@other', as: 'approves' }],
      }).success,
    ).toBe(true);
  });

  it.each([
    { ...item, type: undefined },
    { ...item, target: 'A.b' },
    { ...item, data: 'texto' },
    { ...item, id: id() },
    { ...item, alias: '@first' },
  ])('should reject %j', (value) => {
    expect(BatchItem.safeParse(value).success).toBe(false);
  });

  it('should name data and the ceiling when data exceeds the canonical ceiling', () => {
    const result = BatchItem.safeParse({
      ...item,
      data: dataWithCanonicalLength(DATA_MAX_CHARS + 1),
    });

    expect(result.error?.issues).toEqual([
      expect.objectContaining({
        path: ['data'],
        message: `data exceeds 16000 canonical characters or is not canonicalizable (got ${DATA_MAX_CHARS + 1})`,
      }),
    ]);
  });

  it('should accept data at the canonical ceiling', () => {
    const atCap = dataWithCanonicalLength(DATA_MAX_CHARS);

    expect((canonicalize(atCap) ?? '').length).toBe(DATA_MAX_CHARS);

    expect(BatchItem.safeParse({ ...item, data: atCap }).success).toBe(true);
  });

  it('should accept 7996 emoji, since the data ceiling counts UTF-16 units of the JCS', () => {
    expect((canonicalize(emojis(7996)) ?? '').length).toBe(DATA_MAX_CHARS);

    expect(BatchItem.safeParse({ ...item, data: emojis(7996) }).success).toBe(true);
  });

  it('should reject 7997 emoji, since the data ceiling counts UTF-16 units of the JCS', () => {
    expect(BatchItem.safeParse({ ...item, data: emojis(7997) }).success).toBe(false);
  });

  it('should reject data with a lone surrogate without throwing', () => {
    expect(BatchItem.safeParse({ ...item, data: { text: '\ud800' } }).success).toBe(false);
  });

  it.each([
    { count: RELATIONS_MAX, accepted: true },
    { count: RELATIONS_MAX + 1, accepted: false },
  ])('should return success $accepted for $count relations', ({ count, accepted }) => {
    expect(BatchItem.safeParse({ ...item, relations: relations(count) }).success).toBe(accepted);
  });

  it.each([
    ['a function', { fn: () => 1 }],
    ['undefined', { missing: undefined }],
  ])('should reject data holding %s, which is not JSON', (_label, data) => {
    expect(BatchItem.safeParse({ ...item, data }).success).toBe(false);
  });
});

describe('HexRecord', () => {
  const record = {
    id: id(),
    type: 'note',
    at: new Date().toISOString(),
    target: 'a.b',
    author,
    data: { text: 'oi' },
    relations: [{ kind: 'supports', to: id() }],
  };
  const relations = (count: number) =>
    Array.from({ length: count }, () => ({ kind: 'supports', to: id() }));

  it('should accept the complete record', () => {
    expect(HexRecord.safeParse(record).success).toBe(true);
  });

  it.each([
    { count: RELATIONS_MAX, accepted: true },
    { count: RELATIONS_MAX + 1, accepted: false },
  ])('should return success $accepted for $count relations', ({ count, accepted }) => {
    expect(HexRecord.safeParse({ ...record, relations: relations(count) }).success).toBe(accepted);
  });

  it.each([
    { ...record, relations: undefined },
    { ...record, relations: [{ to: id() }] },
    { ...record, at: '2026-09-30' },
    { ...record, seq: 1 },
  ])('should reject %j', (value) => {
    expect(HexRecord.safeParse(value).success).toBe(false);
  });
});
