import { describe, expect, test } from '@jest/globals';
import { note } from '../commands/register-fakes.ts';
import { at, captureError } from '../helpers.ts';
import { cursorOf, idsOf, PROJECT, querySetup } from './query-setup.ts';

describe('SL5: adulteração de linha antiga (D-24)', () => {
  async function untouched() {
    const setup = querySetup();
    setup.definitions.write(PROJECT, 'gates', 'any', '1.0', {
      name: 'any',
      questions: [{ kind: 'occurred', select: { type: 'note' } }],
    });
    setup.createProcess('run-1');
    setup.createProcess('run-2');
    for (const text of ['primeira', 'segunda', 'terceira']) {
      await setup.registerOne('run-1', note(text), 1);
    }
    await setup.registerOne('run-2', note('de outro processo'), 2);
    return setup;
  }

  test('a linha antiga adulterada é detectada na chamada seguinte, sem reiniciar o serviço', async () => {
    const { query, tamper } = await untouched();
    expect(query({ process: 'run-1' }).records).toHaveLength(3);

    tamper('run-1');
    const error = captureError(() => query({ process: 'run-1' }));

    expect(error.code).toBe('PROCESS_CORRUPTED');
    expect(at(error.details, 0)).toMatchObject({ code: 'broken-chain', process: 'run-1' });
  });

  test('a busca por `text` não serve o índice de antes da adulteração', async () => {
    const { query, tamper } = await untouched();
    expect(idsOf(query({ process: 'run-1', text: 'segunda' }))).toHaveLength(1);

    tamper('run-1');
    const error = captureError(() => query({ process: 'run-1', text: 'segunda' }));

    expect(error.code).toBe('PROCESS_CORRUPTED');
  });

  test('o alcance projeto nomeia o processo adulterado e o outro continua legível sozinho', async () => {
    const { query, tamper } = await untouched();
    expect(query({ scope: 'project' }).records).toHaveLength(4);

    tamper('run-1');
    const project = captureError(() => query({ scope: 'project' }));

    expect(project.code).toBe('PROCESS_CORRUPTED');
    expect(at(project.details, 0)).toMatchObject({ code: 'broken-chain', process: 'run-1' });
    expect(query({ process: 'run-2' }).records).toHaveLength(1);
  });

  test('a página seguinte de uma consulta em andamento também falha depois da adulteração', async () => {
    const { query, tamper } = await untouched();
    const first = query({ process: 'run-1', limit: 2 });

    tamper('run-1');
    const error = captureError(() =>
      query({ process: 'run-1', limit: 2, cursor: cursorOf(first) }),
    );

    expect(error.code).toBe('PROCESS_CORRUPTED');
  });

  test('o cursor cujo marcador é a linha rejeitada pela adulteração da anterior dá PROCESS_CORRUPTED, não MARKER_NOT_FOUND', async () => {
    const { query, tamperLine } = await untouched();
    const first = query({ process: 'run-1', limit: 2 });

    tamperLine('run-1', 1);
    const error = captureError(() =>
      query({ process: 'run-1', limit: 2, cursor: cursorOf(first) }),
    );

    expect(error.code).toBe('PROCESS_CORRUPTED');
    expect(at(error.details, 0)).toMatchObject({ code: 'broken-chain', process: 'run-1' });
  });

  test('`evaluateGate` com `marker` na linha rejeitada pela adulteração da anterior dá PROCESS_CORRUPTED', async () => {
    const { queries, query, tamperLine } = await untouched();
    const { marker } = query({ process: 'run-1' });

    tamperLine('run-1', 1);
    const error = captureError(() =>
      queries.evaluateGate({ project: PROJECT, process: 'run-1', gate: 'any', marker }),
    );

    expect(error.code).toBe('PROCESS_CORRUPTED');
    expect(at(error.details, 0)).toMatchObject({ code: 'broken-chain', process: 'run-1' });
  });

  test('`changesSince` sobre processo adulterado também falha, sem devolver diferença parcial', async () => {
    const { query, tamper } = await untouched();
    const snapshot = query({ process: 'run-1' });

    tamper('run-1');
    const error = captureError(() => query({ process: 'run-1', changesSince: snapshot.marker }));

    expect(error.code).toBe('PROCESS_CORRUPTED');
  });
});
