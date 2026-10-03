import { describe, expect, test } from '@jest/globals';
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
  test('sem projeto lista os projetos com a contagem de processos', () => {
    const { definitions, list } = listSetup();
    definitions.write('beta', 'types', 'note', '1.0', NOTE);

    expect(list({})).toEqual({
      projects: [
        { name: PROJECT, processes: 2 },
        { name: 'beta', processes: 0 },
      ],
    });
  });

  test('com projeto lista os processos em ordem de nome e as definições com a versão mais nova', () => {
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

  test('com projeto e processo devolve o que o manifesto fixou, sem as definições novas', () => {
    const { definitions, list } = listSetup();
    definitions.write(PROJECT, 'gates', 'late', '1.0', {
      name: 'late',
      questions: [{ kind: 'no_open_contradiction' }],
    });

    expect(list({ project: PROJECT, process: 'run-1' }).process).toEqual({
      name: 'run-1',
      createdAt: instant(0).toISOString(),
      pinned: { types: ['doc', 'note'], relations: ['approves'], gates: [] },
      hashes: {
        types: expect.stringMatching(/^[0-9a-f]{64}$/),
        relations: expect.stringMatching(/^[0-9a-f]{64}$/),
        gates: expect.stringMatching(/^[0-9a-f]{64}$/),
      },
    });
  });

  test('projeto inexistente é PROJECT_NOT_FOUND, com e sem processo', () => {
    const { list } = listSetup();

    expect(captureError(() => list({ project: 'ghost' })).code).toBe('PROJECT_NOT_FOUND');
    expect(captureError(() => list({ project: 'ghost', process: 'run-1' })).code).toBe(
      'PROJECT_NOT_FOUND',
    );
  });

  test('processo inexistente é PROCESS_NOT_FOUND e processo sem projeto é INVALID_INPUT', () => {
    const { list } = listSetup();

    expect(captureError(() => list({ project: PROJECT, process: 'ghost' })).code).toBe(
      'PROCESS_NOT_FOUND',
    );
    const orphan = captureError(() => list({ process: 'run-1' }));
    expect(orphan.code).toBe('INVALID_INPUT');
    expect(orphan.details[0]).toMatchObject({ path: '/project', code: 'required' });
  });
});
