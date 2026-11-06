import { describe, it, expect, jest } from '@jest/globals';
import { CLIENT_INFO_META_KEY } from '@modelcontextprotocol/server';
import { z } from 'zod';
import { noopTelemetry } from '../../src/adapters/telemetry/noop.ts';
import { HexlogError } from '../../src/errors.ts';
import type { CallProbe, Telemetry } from '../../src/ports.ts';
import { PAGE_CHARS_CAP } from '../../src/queries/query-service.ts';
import {
  advertise,
  type CallContext,
  execute,
  toHexlogError,
  type ToolDeps,
} from '../../src/mcp/kernel.ts';
import { ARCHIVE_COMMAND } from '../helpers.ts';
import { errorBodyOf, nest } from './environment.ts';

const Input = z.strictObject({ project: z.string().min(1), count: z.number().int() });

function makeDeps({
  isLegacy = false,
  throwingLogger = false,
  telemetry = noopTelemetry,
}: { isLegacy?: boolean; throwingLogger?: boolean; telemetry?: Telemetry } = {}) {
  const logger = jest.fn<ToolDeps['logger']>();
  if (throwingLogger) {
    logger.mockImplementation(() => {
      throw new Error('stderr closed');
    });
  }
  const deps: ToolDeps = {
    services: {} as ToolDeps['services'],
    isLegacy: () => isLegacy,
    logger,
    telemetry,
  };
  return { deps, logger };
}

/** Telemetria falsa e ligada: `trace` chama `run` com uma sonda que guarda cada `end`. */
function fakeTelemetry(overrides: Partial<Telemetry> = {}) {
  const ends: Parameters<CallProbe['end']>[0][] = [];
  const probe: CallProbe = { end: (outcome) => void ends.push(outcome) };
  const telemetry: Telemetry = {
    enabled: true,
    trace: (_tool, run) => run(probe),
    recordLoad: () => undefined,
    degraded: () => undefined,
    shutdown: () => Promise.resolve(),
    ...overrides,
  };
  return { telemetry, probe, ends };
}

/** Os registros de log de um evento. */
const eventsOf = (logger: jest.Mock<ToolDeps['logger']>, event: string) =>
  logger.mock.calls.map(([record]) => record).filter((record) => record.event === event);

const ctxOf = (envelope?: Record<string, unknown>): CallContext => ({ mcpReq: { envelope } });

const callOf = (args: unknown, ctx = ctxOf()) => ({ name: 'demo', schema: Input, args, ctx });

