import { describe, test, expect, jest } from '@jest/globals';
import { CLIENT_INFO_META_KEY } from '@modelcontextprotocol/server';
import { z } from 'zod';
import { HexlogError } from '../../src/errors.ts';
import { PAGE_CHARS_CAP } from '../../src/queries/query-service.ts';
import {
  advertise,
  type CallContext,
  execute,
  toHexlogError,
  type ToolDeps,
} from '../../src/mcp/kernel.ts';
import { errorBodyOf } from './environment.ts';

const Input = z.strictObject({ project: z.string().min(1), count: z.number().int() });

const ARCHIVE_COMMAND = 'node scripts/install.ts --archive-0x (from the hexlog repository)';

function makeDeps(isLegacy = false) {
  const logger = jest.fn<ToolDeps['logger']>();
  const deps: ToolDeps = {
    services: {} as ToolDeps['services'],
    isLegacy: () => isLegacy,
    logger,
  };
  return { deps, logger };
}

const ctxOf = (envelope?: Record<string, unknown>): CallContext => ({ mcpReq: { envelope } });

const callOf = (args: unknown, ctx = ctxOf()) => ({ name: 'demo', schema: Input, args, ctx });

describe('execute', () => {
  test('devolve o resultado como structuredContent e como texto JSON', async () => {
    const { deps } = makeDeps();

    const result = await execute(deps, callOf({ project: 'p', count: 2 }), (input) => ({
      doubled: input.count * 2,
    }));

    expect(result).toEqual({
      structuredContent: { doubled: 4 },
      content: [{ type: 'text', text: '{"doubled":4}' }],
    });
  });

  test('registra um log tool com name e ms, sem o conteúdo da entrada', async () => {
    const { deps, logger } = makeDeps();

    await execute(deps, callOf({ project: 'segredo', count: 1 }), () => ({}));

    expect(logger).toHaveBeenCalledWith(
      expect.objectContaining({
        level: 'info',
        event: 'tool',
        name: 'demo',
        ms: expect.any(Number),
      }),
    );
    expect(JSON.stringify(logger.mock.calls)).not.toContain('segredo');
  });

  test('entrada fora do schema vira INVALID_INPUT com details[].path, nunca "Input validation error"', async () => {
    const { deps } = makeDeps();
    const run = jest.fn(() => ({}));

    const result = await execute(deps, callOf({ project: '', count: 'x', extra: 1 }), run);

    expect(run).not.toHaveBeenCalled();
    expect(errorBodyOf(result)).toMatchObject({
      code: 'INVALID_INPUT',
      details: expect.arrayContaining([
        expect.objectContaining({ path: '/project', code: 'too_small' }),
        expect.objectContaining({ path: '/count', code: 'invalid_type' }),
      ]),
    });
    expect(JSON.stringify(result)).not.toContain('Input validation error');
  });

  test('chave própria __proto__ em qualquer nível vira INVALID_INPUT reserved-key, sem chamar run', async () => {
    const { deps } = makeDeps();
    const run = jest.fn(() => ({}));
    const args: unknown = JSON.parse('{"project":"p","count":1,"deep":[{"a/b":{"__proto__":1}}]}');

    const result = await execute(deps, callOf(args), run);

    expect(run).not.toHaveBeenCalled();
    expect(errorBodyOf(result)).toMatchObject({
      code: 'INVALID_INPUT',
      details: [{ path: '/deep/0/a~1b/__proto__', code: 'reserved-key' }],
    });
  });

  describe('profundidade dos args crus', () => {
    const Anything = z.looseObject({});
    // `nest(n)` tem n objetos aninhados, contando a raiz dos args como o nível 1.
    const nest = (levels: number): Record<string, unknown> =>
      Array.from({ length: levels - 1 }).reduce<Record<string, unknown>>(
        (inner) => ({ a: inner }),
        {},
      );
    const callWith = (args: unknown) => ({ name: 'demo', schema: Anything, args, ctx: ctxOf() });

    test('64 níveis passam e chegam ao run', async () => {
      const { deps } = makeDeps();
      const run = jest.fn(() => ({}));

      await execute(deps, callWith(nest(64)), run);

      expect(run).toHaveBeenCalledTimes(1);
    });

    test('65 níveis viram INVALID_INPUT too-deep no nó do nível 65, sem chamar run', async () => {
      const { deps } = makeDeps();
      const run = jest.fn(() => ({}));

      const result = await execute(deps, callWith(nest(65)), run);

      expect(run).not.toHaveBeenCalled();
      expect(errorBodyOf(result)).toMatchObject({
        code: 'INVALID_INPUT',
        details: [{ path: `/${Array(64).fill('a').join('/')}`, code: 'too-deep' }],
      });
    });

    test('array também conta como nível', async () => {
      const { deps } = makeDeps();
      const args = { a: Array.from({ length: 63 }).reduce<unknown>((inner) => [inner], {}) };

      const result = await execute(deps, callWith(args), () => ({}));

      expect(errorBodyOf(result)).toMatchObject({ details: [{ code: 'too-deep' }] });
    });

    test('2.000 níveis dão um só detalhe e nunca INTERNAL', async () => {
      const { deps } = makeDeps();

      const result = await execute(deps, callWith(nest(2000)), () => ({}));

      const body = errorBodyOf(result);
      expect(body.code).toBe('INVALID_INPUT');
      expect(body.details).toHaveLength(1);
    });
  });

  describe('resposta acima do dobro de PAGE_CHARS_CAP', () => {
    const OVER_CAP = 2 * PAGE_CHARS_CAP;

    // `{"t":""}` tem 8 caracteres, então `chars - 8` letras dão um texto de `chars`.
    const resultOf = (chars: number) => ({ t: 'x'.repeat(chars - 8) });

    test('emite o warn tool-over-cap com name e chars, sem a entrada, e não corta a resposta', async () => {
      const { deps, logger } = makeDeps();

      const full = resultOf(OVER_CAP + 1);

      const result = await execute(deps, callOf({ project: 'segredo', count: 1 }), () => full);

      expect(logger).toHaveBeenCalledWith({
        level: 'warn',
        event: 'tool-over-cap',
        name: 'demo',
        chars: OVER_CAP + 1,
      });
      expect(JSON.stringify(logger.mock.calls)).not.toContain('segredo');
      expect(result).toEqual({
        structuredContent: full,
        content: [{ type: 'text', text: JSON.stringify(full) }],
      });
    });

    test('no teto não emite', async () => {
      const { deps, logger } = makeDeps();

      await execute(deps, callOf({ project: 'p', count: 1 }), () => resultOf(OVER_CAP));

      expect(logger).not.toHaveBeenCalledWith(expect.objectContaining({ event: 'tool-over-cap' }));
    });
  });

  test('args ausente é tratado como objeto vazio', async () => {
    const { deps } = makeDeps();

    const result = await execute(deps, callOf(undefined), () => ({}));

    expect(errorBodyOf(result)).toMatchObject({ code: 'INVALID_INPUT' });
  });

  test('HexlogError da operação sai como {code, message, details}', async () => {
    const { deps, logger } = makeDeps();
    const details = [{ path: '/project', code: 'unknown-name', message: 'no such project' }];

    const result = await execute(deps, callOf({ project: 'p', count: 1 }), () => {
      throw new HexlogError('PROJECT_NOT_FOUND', 'project not found', details);
    });

    expect(errorBodyOf(result)).toEqual({
      code: 'PROJECT_NOT_FOUND',
      message: 'project not found',
      details,
    });
    expect(logger).toHaveBeenCalledWith(
      expect.objectContaining({ level: 'error', event: 'tool', code: 'PROJECT_NOT_FOUND' }),
    );
  });

  test('logger que lança no sucesso não troca o resultado já produzido por INTERNAL', async () => {
    const { deps, logger } = makeDeps();
    logger.mockImplementation(() => {
      throw new Error('stderr closed');
    });

    const result = await execute(deps, callOf({ project: 'p', count: 2 }), (input) => ({
      doubled: input.count * 2,
    }));

    expect(result).toEqual({
      structuredContent: { doubled: 4 },
      content: [{ type: 'text', text: '{"doubled":4}' }],
    });
  });

  test('logger que lança no erro não escapa de execute', async () => {
    const { deps, logger } = makeDeps();
    logger.mockImplementation(() => {
      throw new Error('stderr closed');
    });

    const result = await execute(deps, callOf({ project: 'p', count: 1 }), () => {
      throw new HexlogError('PROJECT_NOT_FOUND', 'project not found');
    });

    expect(errorBodyOf(result)).toMatchObject({ code: 'PROJECT_NOT_FOUND' });
  });

  test('logger que lança ao registrar a exceção ainda devolve INTERNAL', async () => {
    const { deps, logger } = makeDeps();
    logger.mockImplementation(() => {
      throw new Error('stderr closed');
    });

    const result = await execute(deps, callOf({ project: 'p', count: 1 }), () =>
      Promise.reject(new TypeError('boom')),
    );

    expect(errorBodyOf(result)).toMatchObject({ code: 'INTERNAL' });
  });

  test('exceção qualquer vira INTERNAL sem stack na resposta; a stack vai só para o log', async () => {
    const { deps, logger } = makeDeps();

    const result = await execute(deps, callOf({ project: 'p', count: 1 }), () =>
      Promise.reject(new TypeError('boom')),
    );

    expect(errorBodyOf(result)).toEqual({
      code: 'INTERNAL',
      message: 'internal error',
      details: [],
    });
    expect(JSON.stringify(result)).not.toMatch(/boom|at .*kernel/);
    expect(logger).toHaveBeenCalledWith(
      expect.objectContaining({
        event: 'internal-error',
        stack: expect.stringContaining('boom'),
      }),
    );
  });
});

