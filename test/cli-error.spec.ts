import { describe, test, expect } from '@jest/globals';
import { HexlogError } from '../src/errors.ts';
import { formatCliError } from '../scripts/cli-error.ts';

describe('formatCliError', () => {
  test('wraps a plain Error as INTERNAL with exit code 1', () => {
    expect(formatCliError('x', new Error('boom'))).toEqual({
      text: 'x failed: INTERNAL: Error: boom',
      exitCode: 1,
    });
  });

  test('wraps a thrown string as INTERNAL with exit code 1', () => {
    expect(formatCliError('x', 'oops')).toEqual({
      text: 'x failed: INTERNAL: oops',
      exitCode: 1,
    });
  });

  test('exits with 2 for a data error', () => {
    expect(formatCliError('x', new HexlogError('LEGACY_DATA', 'legacy data')).exitCode).toBe(2);
  });
});
