import { describe, it, expect } from '@jest/globals';
import { randomUUIDv7 } from 'node:crypto';
import canonicalize from 'canonicalize';
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
  it('should accept an author with or without model', () => {
    expect(Author.safeParse(author).success).toBe(true);
    expect(Author.safeParse({ ...author, model: 'opus' }).success).toBe(true);
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
});

describe('Relation', () => {
  it('should accept a relation with kind and to', () => {
    expect(Relation.safeParse({ kind: 'supports', to: id() }).success).toBe(true);
  });

  it('should accept a relation with kind, to and as', () => {
    expect(Relation.safeParse({ kind: 'supports', to: id(), as: 'approves' }).success).toBe(true);
  });

  it('should reject a relation without kind', () => {
    expect(Relation.safeParse({ to: id() }).success).toBe(false);
  });

  it('should reject an unknown key', () => {
    expect(Relation.safeParse({ kind: 'supports', to: id(), extra: 1 }).success).toBe(false);
  });

  it('should reject an alias in the stored to', () => {
    expect(Relation.safeParse({ kind: 'supports', to: '@a' }).success).toBe(false);
  });
});

describe('RelationInput', () => {
  it('should accept an id or @alias in to, with kind or as', () => {
    expect(RelationInput.safeParse({ to: id(), kind: 'supports' }).success).toBe(true);
    expect(RelationInput.safeParse({ to: '@plan-1', kind: 'supports' }).success).toBe(true);
    expect(RelationInput.safeParse({ to: '@plan-1', as: 'approves' }).success).toBe(true);
    expect(
      RelationInput.safeParse({ to: '@plan-1', kind: 'supports', as: 'approves' }).success,
    ).toBe(true);
  });

  it('should reject a relation without kind and without as', () => {
    const result = RelationInput.safeParse({ to: id() });

    expect(result.success).toBe(false);
    expect(result.error?.issues).toEqual([
      expect.objectContaining({ path: ['kind'], message: 'relation needs kind or as' }),
    ]);
  });

  it.each([{}, { to: 'plan-1' }, { to: '@' }, { to: '@A' }, { to: id(), kind: 'likes' }])(
    'should reject %j',
    (value) => {
      expect(RelationInput.safeParse(value).success).toBe(false);
    },
  );
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

  it('should accept data at the canonical ceiling', () => {
    const atCap = dataWithCanonicalLength(DATA_MAX_CHARS);

    expect((canonicalize(atCap) ?? '').length).toBe(DATA_MAX_CHARS);

    expect(BatchItem.safeParse({ ...item, data: atCap }).success).toBe(true);
  });

  it('should reject data one character over the canonical ceiling', () => {
    expect(
      BatchItem.safeParse({ ...item, data: dataWithCanonicalLength(DATA_MAX_CHARS + 1) }).success,
    ).toBe(false);
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

  it('should accept relations at the ceiling', () => {
    expect(BatchItem.safeParse({ ...item, relations: relations(RELATIONS_MAX) }).success).toBe(
      true,
    );
  });

  it('should reject one relation over the ceiling', () => {
    expect(BatchItem.safeParse({ ...item, relations: relations(RELATIONS_MAX + 1) }).success).toBe(
      false,
    );
  });

  it('should reject data that is not JSON', () => {
    expect(BatchItem.safeParse({ ...item, data: { fn: () => 1 } }).success).toBe(false);
    expect(BatchItem.safeParse({ ...item, data: { missing: undefined } }).success).toBe(false);
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

  it('should accept relations at the ceiling', () => {
    expect(HexRecord.safeParse({ ...record, relations: relations(RELATIONS_MAX) }).success).toBe(
      true,
    );
  });

  it('should reject one relation over the ceiling', () => {
    expect(
      HexRecord.safeParse({ ...record, relations: relations(RELATIONS_MAX + 1) }).success,
    ).toBe(false);
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
