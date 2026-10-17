import { describe, expect, it } from '@jest/globals';
import { note } from '../commands/register-fakes.ts';
import { idsOf, querySetup, walkPages } from './query-setup.ts';

describe('QueryService.queryRecords', () => {
  it('should order the process scope by seq, even with the clock going backwards', async () => {
    const { createProcess, registerOne, query } = querySetup();
    createProcess('run-1');
    const first = await registerOne('run-1', note('primeiro'), 30);
    const second = await registerOne('run-1', note('segundo'), 20);
    const third = await registerOne('run-1', note('terceiro'), 10);

    const page = query({ process: 'run-1' });

    expect(idsOf(page)).toEqual([first, second, third]);
    expect(page.records.map((record) => record.at)).toEqual([
      '2026-10-02T12:30:00.000Z',
      '2026-10-02T12:20:00.000Z',
      '2026-10-02T12:10:00.000Z',
    ]);
  });

  it('should order the project scope by (at, process, seq), breaking an instant tie by the name', async () => {
    const { createProcess, register, registerOne, query } = querySetup();
    createProcess('run-a');
    createProcess('run-b');
    const a1 = await registerOne('run-a', note('a1'), 30);
    const a2 = await registerOne('run-a', note('a2'), 5);
    const a3 = await registerOne('run-a', note('a3'), 10);
    const b1 = await registerOne('run-b', note('b1'), 10);
    const batch = await register('run-b', [note('b2'), note('b3')], 20);

    const page = query({ scope: 'project' });

    expect(idsOf(page)).toEqual([a2, a3, b1, ...batch, a1]);
  });

  it('should rank by relevance with text, breaking ties by the key of the scope', async () => {
    const { createProcess, registerOne, query } = querySetup();
    createProcess('run-a');
    createProcess('run-b');
    const tieLate = await registerOne('run-a', note('webhook um dois tres'), 7);
    const heavy = await registerOne('run-b', note('webhook webhook webhook um'), 9);
    const tieMiddle = await registerOne('run-b', note('webhook um dois tres'), 3);
    const tieEarly = await registerOne('run-a', note('webhook um dois tres'), 1);

    const project = query({ scope: 'project', text: 'webhook' });
    const process = query({ process: 'run-a', text: 'webhook' });

    expect(idsOf(project)).toEqual([heavy, tieEarly, tieMiddle, tieLate]);
    expect(idsOf(process)).toEqual([tieLate, tieEarly]);
  });

  it('should restart page 2 after the lastId in the same order, with or without text', async () => {
    const { createProcess, registerOne, query } = querySetup();
    createProcess('run-a');
    createProcess('run-b');
    await registerOne('run-a', note('webhook um dois'), 7);
    await registerOne('run-b', note('webhook webhook um'), 9);
    await registerOne('run-b', note('webhook um dois'), 3);
    await registerOne('run-a', note('webhook um dois'), 1);
    await registerOne('run-a', note('outro assunto'), 2);

    for (const filters of [{}, { text: 'webhook' }]) {
      const whole = idsOf(query({ scope: 'project', ...filters }));
      const walked = walkPages(query, { scope: 'project', limit: 2, ...filters }).flatMap(idsOf);

      expect(walked).toEqual(whole);
    }
  });

  it('should output changes.entered and changes.left in the same order as the result', async () => {
    const { createProcess, registerOne, query } = querySetup();
    createProcess('run-a');
    createProcess('run-b');
    const x = await registerOne('run-a', note('x'), 10);
    const y = await registerOne('run-b', note('y'), 5);
    const snapshot = query({ scope: 'project' });
    const x2 = await registerOne(
      'run-a',
      note('x2', { relations: [{ to: x, kind: 'supersedes' }] }),
      40,
    );
    const y2 = await registerOne(
      'run-b',
      note('y2', { relations: [{ to: y, kind: 'supersedes' }] }),
      20,
    );

    const page = query({ scope: 'project', changesSince: snapshot.marker });

    expect(idsOf(page)).toEqual([y2, x2]);
    expect(page.changes?.entered).toEqual([y2, x2]);
    expect(page.changes?.left.map(({ id }) => id)).toEqual([y, x]);
  });
});
