import fs from 'node:fs';
import { describe, expect, test } from '@jest/globals';
import { omit } from 'es-toolkit';
import { processPaths } from '../../src/adapters/fs/data-format.ts';
import { NOTE } from '../commands/register-fakes.ts';
import { captureError } from '../helpers.ts';
import { instant, PROJECT, querySetup } from './query-setup.ts';

function listSetup() {
  const setup = querySetup();
  setup.createProcess('run-2');
  setup.createProcess('run-1');
  const list = (input: { project?: string; process?: string }) => setup.queries.list(input);
  return { ...setup, list };
}

describe('list', () => {
  test('without a project lists the projects with the process count', () => {
    const { definitions, list } = listSetup();
    definitions.write('beta', 'types', 'note', '1.0', NOTE);

    expect(list({})).toEqual({
      projects: [
        { name: PROJECT, processes: 2 },
        { name: 'beta', processes: 0 },
      ],
    });
  });

  test('with a project lists the processes in name order and the definitions with the newest version', () => {
    const { definitions, list } = listSetup();
    definitions.write(PROJECT, 'types', 'note', '1.1', NOTE);

    expect(list({ project: PROJECT }).project).toEqual({
      name: PROJECT,
      processes: [
        { name: 'run-1', createdAt: instant(0).toISOString() },
        { name: 'run-2', createdAt: instant(0).toISOString() },
      ],
      types: [
        { name: 'doc', version: '1.0', versions: ['1.0'] },
        { name: 'note', version: '1.1', versions: ['1.0', '1.1'] },
      ],
      relations: [{ name: 'approves', version: '1.0', versions: ['1.0'] }],
      gates: [],
    });
  });

  test('with a project and process returns what the manifest pinned, without the new definitions', () => {
    const { definitions, list } = listSetup();
    definitions.write(PROJECT, 'gates', 'late', '1.0', {
      name: 'late',
      questions: [{ kind: 'no_open_contradiction' }],
    });

    expect(list({ project: PROJECT, process: 'run-1' }).process).toEqual({
      name: 'run-1',
      createdAt: instant(0).toISOString(),
      lineageInheritance: true,
      pinned: { types: ['doc', 'note'], relations: ['approves'], gates: [] },
      hashes: {
        types: expect.stringMatching(/^[0-9a-f]{64}$/),
        relations: expect.stringMatching(/^[0-9a-f]{64}$/),
        gates: expect.stringMatching(/^[0-9a-f]{64}$/),
      },
    });
  });

  test('process view omits lineageInheritance for a manifest without it', () => {
    const { dataDir, list } = listSetup();
    const manifestFile = processPaths(dataDir, { project: PROJECT, process: 'run-1' }).manifest;
    const manifest = JSON.parse(fs.readFileSync(manifestFile, 'utf8')) as Record<string, unknown>;
    fs.writeFileSync(manifestFile, JSON.stringify(omit(manifest, ['lineageInheritance'])));

    expect(list({ project: PROJECT, process: 'run-1' }).process).not.toHaveProperty(
      'lineageInheritance',
    );
  });

  test('unknown project is PROJECT_NOT_FOUND, with and without a process', () => {
    const { list } = listSetup();

    expect(captureError(() => list({ project: 'ghost' })).code).toBe('PROJECT_NOT_FOUND');
    expect(captureError(() => list({ project: 'ghost', process: 'run-1' })).code).toBe(
      'PROJECT_NOT_FOUND',
    );
  });

  test('unknown process is PROCESS_NOT_FOUND and a process without a project is INVALID_INPUT', () => {
    const { list } = listSetup();

    expect(captureError(() => list({ project: PROJECT, process: 'ghost' })).code).toBe(
      'PROCESS_NOT_FOUND',
    );
    const orphan = captureError(() => list({ process: 'run-1' }));
    expect(orphan.code).toBe('INVALID_INPUT');
    expect(orphan.details[0]).toMatchObject({ path: '/project', code: 'required' });
  });
});
