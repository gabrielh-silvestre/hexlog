import { describe, expect, it } from '@jest/globals';
import type { z } from 'zod';
import {
  HexlogError,
  brokenChain,
  capDetails,
  domainError,
  fromDetails,
  fromIssues,
  internalError,
  invalidArgs,
  invalidInput,
  invalidRecord,
  issueDetails,
  legacyDataError,
  mapDetails,
  pointer,
  reservedName,
  withPath,
  type Detail,
} from '../src/errors.ts';
import { ARCHIVE_COMMAND, at } from './helpers.ts';

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

describe('domainError', () => {
  it('should return a HexlogError with the given code and message', () => {
    const error = domainError('TYPE_NOT_FOUND', '/type', 'unknown-type', 'type not found');

    expect(error).toBeInstanceOf(HexlogError);
    expect(error.code).toBe('TYPE_NOT_FOUND');
    expect(error.message).toBe('type not found');
  });

  it('should describe the refusal in a single detail that repeats the message', () => {
    expect(
      domainError('TYPE_NOT_FOUND', '/type', 'unknown-type', 'type not found').details,
    ).toStrictEqual([{ path: '/type', code: 'unknown-type', message: 'type not found' }]);
  });

  it.each([
    { name: 'pid and process', extras: { pid: 42, process: 'p1' } },
    {
      name: 'current, versions and process',
      extras: {
        current: 'p:0190a0a0-0000-7000-8000-000000000000',
        versions: ['1.0', '1.1'],
        process: 'p',
      },
    },
  ])(
    'should append the extras $name after path, code and message, in the order passed',
    ({ extras }) => {
      const error = domainError('LOCK_TIMEOUT', '/process', 'lock-busy', 'lock is busy', extras);

      expect(Object.keys(at(error.details, 0))).toStrictEqual([
        'path',
        'code',
        'message',
        ...Object.keys(extras),
      ]);
      expect(error.details).toStrictEqual([
        { path: '/process', code: 'lock-busy', message: 'lock is busy', ...extras },
      ]);
    },
  );

  it('should omit an extra whose value is undefined', () => {
    const error = domainError('LOCK_TIMEOUT', '/process', 'lock-busy', 'lock is busy', {
      pid: undefined,
      process: undefined,
    });

    expect(error.details).toStrictEqual([
      { path: '/process', code: 'lock-busy', message: 'lock is busy' },
    ]);
  });

  it('should keep an extra whose value is null', () => {
    const error = domainError('FORK_REJECTED', '/records/0', 'not-current', 'not current', {
      current: null,
    });

    expect(error.details).toStrictEqual([
      { path: '/records/0', code: 'not-current', message: 'not current', current: null },
    ]);
  });
});

describe('fixed-code error factories', () => {
  const details: Detail[] = [{ path: '/q', code: 'x', message: 'mx' }];
  const factories: {
    name: string;
    build: () => HexlogError;
    code: string;
    message: string;
    details: Detail[];
  }[] = [
    {
      name: 'internalError',
      build: () => internalError('boom'),
      code: 'INTERNAL',
      message: 'boom',
      details: [],
    },
    {
      name: 'invalidInput',
      build: () => invalidInput('/limit', 'out-of-range', 'limit is out of range'),
      code: 'INVALID_INPUT',
      message: 'limit is out of range',
      details: [{ path: '/limit', code: 'out-of-range', message: 'limit is out of range' }],
    },
    {
      name: 'brokenChain',
      build: () => brokenChain('alpha'),
      code: 'PROCESS_CORRUPTED',
      message: 'process chain is broken',
      details: [
        {
          path: '/process',
          code: 'broken-chain',
          message: 'process chain is broken',
          process: 'alpha',
        },
      ],
    },
    {
      name: 'reservedName',
      build: () => reservedName(),
      code: 'RESERVED_NAME',
      message: 'reserved process name',
      details: [{ path: '/process', code: 'reserved-name', message: 'reserved process name' }],
    },
    {
      name: 'legacyDataError',
      build: () => legacyDataError(),
      code: 'LEGACY_DATA',
      message: 'legacy 0.x data found; archive it first',
      details: [{ path: '', code: 'run', message: ARCHIVE_COMMAND }],
    },
    {
      name: 'invalidArgs',
      build: () => invalidArgs(details),
      code: 'INVALID_INPUT',
      message: 'invalid input',
      details,
    },
    {
      name: 'invalidRecord',
      build: () => invalidRecord(details),
      code: 'INVALID_RECORD',
      message: 'record violates a type or relation rule',
      details,
    },
  ];

  it.each(factories)('should return a HexlogError with the code of $name', ({ build, code }) => {
    const error = build();

    expect(error).toBeInstanceOf(HexlogError);
    expect(error.code).toBe(code);
  });

  it.each(factories)('should give $name the fixed message', ({ build, message }) => {
    expect(build().message).toBe(message);
  });

  it.each(factories)(
    'should give $name the details it describes',
    ({ build, details: expected }) => {
      expect(build().details).toStrictEqual(expected);
    },
  );
});

