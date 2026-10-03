import * as fs from 'node:fs';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, test } from '@jest/globals';
import { at } from '../helpers.ts';
import { createEnvironment } from './environment.ts';
import type { Environment } from './environment.ts';

const PROJECT = 'alpha';
const HASH = 'a'.repeat(64);
const SCHEMA = { type: 'object', additionalProperties: true };

// Uma entrada válida por tool: o `LEGACY_DATA` vale em qualquer uma, antes de qualquer serviço.
const CALLS: [tool: string, args: Record<string, unknown>][] = [
  ['create_process', { project: PROJECT, process: 'run-1' }],
  [
    'register',
    {
      project: PROJECT,
      process: 'run-1',
      agent: 'executor',
      records: [{ type: 'note', target: 'run.step', data: {} }],
    },
  ],
  ['attach', { project: PROJECT, text: 'conteúdo' }],
  ['define_type', { project: PROJECT, name: 'note', schema: SCHEMA }],
  ['define_relation', { project: PROJECT, name: 'approves', kind: 'supports' }],
  [
    'define_gate',
    {
      project: PROJECT,
      name: 'has-note',
      questions: [{ kind: 'occurred', select: { type: 'note' } }],
    },
  ],
  ['query', { project: PROJECT, process: 'run-1' }],
  ['evaluate_gate', { project: PROJECT, process: 'run-1', gate: 'has-note' }],
  ['verify_chain', { project: PROJECT, process: 'run-1' }],
  ['read_attachment', { project: PROJECT, hash: HASH }],
  ['list', {}],
];

let environment: Environment;

beforeEach(async () => {
  environment = await createEnvironment();
});

afterEach(async () => {
  await environment.close();
});

describe('D9 e TI4: servidor 1.0 diante de dado 0.x em <D>', () => {
  test('o conjunto de chamadas cobre as 11 tools do catálogo', async () => {
    const { tools } = await environment.client.listTools();

    expect(CALLS.map(([tool]) => tool).sort()).toEqual(tools.map(({ name }) => name).sort());
  });

  test.each(CALLS)(
    'dado 0.x semeado: %s responde LEGACY_DATA com o comando em details',
    async (tool, args) => {
      environment.seedLegacy();

      const body = await environment.fail(tool, args);

      expect(body.code).toBe('LEGACY_DATA');
      expect(body.details).toEqual([
        {
          path: '',
          code: 'run',
          message: 'node scripts/install.ts --archive-0x (from the hexlog repository)',
        },
      ]);
    },
  );

  test('a resposta não traz caminho absoluto do <D>', async () => {
    environment.seedLegacy();

    const body = await environment.fail('list');

    expect(JSON.stringify(body)).not.toContain(environment.dataDir);
  });

  test('a mesma instância volta a funcionar sem reinício depois de remover o dado 0.x', async () => {
    await environment.ok('define_type', { project: PROJECT, name: 'note', schema: SCHEMA });
    environment.seedLegacy('old-project');
    const refused = await environment.fail('list');

    fs.rmSync(path.join(environment.dataDir, 'old-project'), { recursive: true });
    const recovered = await environment.ok('create_process', {
      project: PROJECT,
      process: 'run-1',
    });

    expect(refused.code).toBe('LEGACY_DATA');
    expect(recovered).toMatchObject({ process: 'run-1', created: true });
  });

  test('dado 0.x que aparece com o servidor de pé é pego na chamada seguinte', async () => {
    await environment.ok('list');

    environment.seedLegacy();

    expect(at((await environment.fail('list')).details, 0).code).toBe('run');
  });

  test('o dado 1.0 em <D>/.v1 e a pasta archive não contam como dado 0.x', async () => {
    fs.mkdirSync(path.join(environment.dataDir, '.v1'));
    fs.mkdirSync(path.join(environment.dataDir, 'archive'));

    expect(await environment.ok('list')).toEqual({ projects: [] });
  });
});
