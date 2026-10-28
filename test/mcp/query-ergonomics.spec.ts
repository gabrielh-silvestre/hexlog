import { afterEach, beforeEach, describe, expect, it } from '@jest/globals';
import type { QueryResult } from '../../src/queries/query-service.ts';
import {
  type Environment,
  NOTE_SCHEMA,
  PROJECT,
  createEnvironment,
  registerNote,
} from './environment.ts';

let environment: Environment;

// O describe de topo liga estas funções aos hooks: `jest/require-top-level-describe` barra hook fora de describe.
const openEnvironment = async () => {
  environment = await createEnvironment();
  await environment.ok('define_type', { project: PROJECT, name: 'note', schema: NOTE_SCHEMA });
  await environment.ok('create_process', { project: PROJECT, process: 'run-1' });
};

const closeEnvironment = async () => {
  await environment.close();
};

const registerAt = (target: string) => registerNote(environment, { process: 'run-1', target });

const query = (args: Record<string, unknown>) =>
  environment.ok<QueryResult>('query', { project: PROJECT, process: 'run-1', ...args });

describe('query', () => {
  beforeEach(openEnvironment);
  afterEach(closeEnvironment);

  it('should return only the changes with limit 0 and changesSince', async () => {
    await registerAt('run.step');
    const { marker } = await query({});
    const added = await registerAt('run.step.b');

    const page = await query({ changesSince: marker, limit: 0 });

    expect(page.records).toEqual([]);
    expect(page.changes?.entered).toEqual(added.records.map(({ id }) => id));
  });

  it('should accept a record id of the process as the changesSince entry with limit 0', async () => {
    const first = await registerAt('run.step');
    const added = await registerAt('run.step.b');

    const page = await query({ changesSince: { 'run-1': first.records[0]!.id }, limit: 0 });

    expect(page.changes?.entered).toEqual(added.records.map(({ id }) => id));
  });

  it('should refuse limit 0 without changesSince with INVALID_FILTER', async () => {
    const body = await environment.fail(
      'query',
      {
        project: PROJECT,
        process: 'run-1',
        limit: 0,
      },
      'INVALID_FILTER',
    );

    expect(body.details[0]).toMatchObject({ path: '/limit', code: 'out-of-range' });
  });

  it('should name the target that starts with the prefix without the boundary when the targetPrefix answer is empty', async () => {
    await registerAt('unit-10');

    const page = await query({ targetPrefix: 'unit-1' });

    expect(page.records).toEqual([]);
    expect(page.hint).toContain('"unit-10"');
  });

  it('should add no hint when the targetPrefix answer has records', async () => {
    await registerAt('unit-10');

    expect(await query({ targetPrefix: 'unit-10' })).not.toHaveProperty('hint');
  });
});
