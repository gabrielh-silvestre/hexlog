import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, test } from '@jest/globals';
import type { BatchItem } from '../../src/domain/record.ts';
import { note } from '../commands/register-fakes.ts';
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

  test('`limit` fora do intervalo e `text` em branco são INVALID_FILTER', () => {
    const { createProcess, query } = querySetup();
    createProcess('run-1');

    const limit = captureError(() => query({ process: 'run-1', limit: 0 }));
    const text = captureError(() => query({ process: 'run-1', text: '  ' }));

    expect(limit.code).toBe('INVALID_FILTER');
    expect(at(limit.details, 0).path).toBe('/limit');
    expect(text.code).toBe('INVALID_FILTER');
    expect(at(text.details, 0).path).toBe('/text');
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

  test('prova vencida: veredito que cita evidência substituída é marcado até citar a nova', async () => {
    const { createProcess, registerOne, query } = querySetup();
    createProcess('run-1');
    const evidence = await registerOne('run-1', note('evidência'), 1);
    const verdict = await registerOne(
      'run-1',
      note('veredito', { relations: [supports(evidence)] }),
      2,
    );
    const evidence2 = await registerOne(
      'run-1',
      note('evidência 2', { relations: [supersedes(evidence)] }),
      3,
    );

    const stale = query({ process: 'run-1' });
    const verdict2 = await registerOne(
      'run-1',
      note('veredito 2', { relations: [supersedes(verdict), supports(evidence2)] }),
      4,
    );
    const cleared = query({ process: 'run-1' });

    expect(idsOf(stale)).toEqual([verdict, evidence2]);
    expect(at(stale.records, 0).needsReview).toEqual({ staleIn: [], staleOut: [evidence] });
    expect(at(stale.records, 1)).not.toHaveProperty('needsReview');
    expect(idsOf(cleared)).toEqual([evidence2, verdict2]);
    expect(cleared.records.some((record) => 'needsReview' in record)).toBe(false);
  });

  test('prova vencida: plano aprovado por revisão substituída é marcado só se a atual não apoia mais', async () => {
    const { createProcess, registerOne, query } = querySetup();
    createProcess('run-1');
    const plan = await registerOne('run-1', note('plano'), 1);
    const review = await registerOne('run-1', note('revisão', { relations: [supports(plan)] }), 2);
    await registerOne('run-1', note('revisão 2', { relations: [supersedes(review)] }), 3);

    const marked = query({ process: 'run-1', ids: [plan] });

    expect(at(marked.records, 0).needsReview).toEqual({ staleIn: [review], staleOut: [] });
  });

  test('prova vencida: revisão que repete o apoio não marca o plano', async () => {
    const { createProcess, registerOne, query } = querySetup();
    createProcess('run-1');
    const plan = await registerOne('run-1', note('plano'), 1);
    const review = await registerOne('run-1', note('revisão', { relations: [supports(plan)] }), 2);
    await registerOne(
      'run-1',
      note('revisão 2', { relations: [supersedes(review), supports(plan)] }),
      3,
    );

    const page = query({ process: 'run-1', ids: [plan] });

    expect(at(page.records, 0)).not.toHaveProperty('needsReview');
  });

  test('prova vencida: linhagem de apoio revogada marca o plano', async () => {
    const { createProcess, registerOne, query } = querySetup();
    createProcess('run-1');
    const plan = await registerOne('run-1', note('plano'), 1);
    const review = await registerOne('run-1', note('revisão', { relations: [supports(plan)] }), 2);
    await registerOne('run-1', note('revoga', { relations: [{ to: review, kind: 'revokes' }] }), 3);

    const page = query({ process: 'run-1', ids: [plan] });

    expect(at(page.records, 0).needsReview).toEqual({ staleIn: [review], staleOut: [] });
  });

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
