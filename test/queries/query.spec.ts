import fs from 'node:fs';
import { describe, expect, it } from '@jest/globals';
import { omit } from 'es-toolkit';
import { blobFile } from '../../src/adapters/fs/data-format.ts';
import type { BatchItem } from '../../src/domain/record.ts';
import { ghostId, note } from '../commands/register-fakes.ts';
import { at, captureError, idsOf } from '../helpers.ts';
import { PROJECT, querySetup, seeded } from './query-setup.ts';

const doc = (data: BatchItem['data'], extra: Partial<BatchItem> = {}): BatchItem => ({
  type: 'doc',
  target: 'run.doc',
  data,
  ...extra,
});

const supports = (to: string) => ({ to, kind: 'supports' as const });
const supersedes = (to: string) => ({ to, kind: 'supersedes' as const });

/** `evidence` com duas relações `approves`, uma `supports` sem nome e uma `supersedes` que a substitui. */
async function wired() {
  const setup = querySetup();
  setup.createProcess('run-1');
  const { registerOne } = setup;
  const evidence = await registerOne('run-1', note('evidence'), 1);
  const approve = (text: string) => note(text, { relations: [{ to: evidence, as: 'approves' }] });
  await registerOne('run-1', approve('a'), 2);
  await registerOne('run-1', approve('b'), 3);
  await registerOne('run-1', note('c', { relations: [supports(evidence)] }), 4);
  const newer = await registerOne(
    'run-1',
    note('evidence 2', { relations: [supersedes(evidence)] }),
    5,
  );
  return { ...setup, evidence, newer };
}

/** `run-2` tem um veredito que apoia a evidência de `run-1`, que `supersedeEvidence` pode superar. */
async function verdictSupportingEvidenceOfRun1(supersedeEvidence: boolean) {
  const setup = querySetup();
  setup.createLegacyProcess('run-1');
  setup.createLegacyProcess('run-2');
  const { registerOne } = setup;
  const evidence = await registerOne('run-1', note('evidence'), 1);
  const verdict = await registerOne(
    'run-2',
    note('verdict', { relations: [supports(evidence)] }),
    2,
  );
  if (supersedeEvidence) {
    await registerOne('run-1', note('evidence 2', { relations: [supersedes(evidence)] }), 3);
  }
  return { ...setup, evidence, verdict };
}

