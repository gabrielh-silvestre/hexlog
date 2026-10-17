import { describe, it, expect } from '@jest/globals';
import { randomUUIDv7 } from 'node:crypto';
import {
  Hash,
  Instant,
  Name,
  RecordId,
  RESERVED_PROCESS_NAMES,
  Target,
  alias,
  processOf,
} from '../../src/domain/ids.ts';

describe('Name', () => {
  it.each(['a', 'a-b1', '0a', 'x'.repeat(63)])('should accept %s', (value) => {
    expect(Name.safeParse(value).success).toBe(true);
  });

  it.each(['', 'A', '-a', 'a_b', 'a.b', 'a:b', 'x'.repeat(64)])('should reject %s', (value) => {
    expect(Name.safeParse(value).success).toBe(false);
  });

  it.each(RESERVED_PROCESS_NAMES)('should accept the reserved process name %s (TI5)', (value) => {
    expect(Name.safeParse(value).success).toBe(true);
  });
});

describe('alias', () => {
  it.each(['a', 'plan-1', 'x'.repeat(63)])('should accept %s (D-01)', (value) => {
    expect(alias.safeParse(value).success).toBe(true);
  });

  it.each(['@a', '', 'A', '-a', 'x'.repeat(64)])('should reject %s (D-01)', (value) => {
    expect(alias.safeParse(value).success).toBe(false);
  });
});

describe('Hash', () => {
  it('should accept 64 lowercase hex characters', () => {
    expect(Hash.safeParse('a'.repeat(64)).success).toBe(true);
  });

  it.each(['a'.repeat(63), 'A'.repeat(64), 'g'.repeat(64)])('should reject %s', (value) => {
    expect(Hash.safeParse(value).success).toBe(false);
  });
});

describe('Instant', () => {
  it('should accept ISO 8601 in UTC with milliseconds', () => {
    expect(Instant.safeParse(new Date().toISOString()).success).toBe(true);
  });

  it.each([
    '2026-09-30',
    '2026-09-30T10:00:00',
    '2026-09-30T10:00:00Z',
    '2026-09-30T10:00:00.123456789Z',
    '2026-09-30T10:00:00.123+02:00',
    'ontem',
  ])('should reject %s', (value) => {
    expect(Instant.safeParse(value).success).toBe(false);
  });
});

describe('Target', () => {
  const at200 = [...Array<string>(3).fill('x'.repeat(63)), 'y'.repeat(8)].join('.');

  it.each(['a', 'a.b.c', 'rdsc.card-1', `${'x'.repeat(63)}.${'y'.repeat(63)}`])(
    'should accept %s (D-07)',
    (value) => {
      expect(Target.safeParse(value).success).toBe(true);
    },
  );

  it.each(['', 'a.', '.a', 'a..b', 'A.b', 'a b', 'a:b', 'hex:target:x'])(
    'should reject %s (D-07)',
    (value) => {
      expect(Target.safeParse(value).success).toBe(false);
    },
  );

  it('should accept a target of exactly 200 characters (D-07)', () => {
    expect(at200).toHaveLength(200);

    expect(Target.safeParse(at200).success).toBe(true);
  });

  it('should reject a target of 201 characters (D-07)', () => {
    expect(Target.safeParse(`${at200}y`).success).toBe(false);
  });
});

describe('RecordId', () => {
  it('should accept <process>:<uuidv7> (D-01)', () => {
    const id = `proc-1:${randomUUIDv7()}`;

    expect(RecordId.safeParse(id).success).toBe(true);
  });

  it.each([
    'proc-1',
    'proc-1:',
    `:${randomUUIDv7()}`,
    'proc-1:123e4567-e89b-42d3-a456-426614174000',
    'proc-1:0198F4A0-0000-7000-8000-000000000001',
    `a:b:${randomUUIDv7()}`,
    `Proc:${randomUUIDv7()}`,
  ])('should reject %s (D-01)', (value) => {
    expect(RecordId.safeParse(value).success).toBe(false);
  });
});

describe('processOf', () => {
  it('should return the process the id carries', () => {
    expect(processOf(`proc-1:${randomUUIDv7()}`)).toBe('proc-1');
  });
});

describe('RESERVED_PROCESS_NAMES', () => {
  it('should list exactly the five reserved names (TI5)', () => {
    expect([...RESERVED_PROCESS_NAMES]).toEqual([
      'types',
      'relations',
      'gates',
      'attachments',
      'archive',
    ]);
  });
});