describe('pointer', () => {
  it('should return an empty pointer for an empty path', () => {
    expect(pointer([])).toBe('');
  });

  it('should prefix every segment with a slash, numbers included', () => {
    expect(pointer(['records', 0, 'data'])).toBe('/records/0/data');
  });

  it.each([
    ['~', 'a~b~c', '/a~0b~0c'],
    ['/', 'a/b/c', '/a~1b~1c'],
  ])('should escape %s in every occurrence', (_character, segment, expected) => {
    expect(pointer([segment])).toBe(expected);
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
    expect(at(issueDetails([makeIssue(['a/b'])], '/data'), 0).path).toBe('/data/a~1b');
  });

  it('should use the prefix alone as the path of an issue at the root', () => {
    expect(at(issueDetails([makeIssue([])], '/data'), 0).path).toBe('/data');
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

describe('fromIssues', () => {
  it('should use the given code and message with the issueDetails of the issues under the prefix', () => {
    const error = fromIssues(
      'INVALID_SCHEMA',
      'schema is wrong',
      [makeIssue(['type'], 'bad')],
      '/schema',
    );

    expect(error.code).toBe('INVALID_SCHEMA');
    expect(error.message).toBe('schema is wrong');
    expect(error.details).toStrictEqual([{ path: '/schema/type', code: 'custom', message: 'bad' }]);
  });
});

describe('mapDetails', () => {
  const source = (): HexlogError =>
    new HexlogError('PROCESS_NOT_FOUND', 'process not found', [
      { path: '/process', code: 'missing', message: 'process not found' },
      { path: '/project', code: 'gone', message: 'project gone' },
    ]);
  const remap = (detail: Detail): Detail => ({ ...detail, path: `/mapped${detail.path}` });

  it('should return a new error with the same code and message', () => {
    const original = source();

    const mapped = mapDetails(original, remap);

    expect(mapped).not.toBe(original);
    expect(mapped.code).toBe('PROCESS_NOT_FOUND');
    expect(mapped.message).toBe('process not found');
  });

  it('should map every detail', () => {
    expect(mapDetails(source(), remap).details).toStrictEqual([
      { path: '/mapped/process', code: 'missing', message: 'process not found' },
      { path: '/mapped/project', code: 'gone', message: 'project gone' },
    ]);
  });

  it('should not mutate the details of the source error', () => {
    const original = source();

    mapDetails(original, remap);

    expect(original.details).toStrictEqual(source().details);
  });
});

describe('fromDetails', () => {
  const details: Detail[] = [
    { path: '/type', code: 'a', message: 'ma' },
    { path: '', code: 'b', message: 'mb' },
  ];

  it('should use the given code and message', () => {
    const error = fromDetails('INVALID_SCHEMA', 'schema is not valid', details, '/schema');

    expect(error.code).toBe('INVALID_SCHEMA');
    expect(error.message).toBe('schema is not valid');
  });

  it('should prefix the path of each detail and keep the other keys', () => {
    expect(fromDetails('INVALID_SCHEMA', 'm', details, '/schema').details).toStrictEqual([
      { path: '/schema/type', code: 'a', message: 'ma' },
      { path: '/schema', code: 'b', message: 'mb' },
    ]);
  });

  it('should leave the paths as they are without a prefix', () => {
    expect(fromDetails('INVALID_SCHEMA', 'm', details).details).toStrictEqual(details);
  });

  it('should not mutate the details it receives', () => {
    fromDetails('INVALID_SCHEMA', 'm', details, '/schema');

    expect(at(details, 0).path).toBe('/type');
  });
});

describe('withPath', () => {
  const source = (): HexlogError =>
    new HexlogError('ATTACHMENT_NOT_FOUND', 'attachment not found', [
      { path: '/hash', code: 'missing', message: 'attachment not found' },
      { path: '/other', code: 'gone', message: 'other gone' },
    ]);
  const rewritten = (path: string, process?: string): HexlogError =>
    withPath(source(), path, process) as HexlogError;

  it.each([new Error('boom'), 'text'])(
    'should return %p untouched when it is not a HexlogError',
    (value) => {
      expect(withPath(value, '/records/0/x')).toBe(value);
    },
  );

  it('should keep the code and the message', () => {
    const error = rewritten('/records/2/data/doc');

    expect(error).toBeInstanceOf(HexlogError);
    expect(error.code).toBe('ATTACHMENT_NOT_FOUND');
    expect(error.message).toBe('attachment not found');
  });

  it('should rewrite the path of every detail and add no process key when none is given', () => {
    expect(rewritten('/records/2/data/doc').details).toStrictEqual([
      { path: '/records/2/data/doc', code: 'missing', message: 'attachment not found' },
      { path: '/records/2/data/doc', code: 'gone', message: 'other gone' },
    ]);
  });

  it('should name the process after the path in every detail when one is given', () => {
    const { details } = rewritten('/records/2/data/doc', 'p2');

    expect(details.map((detail) => Object.keys(detail))).toStrictEqual([
      ['path', 'code', 'message', 'process'],
      ['path', 'code', 'message', 'process'],
    ]);
    expect(details.map((detail) => detail.process)).toStrictEqual(['p2', 'p2']);
  });

  it('should keep an error without details without details', () => {
    expect(
      (withPath(internalError('boom'), '/records/0', 'p') as HexlogError).details,
    ).toStrictEqual([]);
  });
});