describe('LEGACY_DATA', () => {
  test('responde antes de validar a entrada e antes de qualquer serviço', async () => {
    const { deps } = makeDeps(true);
    const run = jest.fn(() => ({}));

    const result = await execute(deps, callOf({ lixo: true }), run);

    expect(run).not.toHaveBeenCalled();
    expect(errorBodyOf(result)).toMatchObject({
      code: 'LEGACY_DATA',
      details: [{ path: '', code: 'run', message: ARCHIVE_COMMAND }],
    });
  });

  test('exceção do próprio isLegacy vira INTERNAL, não escapa para o SDK', async () => {
    const { deps } = makeDeps();
    const broken: ToolDeps = {
      ...deps,
      isLegacy: () => {
        throw new Error('readdir failed');
      },
    };

    const result = await execute(broken, callOf({ project: 'p', count: 1 }), () => ({}));

    expect(errorBodyOf(result)).toMatchObject({ code: 'INTERNAL' });
  });
});

describe('client', () => {
  const envelopeOf = (clientInfo: unknown) => ctxOf({ [CLIENT_INFO_META_KEY]: clientInfo });
  const clientOf = (ctx: CallContext) =>
    execute(makeDeps().deps, callOf({ project: 'p', count: 1 }, ctx), (_input, client) => ({
      client,
    }));

  test('D-21: client vem de clientInfo.name do envelope', async () => {
    const result = await clientOf(envelopeOf({ name: 'claude-code', version: '2' }));

    expect(result).toMatchObject({ structuredContent: { client: 'claude-code' } });
  });

  test.each([
    ['sem envelope', ctxOf()],
    ['envelope sem clientInfo', ctxOf({})],
    ['clientInfo sem name', envelopeOf({ version: '1' })],
    ['name vazio', envelopeOf({ name: '' })],
    ['name acima de 100 caracteres', envelopeOf({ name: 'x'.repeat(101) })],
    ['name com surrogate solto', envelopeOf({ name: 'cl\ud800' })],
  ])('client é "unknown" %s', async (_title, ctx) => {
    const result = await clientOf(ctx);

    expect(result).toMatchObject({ structuredContent: { client: 'unknown' } });
  });
});

