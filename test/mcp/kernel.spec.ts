import { describe, it, expect, jest } from '@jest/globals';
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
  it('should return the result as structuredContent and as JSON text', async () => {
    const { deps } = makeDeps();

    const result = await execute(deps, callOf({ project: 'p', count: 2 }), (input) => ({
      doubled: input.count * 2,
    }));

    expect(result).toEqual({
      structuredContent: { doubled: 4 },
      content: [{ type: 'text', text: '{"doubled":4}' }],
    });
  });

  it('should log a tool record with name and ms, without the input content', async () => {
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

  it('should turn input outside the schema into INVALID_INPUT with details[].path, never "Input validation error"', async () => {
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

  it('should turn an own __proto__ key at any level into INVALID_INPUT reserved-key, without calling run', async () => {
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

  describe('with deeply nested raw args', () => {
    const Anything = z.looseObject({});
    // `nest(n)` tem n objetos aninhados, contando a raiz dos args como o nível 1.
    const nest = (levels: number): Record<string, unknown> =>
      Array.from({ length: levels - 1 }).reduce<Record<string, unknown>>(
        (inner) => ({ a: inner }),
        {},
      );
    const callWith = (args: unknown) => ({ name: 'demo', schema: Anything, args, ctx: ctxOf() });

    it('should let 64 levels through to run', async () => {
      const { deps } = makeDeps();
      const run = jest.fn(() => ({}));

      await execute(deps, callWith(nest(64)), run);

      expect(run).toHaveBeenCalledTimes(1);
    });

    it('should turn 65 levels into INVALID_INPUT too-deep at the level 65 node, without calling run', async () => {
      const { deps } = makeDeps();
      const run = jest.fn(() => ({}));

      const result = await execute(deps, callWith(nest(65)), run);

      expect(run).not.toHaveBeenCalled();
      expect(errorBodyOf(result)).toMatchObject({
        code: 'INVALID_INPUT',
        details: [{ path: `/${Array(64).fill('a').join('/')}`, code: 'too-deep' }],
      });
    });

    it('should count an array as a level', async () => {
      const { deps } = makeDeps();
      const args = { a: Array.from({ length: 63 }).reduce<unknown>((inner) => [inner], {}) };

      const result = await execute(deps, callWith(args), () => ({}));

      expect(errorBodyOf(result)).toMatchObject({ details: [{ code: 'too-deep' }] });
    });

    it('should give a single detail and never INTERNAL for 2,000 levels', async () => {
      const { deps } = makeDeps();

      const result = await execute(deps, callWith(nest(2000)), () => ({}));

      const body = errorBodyOf(result);

      expect(body.code).toBe('INVALID_INPUT');
      expect(body.details).toHaveLength(1);
    });
  });

  describe('with a response size around twice PAGE_CHARS_CAP', () => {
    const OVER_CAP = 2 * PAGE_CHARS_CAP;

    // `{"t":""}` tem 8 caracteres, então `chars - 8` letras dão um texto de `chars`.
    const resultOf = (chars: number) => ({ t: 'x'.repeat(chars - 8) });

    it('should emit the tool-over-cap warn with name and chars, never the input', async () => {
      const { deps, logger } = makeDeps();
      const full = resultOf(OVER_CAP + 1);

      await execute(deps, callOf({ project: 'segredo', count: 1 }), () => full);

      expect(logger).toHaveBeenCalledWith({
        level: 'warn',
        event: 'tool-over-cap',
        name: 'demo',
        chars: OVER_CAP + 1,
      });
      expect(JSON.stringify(logger.mock.calls)).not.toContain('segredo');
    });

    it('should return the response uncut when it is over the cap', async () => {
      const { deps } = makeDeps();
      const full = resultOf(OVER_CAP + 1);

      const result = await execute(deps, callOf({ project: 'p', count: 1 }), () => full);

      expect(result).toEqual({
        structuredContent: full,
        content: [{ type: 'text', text: JSON.stringify(full) }],
      });
    });

    it('should not emit the warn when the response is exactly at the cap', async () => {
      const { deps, logger } = makeDeps();

      await execute(deps, callOf({ project: 'p', count: 1 }), () => resultOf(OVER_CAP));

      expect(logger).not.toHaveBeenCalledWith(expect.objectContaining({ event: 'tool-over-cap' }));
    });
  });

  it('should treat missing args as an empty object', async () => {
    const { deps } = makeDeps();

    const result = await execute(deps, callOf(undefined), () => ({}));

    expect(errorBodyOf(result)).toMatchObject({ code: 'INVALID_INPUT' });
  });

  it('should return a HexlogError thrown by the operation as {code, message, details}', async () => {
    const { deps } = makeDeps();
    const details = [{ path: '/project', code: 'unknown-name', message: 'no such project' }];

    const result = await execute(deps, callOf({ project: 'p', count: 1 }), () => {
      throw new HexlogError('PROJECT_NOT_FOUND', 'project not found', details);
    });

    expect(errorBodyOf(result)).toEqual({
      code: 'PROJECT_NOT_FOUND',
      message: 'project not found',
      details,
    });
  });

  it('should log a HexlogError thrown by the operation at error level with its code', async () => {
    const { deps, logger } = makeDeps();

    await execute(deps, callOf({ project: 'p', count: 1 }), () => {
      throw new HexlogError('PROJECT_NOT_FOUND', 'project not found');
    });

    expect(logger).toHaveBeenCalledWith(
      expect.objectContaining({ level: 'error', event: 'tool', code: 'PROJECT_NOT_FOUND' }),
    );
  });

  it('should keep the result already produced when the logger throws on success', async () => {
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

  it('should not let a throwing logger escape execute on an error', async () => {
    const { deps, logger } = makeDeps();
    logger.mockImplementation(() => {
      throw new Error('stderr closed');
    });

    const result = await execute(deps, callOf({ project: 'p', count: 1 }), () => {
      throw new HexlogError('PROJECT_NOT_FOUND', 'project not found');
    });

    expect(errorBodyOf(result)).toMatchObject({ code: 'PROJECT_NOT_FOUND' });
  });

  it('should still return INTERNAL when the logger throws while recording the exception', async () => {
    const { deps, logger } = makeDeps();
    logger.mockImplementation(() => {
      throw new Error('stderr closed');
    });

    const result = await execute(deps, callOf({ project: 'p', count: 1 }), () =>
      Promise.reject(new TypeError('boom')),
    );

    expect(errorBodyOf(result)).toMatchObject({ code: 'INTERNAL' });
  });

  it('should turn any exception into INTERNAL, keeping the stack only in the log', async () => {
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

  it('should answer LEGACY_DATA before validating the input or reaching any service', async () => {
    const { deps } = makeDeps(true);
    const run = jest.fn(() => ({}));

    const result = await execute(deps, callOf({ lixo: true }), run);

    expect(run).not.toHaveBeenCalled();
    expect(errorBodyOf(result)).toMatchObject({
      code: 'LEGACY_DATA',
      details: [{ path: '', code: 'run', message: ARCHIVE_COMMAND }],
    });
  });

  it('should turn an exception from isLegacy into INTERNAL instead of letting it reach the SDK', async () => {
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

  describe('with the client info in the envelope', () => {
    const envelopeOf = (clientInfo: unknown) => ctxOf({ [CLIENT_INFO_META_KEY]: clientInfo });
    const clientOf = (ctx: CallContext) =>
      execute(makeDeps().deps, callOf({ project: 'p', count: 1 }, ctx), (_input, client) => ({
        client,
      }));

    it('should take the client from clientInfo.name of the envelope', async () => {
      const ctx = envelopeOf({ name: 'claude-code', version: '2' });

      const result = await clientOf(ctx);

      expect(result).toMatchObject({ structuredContent: { client: 'claude-code' } });
    });

    it.each([
      { scenario: 'no envelope', ctx: ctxOf() },
      { scenario: 'an envelope without clientInfo', ctx: ctxOf({}) },
      { scenario: 'a clientInfo without name', ctx: envelopeOf({ version: '1' }) },
      { scenario: 'an empty name', ctx: envelopeOf({ name: '' }) },
      { scenario: 'a name over 100 characters', ctx: envelopeOf({ name: 'x'.repeat(101) }) },
      { scenario: 'a name with a lone surrogate', ctx: envelopeOf({ name: 'cl\ud800' }) },
    ])('should report the client as "unknown" for $scenario', async ({ ctx }) => {
      const result = await clientOf(ctx);

      expect(result).toMatchObject({ structuredContent: { client: 'unknown' } });
    });
  });
});

describe('toHexlogError', () => {
  it('should return a HexlogError as is, without logging', () => {
    const { logger } = makeDeps();
    const error = new HexlogError('IO_ERROR', 'disk', [{ path: '', code: 'enospc', message: 'x' }]);

    expect(toHexlogError(error, logger)).toBe(error);
    expect(logger).not.toHaveBeenCalled();
  });

  it('should turn a value that is not an Error into INTERNAL', () => {
    const { logger } = makeDeps();

    const error = toHexlogError('algo', logger);

    expect(error).toMatchObject({ code: 'INTERNAL', message: 'internal error', details: [] });
  });

  it('should log a value that is not an Error as text', () => {
    const { logger } = makeDeps();

    toHexlogError('algo', logger);

    expect(logger).toHaveBeenCalledWith({ level: 'error', event: 'internal-error', stack: 'algo' });
  });

  it('should still return INTERNAL when the logger throws', () => {
    const { logger } = makeDeps();
    logger.mockImplementation(() => {
      throw new Error('stderr closed');
    });

    expect(toHexlogError('algo', logger)).toMatchObject({ code: 'INTERNAL' });
  });
});

describe('advertise', () => {
  it('should advertise the JSON Schema of the zod schema', () => {
    const standard = advertise(Input)['~standard'];

    expect(standard.jsonSchema.input({ target: 'draft-2020-12' })).toMatchObject({
      type: 'object',
      properties: { project: { type: 'string' }, count: { type: 'integer' } },
      required: ['project', 'count'],
    });
  });

  it('should let the raw input through validate, even when invalid', async () => {
    const raw = { project: 1, lixo: true };

    const result = await advertise(Input)['~standard'].validate(raw);

    expect(result).toEqual({ value: raw });
  });
});
