import { describe, expect, it } from '@jest/globals';
import { HexlogError } from '../src/errors.ts';
import { formatCliError } from '../scripts/cli-error.ts';

describe('formatCliError', () => {
  it('should wrap a plain Error as INTERNAL with exit code 1', () => {
    expect(formatCliError('x', new Error('boom'))).toEqual({
      text: 'x failed: INTERNAL: Error: boom',
      exitCode: 1,
    });
  });

  it('should wrap a thrown string as INTERNAL with exit code 1', () => {
    expect(formatCliError('x', 'oops')).toEqual({
      text: 'x failed: INTERNAL: oops',
      exitCode: 1,
    });
  });

  it('should exit with 2 for a data error', () => {
    expect(formatCliError('x', new HexlogError('LEGACY_DATA', 'legacy data')).exitCode).toBe(2);
  });
});
