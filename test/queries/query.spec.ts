import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, test } from '@jest/globals';
import type { BatchItem } from '../../src/domain/record.ts';
import { QUERY_TEXT_MAX_CHARS } from '../../src/queries/query-service.ts';
import { ghostId, note } from '../commands/register-fakes.ts';
import { at, captureError } from '../helpers.ts';
import { idsOf, PROJECT, querySetup, seeded } from './query-setup.ts';

const doc = (data: BatchItem['data'], extra: Partial<BatchItem> = {}): BatchItem => ({
  type: 'doc',
  target: 'run.doc',
  data,
  ...extra,
});

describe('queryRecords: filtros e dados embutidos', () => {
  test('por padrão só os vigentes saem, e `includeNonCurrent` traz os substituídos', async () => {
    const { query, v1, v2, task, other } = await seeded();

    expect(idsOf(query({ process: 'run-1' }))).toEqual([task, other, v2]);
    expect(idsOf(query({ process: 'run-1', includeNonCurrent: true }))).toEqual([
      v1,
      task,
      other,
      v2,
    ]);
  });

  test('`type` e `where` escalar filtram por igualdade', async () => {
    const { query, other, task } = await seeded();

    expect(idsOf(query({ process: 'run-1', type: 'doc' }))).toEqual([other]);
    expect(idsOf(query({ process: 'run-1', where: { text: 'tarefa' } }))).toEqual([task]);
  });

  test('`targetPrefix` respeita a fronteira em ponto', async () => {
    const { query, v2, task } = await seeded();

    expect(idsOf(query({ process: 'run-1', targetPrefix: 'run.step' }))).toEqual([task, v2]);
  });

  test('os filtros combinam por E', async () => {
    const { query, task } = await seeded();

    const page = query({
      process: 'run-1',
      type: 'note',
      targetPrefix: 'run.step',
      text: 'tarefa',
    });

    expect(idsOf(page)).toEqual([task]);
  });

  test('`text` de 2+ termos com `type`: o fallback OR decide sobre os registros que passam nos filtros', async () => {
    const { createProcess, registerOne, query } = querySetup();
    createProcess('run-1');
    await registerOne('run-1', doc({ note: 'banana uva' }), 1);
    const banana = await registerOne('run-1', note('banana'), 2);
    const uva = await registerOne('run-1', note('uva'), 3);

    const page = query({ process: 'run-1', type: 'note', text: 'banana uva' });

    expect(idsOf(page)).toEqual([banana, uva]);
  });

  test('`text` de 2+ termos: o fallback OR também decide sobre a vigência', async () => {
    const { createProcess, registerOne, query } = querySetup();
    createProcess('run-1');
    const old = await registerOne('run-1', note('banana uva'), 1);
    const banana = await registerOne('run-1', note('banana'), 2);
    const uva = await registerOne('run-1', note('uva'), 3);
    await registerOne(
      'run-1',
      note('laranja', { relations: [{ to: old, kind: 'supersedes' }] }),
      4,
    );

    expect(idsOf(query({ process: 'run-1', text: 'banana uva' }))).toEqual([banana, uva]);
    expect(idsOf(query({ process: 'run-1', text: 'banana uva', includeNonCurrent: true }))).toEqual(
      [old],
    );
  });

  test('`text` acima do teto é INVALID_FILTER `too-long`, e no teto passa', () => {
    const { createProcess, query } = querySetup();
    createProcess('run-1');

    const error = captureError(() =>
      query({ process: 'run-1', text: 'a'.repeat(QUERY_TEXT_MAX_CHARS + 1) }),
    );

    expect(error.code).toBe('INVALID_FILTER');
    expect(error.details).toEqual([expect.objectContaining({ path: '/text', code: 'too-long' })]);
    expect(query({ process: 'run-1', text: 'a'.repeat(QUERY_TEXT_MAX_CHARS) }).records).toEqual([]);
  });

  test.each([0, -1, 1.5, NaN, Infinity])('`limit` %p é INVALID_FILTER em /limit', (limit) => {
    const { createProcess, query } = querySetup();
    createProcess('run-1');

    const error = captureError(() => query({ process: 'run-1', limit }));

    expect(error.code).toBe('INVALID_FILTER');
    expect(at(error.details, 0)).toMatchObject({ path: '/limit', code: 'out-of-range' });
  });

  test.each(['', '  ', '!!!', '&&', '::', '§', '́', ' '])(
    '`text` %j sem termo pesquisável é INVALID_FILTER `no-terms` em /text',
    (text) => {
      const { createProcess, query } = querySetup();
      createProcess('run-1');

      const error = captureError(() => query({ process: 'run-1', text }));

      expect(error.code).toBe('INVALID_FILTER');
      expect(at(error.details, 0)).toMatchObject({ path: '/text', code: 'no-terms' });
    },
  );

  test.each(['=>', '+++', '$$$', 'C++', '😀'])(
    '`text` %j tem termo: devolve vazio, sem erro',
    (text) => {
      const { createProcess, query } = querySetup();
      createProcess('run-1');

      expect(query({ process: 'run-1', text }).records).toEqual([]);
    },
  );

  test('`ids` com id inexistente ou repetido devolve cada registro uma vez, na ordem de saída', async () => {
    const { query, task, other } = await seeded();

    const page = query({ process: 'run-1', ids: [other, ghostId('run-1'), task, other] });

    expect(idsOf(page)).toEqual([task, other]);
  });

  test('`relatedTo` com âncora de outro processo acha quem a cita; âncora que não existe não acha nada', async () => {
    const { createProcess, registerOne, query } = querySetup();
    createProcess('run-1');
    createProcess('run-2');
    const anchor = await registerOne('run-2', note('âncora'), 1);
    const citing = await registerOne(
      'run-1',
      note('cita', { relations: [{ to: anchor, kind: 'supports' }] }),
      2,
    );

    expect(idsOf(query({ process: 'run-1', relatedTo: anchor }))).toEqual([citing]);
    expect(idsOf(query({ process: 'run-1', relatedTo: ghostId('run-1') }))).toEqual([]);
  });
});