const validCall = (ctx?: CallContext) => callOf({ project: 'p', count: 1 }, ctx);

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

  it('should log a tool record with name and ms', async () => {
    const { deps, logger } = makeDeps();

    await execute(deps, validCall(), () => ({}));

    expect(logger).toHaveBeenCalledWith(
      expect.objectContaining({
        level: 'info',
        event: 'tool',
        name: 'demo',
        ms: expect.any(Number),
      }),
    );
  });

  it('should keep the input content out of the tool record', async () => {
    const { deps, logger } = makeDeps();

    await execute(deps, callOf({ project: 'segredo', count: 1 }), () => ({}));

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

      const result = await execute(deps, validCall(), () => full);

      expect(result).toEqual({
        structuredContent: full,
        content: [{ type: 'text', text: JSON.stringify(full) }],
      });
    });

    it('should not turn the produced result into INTERNAL when the logger throws on the over-cap warn', async () => {
      const { deps, logger } = makeDeps();
      logger.mockImplementation((record) => {
        if (record.event === 'tool-over-cap') throw new Error('stderr closed');
      });
      const full = resultOf(OVER_CAP + 1);

      const result = await execute(deps, validCall(), () => full);

      expect(logger).toHaveBeenCalledWith(expect.objectContaining({ event: 'tool-over-cap' }));
      expect(result).toEqual({
        structuredContent: full,
        content: [{ type: 'text', text: JSON.stringify(full) }],
      });
    });

    it('should not emit the warn when the response is exactly at the cap', async () => {
      const { deps, logger } = makeDeps();

      await execute(deps, validCall(), () => resultOf(OVER_CAP));

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

    const result = await execute(deps, validCall(), () => {
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

    await execute(deps, validCall(), () => {
      throw new HexlogError('PROJECT_NOT_FOUND', 'project not found');
    });

    expect(logger).toHaveBeenCalledWith(
      expect.objectContaining({ level: 'error', event: 'tool', code: 'PROJECT_NOT_FOUND' }),
    );
  });

  it('should keep the result already produced when the logger throws on success', async () => {
    const { deps } = makeDeps({ throwingLogger: true });

    const result = await execute(deps, callOf({ project: 'p', count: 2 }), (input) => ({
      doubled: input.count * 2,
    }));

    expect(result).toEqual({
      structuredContent: { doubled: 4 },
      content: [{ type: 'text', text: '{"doubled":4}' }],
    });
  });

  it('should not let a throwing logger escape execute on an error', async () => {
    const { deps } = makeDeps({ throwingLogger: true });

    const result = await execute(deps, validCall(), () => {
      throw new HexlogError('PROJECT_NOT_FOUND', 'project not found');
    });

    expect(errorBodyOf(result)).toMatchObject({ code: 'PROJECT_NOT_FOUND' });
  });

  it('should still return INTERNAL when the logger throws while recording the exception', async () => {
    const { deps } = makeDeps({ throwingLogger: true });

    const result = await execute(deps, validCall(), () => Promise.reject(new TypeError('boom')));

    expect(errorBodyOf(result)).toMatchObject({ code: 'INTERNAL' });
  });

  it('should turn any exception into INTERNAL without the stack in the response', async () => {
    const { deps } = makeDeps();

    const result = await execute(deps, validCall(), () => Promise.reject(new TypeError('boom')));

    expect(errorBodyOf(result)).toEqual({
      code: 'INTERNAL',
      message: 'internal error',
      details: [],
    });
    expect(JSON.stringify(result)).not.toMatch(/boom|at .*kernel/);
  });

  it('should keep the stack of an exception in the log', async () => {
    const { deps, logger } = makeDeps();

    await execute(deps, validCall(), () => Promise.reject(new TypeError('boom')));

    expect(logger).toHaveBeenCalledWith(
      expect.objectContaining({
        event: 'internal-error',
        stack: expect.stringContaining('boom'),
      }),
    );
  });

  it('should answer LEGACY_DATA before validating the input or reaching any service', async () => {
    const { deps } = makeDeps({ isLegacy: true });
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

    const result = await execute(broken, validCall(), () => ({}));

    expect(errorBodyOf(result)).toMatchObject({ code: 'INTERNAL' });
  });

  describe('with the client info in the envelope', () => {
    const envelopeOf = (clientInfo: unknown) => ctxOf({ [CLIENT_INFO_META_KEY]: clientInfo });
    const clientOf = (ctx: CallContext) =>
      execute(makeDeps().deps, validCall(ctx), (_input, client) => ({
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

  describe('with a telemetry that misbehaves', () => {
    const OVER_CAP = 2 * PAGE_CHARS_CAP;
    const never = () => new Promise<never>(() => undefined);

    // Cada linha: como o `trace` falha e quantas vezes a sonda deve receber `end`.
    it.each([
      {
        scenario: 'rejects after calling run and before it resolves',
        ends: 1,
        trace: (probe: CallProbe): Telemetry['trace'] => {
          return (_tool, run) => {
            void run(probe);
            return Promise.reject(new Error('exporter down'));
          };
        },
      },
      {
        scenario: 'calls run twice',
        ends: 1,
        trace: (probe: CallProbe): Telemetry['trace'] => {
          return async (_tool, run) => {
            const [first] = await Promise.all([run(probe), run(probe)]);
            return first;
          };
        },
      },
      {
        scenario: 'throws before the callback',
        ends: 0,
        trace: (): Telemetry['trace'] => () => {
          throw new Error('sdk broke');
        },
      },
      { scenario: 'never resolves and never calls run', ends: 0, trace: () => never },
      {
        scenario: 'never resolves after calling run',
        ends: 1,
        trace: (probe: CallProbe): Telemetry['trace'] => {
          return (_tool, run) => {
            void run(probe);
            return never();
          };
        },
      },
    ])(
      'should run the call once, log it once and answer without waiting when trace $scenario',
      async ({ trace, ends }) => {
        const fake = fakeTelemetry();
        const { deps, logger } = makeDeps({
          telemetry: { ...fake.telemetry, trace: trace(fake.probe) },
        });
        const run = jest.fn(() => ({ t: 'x'.repeat(OVER_CAP) }));

        const result = await execute(deps, validCall(), run);

        expect(result).toMatchObject({ structuredContent: { t: 'x'.repeat(OVER_CAP) } });
        expect(run).toHaveBeenCalledTimes(1);
        expect(eventsOf(logger, 'tool')).toHaveLength(1);
        expect(eventsOf(logger, 'tool-over-cap')).toHaveLength(1);
        expect(fake.ends).toHaveLength(ends);
      },
    );

    it('should keep the result and the tool record when degraded throws', async () => {
      const fake = fakeTelemetry({
        degraded: () => {
          throw new Error('state broke');
        },
      });
      const { deps, logger } = makeDeps({ telemetry: fake.telemetry });

      const result = await execute(deps, validCall(), () => ({ ok: true }));

      expect(result).toMatchObject({ structuredContent: { ok: true } });
      expect(eventsOf(logger, 'tool')).toHaveLength(1);
      expect(eventsOf(logger, 'telemetry-degraded')).toHaveLength(0);
    });

    it('should still emit the degraded warning and the tool record when probe.end throws', async () => {
      const fake = fakeTelemetry({ degraded: () => 'probe' });
      fake.probe.end = () => {
        throw new Error('span broke');
      };
      const { deps, logger } = makeDeps({ telemetry: fake.telemetry });

      const result = await execute(deps, validCall(), () => ({ ok: true }));

      expect(result).toMatchObject({ structuredContent: { ok: true } });
      expect(eventsOf(logger, 'tool')).toHaveLength(1);
      expect(eventsOf(logger, 'telemetry-degraded')).toHaveLength(1);
    });
  });

  describe('with a call probe', () => {
    it('should name the tool in trace', async () => {
      const fake = fakeTelemetry();
      const trace = jest.spyOn(fake.telemetry, 'trace');
      const { deps } = makeDeps({ telemetry: fake.telemetry });

      await execute(deps, validCall(), () => ({}));

      expect(trace).toHaveBeenCalledWith('demo', expect.any(Function));
    });

    it('should end the probe once with ms and no code on success', async () => {
      const fake = fakeTelemetry();
      const { deps } = makeDeps({ telemetry: fake.telemetry });

      await execute(deps, validCall(), () => ({}));

      expect(fake.ends).toEqual([{ ms: expect.any(Number), detailCodes: [] }]);
    });

    it.each([
      {
        scenario: 'a reserved key',
        args: JSON.parse('{"project":"p","count":1,"deep":{"__proto__":1}}') as unknown,
        run: () => ({}),
        outcome: { code: 'INVALID_INPUT', detailCodes: ['reserved-key'] },
      },
      {
        scenario: 'input outside the schema',
        args: { project: '', count: 'x' },
        run: () => ({}),
        outcome: { code: 'INVALID_INPUT', detailCodes: ['too_small', 'invalid_type'] },
      },
      {
        scenario: 'a domain error with repeated detail codes',
        args: { project: 'p', count: 1 },
        run: () => {
          throw new HexlogError('PROJECT_NOT_FOUND', 'project not found', [
            { path: '/a', code: 'unknown-name', message: 'a' },
            { path: '/b', code: 'unknown-name', message: 'b' },
            { path: '/c', code: 'other', message: 'c' },
          ]);
        },
        outcome: { code: 'PROJECT_NOT_FOUND', detailCodes: ['unknown-name', 'other'] },
      },
      {
        scenario: 'an unexpected exception',
        args: { project: 'p', count: 1 },
        run: () => Promise.reject(new TypeError('boom')),
        outcome: { code: 'INTERNAL', detailCodes: [] },
      },
    ])('should end the probe once with the code and the detail codes for $scenario', async (c) => {
      const fake = fakeTelemetry();
      const { deps } = makeDeps({ telemetry: fake.telemetry });

      await execute(deps, callOf(c.args), c.run);

      expect(fake.ends).toEqual([{ ms: expect.any(Number), ...c.outcome }]);
    });

    it('should end the probe with LEGACY_DATA when the data is 0.x', async () => {
      const fake = fakeTelemetry();
      const { deps } = makeDeps({ isLegacy: true, telemetry: fake.telemetry });

      await execute(deps, validCall(), () => ({}));

      expect(fake.ends).toEqual([
        { ms: expect.any(Number), code: 'LEGACY_DATA', detailCodes: ['run'] },
      ]);
    });
  });

  describe('with a degraded telemetry', () => {
    it.each(['probe', 'export'] as const)(
      'should warn once per call with reason %s',
      async (reason) => {
        const fake = fakeTelemetry({ degraded: () => reason });
        const { deps, logger } = makeDeps({ telemetry: fake.telemetry });

        await execute(deps, validCall(), () => ({}));
        await execute(deps, validCall(), () => ({}));

        expect(eventsOf(logger, 'telemetry-degraded')).toEqual([
          { level: 'warn', event: 'telemetry-degraded', reason },
          { level: 'warn', event: 'telemetry-degraded', reason },
        ]);
      },
    );

    it('should not warn when the telemetry is healthy', async () => {
      const fake = fakeTelemetry();
      const { deps, logger } = makeDeps({ telemetry: fake.telemetry });

      await execute(deps, validCall(), () => ({}));

      expect(eventsOf(logger, 'telemetry-degraded')).toEqual([]);
    });
  });

  describe('with sentinels in project and process', () => {
    const PrivateInput = z.strictObject({ project: z.string(), process: z.string() });
    const privateCall = (args: unknown) => ({
      name: 'demo',
      schema: PrivateInput,
      args,
      ctx: ctxOf(),
    });
    const SECRETS = ['secret-project', 'secret-process'];
    const REFUSAL = 'must not use the key __proto__';

    it('should keep them and the error messages out of the log and out of the probe', async () => {
      const fake = fakeTelemetry({ degraded: () => 'export' });
      const { deps, logger } = makeDeps({ telemetry: fake.telemetry });
      const args = { project: SECRETS[0], process: SECRETS[1] };
      const hostile: unknown = JSON.parse(
        `{"project":"${SECRETS[0]}","process":"${SECRETS[1]}","x":{"__proto__":1}}`,
      );

      await execute(deps, privateCall(args), () => ({ t: 'x'.repeat(2 * PAGE_CHARS_CAP) }));
      await execute(deps, privateCall(hostile), () => ({}));
      await execute(deps, privateCall(args), () => {
        throw new HexlogError('PROCESS_TOO_LARGE', `process ${SECRETS[1]} is too large`, [
          { path: '/process', code: 'too-large', message: `${SECRETS[0]} ${SECRETS[1]}` },
        ]);
      });

      const surfaces = JSON.stringify([logger.mock.calls, fake.ends]);

      expect(surfaces).not.toContain(SECRETS[0]);
      expect(surfaces).not.toContain(SECRETS[1]);
      expect(surfaces).not.toContain(REFUSAL);
      expect(new Set(logger.mock.calls.map(([record]) => record.event))).toEqual(
        new Set(['tool', 'tool-over-cap', 'telemetry-degraded']),
      );
      expect(fake.ends).toHaveLength(3);
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
    const { logger } = makeDeps({ throwingLogger: true });

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
