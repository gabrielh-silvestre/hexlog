import { describe, expect, it } from '@jest/globals';
import { FORMAT_CATALOG, catalogNames, isGitSha } from '../../src/domain/formats.ts';

describe('isGitSha', () => {
  it.each(['abcdef1', '0123456789abcdef0123456789abcdef01234567', 'a'.repeat(40)])(
    'should accept %s as a git sha of 7 to 40 lowercase hexadecimal characters',
    (value) => {
      expect(isGitSha(value)).toBe(true);
    },
  );

  it.each([
    ['6 characters', 'abcdef'],
    ['41 characters', 'a'.repeat(41)],
    ['HEAD', 'HEAD'],
    ['uppercase', 'ABCDEF1'],
    ['trailing newline', 'abcdef1\n'],
    ['empty', ''],
    ['non-hexadecimal', 'ghijklm'],
  ])('should reject %s', (_label, value) => {
    expect(isGitSha(value)).toBe(false);
  });
});

describe('FORMAT_CATALOG', () => {
  it('should hold only the git-sha format', () => {
    expect(Object.keys(FORMAT_CATALOG)).toEqual(['git-sha']);
  });
});

describe('catalogNames', () => {
  it('should list the names of the catalog', () => {
    expect(catalogNames()).toEqual(Object.keys(FORMAT_CATALOG));
  });
});
