import { afterEach, beforeEach, describe, expect, test } from '@jest/globals';
import { decodeCursor, encodeCursor } from '../../src/queries/cursor.ts';
import { createEnvironment, errorBodyOf, expectError } from './environment.ts';
import type { Environment } from './environment.ts';

const PROJECT = 'alpha';
const AGENT = 'executor';
const NOTE = {
  type: 'object',
  properties: { text: { type: 'string' } },
  required: ['text'],
  additionalProperties: false,
};
const GATE = { name: 'proposed', questions: [{ kind: 'approved', of: { type: 'note' } }] };

let environment: Environment;

/** Dois processos com registros em `note`: `run-1` com três (pagina com limit 1) e `run-2` com dois. */
async function seed(): Promise<void> {
  await environment.call('define_type', { project: PROJECT, name: 'note', schema: NOTE });
  await environment.call('define_gate', { project: PROJECT, ...GATE });
  for (const [process, count] of [
    ['run-1', 3],
    ['run-2', 2],
  ] as const) {
    await environment.call('create_process', { project: PROJECT, process });
    await environment.call('register', {
      project: PROJECT,
      process,
      agent: AGENT,
      records: Array.from({ length: count }, (_, n) => ({
        type: 'note',
        target: `${process}.step`,
        data: { text: `nota ${n}` },
      })),
    });
  }
}

/** Primeira página de `run-1` com `limit: 1`, e o cursor que ela devolveu. */
async function firstCursor(): Promise<string> {
  const page = await environment.call('query', { project: PROJECT, process: 'run-1', limit: 1 });
  const { cursor } = page.structuredContent as { cursor?: string };
  if (cursor === undefined) throw new Error('a primeira página deveria ter cursor');
  return cursor;
}

const queryRun1 = (extra: Record<string, unknown>) =>
  environment.call('query', { project: PROJECT, process: 'run-1', ...extra });

beforeEach(async () => {
  environment = await createEnvironment();
  await seed();
});

afterEach(async () => {
  await environment.close();
});

describe('TM5: cursor inválido dá INVALID_CURSOR', () => {
  test('o cursor emitido pela página 1 abre a página 2', async () => {
    const result = await queryRun1({ limit: 1, cursor: await firstCursor() });

    expect(result.isError).toBeFalsy();
  });

  test.each([
    ['truncado no checksum', (cursor: string) => cursor.slice(0, -4)],
    ['truncado na metade', (cursor: string) => cursor.slice(0, cursor.length / 2)],
    [
      'editado no corpo',
      (cursor: string) => `${cursor.startsWith('e') ? 'f' : 'e'}${cursor.slice(1)}`,
    ],
    ['sem checksum', (cursor: string) => cursor.split('.')[0] ?? ''],
  ])('cursor %s', async (_title, mangle) => {
    const result = await queryRun1({ limit: 1, cursor: mangle(await firstCursor()) });

    const body = expectError(result, 'INVALID_CURSOR');
    expect(body.details).toEqual([expect.objectContaining({ path: '/cursor' })]);
  });

  test('cursor de outro processo', async () => {
    const cursor = await firstCursor();

    const result = await environment.call('query', {
      project: PROJECT,
      process: 'run-2',
      limit: 1,
      cursor,
    });

    expectError(result, 'INVALID_CURSOR');
  });

  test('cursor com outros filtros', async () => {
    const cursor = await firstCursor();

    const result = await queryRun1({ limit: 1, type: 'note', cursor });

    expectError(result, 'INVALID_CURSOR');
  });

  test('cursor acima de 65.536 caracteres é recusado com path /cursor', async () => {
    const result = await queryRun1({ cursor: 'a'.repeat(65_537) });

    const body = errorBodyOf(result);
    expect(['INVALID_CURSOR', 'INVALID_INPUT']).toContain(body.code);
    expect(body.details).toEqual(
      expect.arrayContaining([expect.objectContaining({ path: '/cursor' })]),
    );
  });
});

describe('N4/N14: marcador sem a chave do processo lido dá MARKER_NOT_FOUND', () => {
  test('em changesSince, com path /changesSince', async () => {
    const page = await queryRun1({});
    const { marker } = page.structuredContent as { marker: Record<string, string> };

    for (const changesSince of [{}, { 'run-2': marker['run-1'] }]) {
      const result = await queryRun1({ changesSince });

      const body = expectError(result, 'MARKER_NOT_FOUND');
      expect(body.details).toEqual([
        expect.objectContaining({ path: '/changesSince', code: 'process-not-found' }),
      ]);
    }
  });

  test('em evaluate_gate, com path /marker', async () => {
    const result = await environment.call('evaluate_gate', {
      project: PROJECT,
      process: 'run-1',
      gate: GATE.name,
      marker: {},
    });

    const body = expectError(result, 'MARKER_NOT_FOUND');
    expect(body.details).toEqual([
      expect.objectContaining({ path: '/marker', code: 'process-not-found' }),
    ]);
  });

  test('em cursor reassinado com marcador vazio, com path /cursor', async () => {
    const issued = decodeCursor(await firstCursor());
    const cursor = encodeCursor({ ...issued, marker: {}, markerHashes: {} });

    const result = await queryRun1({ limit: 1, cursor });

    const body = expectError(result, 'MARKER_NOT_FOUND');
    expect(body.details).toEqual([expect.objectContaining({ path: '/cursor' })]);
  });
});
