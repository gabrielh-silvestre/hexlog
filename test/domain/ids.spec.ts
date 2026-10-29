import { describe, it, expect } from '@jest/globals';
import { randomUUIDv7 } from 'node:crypto';
import {
  Hash,
  Instant,
  Name,
  RecordId,
  RESERVED_PROCESS_NAMES,
  Target,
  TypeNames,
  alias,
  processOf,
} from '../../src/domain/ids.ts';

describe('Name', () => {
  it.each([
    ['a letter', 'a'],
    ['a hyphen and a digit', 'a-b1'],
    ['a leading digit', '0a'],
    ['63 characters', 'x'.repeat(63)],
  ])('should accept %s', (_label, value) => {
    expect(Name.safeParse(value).success).toBe(true);
  });

  it.each([
    ['empty', ''],
    ['an uppercase letter', 'A'],
    ['a leading hyphen', '-a'],
    ['an underscore', 'a_b'],
    ['a dot', 'a.b'],
    ['a colon', 'a:b'],
    ['64 characters', 'x'.repeat(64)],
  ])('should reject a name with %s', (_label, value) => {
    expect(Name.safeParse(value).success).toBe(false);
  });

  it.each(RESERVED_PROCESS_NAMES)('should accept the reserved process name %s', (value) => {
    expect(Name.safeParse(value).success).toBe(true);
  });
});

describe('alias', () => {
  it.each([
    ['a letter', 'a'],
    ['a hyphen and a digit', 'plan-1'],
    ['63 characters', 'x'.repeat(63)],
  ])('should accept an alias with %s', (_label, value) => {
    expect(alias.safeParse(value).success).toBe(true);
  });

  it.each([
    ['a leading @', '@a'],
    ['empty', ''],
    ['an uppercase letter', 'A'],
    ['a leading hyphen', '-a'],
    ['64 characters', 'x'.repeat(64)],
  ])('should reject an alias with %s', (_label, value) => {
    expect(alias.safeParse(value).success).toBe(false);
  });
});

describe('Hash', () => {
  it('should accept 64 lowercase hex characters', () => {
    expect(Hash.safeParse('a'.repeat(64)).success).toBe(true);
  });

  it.each([
    ['63 characters', 'a'.repeat(63)],
    ['uppercase', 'A'.repeat(64)],
    ['a non-hexadecimal character', 'g'.repeat(64)],
    ['a trailing extra character', `${'a'.repeat(64)}g`],
    ['a leading extra character', `g${'a'.repeat(64)}`],
    ['65 characters', 'a'.repeat(65)],
  ])('should reject a hash with %s', (_label, value) => {
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
  ])('should reject %s as an instant that is not ISO 8601 in UTC with milliseconds', (value) => {
    expect(Instant.safeParse(value).success).toBe(false);
  });
});

describe('Target', () => {
  const at200 = [...Array<string>(3).fill('x'.repeat(63)), 'y'.repeat(8)].join('.');

  it.each([
    ['one segment', 'a'],
    ['three segments', 'a.b.c'],
    ['a hyphen and a digit', 'rdsc.card-1'],
    ['two segments of 63 characters', `${'x'.repeat(63)}.${'y'.repeat(63)}`],
  ])('should accept a target with %s', (_label, value) => {
    expect(Target.safeParse(value).success).toBe(true);
  });

  it.each([
    ['empty', ''],
    ['a trailing dot', 'a.'],
    ['a leading dot', '.a'],
    ['an empty segment', 'a..b'],
    ['an uppercase letter', 'A.b'],
    ['a space', 'a b'],
    ['a colon', 'a:b'],
    ['colons in the form of an id', 'hex:target:x'],
  ])('should reject a target with %s', (_label, value) => {
    expect(Target.safeParse(value).success).toBe(false);
  });

  it('should accept a target of exactly 200 characters', () => {
    expect(at200).toHaveLength(200);

    expect(Target.safeParse(at200).success).toBe(true);
  });

  it('should reject a target of 201 characters', () => {
    expect(Target.safeParse(`${at200}y`).success).toBe(false);
  });
});

describe('RecordId', () => {
  it('should accept <process>:<uuidv7>', () => {
    const id = `proc-1:${randomUUIDv7()}`;

    expect(RecordId.safeParse(id).success).toBe(true);
  });

  it.each([
    ['no uuid', 'proc-1'],
    ['an empty uuid', 'proc-1:'],
    ['no process', `:${randomUUIDv7()}`],
    ['a uuid that is not v7', 'proc-1:123e4567-e89b-42d3-a456-426614174000'],
    ['an uppercase uuid', 'proc-1:0198F4A0-0000-7000-8000-000000000001'],
    ['two colons', `a:b:${randomUUIDv7()}`],
    ['an uppercase process', `Proc:${randomUUIDv7()}`],
  ])('should reject an id with %s', (_label, value) => {
    expect(RecordId.safeParse(value).success).toBe(false);
  });
});

describe('TypeNames', () => {
  it('should reject a repeated type name with the duplicate message', () => {
    const result = TypeNames.safeParse(['note', 'decision', 'note']);

    expect(result.success).toBe(false);
    expect(result.error?.issues).toEqual([
      expect.objectContaining({ message: 'duplicate type name' }),
    ]);
  });
});

describe('processOf', () => {
  it('should return the process the id carries', () => {
    expect(processOf(`proc-1:${randomUUIDv7()}`)).toBe('proc-1');
  });
});

describe('RESERVED_PROCESS_NAMES', () => {
  it('should list exactly the five reserved names', () => {
    expect([...RESERVED_PROCESS_NAMES]).toEqual([
      'types',
      'relations',
      'gates',
      'attachments',
      'archive',
    ]);
  });
});
