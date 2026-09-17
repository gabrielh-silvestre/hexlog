import { describe, test, expect } from '@jest/globals';
import { randomUUIDv7 } from 'node:crypto';
import fc from 'fast-check';
import { z } from 'zod';
import { HexlogError } from '../src/errors.ts';
import { Target, Name, parseId, normalizeData } from '../src/events.ts';

describe('Nome', () => {
  test.each(['a', 'a-b1', 'x'.repeat(63)])('%s é válido', (value) => {
    expect(Name.safeParse(value).success).toBe(true);
  });

  test.each(['..', 'a/b', 'A', '', '-a', 'x'.repeat(64)])('%s é inválido', (value) => {
    expect(Name.safeParse(value).success).toBe(false);
  });
});

describe('Alvo (N12)', () => {
  test.each(['u1', 'hex:target:', 'hex:target:a:b', 'hex:target:a b', 'hex:other:x'])(
    '%s é rejeitado',
    (value) => {
      expect(Target.safeParse(value).success).toBe(false);
    },
  );

  test('hex:target:u1 é aceito', () => {
    expect(Target.safeParse('hex:target:u1').success).toBe(true);
  });

  test('normalizeData rejeita target inválido num Milestone com INVALID_EVENT em /data/target', () => {
    const data = { milestoneType: 'review', target: 'u1' };
    expect.assertions(3);
    try {
      normalizeData('milestone', data);
    } catch (error) {
      expect(error).toBeInstanceOf(HexlogError);
      expect((error as HexlogError).code).toBe('INVALID_EVENT');
      expect((error as HexlogError).details).toContainEqual(
        expect.objectContaining({ path: '/data/target' }),
      );
    }
  });

  test('normalizeData rejeita target inválido num Verdict com INVALID_EVENT em /data/target', () => {
    const data = {
      claim: 'a',
      source: 'f',
      result: 'approved',
      evidence: 'p',
      target: 'hex:other:x',
      origin: 'o',
      trace: 'r',
    };
    expect.assertions(3);
    try {
      normalizeData('verdict', data);
    } catch (error) {
      expect(error).toBeInstanceOf(HexlogError);
      expect((error as HexlogError).code).toBe('INVALID_EVENT');
      expect((error as HexlogError).details).toContainEqual(
        expect.objectContaining({ path: '/data/target' }),
      );
    }
  });
});

describe('normalizeData (N8: dueAt → UTC Z)', () => {
  test('offset -03:00 vira Z equivalente', () => {
    const data = {
      milestoneType: 'review',
      target: 'hex:target:u1',
      dueAt: '2026-09-16T18:00:00-03:00',
    };
    expect(normalizeData('milestone', data).dueAt).toBe('2026-09-16T21:00:00.000Z');
  });
});

describe('parseId (N9)', () => {
  test('prefixo válido decompõe em project/process/type, sem uuid', () => {
    expect(parseId('my-project:proc1:milestone')).toEqual({
      project: 'my-project',
      process: 'proc1',
      type: 'milestone',
    });
  });

  test('id completo com uuid v7 válido decompõe com uuid', () => {
    const uuid = randomUUIDv7();
    expect(parseId(`my-project:proc1:milestone:${uuid}`)).toEqual({
      project: 'my-project',
      process: 'proc1',
      type: 'milestone',
      uuid,
    });
  });

  test('uuid v4 é rejeitado (versão/variante erradas)', () => {
    expect(parseId('my-project:proc1:milestone:3fa85f64-5717-4562-b3fc-2c963f66afa6')).toBeNull();
  });

  test('maiúsculas são rejeitadas', () => {
    expect(parseId('My-Project:proc1:milestone')).toBeNull();
    const uuid = randomUUIDv7().toUpperCase();
    expect(parseId(`my-project:proc1:milestone:${uuid}`)).toBeNull();
  });
});

describe('normalizeData idempotência (N2 iii, property)', () => {
  const pad = (n: number, width = 2) => String(n).padStart(width, '0');

  /** Formata `instant` (UTC) como visto num relógio local deslocado por `offsetMin`. */
  function formatWithOffset(instant: Date, offsetMin: number): string {
    const local = new Date(instant.getTime() + offsetMin * 60_000);
    const sign = offsetMin < 0 ? '-' : '+';
    const absMin = Math.abs(offsetMin);
    const date = `${local.getUTCFullYear()}-${pad(local.getUTCMonth() + 1)}-${pad(local.getUTCDate())}`;
    const time = `${pad(local.getUTCHours())}:${pad(local.getUTCMinutes())}:${pad(local.getUTCSeconds())}`;
    return `${date}T${time}${sign}${pad(Math.floor(absMin / 60))}:${pad(absMin % 60)}`;
  }

  const arbText = fc.stringMatching(/^[A-Za-z0-9 ]{1,20}$/);
  const arbTarget = fc.stringMatching(/^[a-z0-9]{1,20}$/).map((s) => `hex:target:${s}`);
  const arbDate = fc.date({
    min: new Date('2000-01-01T00:00:00.000Z'),
    max: new Date('2035-01-01T00:00:00.000Z'),
    noInvalidDate: true,
  });
  const arbOffsetMin = fc.integer({ min: -23 * 60, max: 23 * 60 });
  const arbDueDate = fc
    .tuple(arbDate, arbOffsetMin)
    .map(([date, offset]) => formatWithOffset(date, offset));

  test('Milestone: normalizeData é idempotente com dueAt em offset aleatório', () => {
    fc.assert(
      fc.property(
        fc.record({ milestoneType: arbText, target: arbTarget, dueAt: arbDueDate }),
        (data) => {
          const applied = normalizeData('milestone', data);
          const reapplied = normalizeData('milestone', applied);
          expect(reapplied).toEqual(applied);
        },
      ),
    );
  });

  test('Verdict: normalizeData é idempotente', () => {
    fc.assert(
      fc.property(
        fc.record({
          claim: arbText,
          source: arbText,
          result: arbText,
          evidence: arbText,
          target: arbTarget,
          origin: arbText,
          trace: arbText,
        }),
        (data) => {
          const applied = normalizeData('verdict', data);
          const reapplied = normalizeData('verdict', applied);
          expect(reapplied).toEqual(applied);
        },
      ),
    );
  });

  test('tipo custom com default: normalizeData é idempotente', () => {
    const customSchema = z.strictObject({
      name: z.string().min(1),
      priority: z.number().default(1),
    });
    const customSchemas = { 'my-type': customSchema };

    fc.assert(
      fc.property(
        arbText,
        fc.option(fc.integer({ min: 0, max: 10 }), { nil: undefined }),
        (name, priority) => {
          const data = priority === undefined ? { name } : { name, priority };
          const applied = normalizeData('my-type', data, customSchemas);
          const reapplied = normalizeData('my-type', applied, customSchemas);
          expect(reapplied).toEqual(applied);
        },
      ),
    );
  });
});
