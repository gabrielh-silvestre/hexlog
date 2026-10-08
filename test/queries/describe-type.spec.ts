import { describe, expect, test } from '@jest/globals';
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
  const describe = (input: { type: string; process?: string; version?: string }) =>
    setup.queries.describeType({ project: PROJECT, ...input });
  return { ...setup, describe };
}

describe('describeType', () => {
  test('com process devolve o tipo fixado, sem version, mesmo depois de o projeto definir versão nova', () => {
    const { describe } = describeSetup();

    const result = describe({ type: 'note', process: 'run-1' });

    expect(result).toEqual({ name: 'note', schema: NOTE });
    expect(result).not.toHaveProperty('version');
  });

  test('sem process devolve a versão vigente do projeto, com version', () => {
    const { describe } = describeSetup();

    expect(describe({ type: 'note' })).toEqual({ name: 'note', version: '1.1', schema: NOTE_V2 });
  });

  test('com version devolve a versão pedida', () => {
    const { describe } = describeSetup();

    expect(describe({ type: 'note', version: '1.0' })).toEqual({
      name: 'note',
      version: '1.0',
      schema: NOTE,
    });
  });

  describe('tipo legado com pattern e patternProperties', () => {
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

    test('com process omite as duas palavras-chave e mantém o campo de nome pattern', () => {
      const { describe } = legacySetup();

      expect(describe({ type: 'legacy', process: 'run-legacy' })).toEqual({
        name: 'legacy',
        schema: SHOWN,
      });
    });

    test('sem process omite as duas palavras-chave da definição lida do projeto', () => {
      const { describe, definitions } = legacySetup();

      expect(describe({ type: 'legacy' })).toEqual({
        name: 'legacy',
        version: '1.0',
        schema: SHOWN,
      });
      expect(definitions.read(PROJECT, 'types', 'legacy', '1.0')).toEqual(LEGACY);
    });

    test('a cadeia do processo segue íntegra depois do describe', () => {
      const { describe, queries } = legacySetup();

      describe({ type: 'legacy', process: 'run-legacy' });

      expect(queries.verifyChain({ project: PROJECT, process: 'run-legacy' })).toMatchObject({
        ok: true,
        breaks: [],
      });
    });
  });

  test('tipo ausente do projeto é TYPE_NOT_FOUND em /type, com ou sem version', () => {
    const { describe } = describeSetup();

    for (const version of [undefined, '1.0']) {
      const error = captureError(() => describe({ type: 'ghost', version }));
      expect(error.code).toBe('TYPE_NOT_FOUND');
      expect(error.details).toEqual([
        { path: '/type', code: 'unknown-name', message: expect.any(String) },
      ]);
    }
  });

  test('projeto inexistente é PROJECT_NOT_FOUND em /project, com ou sem version', () => {
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

  test('projeto inexistente com process segue PROCESS_NOT_FOUND', () => {
    const { queries } = describeSetup();

    const error = captureError(() =>
      queries.describeType({ project: 'ghost-project', type: 'note', process: 'run-1' }),
    );

    expect(error.code).toBe('PROCESS_NOT_FOUND');
  });

  test('versão ausente é TYPE_NOT_FOUND em /version, com as versões que existem', () => {
    const { describe } = describeSetup();

    const error = captureError(() => describe({ type: 'note', version: '9.0' }));

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

  test('tipo do projeto que o processo não fixou é TYPE_NOT_PINNED em /type', () => {
    const { definitions, describe } = describeSetup();
    definitions.write(PROJECT, 'types', 'later', '1.0', NOTE);

    const error = captureError(() => describe({ type: 'later', process: 'run-1' }));

    expect(error.code).toBe('TYPE_NOT_PINNED');
    expect(error.details).toEqual([
      { path: '/type', code: 'not-pinned', message: expect.any(String) },
    ]);
  });

  test('processo inexistente é PROCESS_NOT_FOUND', () => {
    const { describe } = describeSetup();

    expect(captureError(() => describe({ type: 'note', process: 'ghost' })).code).toBe(
      'PROCESS_NOT_FOUND',
    );
  });

  test('process e version juntos são INVALID_INPUT em /version, antes de qualquer leitura', () => {
    const { describe } = describeSetup();

    const error = captureError(() => describe({ type: 'ghost', process: 'ghost', version: '1.0' }));

    expect(error.code).toBe('INVALID_INPUT');
    expect(error.details).toEqual([
      { path: '/version', code: 'process-with-version', message: expect.any(String) },
    ]);
  });
});
