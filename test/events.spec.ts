import { describe, test, expect } from '@jest/globals';
import { randomUUIDv7 } from 'node:crypto';
import fc from 'fast-check';
import { z } from 'zod';
import { HexlogError } from '../src/errors.ts';
import { Target, Name, parseId, normalizeData } from '../src/events.ts';

describe('Nome', () => {
  test.each(['a', 'a-b1', 'x'.repeat(63)])('%s é válido', (valor) => {
    expect(Name.safeParse(valor).success).toBe(true);
  });

  test.each(['..', 'a/b', 'A', '', '-a', 'x'.repeat(64)])('%s é inválido', (valor) => {
    expect(Name.safeParse(valor).success).toBe(false);
  });
});

describe('Alvo (N12)', () => {
  test.each(['u1', 'hex:target:', 'hex:target:a:b', 'hex:target:a b', 'hex:outro:x'])(
    '%s é rejeitado',
    (valor) => {
      expect(Target.safeParse(valor).success).toBe(false);
    },
  );

  test('hex:target:u1 é aceito', () => {
    expect(Target.safeParse('hex:target:u1').success).toBe(true);
  });

  test('normalizeData rejeita target inválido num Milestone com INVALID_EVENT em /data/target', () => {
    const data = { milestoneType: 'revisao', target: 'u1' };
    expect.assertions(3);
    try {
      normalizeData('milestone', data);
    } catch (erro) {
      expect(erro).toBeInstanceOf(HexlogError);
      expect((erro as HexlogError).code).toBe('INVALID_EVENT');
      expect((erro as HexlogError).details).toContainEqual(
        expect.objectContaining({ path: '/data/target' }),
      );
    }
  });

  test('normalizeData rejeita target inválido num Verdict com INVALID_EVENT em /data/target', () => {
    const data = {
      claim: 'a',
      source: 'f',
      result: 'aprovado',
      evidence: 'p',
      target: 'hex:outro:x',
      origin: 'o',
      trace: 'r',
    };
    expect.assertions(3);
    try {
      normalizeData('verdict', data);
    } catch (erro) {
      expect(erro).toBeInstanceOf(HexlogError);
      expect((erro as HexlogError).code).toBe('INVALID_EVENT');
      expect((erro as HexlogError).details).toContainEqual(
        expect.objectContaining({ path: '/data/target' }),
      );
    }
  });
});

describe('normalizeData (N8: dueAt → UTC Z)', () => {
  test('offset -03:00 vira Z equivalente', () => {
    const data = {
      milestoneType: 'revisao',
      target: 'hex:target:u1',
      dueAt: '2026-09-16T18:00:00-03:00',
    };
    expect(normalizeData('milestone', data).dueAt).toBe('2026-09-16T21:00:00.000Z');
  });
});

describe('parseId (N9)', () => {
  test('prefixo válido decompõe em project/process/type, sem uuid', () => {
    expect(parseId('meu-projeto:proc1:milestone')).toEqual({
      project: 'meu-projeto',
      process: 'proc1',
      type: 'milestone',
    });
  });

  test('id completo com uuid v7 válido decompõe com uuid', () => {
    const uuid = randomUUIDv7();
    expect(parseId(`meu-projeto:proc1:milestone:${uuid}`)).toEqual({
      project: 'meu-projeto',
      process: 'proc1',
      type: 'milestone',
      uuid,
    });
  });

  test('uuid v4 é rejeitado (versão/variante erradas)', () => {
    expect(parseId('meu-projeto:proc1:milestone:3fa85f64-5717-4562-b3fc-2c963f66afa6')).toBeNull();
  });

  test('maiúsculas são rejeitadas', () => {
    expect(parseId('Meu-Projeto:proc1:milestone')).toBeNull();
    const uuid = randomUUIDv7().toUpperCase();
    expect(parseId(`meu-projeto:proc1:milestone:${uuid}`)).toBeNull();
  });
});

describe('normalizeData idempotência (N2 iii, property)', () => {
  const pad = (n: number, largura = 2) => String(n).padStart(largura, '0');

  /** Formata `instante` (UTC) como visto num relógio local deslocado por `offsetMin`. */
  function formatarComOffset(instante: Date, offsetMin: number): string {
    const local = new Date(instante.getTime() + offsetMin * 60_000);
    const sinal = offsetMin < 0 ? '-' : '+';
    const absMin = Math.abs(offsetMin);
    const date = `${local.getUTCFullYear()}-${pad(local.getUTCMonth() + 1)}-${pad(local.getUTCDate())}`;
    const hora = `${pad(local.getUTCHours())}:${pad(local.getUTCMinutes())}:${pad(local.getUTCSeconds())}`;
    return `${date}T${hora}${sinal}${pad(Math.floor(absMin / 60))}:${pad(absMin % 60)}`;
  }

  const arbTexto = fc.stringMatching(/^[A-Za-z0-9 ]{1,20}$/);
  const arbAlvo = fc.stringMatching(/^[a-z0-9]{1,20}$/).map((s) => `hex:target:${s}`);
  const arbDate = fc.date({
    min: new Date('2000-01-01T00:00:00.000Z'),
    max: new Date('2035-01-01T00:00:00.000Z'),
    noInvalidDate: true,
  });
  const arbOffsetMin = fc.integer({ min: -23 * 60, max: 23 * 60 });
  const arbPrazo = fc
    .tuple(arbDate, arbOffsetMin)
    .map(([date, offset]) => formatarComOffset(date, offset));

  test('Milestone: normalizeData é idempotente com dueAt em offset aleatório', () => {
    fc.assert(
      fc.property(
        fc.record({ milestoneType: arbTexto, target: arbAlvo, dueAt: arbPrazo }),
        (data) => {
          const uma = normalizeData('milestone', data);
          const duas = normalizeData('milestone', uma);
          expect(duas).toEqual(uma);
        },
      ),
    );
  });

  test('Verdict: normalizeData é idempotente', () => {
    fc.assert(
      fc.property(
        fc.record({
          claim: arbTexto,
          source: arbTexto,
          result: arbTexto,
          evidence: arbTexto,
          target: arbAlvo,
          origin: arbTexto,
          trace: arbTexto,
        }),
        (data) => {
          const uma = normalizeData('verdict', data);
          const duas = normalizeData('verdict', uma);
          expect(duas).toEqual(uma);
        },
      ),
    );
  });

  test('tipo custom com default: normalizeData é idempotente', () => {
    const esquemaCustom = z.strictObject({
      nome: z.string().min(1),
      prioridade: z.number().default(1),
    });
    const esquemasCustom = { 'meu-tipo': esquemaCustom };

    fc.assert(
      fc.property(
        arbTexto,
        fc.option(fc.integer({ min: 0, max: 10 }), { nil: undefined }),
        (nome, prioridade) => {
          const data = prioridade === undefined ? { nome } : { nome, prioridade };
          const uma = normalizeData('meu-tipo', data, esquemasCustom);
          const duas = normalizeData('meu-tipo', uma, esquemasCustom);
          expect(duas).toEqual(uma);
        },
      ),
    );
  });
});
