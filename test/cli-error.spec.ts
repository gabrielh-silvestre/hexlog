import { describe, expect, it } from '@jest/globals';
import { HexlogError } from '../src/errors.ts';
import { formatCliError } from '../scripts/cli-error.ts';

describe('formatCliError', () => {
  it.each([
    ['a plain Error', new Error('boom'), 'x failed: INTERNAL: Error: boom'],
    ['a thrown string', 'oops', 'x failed: INTERNAL: oops'],
  ])('should wrap %s as INTERNAL with exit code 1', (_name, thrown, text) => {
    expect(formatCliError('x', thrown)).toEqual({ text, exitCode: 1 });
  });

  it('should exit with 2 for a data error', () => {
    expect(formatCliError('x', new HexlogError('LEGACY_DATA', 'legacy data')).exitCode).toBe(2);
  });
});
