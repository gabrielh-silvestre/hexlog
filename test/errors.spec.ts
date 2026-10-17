import { describe, expect, it } from '@jest/globals';
import type { z } from 'zod';
import {
  HexlogError,
  brokenChain,
  capDetails,
  invalidInput,
  issueDetails,
  legacyDataError,
  pointer,
  reservedName,
  type Detail,
} from '../src/errors.ts';

const makeDetails = (count: number): Detail[] =>
  Array.from({ length: count }, (_, n) => ({
    path: `/item/${n}`,
    code: 'code',
    message: `message ${n}`,
  }));

const makeIssue = (path: PropertyKey[], message = 'invalid value'): z.core.$ZodIssue => ({
  code: 'custom',
  path,
  message,
});

describe('HexlogError', () => {
  it('should keep the code, the message and the details it was built with', () => {
    const details = [{ path: '/field', code: 'bad', message: 'bad field' }];

    const error = new HexlogError('INVALID_INPUT', 'invalid input', details);

    expect(error.code).toBe('INVALID_INPUT');
    expect(error.message).toBe('invalid input');
    expect(error.details).toEqual(details);
  });

  it('should default the details to an empty list', () => {
    expect(new HexlogError('INTERNAL', 'boom').details).toEqual([]);
  });

  it('should be an Error', () => {
    expect(new HexlogError('INTERNAL', 'boom')).toBeInstanceOf(Error);
  });

  it('should print as HexlogError followed by the message when converted to a string', () => {
    expect(String(new HexlogError('INTERNAL', 'boom'))).toBe('HexlogError: boom');
  });
});

describe('invalidInput', () => {
  it('should return a HexlogError with the INVALID_INPUT code', () => {
    const error = invalidInput('/limit', 'out-of-range', 'limit is out of range');

    expect(error).toBeInstanceOf(HexlogError);
    expect(error.code).toBe('INVALID_INPUT');
  });

  it('should use the message as the error message', () => {
    expect(invalidInput('/limit', 'out-of-range', 'limit is out of range').message).toBe(
      'limit is out of range',
    );
  });

  it('should describe the refusal in a single detail with the path, the code and the message', () => {
    expect(invalidInput('/limit', 'out-of-range', 'limit is out of range').details).toEqual([
      { path: '/limit', code: 'out-of-range', message: 'limit is out of range' },
    ]);
  });
});

describe('brokenChain', () => {
  it('should return a HexlogError with the PROCESS_CORRUPTED code', () => {
    const error = brokenChain('alpha');

    expect(error).toBeInstanceOf(HexlogError);
    expect(error.code).toBe('PROCESS_CORRUPTED');
  });

  it('should say that the process chain is broken', () => {
    expect(brokenChain('alpha').message).toBe('process chain is broken');
  });

  it('should name the process in a single detail that points at /process with the broken-chain code', () => {
    expect(brokenChain('alpha').details).toEqual([
      {
        path: '/process',
        code: 'broken-chain',
        message: 'process chain is broken',
        process: 'alpha',
      },
    ]);
  });
});

describe('reservedName', () => {
  it('should return a HexlogError with the RESERVED_NAME code', () => {
    const error = reservedName();

    expect(error).toBeInstanceOf(HexlogError);
    expect(error.code).toBe('RESERVED_NAME');
  });

  it('should say that the process name is reserved', () => {
    expect(reservedName().message).toBe('reserved process name');
  });

  it('should describe the refusal in a single detail that points at /process with the reserved-name code', () => {
    expect(reservedName().details).toEqual([
      { path: '/process', code: 'reserved-name', message: 'reserved process name' },
    ]);
  });
});

describe('legacyDataError', () => {
  it('should return a HexlogError with the LEGACY_DATA code', () => {
    const error = legacyDataError();

    expect(error).toBeInstanceOf(HexlogError);
    expect(error.code).toBe('LEGACY_DATA');
  });

  it('should ask to archive the 0.x data first', () => {
    expect(legacyDataError().message).toBe('legacy 0.x data found; archive it first');
  });

  it('should give the archive command in a single detail with an empty path', () => {
    expect(legacyDataError().details).toEqual([
      {
        path: '',
        code: 'run',
        message: 'node scripts/install.ts --archive-0x (from the hexlog repository)',
      },
    ]);
  });
});

