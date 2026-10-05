import fs from 'node:fs';
import { describe, expect, test } from '@jest/globals';
import { MAX_LOG_BYTES } from '../../src/adapters/fs/process-store.ts';
import { note } from '../commands/register-fakes.ts';
import { at, captureError } from '../helpers.ts';
import { idsOf, querySetup } from './query-setup.ts';

describe('SL8: o alcance projeto com não vigentes reproduz a timeline 0.x de um alvo', () => {
  /**
   * Dois processos no mesmo alvo `run.step`. A ordem esperada abaixo vem do comportamento de
   * `projectTimeline` do 0.x (instante, depois nome do processo, depois `seq`), não do
   * serviço de consulta.
   */
  async function scenario() {
    const setup = querySetup();
    setup.createProcess('run-1');
    setup.createProcess('run-2');
    const b1 = await setup.registerOne('run-2', note('b1'), 1);
    const a1 = await setup.registerOne('run-1', note('a1'), 2);
    const a2 = await setup.registerOne(
      'run-1',
      note('a2', { relations: [{ to: a1, kind: 'supersedes' }] }),
      3,
    );
    const b2 = await setup.registerOne(
      'run-2',
      note('b2', { relations: [{ to: b1, kind: 'supersedes' }] }),
      3,
    );
    const sub = await setup.registerOne('run-1', note('sub', { target: 'run.step.sub' }), 4);
    const batch = await setup.register('run-1', [note('p'), note('q')], 6);
    // Fora do alvo: prefixo que não fecha em ponto e outro alvo.
    await setup.registerOne('run-2', note('longe', { target: 'run.stepper' }), 2);
    await setup.registerOne('run-2', note('outro', { target: 'run.other' }), 5);
    return { ...setup, b1, a1, a2, b2, sub, p: at(batch, 0), q: at(batch, 1) };
  }

  test('a ordem é instante, nome do processo e seq, com os substituídos no lugar em que foram escritos', async () => {
    const { query, b1, a1, a2, b2, sub, p, q } = await scenario();

    const page = query({ scope: 'project', targetPrefix: 'run.step', includeNonCurrent: true });

    expect(idsOf(page)).toEqual([b1, a1, a2, b2, sub, p, q]);
  });

  test('sem `includeNonCurrent` saem só os que a 0.x não marca com `supersededBy`', async () => {
    const { query, a2, b2, sub, p, q } = await scenario();

    const page = query({ scope: 'project', targetPrefix: 'run.step' });

    expect(idsOf(page)).toEqual([a2, b2, sub, p, q]);
  });

  test('as relações reproduzem `supersedes` e `supersededBy` da 0.x, entre processos diferentes', async () => {
    const { query, b1, a1, a2, b2 } = await scenario();

    const page = query({
      scope: 'project',
      targetPrefix: 'run.step',
      includeNonCurrent: true,
      ids: [a1, a2, b1, b2],
    });

    expect(page.records.map(({ id, in: incoming, out }) => ({ id, incoming, out }))).toEqual([
      { id: b1, incoming: [{ kind: 'supersedes', from: b2, current: true }], out: [] },
      { id: a1, incoming: [{ kind: 'supersedes', from: a2, current: true }], out: [] },
      { id: a2, incoming: [], out: [{ kind: 'supersedes', to: a1, current: false }] },
      { id: b2, incoming: [], out: [{ kind: 'supersedes', to: b1, current: false }] },
    ]);
  });
});

describe('alcance projeto: PROCESS_TOO_LARGE nomeia o processo cujo log passou do teto', () => {
  test('o processo gigante é o `process` do detalhe, sem recomendar criar outro', async () => {
    const { createProcess, registerOne, logPath, query } = querySetup();
    createProcess('run-1');
    createProcess('run-2');
    await registerOne('run-1', note('a'), 1);
    fs.truncateSync(logPath('run-2'), MAX_LOG_BYTES + 1);

    const error = captureError(() => query({ scope: 'project' }));

    expect(error).toMatchObject({
      code: 'PROCESS_TOO_LARGE',
      message: "process 'run-2' log exceeds 64 MiB",
      details: [{ path: '/process', code: 'too-large', process: 'run-2' }],
    });
  });
});