describe('toHexlogError', () => {
  test('HexlogError passa intacto e não loga', () => {
    const { logger } = makeDeps();
    const error = new HexlogError('IO_ERROR', 'disk', [{ path: '', code: 'enospc', message: 'x' }]);

    expect(toHexlogError(error, logger)).toBe(error);
    expect(logger).not.toHaveBeenCalled();
  });

  test('valor que não é Error vira INTERNAL e entra no log como texto', () => {
    const { logger } = makeDeps();

    const error = toHexlogError('algo', logger);

    expect(error).toMatchObject({ code: 'INTERNAL', message: 'internal error', details: [] });
    expect(logger).toHaveBeenCalledWith({ level: 'error', event: 'internal-error', stack: 'algo' });
  });

  test('logger que lança não impede o INTERNAL', () => {
    const { logger } = makeDeps();
    logger.mockImplementation(() => {
      throw new Error('stderr closed');
    });

    expect(toHexlogError('algo', logger)).toMatchObject({ code: 'INTERNAL' });
  });
});

describe('advertise', () => {
  test('anuncia o JSON Schema do zod', () => {
    const standard = advertise(Input)['~standard'];

    expect(standard.jsonSchema.input({ target: 'draft-2020-12' })).toMatchObject({
      type: 'object',
      properties: { project: { type: 'string' }, count: { type: 'integer' } },
      required: ['project', 'count'],
    });
  });

  test('validate deixa a entrada crua passar, mesmo inválida', async () => {
    const raw = { project: 1, lixo: true };

    const result = await advertise(Input)['~standard'].validate(raw);

    expect(result).toEqual({ value: raw });
  });
});
