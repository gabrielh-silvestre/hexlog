import { describe, expect, it } from '@jest/globals';
import type { RecordType } from '../../src/domain/definitions.ts';
import { NOTE } from '../commands/register-fakes.ts';
import { captureError } from '../helpers.ts';
import { PROJECT, querySetup } from './query-setup.ts';

const NOTE_V2: RecordType = {
  type: 'object',
  properties: { text: { type: 'string' }, tag: { type: 'string' } },
  required: ['text'],
  additionalProperties: false,
};

function describeSetup() {
  const setup = querySetup();
  setup.createProcess('run-1');
  setup.definitions.write(PROJECT, 'types', 'note', '1.1', NOTE_V2);
  const readType = (input: { type: string; process?: string; version?: string }) =>
    setup.queries.describeType({ project: PROJECT, ...input });
  return { ...setup, readType };
}

describe('QueryService.describeType', () => {
  it('should return the pinned type with process, without version, even after the project defines a new version', () => {
    const { readType } = describeSetup();

    const result = readType({ type: 'note', process: 'run-1' });

    expect(result).toEqual({ name: 'note', schema: NOTE });
    expect(result).not.toHaveProperty('version');
  });

  it('should return the current version of the project, with version, without process', () => {
    const { readType } = describeSetup();

    expect(readType({ type: 'note' })).toEqual({ name: 'note', version: '1.1', schema: NOTE_V2 });
  });

  it('should return the requested version with version', () => {
    const { readType } = describeSetup();

    expect(readType({ type: 'note', version: '1.0' })).toEqual({
      name: 'note',
      version: '1.0',
      schema: NOTE,
    });
  });

  describe('with a legacy type that has pattern and patternProperties', () => {
    const LEGACY: RecordType = {
      type: 'object',
      properties: {
        code: { type: 'string', pattern: '^[a-z]+$', maxLength: 10 },
        pattern: { type: 'string' },
      },
      patternProperties: { '^x-': { type: 'string' } },
    };
    const SHOWN: RecordType = {
      type: 'object',
      properties: { code: { type: 'string', maxLength: 10 }, pattern: { type: 'string' } },
    };

    function legacySetup() {
      const setup = describeSetup();
      setup.definitions.write(PROJECT, 'types', 'legacy', '1.0', LEGACY);
      setup.createProcess('run-legacy');
      return setup;
    }

    it('should omit both keywords and keep the field named pattern, with process', () => {
      const { readType } = legacySetup();

      expect(readType({ type: 'legacy', process: 'run-legacy' })).toEqual({
        name: 'legacy',
        schema: SHOWN,
      });
    });

    it('should omit both keywords of the definition read from the project, without process', () => {
      const { readType, definitions } = legacySetup();

      expect(readType({ type: 'legacy' })).toEqual({
        name: 'legacy',
        version: '1.0',
        schema: SHOWN,
      });
      expect(definitions.read(PROJECT, 'types', 'legacy', '1.0')).toEqual(LEGACY);
    });

    it('should omit the pattern of a contentSchema', () => {
      const setup = describeSetup();
      setup.definitions.write(PROJECT, 'types', 'content', '1.0', {
        type: 'string',
        contentMediaType: 'application/json',
        contentSchema: { type: 'string', pattern: '^a+$' },
      });

      expect(setup.readType({ type: 'content' }).schema).toEqual({
        type: 'string',
        contentMediaType: 'application/json',
        contentSchema: { type: 'string' },
      });
    });

    it('should keep the chain of the process intact after the describe', () => {
      const { readType, queries } = legacySetup();

      readType({ type: 'legacy', process: 'run-legacy' });

      expect(queries.verifyChain({ project: PROJECT, process: 'run-legacy' })).toMatchObject({
        ok: true,
        breaks: [],
      });
    });
  });

  it('should refuse a type missing from the project with TYPE_NOT_FOUND at /type, with or without version', () => {
    const { readType } = describeSetup();

    for (const version of [undefined, '1.0']) {
      const error = captureError(() => readType({ type: 'ghost', version }));

      expect(error.code).toBe('TYPE_NOT_FOUND');
      expect(error.details).toEqual([
        { path: '/type', code: 'unknown-name', message: expect.any(String) },
      ]);
    }
  });

  it('should refuse a missing project with PROJECT_NOT_FOUND at /project, with or without version', () => {
    const { queries } = describeSetup();

    for (const version of [undefined, '1.0']) {
      const error = captureError(() =>
        queries.describeType({ project: 'ghost-project', type: 'note', version }),
      );

      expect(error.code).toBe('PROJECT_NOT_FOUND');
      expect(error.details).toEqual([
        { path: '/project', code: 'unknown-project', message: expect.any(String) },
      ]);
    }
  });

  it('should keep PROCESS_NOT_FOUND for a missing project with process', () => {
    const { queries } = describeSetup();

    const error = captureError(() =>
      queries.describeType({ project: 'ghost-project', type: 'note', process: 'run-1' }),
    );

    expect(error.code).toBe('PROCESS_NOT_FOUND');
  });

  it('should refuse a missing version with TYPE_NOT_FOUND at /version, listing the versions that exist', () => {
    const { readType } = describeSetup();

    const error = captureError(() => readType({ type: 'note', version: '9.0' }));

    expect(error.code).toBe('TYPE_NOT_FOUND');
    expect(error.details).toEqual([
      {
        path: '/version',
        code: 'unknown-version',
        message: expect.any(String),
        versions: ['1.0', '1.1'],
      },
    ]);
  });

  it('should refuse a project type that the process did not pin with TYPE_NOT_PINNED at /type', () => {
    const { definitions, readType } = describeSetup();
    definitions.write(PROJECT, 'types', 'later', '1.0', NOTE);

    const error = captureError(() => readType({ type: 'later', process: 'run-1' }));

    expect(error.code).toBe('TYPE_NOT_PINNED');
    expect(error.details).toEqual([
      { path: '/type', code: 'not-pinned', message: expect.any(String) },
    ]);
  });

  it('should refuse an unknown process with PROCESS_NOT_FOUND', () => {
    const { readType } = describeSetup();

    expect(captureError(() => readType({ type: 'note', process: 'ghost' })).code).toBe(
      'PROCESS_NOT_FOUND',
    );
  });

  it('should refuse process and version together with INVALID_INPUT at /version, before any read', () => {
    const { readType } = describeSetup();

    const error = captureError(() => readType({ type: 'ghost', process: 'ghost', version: '1.0' }));

    expect(error.code).toBe('INVALID_INPUT');
    expect(error.details).toEqual([
      { path: '/version', code: 'process-with-version', message: expect.any(String) },
    ]);
  });
});
