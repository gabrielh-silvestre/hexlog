import { describe, expect, it } from '@jest/globals';
import type { z } from 'zod';
import type { RecordId } from '../src/domain/ids.ts';
import {
  domainError,
  fromDetails,
  fromIssues,
  HexlogError,
  internalError,
  invalidArgs,
  invalidInput,
  invalidRecord,
  issueDetails,
  legacyDataError,
  mapDetails,
  reservedName,
  brokenChain,
  withPath,
  type Detail,
} from '../src/errors.ts';

const issue = (path: PropertyKey[], message: string): z.core.$ZodIssue => ({
  code: 'custom',
  path,
  message,
});

describe('domainError', () => {
  it('builds one detail that repeats the error message', () => {
    const error = domainError('TYPE_NOT_FOUND', '/type', 'unknown-type', 'type not found');

    expect(error).toBeInstanceOf(HexlogError);
    expect(error.code).toBe('TYPE_NOT_FOUND');
    expect(error.message).toBe('type not found');
    expect(error.details).toStrictEqual([
      { path: '/type', code: 'unknown-type', message: 'type not found' },
    ]);
  });

  it('keeps the detail keys in the order path, code, message, then the extras as passed', () => {
    const error = domainError('LOCK_TIMEOUT', '/process', 'lock-busy', 'lock is busy', {
      pid: 42,
      process: 'p1',
    });

    expect(Object.keys(error.details[0]!)).toStrictEqual([
      'path',
      'code',
      'message',
      'pid',
      'process',
    ]);
    expect(error.details[0]).toStrictEqual({
      path: '/process',
      code: 'lock-busy',
      message: 'lock is busy',
      pid: 42,
      process: 'p1',
    });
  });

  it('omits an extra whose value is undefined', () => {
    const error = domainError('LOCK_TIMEOUT', '/process', 'lock-busy', 'lock is busy', {
      pid: undefined,
      process: undefined,
    });

    expect(error.details[0]).toStrictEqual({
      path: '/process',
      code: 'lock-busy',
      message: 'lock is busy',
    });
    expect(Object.hasOwn(error.details[0]!, 'pid')).toBe(false);
    expect(Object.hasOwn(error.details[0]!, 'process')).toBe(false);
  });

  it('keeps an extra whose value is null', () => {
    const error = domainError('FORK_REJECTED', '/records/0', 'not-current', 'not current', {
      current: null,
    });

    expect(error.details[0]).toStrictEqual({
      path: '/records/0',
      code: 'not-current',
      message: 'not current',
      current: null,
    });
  });

  it('carries current, versions and process when given', () => {
    const current = 'p:0190a0a0-0000-7000-8000-000000000000' as RecordId;
    const error = domainError('BREAKING_CHANGE', '/type', 'breaking', 'breaking change', {
      current,
      versions: ['1.0', '1.1'],
      process: 'p',
    });

    expect(error.details[0]).toStrictEqual({
      path: '/type',
      code: 'breaking',
      message: 'breaking change',
      current,
      versions: ['1.0', '1.1'],
      process: 'p',
    });
  });
});

describe('internalError', () => {
  it('is INTERNAL with the message and an empty details array', () => {
    const error = internalError('boom');

    expect(error).toBeInstanceOf(HexlogError);
    expect(error.code).toBe('INTERNAL');
    expect(error.message).toBe('boom');
    expect(error.details).toStrictEqual([]);
  });
});

describe('factories that already existed', () => {
  it('invalidInput is INVALID_INPUT with one detail at the path', () => {
    const error = invalidInput('/x', 'too-long', 'x is too long');

    expect(error.code).toBe('INVALID_INPUT');
    expect(error.message).toBe('x is too long');
    expect(error.details).toStrictEqual([
      { path: '/x', code: 'too-long', message: 'x is too long' },
    ]);
  });

  it('brokenChain names the process in details[0]', () => {
    const error = brokenChain('p1');

    expect(error.code).toBe('PROCESS_CORRUPTED');
    expect(error.message).toBe('process chain is broken');
    expect(error.details).toStrictEqual([
      { path: '/process', code: 'broken-chain', message: 'process chain is broken', process: 'p1' },
    ]);
  });

  it('reservedName is RESERVED_NAME at /process', () => {
    const error = reservedName();

    expect(error.code).toBe('RESERVED_NAME');
    expect(error.message).toBe('reserved process name');
    expect(error.details).toStrictEqual([
      { path: '/process', code: 'reserved-name', message: 'reserved process name' },
    ]);
  });

  it('legacyDataError points at the archive command with an empty path', () => {
    const error = legacyDataError();

    expect(error.code).toBe('LEGACY_DATA');
    expect(error.message).toBe('legacy 0.x data found; archive it first');
    expect(error.details).toStrictEqual([
      {
        path: '',
        code: 'run',
        message: 'node scripts/install.ts --archive-0x (from the hexlog repository)',
      },
    ]);
  });
});

