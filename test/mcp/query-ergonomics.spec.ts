import { afterEach, beforeEach, describe, expect, it } from '@jest/globals';
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

// O describe de topo liga estas funções aos hooks: `jest/require-top-level-describe` barra hook fora de describe.
const openEnvironment = async () => {
  environment = await createEnvironment();
  await environment.ok('define_type', { project: PROJECT, name: 'note', schema: NOTE });
  await environment.ok('create_process', { project: PROJECT, process: 'run-1' });
};

const closeEnvironment = async () => {
  await environment.close();
};

const registerNote = (target: string) =>
  environment.ok<RegisterResult>('register', {
    project: PROJECT,
    process: 'run-1',
    agent: 'executor',
    records: [{ type: 'note', target, data: { text: 'x' } }],
  });

const query = (args: Record<string, unknown>) =>
  environment.ok<QueryResult>('query', { project: PROJECT, process: 'run-1', ...args });

describe('query', () => {
  beforeEach(openEnvironment);
  afterEach(closeEnvironment);

  it('should explain segment matching, the marker as any record id and limit 0 in its description', async () => {
    const { tools } = await environment.client.listTools();
    const description = tools.find(({ name }) => name === 'query')?.description ?? '';

    expect(description).toContain('whole "."-separated segments');
    expect(description).toContain('unit-1 does not match unit-10');
    expect(description).toContain('any record id of the process works as its entry');
    expect(description).toContain('add limit 0');
    expect(description).toContain('nonCurrentInCounts and nonCurrentOutCounts');
  });

  it('should point the unrecognized_keys message to changesSince for the since key', async () => {
    const body = expectError(
      await environment.call('query', {
        project: PROJECT,
        process: 'run-1',
        since: '2026-10-14T12:00:00Z',
      }),
      'INVALID_INPUT',
    );

    expect(body.details).toHaveLength(1);
    expect(body.details[0]).toMatchObject({ path: '', code: 'unrecognized_keys' });
    expect(body.details[0]?.message).toContain('changesSince');
    expect(body.details[0]?.message).toContain('"since"');
  });

  it('should keep the default unrecognized_keys message for another unknown key', async () => {
    const body = expectError(
      await environment.call('query', {
        project: PROJECT,
        process: 'run-1',
        ghost: true,
      }),
      'INVALID_INPUT',
    );

    expect(body.details[0]?.message).not.toContain('changesSince');
  });

  it('should return only the changes with limit 0 and changesSince', async () => {
    await registerNote('run.step');
    const { marker } = await query({});
    const added = await registerNote('run.step.b');

    const page = await query({ changesSince: marker, limit: 0 });

    expect(page.records).toEqual([]);
    expect(page.changes?.entered).toEqual(added.records.map(({ id }) => id));
  });

  it('should accept a record id of the process as the changesSince entry with limit 0', async () => {
    const first = await registerNote('run.step');
    const added = await registerNote('run.step.b');

    const page = await query({ changesSince: { 'run-1': first.records[0]!.id }, limit: 0 });

    expect(page.changes?.entered).toEqual(added.records.map(({ id }) => id));
  });

  it('should refuse limit 0 without changesSince with INVALID_FILTER', async () => {
    const body = expectError(
      await environment.call('query', {
        project: PROJECT,
        process: 'run-1',
        limit: 0,
      }),
      'INVALID_FILTER',
    );

    expect(body.details[0]).toMatchObject({ path: '/limit', code: 'out-of-range' });
  });

  it('should name the target that starts with the prefix without the boundary when the targetPrefix answer is empty', async () => {
    await registerNote('unit-10');

    const page = await query({ targetPrefix: 'unit-1' });

    expect(page.records).toEqual([]);
    expect(page.hint).toContain('"unit-10"');
  });

  it('should add no hint when the targetPrefix answer has records', async () => {
    await registerNote('unit-10');

    expect(await query({ targetPrefix: 'unit-10' })).not.toHaveProperty('hint');
  });
});
