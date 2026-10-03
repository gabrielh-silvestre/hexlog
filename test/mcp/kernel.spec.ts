import { describe, test, expect, jest } from '@jest/globals';
import { CLIENT_INFO_META_KEY, type ServerContext } from '@modelcontextprotocol/server';
import { z } from 'zod';
import { HexlogError } from '../../src/errors.ts';
import {
  advertise,
  CHANGES_ITEMS_CAP,
  execute,
  PAGE_CHARS_CAP,
  queryPage,
  toHexlogError,
  type ToolDeps,
} from '../../src/mcp/kernel.ts';
import type { QueryResult, QueryService } from '../../src/queries/query-service.ts';
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

const ctxOf = (envelope?: Record<string, unknown>) =>
  ({ mcpReq: { envelope } }) as unknown as ServerContext;

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

  test('consulta isLegacy a cada chamada: volta a funcionar sem reinício depois de arquivar', async () => {
    const { deps } = makeDeps();
    let legacy = true;
    const live: ToolDeps = { ...deps, isLegacy: () => legacy };
    const valid = { project: 'p', count: 1 };

    const before = await execute(live, callOf(valid), () => ({ ok: true }));
    legacy = false;
    const after = await execute(live, callOf(valid), () => ({ ok: true }));

    expect(errorBodyOf(before)).toMatchObject({ code: 'LEGACY_DATA' });
    expect(after).toEqual({
      structuredContent: { ok: true },
      content: [{ type: 'text', text: '{"ok":true}' }],
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

describe('caller', () => {
  const envelopeOf = (clientInfo: unknown) => ctxOf({ [CLIENT_INFO_META_KEY]: clientInfo });
  const authorOf = (ctx: ServerContext, fields: { agent: string; model?: string }) =>
    execute(makeDeps().deps, callOf({ project: 'p', count: 1 }, ctx), (_input, caller) =>
      caller.author(fields),
    );

  test('D-21: client vem de clientInfo.name do envelope', async () => {
    const result = await authorOf(envelopeOf({ name: 'claude-code', version: '2' }), {
      agent: 'luffy',
    });

    expect(result).toMatchObject({ structuredContent: { agent: 'luffy', client: 'claude-code' } });
  });

  test.each([
    ['sem envelope', ctxOf()],
    ['envelope sem clientInfo', ctxOf({})],
    ['clientInfo sem name', envelopeOf({ version: '1' })],
    ['name vazio', envelopeOf({ name: '' })],
    ['name acima de 100 caracteres', envelopeOf({ name: 'x'.repeat(101) })],
    ['name com surrogate solto', envelopeOf({ name: 'cl\ud800' })],
  ])('client é "unknown" %s', async (_title, ctx) => {
    const result = await authorOf(ctx, { agent: 'luffy' });

    expect(result).toMatchObject({ structuredContent: { client: 'unknown' } });
  });

  test('D8: model só entra no author quando informado', async () => {
    const ctx = envelopeOf({ name: 'claude-code' });

    const without = await authorOf(ctx, { agent: 'luffy' });
    const withModel = await authorOf(ctx, { agent: 'luffy', model: 'sonnet' });

    expect(without).toMatchObject({
      structuredContent: { agent: 'luffy', client: 'claude-code' },
    });
    expect(without).not.toHaveProperty('structuredContent.model');
    expect(withModel).toMatchObject({ structuredContent: { model: 'sonnet' } });
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

describe('queryPage', () => {
  const emptyPage: QueryResult = { records: [], marker: {} };

  function queryWith(page: QueryResult) {
    const queryRecords = jest.fn<QueryService['queryRecords']>(() => page);
    return { query: { queryRecords } as unknown as QueryService, queryRecords };
  }

  test('M4: passa PAGE_CHARS_CAP em maxChars e repassa o resto da entrada', () => {
    const { query, queryRecords } = queryWith(emptyPage);

    queryPage(query, { project: 'p', process: 'run-1', limit: 10 });

    expect(queryRecords).toHaveBeenCalledWith({
      project: 'p',
      process: 'run-1',
      limit: 10,
      maxChars: PAGE_CHARS_CAP,
    });
  });

  test('sem changes, a página volta como veio', () => {
    const { query } = queryWith(emptyPage);

    expect(queryPage(query, { project: 'p' })).toEqual(emptyPage);
  });

  test('changes dentro do teto não ganha omitted', () => {
    const changes = { entered: ['run-1:a' as never], left: [], marker: {} };
    const { query } = queryWith({ ...emptyPage, changes });

    expect(queryPage(query, { project: 'p' }).changes).toEqual(changes);
  });

  test('M4: changes acima do teto é cortado e conta o que ficou de fora', () => {
    const entered = Array.from({ length: CHANGES_ITEMS_CAP + 7 }, (_, i) => `run-1:e${i}` as never);
    const left = [{ id: 'run-1:l0' as never, reason: 'superseded' as never }];
    const { query } = queryWith({ ...emptyPage, changes: { entered, left, marker: {} } });

    const { changes } = queryPage(query, { project: 'p' });

    expect(changes?.entered).toHaveLength(CHANGES_ITEMS_CAP);
    expect(changes?.left).toEqual(left);
    expect(changes?.omitted).toEqual({ entered: 7, left: 0 });
  });
});
