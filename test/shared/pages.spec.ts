import { describe, expect, test } from '@jest/globals';
import { sliceChars } from '../../src/shared/pages.ts';

// '😀' ocupa duas unidades UTF-16 (um par surrogate).
const EMOJI = '\u{1F600}';

describe('sliceChars', () => {
  test('texto sem surrogate corta exatamente em offset + limit', () => {
    expect(sliceChars('abcdef', 0, 3)).toEqual({ text: 'abc', nextOffset: 3 });
  });

  test('par surrogate no corte: recua 1 e o par vai inteiro na página seguinte', () => {
    expect(sliceChars(`ab${EMOJI}cd`, 0, 3)).toEqual({ text: 'ab', nextOffset: 2 });
  });

  test('recuar deixaria a página vazia: avança 1 e leva o par inteiro', () => {
    expect(sliceChars(`${EMOJI}cd`, 0, 1)).toEqual({ text: EMOJI, nextOffset: 2 });
  });

  test('offset no meio do texto também respeita o par surrogate', () => {
    expect(sliceChars(`abcd${EMOJI}ef`, 2, 3)).toEqual({ text: 'cd', nextOffset: 4 });
  });

  test('chegou ao fim: nextOffset é null', () => {
    expect(sliceChars('abc', 0, 10)).toEqual({ text: 'abc', nextOffset: null });
    expect(sliceChars('abcdef', 3, 3)).toEqual({ text: 'def', nextOffset: null });
  });

  test('par surrogate no fim do texto, cortado exatamente nele, não recua', () => {
    expect(sliceChars(`ab${EMOJI}`, 0, 4)).toEqual({ text: `ab${EMOJI}`, nextOffset: null });
  });

  test.each([1, 2, 3, 5])(
    'percorrer com limit %i devolve o texto inteiro e só páginas bem formadas',
    (limit) => {
      const text = `a${EMOJI}b${EMOJI}${EMOJI}c`;
      const pages: string[] = [];
      let offset: number | null = 0;
      while (offset !== null) {
        const page = sliceChars(text, offset, limit);
        pages.push(page.text);
        offset = page.nextOffset;
      }

      expect(pages.join('')).toBe(text);
      expect(pages.every((page) => page.isWellFormed())).toBe(true);
    },
  );
});
