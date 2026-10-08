import { describe, expect, test } from '@jest/globals';
import { FORMAT_CATALOG, catalogNames, isGitSha } from '../../src/domain/formats.ts';

describe('git-sha', () => {
  test.each(['abcdef1', '0123456789abcdef0123456789abcdef01234567', 'a'.repeat(40)])(
    'aceita %s',
    (value) => {
      expect(isGitSha(value)).toBe(true);
    },
  );

  test.each([
    ['6 caracteres', 'abcdef'],
    ['41 caracteres', 'a'.repeat(41)],
    ['HEAD', 'HEAD'],
    ['maiúscula', 'ABCDEF1'],
    ['quebra de linha final', 'abcdef1\n'],
    ['vazio', ''],
    ['não hexadecimal', 'ghijklm'],
  ])('recusa %s', (_label, value) => {
    expect(isGitSha(value)).toBe(false);
  });
});

describe('FORMAT_CATALOG', () => {
  test('é fechado em git-sha', () => {
    expect(Object.keys(FORMAT_CATALOG)).toEqual(['git-sha']);
  });

  test('catalogNames lista os nomes do catálogo', () => {
    expect(catalogNames()).toEqual(['git-sha']);
  });
});
