import { afterEach, describe, expect, test } from '@jest/globals';
import type { QueryResult } from '../../src/queries/query-service.ts';
import { at } from '../helpers.ts';
import { createEnvironment } from './environment.ts';
import type { Environment, EnvironmentOptions } from './environment.ts';

const PROJECT = 'alpha';
const PROCESS = 'run-1';

let environment: Environment | undefined;

afterEach(async () => {
  await environment?.close();
  environment = undefined;
});

/** Sobe o servidor, grava uma nota com os campos de autoria pedidos e devolve o autor lido por `query`. */
async function authorOfRegisteredNote(
  options: EnvironmentOptions,
  authorFields: { agent: string; model?: string },
) {
  environment = await createEnvironment(options);
  await environment.ok('define_type', {
    project: PROJECT,
    name: 'note',
    schema: {
      type: 'object',
      properties: { text: { type: 'string' } },
      additionalProperties: false,
    },
  });
  await environment.ok('create_process', { project: PROJECT, process: PROCESS });
  await environment.ok('register', {
    project: PROJECT,
    process: PROCESS,
    ...authorFields,
    records: [{ type: 'note', target: 'run.step', data: { text: 'olá' } }],
  });

  const page = await environment.ok<QueryResult>('query', { project: PROJECT, process: PROCESS });
  return at(page.records, 0).author;
}

describe('D8 e TM6: autoria gravada pelo hexlog', () => {
  test('cliente com envelope grava client = claude-code', async () => {
    const author = await authorOfRegisteredNote(
      { clientInfo: { name: 'claude-code', version: '2.1.0' } },
      { agent: 'executor' },
    );

    expect(author.client).toBe('claude-code');
  });

  test('o client vem do envelope do cliente, não do que o agente informa', async () => {
    const author = await authorOfRegisteredNote(
      { clientInfo: { name: 'outro-cliente', version: '1.0.0' } },
      { agent: 'claude-code' },
    );

    expect(author).toEqual({ agent: 'claude-code', client: 'outro-cliente' });
  });

  test('cliente com nome malformado grava client = unknown e o register não vira INTERNAL', async () => {
    const author = await authorOfRegisteredNote(
      { clientInfo: { name: 'cl\ud800', version: '1.0.0' } },
      { agent: 'executor' },
    );

    expect(author.client).toBe('unknown');
  });

  test('cliente sem envelope grava client = unknown', async () => {
    const author = await authorOfRegisteredNote({}, { agent: 'executor' });

    expect(author.client).toBe('unknown');
  });

  test('grava o model só quando o agente o informa', async () => {
    const withModel = await authorOfRegisteredNote({}, { agent: 'executor', model: 'sonnet' });
    await environment?.close();
    const withoutModel = await authorOfRegisteredNote({}, { agent: 'executor' });

    expect(withModel).toEqual({ agent: 'executor', model: 'sonnet', client: 'unknown' });
    expect(withoutModel).not.toHaveProperty('model');
  });
});
