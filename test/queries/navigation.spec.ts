import { describe, expect, test } from '@jest/globals';
import { note } from '../commands/register-fakes.ts';
import { at } from '../helpers.ts';
import { idsOf, querySetup, seeded } from './query-setup.ts';

describe('SL9: navegação por text, ids e relatedTo', () => {
  test('`text` acha pelo conteúdo e `ids` restringe o resultado', async () => {
    const { query, task, v2 } = await seeded();

    expect(idsOf(query({ process: 'run-1', text: 'tarefa' }))).toEqual([task]);
    expect(idsOf(query({ process: 'run-1', ids: [v2, task] }))).toEqual([task, v2]);
  });

  test('`relatedTo` traz quem aponta para o registro e quem ele aponta', async () => {
    const { query, v1, v2, task } = await seeded();

    expect(idsOf(query({ process: 'run-1', relatedTo: v2, includeNonCurrent: true }))).toEqual([
      v1,
    ]);
    expect(idsOf(query({ process: 'run-1', relatedTo: v1, includeNonCurrent: true }))).toEqual([
      v2,
    ]);
    expect(idsOf(query({ process: 'run-1', relatedTo: task }))).toEqual([]);
  });

  test('cada registro traz os dados e as relações de entrada e de saída', async () => {
    const { query, v1, v2 } = await seeded();

    const page = query({ process: 'run-1', includeNonCurrent: true, ids: [v1, v2] });

    expect(at(page.records, 0)).toMatchObject({
      id: v1,
      type: 'note',
      target: 'run.step',
      data: { text: 'primeira versão' },
      in: [{ kind: 'supersedes', from: v2, current: true }],
      out: [],
    });
    expect(at(page.records, 1).out).toEqual([{ kind: 'supersedes', to: v1, current: false }]);
  });

  test('SL9: de um termo do texto antigo à versão vigente, sem pivô por alvo', async () => {
    const { createProcess, register, registerOne, query } = querySetup();
    createProcess('run-1');
    const created = await register(
      'run-1',
      [note('webhook com backoff linear', { target: 'run.webhook' }), note('sem relação')],
      1,
    );
    const old = at(created, 0);
    const current = await registerOne(
      'run-1',
      note('webhook com jitter', {
        target: 'run.outro',
        relations: [{ to: old, kind: 'supersedes' }],
      }),
      2,
    );

    const found = query({ process: 'run-1', text: 'backoff', includeNonCurrent: true });
    const neighbours = query({ process: 'run-1', relatedTo: at(idsOf(found), 0) });
    const detail = query({ process: 'run-1', ids: idsOf(neighbours) });

    expect(idsOf(query({ process: 'run-1', text: 'backoff' }))).toEqual([]);
    expect(idsOf(found)).toEqual([old]);
    expect(idsOf(neighbours)).toEqual([current]);
    expect(at(detail.records, 0)).toMatchObject({
      data: { text: 'webhook com jitter' },
      in: [],
      out: [{ kind: 'supersedes', to: old, current: false }],
    });
  });

  test('SL9: do termo ao veredito que apoia a evidência, pela relação de entrada', async () => {
    const { createProcess, registerOne, query } = querySetup();
    createProcess('run-1');
    const evidence = await registerOne('run-1', note('latência medida em 40ms'), 1);
    const verdict = await registerOne(
      'run-1',
      note('aprovado', { target: 'run.verdict', relations: [{ to: evidence, kind: 'supports' }] }),
      2,
    );

    const found = query({ process: 'run-1', text: 'latência' });
    const supporters = query({ process: 'run-1', relatedTo: at(idsOf(found), 0) });

    expect(idsOf(found)).toEqual([evidence]);
    expect(idsOf(supporters)).toEqual([verdict]);
    expect(at(found.records, 0).in).toEqual([{ kind: 'supports', from: verdict, current: true }]);
    expect(at(supporters.records, 0).out).toEqual([
      { kind: 'supports', to: evidence, current: true },
    ]);
  });
});