describe('queryRecords: attachmentStatus', () => {
  test('cada anexo citado sai com o estado do blob e o registro sem anexo não leva o campo', async () => {
    const { createProcess, registerOne, attachments, dataDir, query } = querySetup();
    createProcess('run-1');
    const kept = attachments.putText(PROJECT, 'guardado').hash;
    const gone = attachments.putText(PROJECT, 'apagado').hash;
    const broken = attachments.putText(PROJECT, 'adulterado').hash;
    await registerOne('run-1', doc({ body: kept, files: [gone, broken] }));
    await registerOne('run-1', note('sem anexo'));
    const blob = (hash: string) => path.join(dataDir, '.v1', PROJECT, 'attachments', hash);
    fs.rmSync(blob(gone));
    fs.writeFileSync(blob(broken), 'outro conteúdo');

    const page = query({ process: 'run-1' });

    expect(at(page.records, 0).attachmentStatus).toEqual({
      [kept]: 'ok',
      [gone]: 'missing',
      [broken]: 'corrupted',
    });
    expect(at(page.records, 1)).not.toHaveProperty('attachmentStatus');
  });
});

describe('queryRecords: needsReview (D-09)', () => {
  const supports = (to: string) => ({ to, kind: 'supports' as const });
  const supersedes = (to: string) => ({ to, kind: 'supersedes' as const });

  test('prova vencida: o alcance processo não vê o apoio de outro processo e o projeto vê', async () => {
    const { createProcess, registerOne, query } = querySetup();
    createProcess('run-1');
    createProcess('run-2');
    const evidence = await registerOne('run-1', note('evidência'), 1);
    const verdict = await registerOne(
      'run-2',
      note('veredito', { relations: [supports(evidence)] }),
      2,
    );
    await registerOne('run-1', note('evidência 2', { relations: [supersedes(evidence)] }), 3);

    const own = query({ process: 'run-2' });
    const project = query({ scope: 'project', ids: [verdict] });

    expect(at(own.records, 0)).not.toHaveProperty('needsReview');
    expect(at(project.records, 0).needsReview).toEqual({ staleIn: [], staleOut: [evidence] });
  });
});
