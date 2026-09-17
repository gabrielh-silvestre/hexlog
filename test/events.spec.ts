import { describe, test, expect } from '@jest/globals';
import { randomUUIDv7 } from 'node:crypto';
import fc from 'fast-check';
import { z } from 'zod';
import { ErroHexlog } from '../src/errors.ts';
import { Alvo, Nome, analisarId, normalizarDados } from '../src/events.ts';

describe('Nome', () => {
  test.each(['a', 'a-b1', 'x'.repeat(63)])('%s é válido', (valor) => {
    expect(Nome.safeParse(valor).success).toBe(true);
  });

  test.each(['..', 'a/b', 'A', '', '-a', 'x'.repeat(64)])('%s é inválido', (valor) => {
    expect(Nome.safeParse(valor).success).toBe(false);
  });
});

describe('Alvo (N12)', () => {
  test.each(['u1', 'hex:alvo:', 'hex:alvo:a:b', 'hex:alvo:a b', 'hex:outro:x'])(
    '%s é rejeitado',
    (valor) => {
      expect(Alvo.safeParse(valor).success).toBe(false);
    },
  );

  test('hex:alvo:u1 é aceito', () => {
    expect(Alvo.safeParse('hex:alvo:u1').success).toBe(true);
  });

  test('normalizarDados rejeita alvo inválido num Marco com EVENTO_INVALIDO em /dados/alvo', () => {
    const dados = { marcoTipo: 'revisao', alvo: 'u1' };
    expect.assertions(3);
    try {
      normalizarDados('marco', dados);
    } catch (erro) {
      expect(erro).toBeInstanceOf(ErroHexlog);
      expect((erro as ErroHexlog).codigo).toBe('EVENTO_INVALIDO');
      expect((erro as ErroHexlog).detalhes).toContainEqual(
        expect.objectContaining({ caminho: '/dados/alvo' }),
      );
    }
  });

  test('normalizarDados rejeita destino inválido num Veredito com EVENTO_INVALIDO em /dados/destino', () => {
    const dados = {
      afirmacao: 'a',
      fonte: 'f',
      resultado: 'aprovado',
      prova: 'p',
      destino: 'hex:outro:x',
      origem: 'o',
      rastro: 'r',
    };
    expect.assertions(3);
    try {
      normalizarDados('veredito', dados);
    } catch (erro) {
      expect(erro).toBeInstanceOf(ErroHexlog);
      expect((erro as ErroHexlog).codigo).toBe('EVENTO_INVALIDO');
      expect((erro as ErroHexlog).detalhes).toContainEqual(
        expect.objectContaining({ caminho: '/dados/destino' }),
      );
    }
  });
});

describe('normalizarDados (N8: prazoExecucao → UTC Z)', () => {
  test('offset -03:00 vira Z equivalente', () => {
    const dados = {
      marcoTipo: 'revisao',
      alvo: 'hex:alvo:u1',
      prazoExecucao: '2026-09-16T18:00:00-03:00',
    };
    expect(normalizarDados('marco', dados).prazoExecucao).toBe('2026-09-16T21:00:00.000Z');
  });
});

describe('analisarId (N9)', () => {
  test('prefixo válido decompõe em projeto/processo/tipo, sem uuid', () => {
    expect(analisarId('meu-projeto:proc1:marco')).toEqual({
      projeto: 'meu-projeto',
      processo: 'proc1',
      tipo: 'marco',
    });
  });

  test('id completo com uuid v7 válido decompõe com uuid', () => {
    const uuid = randomUUIDv7();
    expect(analisarId(`meu-projeto:proc1:marco:${uuid}`)).toEqual({
      projeto: 'meu-projeto',
      processo: 'proc1',
      tipo: 'marco',
      uuid,
    });
  });

  test('uuid v4 é rejeitado (versão/variante erradas)', () => {
    expect(analisarId('meu-projeto:proc1:marco:3fa85f64-5717-4562-b3fc-2c963f66afa6')).toBeNull();
  });

  test('maiúsculas são rejeitadas', () => {
    expect(analisarId('Meu-Projeto:proc1:marco')).toBeNull();
    const uuid = randomUUIDv7().toUpperCase();
    expect(analisarId(`meu-projeto:proc1:marco:${uuid}`)).toBeNull();
  });
});

describe('normalizarDados idempotência (N2 iii, property)', () => {
  const pad = (n: number, largura = 2) => String(n).padStart(largura, '0');

  /** Formata `instante` (UTC) como visto num relógio local deslocado por `offsetMin`. */
  function formatarComOffset(instante: Date, offsetMin: number): string {
    const local = new Date(instante.getTime() + offsetMin * 60_000);
    const sinal = offsetMin < 0 ? '-' : '+';
    const absMin = Math.abs(offsetMin);
    const data = `${local.getUTCFullYear()}-${pad(local.getUTCMonth() + 1)}-${pad(local.getUTCDate())}`;
    const hora = `${pad(local.getUTCHours())}:${pad(local.getUTCMinutes())}:${pad(local.getUTCSeconds())}`;
    return `${data}T${hora}${sinal}${pad(Math.floor(absMin / 60))}:${pad(absMin % 60)}`;
  }

  const arbTexto = fc.stringMatching(/^[A-Za-z0-9 ]{1,20}$/);
  const arbAlvo = fc.stringMatching(/^[a-z0-9]{1,20}$/).map((s) => `hex:alvo:${s}`);
  const arbData = fc.date({
    min: new Date('2000-01-01T00:00:00.000Z'),
    max: new Date('2035-01-01T00:00:00.000Z'),
    noInvalidDate: true,
  });
  const arbOffsetMin = fc.integer({ min: -23 * 60, max: 23 * 60 });
  const arbPrazo = fc
    .tuple(arbData, arbOffsetMin)
    .map(([data, offset]) => formatarComOffset(data, offset));

  test('Marco: normalizarDados é idempotente com prazoExecucao em offset aleatório', () => {
    fc.assert(
      fc.property(
        fc.record({ marcoTipo: arbTexto, alvo: arbAlvo, prazoExecucao: arbPrazo }),
        (dados) => {
          const uma = normalizarDados('marco', dados);
          const duas = normalizarDados('marco', uma);
          expect(duas).toEqual(uma);
        },
      ),
    );
  });

  test('Veredito: normalizarDados é idempotente', () => {
    fc.assert(
      fc.property(
        fc.record({
          afirmacao: arbTexto,
          fonte: arbTexto,
          resultado: arbTexto,
          prova: arbTexto,
          destino: arbAlvo,
          origem: arbTexto,
          rastro: arbTexto,
        }),
        (dados) => {
          const uma = normalizarDados('veredito', dados);
          const duas = normalizarDados('veredito', uma);
          expect(duas).toEqual(uma);
        },
      ),
    );
  });

  test('tipo custom com default: normalizarDados é idempotente', () => {
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
          const dados = prioridade === undefined ? { nome } : { nome, prioridade };
          const uma = normalizarDados('meu-tipo', dados, esquemasCustom);
          const duas = normalizarDados('meu-tipo', uma, esquemasCustom);
          expect(duas).toEqual(uma);
        },
      ),
    );
  });
});