describe('QueryService.queryRecords', () => {
  it('should return only the current records by default', async () => {
    const { query, v2, task, other } = await seeded();

    expect(idsOf(query({ process: 'run-1' }))).toEqual([task, other, v2]);
  });

  it('should bring the superseded records with `includeNonCurrent`', async () => {
    const { query, v1, v2, task, other } = await seeded();

    expect(idsOf(query({ process: 'run-1', includeNonCurrent: true }))).toEqual([
      v1,
      task,
      other,
      v2,
    ]);
  });

  it('should filter by equality with `type` and with a scalar `where`', async () => {
    const { query, other, task } = await seeded();

    expect(idsOf(query({ process: 'run-1', type: 'doc' }))).toEqual([other]);
    expect(idsOf(query({ process: 'run-1', where: { text: 'tarefa' } }))).toEqual([task]);
  });

  it('should respect the dot boundary in `targetPrefix`', async () => {
    const { query, v2, task } = await seeded();

    expect(idsOf(query({ process: 'run-1', targetPrefix: 'run.step' }))).toEqual([task, v2]);
  });

  it('should combine filters with AND', async () => {
    const { query, task } = await seeded();

    const page = query({
      process: 'run-1',
      type: 'note',
      targetPrefix: 'run.step',
      text: 'tarefa',
    });

    expect(idsOf(page)).toEqual([task]);
  });

  it('should decide the OR fallback over the records that pass the filters with `text` of 2+ terms and `type`', async () => {
    const { createProcess, registerOne, query } = querySetup();
    createProcess('run-1');
    await registerOne('run-1', doc({ note: 'banana uva' }), 1);
    const banana = await registerOne('run-1', note('banana'), 2);
    const uva = await registerOne('run-1', note('uva'), 3);

    const page = query({ process: 'run-1', type: 'note', text: 'banana uva' });

    expect(idsOf(page)).toEqual([banana, uva]);
  });

  it('should decide the OR fallback also over currency with `text` of 2+ terms', async () => {
    const { createProcess, registerOne, query } = querySetup();
    createProcess('run-1');
    const old = await registerOne('run-1', note('banana uva'), 1);
    const banana = await registerOne('run-1', note('banana'), 2);
    const uva = await registerOne('run-1', note('uva'), 3);
    await registerOne('run-1', note('laranja', { relations: [supersedes(old)] }), 4);

    expect(idsOf(query({ process: 'run-1', text: 'banana uva' }))).toEqual([banana, uva]);
    expect(idsOf(query({ process: 'run-1', text: 'banana uva', includeNonCurrent: true }))).toEqual(
      [old],
    );
  });

  it.each([
    ['empty', ''],
    ['spaces', '  '],
    ['exclamation marks', '!!!'],
    ['ampersands', '&&'],
    ['colons', '::'],
    ['section sign', '§'],
    ['combining acute accent', '\u0301'],
    ['no-break space', '\u00a0'],
  ])(
    'should refuse `text` of %s without a searchable term with INVALID_FILTER `no-terms` at /text',
    (_name, text) => {
      const { createProcess, query } = querySetup();
      createProcess('run-1');

      const error = captureError(() => query({ process: 'run-1', text }));

      expect(error.code).toBe('INVALID_FILTER');
      expect(at(error.details, 0)).toMatchObject({ path: '/text', code: 'no-terms' });
      expect(at(error.details, 0).message).toContain('spaces and punctuation are not terms');
    },
  );

  it.each(['=>', '+++', '$$$', 'C++', '😀'])(
    'should return empty with no error for `text` %j, which has a term',
    (text) => {
      const { createProcess, query } = querySetup();
      createProcess('run-1');

      expect(query({ process: 'run-1', text }).records).toEqual([]);
    },
  );

  it('should return each record once, in output order, for `ids` with an unknown or repeated id', async () => {
    const { query, task, other } = await seeded();

    const page = query({ process: 'run-1', ids: [other, ghostId('run-1'), task, other] });

    expect(idsOf(page)).toEqual([task, other]);
  });

  it('should find who cites an anchor from another process with `relatedTo`', async () => {
    const { createProcess, registerOne, query } = querySetup();
    createProcess('run-1');
    createProcess('run-2');
    const anchor = await registerOne('run-2', note('âncora'), 1);
    const citing = await registerOne('run-1', note('cita', { relations: [supports(anchor)] }), 2);

    expect(idsOf(query({ process: 'run-1', relatedTo: anchor }))).toEqual([citing]);
  });

  it('should find nothing with `relatedTo` for an anchor that does not exist', async () => {
    const { createProcess, registerOne, query } = querySetup();
    createProcess('run-1');
    createProcess('run-2');
    const anchor = await registerOne('run-2', note('âncora'), 1);
    await registerOne('run-1', note('cita', { relations: [supports(anchor)] }), 2);

    expect(idsOf(query({ process: 'run-1', relatedTo: ghostId('run-1') }))).toEqual([]);
  });

  it('should bring each cited attachment with the blob state and no field for a record without attachments', async () => {
    const { createProcess, registerOne, attachments, dataDir, query } = querySetup();
    createProcess('run-1');
    const kept = attachments.putText(PROJECT, 'guardado').hash;
    const gone = attachments.putText(PROJECT, 'apagado').hash;
    const broken = attachments.putText(PROJECT, 'adulterado').hash;
    await registerOne('run-1', doc({ body: kept, files: [gone, broken] }));
    await registerOne('run-1', note('sem anexo'));
    fs.rmSync(blobFile(dataDir, PROJECT, gone));
    fs.writeFileSync(blobFile(dataDir, PROJECT, broken), 'outro conteúdo');

    const page = query({ process: 'run-1' });

    expect(at(page.records, 0).attachmentStatus).toEqual({
      [kept]: 'ok',
      [gone]: 'missing',
      [broken]: 'corrupted',
    });
    expect(at(page.records, 1)).not.toHaveProperty('attachmentStatus');
  });

  it('should leave the page unchanged with `fields` undefined', async () => {
    const { query } = await seeded();
    const byDefault = query({ process: 'run-1' });

    const page = query({ process: 'run-1', fields: undefined });

    expect(JSON.stringify(page)).toBe(JSON.stringify(byDefault));
  });

  it('should put `data` right after the envelope without `fields`', async () => {
    const { query } = await seeded();

    const page = query({ process: 'run-1' });

    expect(Object.keys(at(page.records, 0)).slice(0, 6)).toEqual([
      'id',
      'type',
      'at',
      'target',
      'author',
      'data',
    ]);
  });

  it('should trim only `data`, with envelope, relations and `attachmentStatus` whole', async () => {
    const { createProcess, registerOne, attachments, query } = querySetup();
    createProcess('run-1');
    const kept = attachments.putText(PROJECT, 'guardado').hash;
    const first = await registerOne('run-1', doc({ body: kept, note: 'anotação' }), 1);
    await registerOne('run-1', note('apoio', { relations: [supports(first)] }), 2);
    const full = query({ process: 'run-1' });

    const page = query({ process: 'run-1', fields: ['note'] });

    expect(at(page.records, 0)).toEqual({
      ...omit(at(full.records, 0), ['data']),
      data: { note: 'anotação' },
    });
    expect(at(page.records, 0).attachmentStatus).toEqual({ [kept]: 'ok' });
    expect(at(page.records, 0).in).toHaveLength(1);
    expect(at(page.records, 1)).toEqual({ ...at(full.records, 1), data: {} });
  });

  it('should bring `needsReview` whole even with trimmed `data`', async () => {
    const { query, evidence, verdict } = await verdictSupportingEvidenceOfRun1(true);

    const page = query({ scope: 'project', ids: [verdict], fields: [] });

    expect(at(page.records, 0).needsReview).toEqual({ staleIn: [], staleOut: [evidence] });
  });

  it('should omit the `data` key and keep the rest of the record with `fields: []`', async () => {
    const { query, task } = await seeded();

    const page = query({ process: 'run-1', ids: [task], fields: [] });

    expect(at(page.records, 0)).not.toHaveProperty('data');
    expect(at(page.records, 0)).toMatchObject({ id: task, type: 'note', target: 'run.step.sub' });
    expect(at(page.records, 0)).toHaveProperty('in');
    expect(at(page.records, 0)).toHaveProperty('out');
  });

  it('should filter by the whole `data` with `where` and with `text`, even with the field outside `fields`', async () => {
    const { query, task } = await seeded();

    const byWhere = query({ process: 'run-1', where: { text: 'tarefa' }, fields: [] });
    const byText = query({ process: 'run-1', text: 'tarefa', fields: ['inexistente'] });

    expect(idsOf(byWhere)).toEqual([task]);
    expect(idsOf(byText)).toEqual([task]);
  });

  it('should drop a requested field the record lacks, with `data` as `{}` when none exists, in project scope', async () => {
    const { query, task, other } = await seeded();

    const page = query({ scope: 'project', ids: [task, other], fields: ['text'] });

    expect(at(page.records, 0).data).toEqual({ text: 'tarefa' });
    expect(at(page.records, 1).data).toEqual({});
  });

  it.each(['__proto__', 'constructor', 'toString'])(
    'should bring nothing from the prototype for `fields` with `%s`',
    async (name) => {
      const { query, task } = await seeded();

      const page = query({ process: 'run-1', ids: [task], fields: [name, 'text', 'text'] });

      expect(at(page.records, 0).data).toEqual({ text: 'tarefa' });
      expect(Object.keys(at(page.records, 0).data ?? {})).toEqual(['text']);
    },
  );

  it('should not see the dead support from another process in process scope', async () => {
    const { query } = await verdictSupportingEvidenceOfRun1(true);

    const own = query({ process: 'run-2' });

    expect(at(own.records, 0)).not.toHaveProperty('needsReview');
  });

  it('should see the dead support from another process in project scope', async () => {
    const { query, evidence, verdict } = await verdictSupportingEvidenceOfRun1(true);

    const project = query({ scope: 'project', ids: [verdict] });

    expect(at(project.records, 0).needsReview).toEqual({ staleIn: [], staleOut: [evidence] });
  });

  describe('with an edge to a record of another process', () => {
    it('should count the edge in `outCounts` and not in `nonCurrentOutCounts` in process scope', async () => {
      const { query, verdict } = await verdictSupportingEvidenceOfRun1(true);

      const page = query({ process: 'run-2', ids: [verdict], relations: 'counts' });

      expect(at(page.records, 0).outCounts).toEqual({ supports: 1 });
      expect(at(page.records, 0)).not.toHaveProperty('nonCurrentOutCounts');
    });

    it.each([
      ['nonCurrentOutCounts', 'outCounts', 'superseded', true],
      ['outCounts', 'nonCurrentOutCounts', 'current', false],
    ] as const)(
      'should count the edge in `%s` and not in `%s` in project scope when the target is %s',
      async (counted, absent, _state, supersedeEvidence) => {
        const { query, verdict } = await verdictSupportingEvidenceOfRun1(supersedeEvidence);

        const page = query({ scope: 'project', ids: [verdict], relations: 'counts' });

        expect(at(page.records, 0)[counted]).toEqual({ supports: 1 });
        expect(at(page.records, 0)).not.toHaveProperty(absent);
      },
    );
  });

  it('should carry the hint for an empty selection with a prefix that only matches without the dot boundary', async () => {
    const { query } = await seeded();

    const page = query({ process: 'run-1', targetPrefix: 'run.ste' });

    expect(page.records).toEqual([]);
    expect(page.hint).toContain('"run.ste"');
    expect(page.hint).toContain('"run.step"');
  });

  it.each([
    ['prefix with no similar target', { targetPrefix: 'run.nothing' }],
    ['selection with results', { targetPrefix: 'run.step' }],
    [
      'empty because of another filter, with a target that matches the prefix',
      { targetPrefix: 'run.step', type: 'nope' },
    ],
    ['without targetPrefix', { type: 'nope' }],
  ])('should carry no hint: %s', async (_title, filters) => {
    const { query } = await seeded();

    expect(query({ process: 'run-1', ...filters })).not.toHaveProperty('hint');
  });

  it('should replace `in` and `out` with `inCounts` and `outCounts` keyed by relation name in counts mode', async () => {
    const { query, evidence, newer } = await wired();

    const page = query({
      process: 'run-1',
      ids: [evidence, newer],
      includeNonCurrent: true,
      relations: 'counts',
    });

    expect(at(page.records, 0)).not.toHaveProperty('in');
    expect(at(page.records, 0)).not.toHaveProperty('out');
    expect(at(page.records, 0).inCounts).toEqual({ approves: 2, supports: 1, supersedes: 1 });
    expect(at(page.records, 1).nonCurrentOutCounts).toEqual({ supersedes: 1 });
  });

  it('should omit empty count maps in counts mode', async () => {
    const { query, evidence, newer } = await wired();

    const page = query({
      process: 'run-1',
      ids: [evidence, newer],
      includeNonCurrent: true,
      relations: 'counts',
    });

    expect(at(page.records, 0)).not.toHaveProperty('outCounts');
    expect(at(page.records, 1)).not.toHaveProperty('inCounts');
  });

  it('should list in `inCounts` only the kinds that have edges', async () => {
    const { query, evidence } = await wired();

    const page = query({
      process: 'run-1',
      ids: [evidence],
      includeNonCurrent: true,
      relations: 'counts',
    });

    expect(Object.keys(at(page.records, 0).inCounts ?? {})).toEqual([
      'approves',
      'supports',
      'supersedes',
    ]);
  });

  it('should omit `in`, `out` and both count maps in none mode', async () => {
    const { query, evidence } = await wired();

    const page = query({
      process: 'run-1',
      ids: [evidence],
      includeNonCurrent: true,
      relations: 'none',
    });

    for (const key of [
      'in',
      'out',
      'inCounts',
      'outCounts',
      'nonCurrentInCounts',
      'nonCurrentOutCounts',
    ]) {
      expect(at(page.records, 0)).not.toHaveProperty(key);
    }
  });

  it('should match the default in full mode', async () => {
    const { query } = await wired();

    const withFull = query({ process: 'run-1', includeNonCurrent: true, relations: 'full' });
    const byDefault = query({ process: 'run-1', includeNonCurrent: true });

    expect(JSON.stringify(withFull)).toBe(JSON.stringify(byDefault));
    expect(at(byDefault.records, 0).in).toHaveLength(4);
  });

  it.each(['counts', 'none', 'full'] as const)(
    'should keep `needsReview` and `attachmentStatus` in %s mode',
    async (relations) => {
      const { createLegacyProcess, registerOne, attachments, query } = querySetup();
      createLegacyProcess('run-1');
      const kept = attachments.putText(PROJECT, 'guardado').hash;
      const evidence = await registerOne('run-1', note('evidência'), 1);
      const verdict = await registerOne(
        'run-1',
        doc({ body: kept }, { relations: [supports(evidence)] }),
        2,
      );
      await registerOne('run-1', note('evidência 2', { relations: [supersedes(evidence)] }), 3);

      const page = query({ process: 'run-1', ids: [verdict], relations });

      expect(at(page.records, 0).needsReview).toEqual({ staleIn: [], staleOut: [evidence] });
      expect(at(page.records, 0).attachmentStatus).toEqual({ [kept]: 'ok' });
    },
  );

  it('should move an edge from a superseded record to `nonCurrentInCounts` in counts mode', async () => {
    const { createProcess, registerOne, query } = querySetup();
    createProcess('run-1');
    const evidence = await registerOne('run-1', note('evidence'), 1);
    const support = await registerOne(
      'run-1',
      note('support', { relations: [supports(evidence)] }),
      2,
    );
    await registerOne('run-1', note('support 2', { relations: [supersedes(support)] }), 3);

    const full = query({ process: 'run-1', ids: [evidence], relations: 'full' });
    const counts = query({ process: 'run-1', ids: [evidence], relations: 'counts' });

    expect(at(full.records, 0).in).toEqual([{ kind: 'supports', from: support, current: false }]);
    expect(at(counts.records, 0)).toMatchObject({ nonCurrentInCounts: { supports: 1 } });
    expect(at(counts.records, 0)).not.toHaveProperty('inCounts');
  });

  describe('with a revoked premise', () => {
    async function withRevokedPremise() {
      const setup = querySetup();
      setup.createProcess('run-1');
      const { registerOne } = setup;
      const decision = await registerOne('run-1', note('decision'), 1);
      const premise = await registerOne(
        'run-1',
        note('premise', { relations: [supports(decision)] }),
        2,
      );
      await registerOne('run-1', note('current support', { relations: [supports(decision)] }), 3);
      await registerOne(
        'run-1',
        note('revoker', { relations: [{ to: premise, kind: 'revokes' }] }),
        4,
      );
      return { ...setup, decision, premise };
    }

    it('should split the supports of a decision between `inCounts` and `nonCurrentInCounts` when a premise is revoked', async () => {
      const { query, decision } = await withRevokedPremise();

      const page = query({ process: 'run-1', ids: [decision], relations: 'counts' });

      expect(at(page.records, 0)).toMatchObject({
        inCounts: { supports: 1 },
        nonCurrentInCounts: { supports: 1 },
      });
    });

    it('should keep the edge from the revoked premise to the current decision in its `outCounts`', async () => {
      const { query, premise } = await withRevokedPremise();

      const page = query({
        process: 'run-1',
        ids: [premise],
        includeNonCurrent: true,
        relations: 'counts',
      });

      expect(at(page.records, 0)).toMatchObject({ outCounts: { supports: 1 } });
      expect(at(page.records, 0)).not.toHaveProperty('nonCurrentOutCounts');
    });

    it('should omit each empty count map independently of the others', async () => {
      const { query, decision, premise } = await withRevokedPremise();

      const countKeys = (record: object) =>
        Object.keys(record).filter((key) => key.endsWith('Counts'));

      const page = query({
        process: 'run-1',
        ids: [decision, premise],
        includeNonCurrent: true,
        relations: 'counts',
      });

      expect(countKeys(at(page.records, 0))).toEqual(['inCounts', 'nonCurrentInCounts']);
      expect(countKeys(at(page.records, 1))).toEqual(['inCounts', 'outCounts']);
    });
  });
});