describe('issueDetails', () => {
  it('prefixes the JSON Pointer of each issue path', () => {
    expect(issueDetails([issue(['a', 0, 'b/c'], 'bad')], '/data')).toStrictEqual([
      { path: '/data/a/0/b~1c', code: 'custom', message: 'bad' },
    ]);
  });

  it('drops repeated path, code and message', () => {
    const repeated = issue(['a'], 'bad');

    expect(issueDetails([repeated, repeated], '')).toHaveLength(1);
  });

  it('cuts at 50 details and reports how many were left out in the last one', () => {
    const issues = Array.from({ length: 53 }, (_, i) => issue([i], 'bad'));

    const details = issueDetails(issues, '');

    expect(details).toHaveLength(51);
    expect(details[49]).toStrictEqual({ path: '/49', code: 'custom', message: 'bad' });
    expect(details[50]).toStrictEqual({
      path: '',
      code: 'too-many-errors',
      message: '3 more errors omitted',
    });
  });

  it('does not cut at exactly 50 details', () => {
    const issues = Array.from({ length: 50 }, (_, i) => issue([i], 'bad'));

    expect(issueDetails(issues, '')).toHaveLength(50);
  });
});

describe('fromIssues', () => {
  it('uses the given message and the issueDetails of the issues', () => {
    const error = fromIssues(
      'INVALID_SCHEMA',
      'schema is wrong',
      [issue(['type'], 'bad')],
      '/schema',
    );

    expect(error.code).toBe('INVALID_SCHEMA');
    expect(error.message).toBe('schema is wrong');
    expect(error.details).toStrictEqual([{ path: '/schema/type', code: 'custom', message: 'bad' }]);
  });
});

describe('fromDetails', () => {
  const details: Detail[] = [
    { path: '/type', code: 'a', message: 'ma' },
    { path: '', code: 'b', message: 'mb' },
  ];

  it('prefixes the path of each detail and keeps the other keys', () => {
    const error = fromDetails('INVALID_SCHEMA', 'schema is not valid', details, '/schema');

    expect(error.code).toBe('INVALID_SCHEMA');
    expect(error.message).toBe('schema is not valid');
    expect(error.details).toStrictEqual([
      { path: '/schema/type', code: 'a', message: 'ma' },
      { path: '/schema', code: 'b', message: 'mb' },
    ]);
  });

  it('leaves the paths as they are when no prefix is given', () => {
    expect(fromDetails('INVALID_SCHEMA', 'm', details).details).toStrictEqual(details);
  });

  it('does not mutate the details it received', () => {
    fromDetails('INVALID_SCHEMA', 'm', details, '/schema');

    expect(details[0]!.path).toBe('/type');
  });
});

describe('invalidArgs', () => {
  it('is INVALID_INPUT with the fixed message and the details given', () => {
    const details: Detail[] = [{ path: '/q', code: 'x', message: 'mx' }];

    const error = invalidArgs(details);

    expect(error.code).toBe('INVALID_INPUT');
    expect(error.message).toBe('invalid input');
    expect(error.details).toStrictEqual(details);
  });
});

describe('invalidRecord', () => {
  it('is INVALID_RECORD with the fixed message and the details given', () => {
    const details: Detail[] = [{ path: '/records/0', code: 'x', message: 'mx' }];

    const error = invalidRecord(details);

    expect(error.code).toBe('INVALID_RECORD');
    expect(error.message).toBe('record violates a type or relation rule');
    expect(error.details).toStrictEqual(details);
  });
});

describe('mapDetails', () => {
  it('keeps code and message and maps every detail', () => {
    const source = domainError('PROCESS_NOT_FOUND', '/process', 'missing', 'process not found');

    const mapped = mapDetails(source, (detail) => ({ ...detail, path: '/other' }));

    expect(mapped).not.toBe(source);
    expect(mapped.code).toBe('PROCESS_NOT_FOUND');
    expect(mapped.message).toBe('process not found');
    expect(mapped.details).toStrictEqual([
      { path: '/other', code: 'missing', message: 'process not found' },
    ]);
    expect(source.details[0]!.path).toBe('/process');
  });
});

describe('withPath', () => {
  it('returns anything that is not a HexlogError untouched', () => {
    const plain = new Error('boom');

    expect(withPath(plain, '/records/0/x')).toBe(plain);
    expect(withPath('text', '/records/0/x')).toBe('text');
  });

  it('rewrites the path of every detail and adds no process key when it is undefined', () => {
    const source = domainError('ATTACHMENT_NOT_FOUND', '/hash', 'missing', 'attachment not found');

    const error = withPath(source, '/records/2/data/doc');

    expect(error).toBeInstanceOf(HexlogError);
    expect((error as HexlogError).code).toBe('ATTACHMENT_NOT_FOUND');
    expect((error as HexlogError).message).toBe('attachment not found');
    expect((error as HexlogError).details).toStrictEqual([
      { path: '/records/2/data/doc', code: 'missing', message: 'attachment not found' },
    ]);
  });

  it('names the process after the path when one is given', () => {
    const source = domainError('ATTACHMENT_NOT_FOUND', '/hash', 'missing', 'attachment not found');

    const error = withPath(source, '/records/2/data/doc', 'p2') as HexlogError;

    expect(Object.keys(error.details[0]!)).toStrictEqual(['path', 'code', 'message', 'process']);
    expect(error.details[0]!.process).toBe('p2');
  });

  it('turns an error without details into one without details', () => {
    const error = withPath(internalError('boom'), '/records/0', 'p') as HexlogError;

    expect(error.code).toBe('INTERNAL');
    expect(error.details).toStrictEqual([]);
  });
});
