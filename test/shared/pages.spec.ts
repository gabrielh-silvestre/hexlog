import { describe, expect, it } from '@jest/globals';
import { isHighSurrogate, sliceChars } from '../../src/shared/pages.ts';

// '😀' ocupa duas unidades UTF-16 (um par surrogate).
const EMOJI = '\u{1F600}';

describe('isHighSurrogate', () => {
  it.each([
    ['0xd800', 0xd800],
    ['0xdbff', 0xdbff],
  ])('should accept %s, an edge of the high surrogate range', (_label, code) => {
    expect(isHighSurrogate(code)).toBe(true);
  });

  it.each([
    ['0xd7ff', 0xd7ff],
    ['0xdc00', 0xdc00],
    ['NaN', NaN],
  ])('should refuse %s, outside the high surrogate range', (_label, code) => {
    expect(isHighSurrogate(code)).toBe(false);
  });
});

describe('sliceChars', () => {
  it('should cut exactly at offset + limit for text without a surrogate', () => {
    expect(sliceChars('abcdef', 0, 3)).toEqual({ text: 'abc', nextOffset: 3 });
  });

  it('should step back by 1 on a surrogate pair at the cut, leaving the whole pair for the next page', () => {
    expect(sliceChars(`ab${EMOJI}cd`, 0, 3)).toEqual({ text: 'ab', nextOffset: 2 });
  });

  it('should advance by 1 and take the whole pair when stepping back would leave the page empty', () => {
    expect(sliceChars(`${EMOJI}cd`, 0, 1)).toEqual({ text: EMOJI, nextOffset: 2 });
  });

  it('should respect the surrogate pair for an offset in the middle of the text too', () => {
    expect(sliceChars(`abcd${EMOJI}ef`, 2, 3)).toEqual({ text: 'cd', nextOffset: 4 });
  });

  it('should return a null nextOffset when the limit goes past the end of the text', () => {
    expect(sliceChars('abc', 0, 10)).toEqual({ text: 'abc', nextOffset: null });
  });

  it('should return a null nextOffset when the page ends exactly at the end of the text', () => {
    expect(sliceChars('abcdef', 3, 3)).toEqual({ text: 'def', nextOffset: null });
  });

  it('should not step back for a surrogate pair at the end of the text, cut exactly at it', () => {
    expect(sliceChars(`ab${EMOJI}`, 0, 4)).toEqual({ text: `ab${EMOJI}`, nextOffset: null });
  });

  it('should keep a lone high surrogate that ends the text, since the cut is the end', () => {
    expect(sliceChars('ab\ud83d', 0, 3)).toEqual({ text: 'ab\ud83d', nextOffset: null });
  });

  it.each([1, 2, 3, 5])(
    'should walk with limit %i returning the whole text and only well-formed pages',
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
