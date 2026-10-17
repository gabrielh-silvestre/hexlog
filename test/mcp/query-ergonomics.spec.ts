import { afterEach, beforeEach, describe, expect, test } from '@jest/globals';
import type { RegisterResult } from '../../src/commands/process.ts';
import type { QueryResult } from '../../src/queries/query-service.ts';
import { type Environment, createEnvironment, expectError } from './environment.ts';

const PROJECT = 'alpha';
const NOTE = {
  type: 'object',
  properties: { text: { type: 'string' } },
  required: ['text'],
  additionalProperties: false,
};

let environment: Environment;

beforeEach(async () => {
  environment = await createEnvironment();
  await environment.ok('define_type', { project: PROJECT, name: 'note', schema: NOTE });
  await environment.ok('create_process', { project: PROJECT, process: 'run-1' });
});

afterEach(async () => {
  await environment.close();
});

const registerNote = (target: string) =>
  environment.ok<RegisterResult>('register', {
    project: PROJECT,
    process: 'run-1',
    agent: 'executor',
    records: [{ type: 'note', target, data: { text: 'x' } }],
  });

const query = (args: Record<string, unknown>) =>
  environment.ok<QueryResult>('query', { project: PROJECT, process: 'run-1', ...args });

describe('query: description', () => {
  test('explains segment matching, the marker as any record id and limit 0', async () => {
    const { tools } = await environment.client.listTools();

    const description = tools.find(({ name }) => name === 'query')?.description ?? '';

    expect(description).toContain('whole "."-separated segments');
    expect(description).toContain('unit-1 does not match unit-10');
    expect(description).toContain('any record id of the process works as its entry');
    expect(description).toContain('add limit 0');
  });
});

describe('query: since', () => {
  test('the unrecognized_keys message points to changesSince', async () => {
    const result = await environment.call('query', {
      project: PROJECT,
      process: 'run-1',
      since: '2026-10-14T12:00:00Z',
    });

    const body = expectError(result, 'INVALID_INPUT');
    expect(body.details).toHaveLength(1);
    expect(body.details[0]).toMatchObject({ path: '', code: 'unrecognized_keys' });
    expect(body.details[0]?.message).toContain('changesSince');
    expect(body.details[0]?.message).toContain('"since"');
  });

  test('another unknown key keeps the default message', async () => {
    const result = await environment.call('query', {
      project: PROJECT,
      process: 'run-1',
      ghost: true,
    });

    const body = expectError(result, 'INVALID_INPUT');
    expect(body.details[0]?.message).not.toContain('changesSince');
  });
});

describe('query: limit 0', () => {
  test('with changesSince returns only the changes', async () => {
    await registerNote('run.step');
    const { marker } = await query({});
    const added = await registerNote('run.step.b');

    const page = await query({ changesSince: marker, limit: 0 });

    expect(page.records).toEqual([]);
    expect(page.changes?.entered).toEqual(added.records.map(({ id }) => id));
  });

  test('a record id of the process works as the changesSince entry', async () => {
    const first = await registerNote('run.step');
    const added = await registerNote('run.step.b');

    const page = await query({ changesSince: { 'run-1': first.records[0]!.id }, limit: 0 });

    expect(page.changes?.entered).toEqual(added.records.map(({ id }) => id));
  });

  test('without changesSince is INVALID_FILTER', async () => {
    const result = await environment.call('query', {
      project: PROJECT,
      process: 'run-1',
      limit: 0,
    });

    const body = expectError(result, 'INVALID_FILTER');
    expect(body.details[0]).toMatchObject({ path: '/limit', code: 'out-of-range' });
  });
});

describe('query: targetPrefix hint', () => {
  test('an empty answer names the target that starts with the prefix without the boundary', async () => {
    await registerNote('unit-10');

    const page = await query({ targetPrefix: 'unit-1' });

    expect(page.records).toEqual([]);
    expect(page.hint).toContain('"unit-10"');
  });

  test('no hint when the answer has records', async () => {
    await registerNote('unit-10');

    expect(await query({ targetPrefix: 'unit-10' })).not.toHaveProperty('hint');
  });
});
