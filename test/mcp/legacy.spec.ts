import * as fs from 'node:fs';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from '@jest/globals';
import { ARCHIVE_COMMAND, at } from '../helpers.ts';
import { PROJECT, createEnvironment } from './environment.ts';
import type { Environment, ToolName } from './environment.ts';

const HASH = 'a'.repeat(64);
const SCHEMA = { type: 'object', additionalProperties: true };

// Uma entrada válida por tool: o `LEGACY_DATA` vale em qualquer uma, antes de qualquer serviço.
const CALLS: Record<ToolName, Record<string, unknown>> = {
  create_process: { project: PROJECT, process: 'run-1' },
  register: {
    project: PROJECT,
    process: 'run-1',
    agent: 'executor',
    records: [{ type: 'note', target: 'run.step', data: {} }],
  },
  attach: { project: PROJECT, text: 'conteúdo' },
  define_type: { project: PROJECT, name: 'note', schema: SCHEMA },
  define_relation: { project: PROJECT, name: 'approves', kind: 'supports' },
  define_gate: {
    project: PROJECT,
    name: 'has-note',
    questions: [{ kind: 'occurred', select: { type: 'note' } }],
  },
  query: { project: PROJECT, process: 'run-1' },
  evaluate_gate: { project: PROJECT, process: 'run-1', gate: 'has-note' },
  verify_chain: { project: PROJECT, process: 'run-1' },
  read_attachment: { project: PROJECT, hash: HASH },
  list: {},
  describe_type: { project: PROJECT, type: 'note' },
};

let environment: Environment;

// Cada describe de topo liga estas funções aos hooks: `jest/require-top-level-describe` barra hook fora de describe.
const openEnvironment = async () => {
  environment = await createEnvironment();
};

const closeEnvironment = async () => {
  await environment.close();
};

describe('tools/list', () => {
  beforeEach(openEnvironment);
  afterEach(closeEnvironment);

  it('should have one call for each of the 12 tools of the catalog', async () => {
    const { tools } = await environment.client.listTools();

    expect(Object.keys(CALLS).sort()).toEqual(tools.map(({ name }) => name).sort());
  });
});

describe('tools/call', () => {
  beforeEach(openEnvironment);
  afterEach(closeEnvironment);

  it.each(Object.entries(CALLS))(
    'should answer %s with LEGACY_DATA and the command in details when 0.x data is seeded',
    async (tool, args) => {
      environment.seedLegacy();

      const body = await environment.fail(tool, args);

      expect(body.code).toBe('LEGACY_DATA');
      expect(body.details).toEqual([{ path: '', code: 'run', message: ARCHIVE_COMMAND }]);
    },
  );
});

describe('list', () => {
  beforeEach(openEnvironment);
  afterEach(closeEnvironment);

  it('should keep the absolute path of <D> out of the response', async () => {
    environment.seedLegacy();

    const body = await environment.fail('list');

    expect(JSON.stringify(body)).not.toContain(environment.dataDir);
  });

  it('should catch 0.x data that appears while the server is up on the next call', async () => {
    await environment.ok('list');
    environment.seedLegacy();

    const body = await environment.fail('list');

    expect(at(body.details, 0).code).toBe('run');
  });

  it('should not count the 1.0 data in <D>/.v1 and the archive folder as 0.x data', async () => {
    fs.mkdirSync(path.join(environment.dataDir, '.v1'));
    fs.mkdirSync(path.join(environment.dataDir, 'archive'));

    expect(await environment.ok('list')).toEqual({ projects: [] });
  });
});

describe('create_process', () => {
  beforeEach(openEnvironment);
  afterEach(closeEnvironment);

  it('should serve the same instance again without a restart after the 0.x data is removed', async () => {
    await environment.ok('define_type', { project: PROJECT, name: 'note', schema: SCHEMA });
    environment.seedLegacy('old-project');
    const refused = await environment.fail('list');
    fs.rmSync(path.join(environment.dataDir, 'old-project'), { recursive: true });

    expect(refused.code).toBe('LEGACY_DATA');

    const recovered = await environment.ok('create_process', {
      project: PROJECT,
      process: 'run-1',
    });

    expect(recovered).toMatchObject({ process: 'run-1', created: true });
  });
});