describe('pointer', () => {
  it('should return an empty pointer for an empty path', () => {
    expect(pointer([])).toBe('');
  });

  it('should prefix every segment with a slash, numbers included', () => {
    expect(pointer(['records', 0, 'data'])).toBe('/records/0/data');
  });

  it('should escape ~ as ~0 and / as ~1 in every occurrence', () => {
    expect(pointer(['a~b~c'])).toBe('/a~0b~0c');
    expect(pointer(['a/b/c'])).toBe('/a~1b~1c');
  });

  it('should escape ~ before / so the tilde of an escaped slash is not escaped again', () => {
    expect(pointer(['~/'])).toBe('/~0~1');
  });
});

describe('capDetails', () => {
  it('should keep every detail when there are exactly 50', () => {
    expect(capDetails(makeDetails(50))).toEqual(makeDetails(50));
  });

  it('should keep only the first 50 details when there are more', () => {
    const result = capDetails(makeDetails(60));

    expect(result).toHaveLength(51);
    expect(result.slice(0, 50)).toEqual(makeDetails(50));
  });

  it('should end with a too-many-errors detail that counts the omitted ones', () => {
    expect(capDetails(makeDetails(60)).at(-1)).toEqual({
      path: '',
      code: 'too-many-errors',
      message: '10 more errors omitted',
    });
  });

  it('should drop a repeated path, code and message, keeping the first occurrence', () => {
    const [first, second] = makeDetails(2) as [Detail, Detail];

    expect(capDetails([first, second, { ...first }])).toEqual([first, second]);
  });

  it('should keep details that differ in only one of path, code or message', () => {
    const base: Detail = { path: '/a', code: 'c', message: 'm' };
    const details = [
      base,
      { ...base, path: '/b' },
      { ...base, code: 'other' },
      { ...base, message: 'other' },
    ];

    expect(capDetails(details)).toEqual(details);
  });

  it('should not merge details whose fields only match once concatenated', () => {
    const details = [
      { path: 'a', code: 'b', message: 'c' },
      { path: 'ab', code: '', message: 'c' },
    ];

    expect(capDetails(details)).toEqual(details);
  });

  it('should count the cap after dropping the repeated details', () => {
    const repeated = [...makeDetails(50), ...makeDetails(50)];

    expect(capDetails(repeated)).toEqual(makeDetails(50));
  });
});

describe('issueDetails', () => {
  it('should map each issue to a detail under the prefix, keeping its code and message in order', () => {
    const issues = [
      makeIssue(['name'], 'name is required'),
      makeIssue(['items', 1], 'item is invalid'),
    ];

    expect(issueDetails(issues, '/data')).toEqual([
      { path: '/data/name', code: 'custom', message: 'name is required' },
      { path: '/data/items/1', code: 'custom', message: 'item is invalid' },
    ]);
  });

  it('should escape the path of the issue as a JSON Pointer', () => {
    expect(issueDetails([makeIssue(['a/b'])], '/data')[0]?.path).toBe('/data/a~1b');
  });

  it('should use the prefix alone as the path of an issue at the root', () => {
    expect(issueDetails([makeIssue([])], '/data')[0]?.path).toBe('/data');
  });

  it('should drop an issue repeated at the same path', () => {
    const issues = [makeIssue(['name']), makeIssue(['name'])];

    expect(issueDetails(issues, '/data')).toHaveLength(1);
  });

  it('should cap the details at 50 with a too-many-errors detail at the end', () => {
    const issues = Array.from({ length: 60 }, (_, n) => makeIssue([n]));

    const result = issueDetails(issues, '/data');

    expect(result).toHaveLength(51);
    expect(result.at(-1)).toEqual({
      path: '',
      code: 'too-many-errors',
      message: '10 more errors omitted',
    });
  });
});
