import { describe, test, expect } from '@jest/globals';
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
  test.each(['a', 'a-b1', '0a', 'x'.repeat(63)])('%s é válido', (value) => {
    expect(Name.safeParse(value).success).toBe(true);
  });

  test.each(['', 'A', '-a', 'a_b', 'a.b', 'a:b', 'x'.repeat(64)])('%s é inválido', (value) => {
    expect(Name.safeParse(value).success).toBe(false);
  });
});

describe('alias (D-01)', () => {
  test.each(['a', 'plan-1', 'x'.repeat(63)])('%s é válido', (value) => {
    expect(alias.safeParse(value).success).toBe(true);
  });

  test.each(['@a', '', 'A', '-a', 'x'.repeat(64)])('%s é inválido', (value) => {
    expect(alias.safeParse(value).success).toBe(false);
  });
});

describe('Hash', () => {
  test('aceita 64 hex minúsculos', () => {
    expect(Hash.safeParse('a'.repeat(64)).success).toBe(true);
  });

  test.each(['a'.repeat(63), 'A'.repeat(64), 'g'.repeat(64)])('%s é inválido', (value) => {
    expect(Hash.safeParse(value).success).toBe(false);
  });
});

describe('Instant', () => {
  test('aceita ISO 8601 em UTC', () => {
    expect(Instant.safeParse(new Date().toISOString()).success).toBe(true);
  });

  test.each(['2026-09-30', '2026-09-30T10:00:00', 'ontem'])('%s é inválido', (value) => {
    expect(Instant.safeParse(value).success).toBe(false);
  });
});

describe('Target (D-07)', () => {
  test.each(['a', 'a.b.c', 'rdsc.card-1', `${'x'.repeat(63)}.${'y'.repeat(63)}`])(
    '%s é válido',
    (value) => {
      expect(Target.safeParse(value).success).toBe(true);
    },
  );

  test.each(['', 'a.', '.a', 'a..b', 'A.b', 'a b', 'a:b', 'hex:target:x'])(
    '%s é inválido',
    (value) => {
      expect(Target.safeParse(value).success).toBe(false);
    },
  );

  test('no limite de 200 caracteres passa e com 201 cai', () => {
    const at200 = [...Array<string>(3).fill('x'.repeat(63)), 'y'.repeat(8)].join('.');
    expect(at200).toHaveLength(200);
    expect(Target.safeParse(at200).success).toBe(true);
    expect(Target.safeParse(`${at200}y`).success).toBe(false);
  });
});

describe('RecordId (D-01)', () => {
  test('aceita <processo>:<uuidv7>', () => {
    const id = `proc-1:${randomUUIDv7()}`;
    expect(RecordId.safeParse(id).success).toBe(true);
  });

  test.each([
    'proc-1',
    'proc-1:',
    `:${randomUUIDv7()}`,
    'proc-1:123e4567-e89b-42d3-a456-426614174000',
    `proc-1:${randomUUIDv7().toUpperCase()}`,
    `a:b:${randomUUIDv7()}`,
    `Proc:${randomUUIDv7()}`,
  ])('%s é inválido', (value) => {
    expect(RecordId.safeParse(value).success).toBe(false);
  });
});

describe('processOf', () => {
  test('devolve o processo que o id carrega', () => {
    expect(processOf(`proc-1:${randomUUIDv7()}`)).toBe('proc-1');
  });
});

describe('nomes de processo reservados (TI5)', () => {
  test('lista exatamente os cinco nomes reservados', () => {
    expect([...RESERVED_PROCESS_NAMES]).toEqual([
      'types',
      'relations',
      'gates',
      'attachments',
      'archive',
    ]);
  });

  test.each(RESERVED_PROCESS_NAMES)('%s segue o formato de Name', (value) => {
    expect(Name.safeParse(value).success).toBe(true);
  });
});
