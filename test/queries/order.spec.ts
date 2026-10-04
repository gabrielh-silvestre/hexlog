import { describe, expect, test } from '@jest/globals';
import { note } from '../commands/register-fakes.ts';
import { idsOf, querySetup } from './query-setup.ts';

describe('P15: ordem de saída da consulta (D-24)', () => {
  test('o alcance processo sai por seq, mesmo com o relógio andando para trás', async () => {
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

  test('o alcance projeto sai por (at, processo, seq), com o empate de instante desfeito pelo nome', async () => {
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

  test('com `text` a relevância manda e o empate segue a chave do alcance', async () => {
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

  test('a página 2 recomeça depois do lastId na mesma ordem, com e sem `text`', async () => {
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
      const walked: string[] = [];
      let cursor: string | undefined;
      do {
        const page = query({ scope: 'project', limit: 2, cursor, ...filters });
        walked.push(...idsOf(page));
        cursor = page.cursor;
      } while (cursor !== undefined);

      expect(walked).toEqual(whole);
    }
  });

  test('`changes.entered` e `changes.left` saem na mesma ordem do resultado', async () => {
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
