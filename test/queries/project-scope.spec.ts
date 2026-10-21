import fs from 'node:fs';
import { describe, expect, it } from '@jest/globals';
import { MAX_LOG_BYTES } from '../../src/adapters/fs/process-store.ts';
import { note } from '../commands/register-fakes.ts';
import { at, captureError } from '../helpers.ts';
import { idsOf, querySetup } from './query-setup.ts';

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

describe('QueryService.queryRecords', () => {
  describe('with the project scope', () => {
    it('should order by instant, process name and seq, with the superseded ones where they were written', async () => {
      const { query, b1, a1, a2, b2, sub, p, q } = await scenario();

      const page = query({ scope: 'project', targetPrefix: 'run.step', includeNonCurrent: true });

      expect(idsOf(page)).toEqual([b1, a1, a2, b2, sub, p, q]);
    });

    it('should return only the records that 0.x does not mark with supersededBy without includeNonCurrent', async () => {
      const { query, a2, b2, sub, p, q } = await scenario();

      const page = query({ scope: 'project', targetPrefix: 'run.step' });

      expect(idsOf(page)).toEqual([a2, b2, sub, p, q]);
    });

    it('should reproduce supersedes and supersededBy of 0.x as relations, across different processes', async () => {
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

    it('should name the process whose log passed the ceiling in the PROCESS_TOO_LARGE detail, without recommending to create another', async () => {
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
});
