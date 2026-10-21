import { describe, expect, it } from '@jest/globals';
import { anchor, hashLink, sha256hex, type Link } from '../../src/domain/chain.ts';
import type { BatchItem, Relation } from '../../src/domain/record.ts';
import { HexlogError } from '../../src/errors.ts';
import { formatLine } from '../../src/shared/loader.ts';
import { at } from '../helpers.ts';
import {
  AUTHOR,
  NOW,
  ORIGIN,
  ghostId,
  manifestOf,
  note,
  refusal,
  setup,
  verifiedOf,
} from './register-fakes.ts';

type Harness = ReturnType<typeof setup>;

const OTHER = 'other-run';
const THIRD = 'third-run';
const doc = (data: BatchItem['data']): BatchItem => ({
  type: 'doc',
  target: 'run.doc',
  data,
});
const relating = (to: string, kind: Relation['kind'], text = 'r'): BatchItem =>
  note(text, { relations: [{ to, kind }] });

/** Grava um registro num processo próprio e devolve o id, para os outros citarem. */
async function seed(harness: Harness, process: string, text = 'destino'): Promise<string> {
  if (process !== ORIGIN) harness.processes.add(process);
  const result = await harness.register([note(text)], {}, process);
  return at(result.records, 0).id;
}

describe('register', () => {
  describe('when the destination is in another process', () => {
    it('should write a supports to a current record of another process, reading each destination once and without locking it', async () => {
      const harness = setup();
      const target = await seed(harness, OTHER);
      const { counters } = harness.processes;
      const readsBefore = counters.reads.filter((process) => process === OTHER).length;
      const writesBefore = counters.writes;

      const result = await harness.register([
        relating(target, 'supports'),
        relating(target, 'derivesFrom'),
      ]);

      expect(result.replayed).toBe(false);
      expect(counters.reads.filter((process) => process === OTHER)).toHaveLength(readsBefore + 1);
      expect(counters.writes).toBe(writesBefore + 1);
      expect(verifiedOf(harness.processes).records[0]?.relations).toEqual([
        { kind: 'supports', to: target },
      ]);
    });

    it('should read each of two distinct destinations once, even with several relations to it', async () => {
      const harness = setup();
      const first = await seed(harness, OTHER, 'a');
      const second = await seed(harness, THIRD, 'b');
      const { counters } = harness.processes;
      const readsOf = (process: string) => counters.reads.filter((read) => read === process).length;
      const before = { [OTHER]: readsOf(OTHER), [THIRD]: readsOf(THIRD) };

      const result = await harness.register([
        relating(first, 'supports'),
        relating(second, 'supports'),
        relating(first, 'derivesFrom'),
        relating(second, 'derivesFrom'),
      ]);

      expect(result.replayed).toBe(false);
      expect(readsOf(OTHER)).toBe(before[OTHER] + 1);
      expect(readsOf(THIRD)).toBe(before[THIRD] + 1);
    });

    it('should refuse a second relation to the same destination that violates a rule, without reading the destination again', async () => {
      const harness = setup();
      const target = await seed(harness, OTHER);
      const readsBefore = harness.processes.counters.reads.filter((read) => read === OTHER).length;

      const error = await refusal(
        harness.register([
          relating(target, 'supports'),
          note('b', { relations: [{ to: target, as: 'only-tasks' }] }),
        ]),
      );

      expect(error).toMatchObject({
        code: 'INVALID_RECORD',
        details: [{ path: '/records/1/relations/0', code: 'endpoint-type' }],
      });
      expect(harness.processes.counters.reads.filter((read) => read === OTHER)).toHaveLength(
        readsBefore + 1,
      );
    });

    it('should refuse a nonexistent destination process with RELATION_NOT_FOUND missing, at the relation path', async () => {
      const harness = setup();
      await harness.register([note()]);

      const error = await refusal(
        harness.register([note('a'), relating(ghostId('nowhere'), 'supports')]),
      );

      expect(error).toMatchObject({
        code: 'RELATION_NOT_FOUND',
        details: [{ path: '/records/1/relations/0', code: 'missing' }],
      });
      expect(harness.processes.counters.appends).toBe(1);
    });

    it('should refuse a nonexistent record in an existing process with RELATION_NOT_FOUND missing', async () => {
      const harness = setup();
      await seed(harness, OTHER);

      const error = await refusal(harness.register([relating(ghostId(OTHER), 'supports')]));

      expect(error).toMatchObject({ code: 'RELATION_NOT_FOUND', details: [{ code: 'missing' }] });
    });

    it.each([
      ['a broken chain', (h: Harness) => h.processes.setText(OTHER, '{"links":[1]}\n')],
      ['an unreadable manifest', (h: Harness) => h.processes.flags.unreadable.add(OTHER)],
    ])(
      'should refuse a destination with %s with RELATION_NOT_FOUND destination-corrupted, naming the process',
      async (_case, corrupt) => {
        const harness = setup();
        const target = await seed(harness, OTHER);
        corrupt(harness);

        const error = await refusal(harness.register([relating(target, 'supports')]));

        expect(error).toMatchObject({
          code: 'RELATION_NOT_FOUND',
          details: [
            { path: '/records/0/relations/0', code: 'destination-corrupted', process: OTHER },
          ],
        });
        expect(harness.processes.counters.appends).toBe(1);
      },
    );

    it('should refuse a supports to a superseded destination as stale-destination with the current version', async () => {
      const harness = setup();
      const target = await seed(harness, OTHER);
      const successor = await harness.register([relating(target, 'supersedes', 'v2')], {}, OTHER);

      const error = await refusal(harness.register([relating(target, 'supports')]));

      expect(error).toMatchObject({
        code: 'INVALID_RECORD',
        details: [
          {
            path: '/records/0/relations/0',
            code: 'stale-destination',
            current: at(successor.records, 0).id,
          },
        ],
      });
    });

    it.each(['contradicts', 'answers', 'derivesFrom', 'complements', 'reopens'] as const)(
      'should accept a %s to a superseded destination, since only supports checks vigency',
      async (kind) => {
        const harness = setup();
        const target = await seed(harness, OTHER);
        await harness.register([relating(target, 'supersedes', 'v2')], {}, OTHER);

        const result = await harness.register([relating(target, kind)]);

        expect(result.replayed).toBe(false);
      },
    );

    it('should refuse a type outside from as endpoint-type when `as` restricts the endpoints by type', async () => {
      const harness = setup();
      const target = await seed(harness, OTHER);

      const error = await refusal(
        harness.register([note('a', { relations: [{ to: target, as: 'only-tasks' }] })]),
      );

      expect(error).toMatchObject({
        code: 'INVALID_RECORD',
        details: [{ path: '/records/0/relations/0', code: 'endpoint-type' }],
      });
    });

    it('should point PROCESS_TOO_LARGE at the relation `to` and name the destination when reading it', async () => {
      const harness = setup();
      const target = await seed(harness, OTHER);
      harness.processes.flags.tooLarge.add(OTHER);

      const error = await refusal(harness.register([relating(target, 'supports')]));

      expect(error).toMatchObject({
        code: 'PROCESS_TOO_LARGE',
        details: [{ path: '/records/0/relations/0/to', code: 'too-large', process: OTHER }],
      });
    });

    it('should point IO_ERROR at the relation `to` and name the destination when reading it', async () => {
      const harness = setup();
      const target = await seed(harness, OTHER);
      const { store } = harness.processes;
      const read = store.read.bind(store);
      store.read = (ref) => {
        if (ref.process !== OTHER) return read(ref);
        throw new HexlogError('IO_ERROR', 'I/O failure', [
          { path: '', code: 'eio', message: 'I/O failure' },
        ]);
      };

      const error = await refusal(harness.register([relating(target, 'supports')]));

      expect(error).toMatchObject({
        code: 'IO_ERROR',
        details: [{ path: '/records/0/relations/0/to', code: 'eio', process: OTHER }],
      });
    });
  });

  describe('when the destination is in the own process', () => {
    it('should refuse a supersedes of an already superseded record with FORK_REJECTED and the current version', async () => {
      const harness = setup();
      const first = await seed(harness, ORIGIN, 'v1');
      const second = await harness.register([relating(first, 'supersedes', 'v2')]);

      const error = await refusal(harness.register([relating(first, 'supersedes', 'v2b')]));

      expect(error).toMatchObject({
        code: 'FORK_REJECTED',
        details: [
          {
            path: '/records/0/relations/0',
            code: 'not-current',
            current: at(second.records, 0).id,
          },
        ],
      });
      expect(harness.processes.counters.appends).toBe(2);
    });

    it('should refuse a revokes of an already superseded record with FORK_REJECTED and the current version', async () => {
      const harness = setup();
      const first = await seed(harness, ORIGIN, 'v1');
      const second = await harness.register([relating(first, 'supersedes', 'v2')]);

      const error = await refusal(harness.register([relating(first, 'revokes', 'cancel')]));

      expect(error).toMatchObject({
        code: 'FORK_REJECTED',
        details: [
          {
            path: '/records/0/relations/0',
            code: 'not-current',
            current: at(second.records, 0).id,
          },
        ],
      });
      expect(harness.processes.counters.appends).toBe(2);
    });

    it.each(['revokes', 'supersedes'] as const)(
      'should refuse a %s of a revoked lineage with FORK_REJECTED and a null current',
      async (kind) => {
        const harness = setup();
        const first = await seed(harness, ORIGIN, 'v1');
        await harness.register([relating(first, 'revokes', 'cancel')]);

        const error = await refusal(harness.register([relating(first, kind)]));

        expect(error).toMatchObject({ code: 'FORK_REJECTED', details: [{ current: null }] });
      },
    );

    it('should refuse the second of two supersedes of the same target in the batch with FORK_REJECTED, pointing at the item', async () => {
      const harness = setup();
      const first = await seed(harness, ORIGIN, 'v1');

      const error = await refusal(
        harness.register([
          note('a', { alias: 'a', relations: [{ to: first, kind: 'supersedes' }] }),
          relating(first, 'supersedes', 'b'),
        ]),
      );

      expect(error).toMatchObject({
        code: 'FORK_REJECTED',
        details: [{ path: '/records/1/relations/0', current: expect.stringMatching(/^run-1:/) }],
      });
    });

    it.each([
      ['supersedes before supports', ['supersedes', 'supports'], 1],
      ['supports before supersedes', ['supports', 'supersedes'], 0],
    ] as const)(
      'should refuse a supports as stale-destination when checking the vigency of the whole batch: %s',
      async (_case, kinds, supportsAt) => {
        const harness = setup();
        const target = await seed(harness, ORIGIN, 'e');

        const error = await refusal(
          harness.register([
            note('v2', { relations: kinds.map((kind) => ({ to: target, kind })) }),
          ]),
        );

        expect(error).toMatchObject({
          code: 'INVALID_RECORD',
          details: [{ path: `/records/0/relations/${supportsAt}`, code: 'stale-destination' }],
        });
      },
    );

    it('should refuse a supports from a later batch item to the record an earlier item superseded as stale-destination', async () => {
      const harness = setup();
      const target = await seed(harness, ORIGIN, 'e');

      const error = await refusal(
        harness.register([relating(target, 'supersedes', 'v2'), relating(target, 'supports', 's')]),
      );

      expect(error).toMatchObject({
        code: 'INVALID_RECORD',
        details: [{ path: '/records/1/relations/0', code: 'stale-destination' }],
      });
    });

    it('should refuse a supersedes between different types as type-mismatch', async () => {
      const harness = setup();
      const target = await seed(harness, ORIGIN, 'e');

      const error = await refusal(
        harness.register([
          {
            type: 'task',
            target: 'run.step',
            data: { text: 't' },
            relations: [{ to: target, kind: 'supersedes' }],
          },
        ]),
      );

      expect(error).toMatchObject({ details: [{ code: 'type-mismatch' }] });
    });

    it('should refuse a supersedes to a record of another target as target-mismatch and write nothing', async () => {
      const harness = setup();
      const previous = await seed(harness, ORIGIN, 'e');
      const logBefore = harness.processes.textOf(ORIGIN);

      const error = await refusal(
        harness.register([
          note('x', { target: 'run.other', relations: [{ to: previous, kind: 'supersedes' }] }),
        ]),
      );

      expect(error).toMatchObject({
        code: 'INVALID_RECORD',
        details: [
          {
            path: '/records/0/relations/0',
            code: 'target-mismatch',
            message: expect.stringMatching(/revoke.*derivesFrom/),
          },
        ],
      });
      expect(harness.processes.textOf(ORIGIN)).toBe(logBefore);
    });

    it('should refuse a supersedes by alias to a batch item on another target as target-mismatch on the item', async () => {
      const harness = setup();

      const error = await refusal(
        harness.register([
          note('a', { alias: 'a' }),
          note('b', { target: 'run.other', relations: [{ to: '@a', kind: 'supersedes' }] }),
        ]),
      );

      expect(error).toMatchObject({
        code: 'INVALID_RECORD',
        details: [{ path: '/records/1/relations/0', code: 'target-mismatch' }],
      });
    });

    it('should accept a revokes of a record of another target', async () => {
      const harness = setup();
      const previous = await seed(harness, ORIGIN, 'e');

      const result = await harness.register([
        note('x', { target: 'run.other', relations: [{ to: previous, kind: 'revokes' }] }),
      ]);

      expect(result.replayed).toBe(false);
    });

    it('should accept the recommended way to change target: one record at the new target with revokes and derivesFrom to the old one', async () => {
      const harness = setup();
      const previous = await seed(harness, ORIGIN, 'e');

      const result = await harness.register([
        note('moved', {
          target: 'run.other',
          relations: [
            { to: previous, kind: 'revokes' },
            { to: previous, kind: 'derivesFrom' },
          ],
        }),
      ]);

      expect(result.records).toHaveLength(1);
    });

    it.each([
      ['supports and contradicts', ['supports', 'contradicts'], 'supports-and-contradicts'],
      ['supersedes and revokes', ['supersedes', 'revokes'], 'supersedes-and-revokes'],
    ] as const)('should refuse %s to the same destination', async (_case, kinds, code) => {
      const harness = setup();
      const target = await seed(harness, ORIGIN, 'e');

      const error = await refusal(
        harness.register([note('x', { relations: kinds.map((kind) => ({ to: target, kind })) })]),
      );

      expect(error).toMatchObject({ code: 'INVALID_RECORD', details: [{ code }] });
    });

    it('should refuse an id of the own process that does not exist with RELATION_NOT_FOUND missing', async () => {
      const harness = setup();

      const error = await refusal(harness.register([relating(ghostId(ORIGIN), 'supports')]));

      expect(error).toMatchObject({
        code: 'RELATION_NOT_FOUND',
        details: [{ path: '/records/0/relations/0', code: 'missing' }],
      });
    });

    it('should accept a chained supersedes inside the batch that cites an earlier item by alias', async () => {
      const harness = setup();

      const result = await harness.register([
        note('v1', { alias: 'v1' }),
        note('v2', { alias: 'v2', relations: [{ to: '@v1', kind: 'supersedes' }] }),
      ]);

      expect(result.replayed).toBe(false);
    });

    it('should refuse with CYCLE_REJECTED, through hasCycle, when the edge is hand-built at the source', async () => {
      const harness = setup();
      const [a, b] = [
        `${ORIGIN}:00000000-0000-7000-8000-00000000aaa1`,
        `${ORIGIN}:00000000-0000-7000-8000-00000000aaa2`,
      ];
      const base = {
        type: 'note',
        at: NOW.toISOString(),
        target: 'run.step',
        author: AUTHOR,
        data: { text: 'x' },
      };
      const first: Link = {
        ...base,
        seq: 0,
        id: a,
        relations: [{ kind: 'supersedes', to: b }],
        prevHash: anchor(manifestOf(ORIGIN)),
      };
      const second: Link = {
        ...base,
        seq: 1,
        id: b,
        relations: [{ kind: 'supersedes', to: a }],
        prevHash: hashLink(first),
      };
      harness.processes.setText(ORIGIN, formatLine([first, second]));

      expect(verifiedOf(harness.processes).chain.ok).toBe(true);

      const error = await refusal(harness.register([note()]));

      expect(error).toMatchObject({
        code: 'CYCLE_REJECTED',
        details: [{ path: '', code: 'cycle' }],
      });
      expect(harness.processes.counters.appends).toBe(0);
    });
  });

  describe('when a state refusal hits a batch', () => {
    /** Monta o estado e devolve o item que viola a regra; vai sempre como terceiro de um lote de três. */
    type Violation = (harness: Harness) => Promise<BatchItem>;
    const supersededTarget = async (harness: Harness) => {
      const first = await seed(harness, ORIGIN, 'v1');
      await harness.register([relating(first, 'supersedes', 'v2')]);
      return first;
    };

    it.each([
      [
        'FORK_REJECTED',
        'FORK_REJECTED',
        'not-current',
        async (harness) => relating(await supersededTarget(harness), 'supersedes', 'fork'),
      ],
      [
        'stale-destination',
        'INVALID_RECORD',
        'stale-destination',
        async (harness) => relating(await supersededTarget(harness), 'supports', 's'),
      ],
      [
        'type-mismatch',
        'INVALID_RECORD',
        'type-mismatch',
        async (harness) => ({
          type: 'task',
          target: 'run.step',
          data: { text: 't' },
          relations: [{ to: await seed(harness, ORIGIN, 'e'), kind: 'supersedes' }],
        }),
      ],
      [
        'target-mismatch',
        'INVALID_RECORD',
        'target-mismatch',
        async (harness) =>
          note('x', {
            target: 'run.other',
            relations: [{ to: await seed(harness, ORIGIN, 'e'), kind: 'supersedes' }],
          }),
      ],
      [
        'supports-and-contradicts',
        'INVALID_RECORD',
        'supports-and-contradicts',
        async (harness) => {
          const to = await seed(harness, ORIGIN, 'e');
          return note('x', {
            relations: [
              { to, kind: 'supports' },
              { to, kind: 'contradicts' },
            ],
          });
        },
      ],
      [
        'supersedes-and-revokes',
        'INVALID_RECORD',
        'supersedes-and-revokes',
        async (harness) => {
          const to = await seed(harness, ORIGIN, 'e');
          return note('x', {
            relations: [
              { to, kind: 'supersedes' },
              { to, kind: 'revokes' },
            ],
          });
        },
      ],
      [
        'endpoint-type',
        'INVALID_RECORD',
        'endpoint-type',
        async (harness) =>
          note('a', { relations: [{ to: await seed(harness, ORIGIN, 'e'), as: 'only-tasks' }] }),
      ],
    ] as [string, string, string, Violation][])(
      'should not write the two earlier items when %s hits the third item of a three-item batch',
      async (_case, code, detail, violate) => {
        const harness = setup();
        const failing = await violate(harness);
        const logBefore = harness.processes.textOf(ORIGIN);
        const { appends } = harness.processes.counters;

        const error = await refusal(harness.register([note('a'), note('b'), failing]));

        expect(error).toMatchObject({
          code,
          details: [{ path: '/records/2/relations/0', code: detail }],
        });
        expect(harness.processes.counters.appends).toBe(appends);
        expect(harness.processes.textOf(ORIGIN)).toBe(logBefore);
      },
    );
  });

  describe('with attachment fields', () => {
    const hash = sha256hex('anexo');

    it('should write a marked field with an intact attachment, querying each hash once per call', async () => {
      const harness = setup();
      harness.attachments.set(hash, 'ok');

      const result = await harness.register([doc({ body: hash }), doc({ files: [hash, hash] })]);

      expect(result.replayed).toBe(false);
      expect(harness.attachments.calls).toEqual([hash]);
    });

    it('should check both marked fields of a record, body and files', async () => {
      const harness = setup();
      const other = sha256hex('outro anexo');
      harness.attachments.set(hash, 'ok');
      harness.attachments.set(other, 'ok');

      const result = await harness.register([doc({ body: hash, files: [other] })]);

      expect(result.replayed).toBe(false);
      expect(harness.attachments.calls).toEqual([hash, other]);
    });

    it('should refuse the missing second marked field of a record at its own path', async () => {
      const harness = setup();
      harness.attachments.set(hash, 'ok');

      const error = await refusal(
        harness.register([doc({ body: hash, files: [sha256hex('outro anexo')] })]),
      );

      expect(error).toMatchObject({
        code: 'ATTACHMENT_NOT_FOUND',
        details: [{ path: '/records/0/data/files', code: 'not-found' }],
      });
    });

    it.each([
      ['nonexistent', 'missing', 'ATTACHMENT_NOT_FOUND', 'not-found'],
      ['corrupted', 'corrupted', 'ATTACHMENT_CORRUPTED', 'corrupted'],
    ] as const)(
      'should refuse a %s attachment in a marked field',
      async (_case, status, code, subcode) => {
        const harness = setup();
        harness.attachments.set(hash, status);

        const error = await refusal(harness.register([note('a'), doc({ body: hash })]));

        expect(error).toMatchObject({
          code,
          details: [{ path: '/records/1/data/body', code: subcode }],
        });
        expect(harness.processes.counters.appends).toBe(0);
      },
    );

    it('should also refuse a nonexistent item of a marked attachment list', async () => {
      const harness = setup();
      harness.attachments.set(hash, 'ok');

      const error = await refusal(harness.register([doc({ files: [hash, sha256hex('outro')] })]));

      expect(error).toMatchObject({
        code: 'ATTACHMENT_NOT_FOUND',
        details: [{ path: '/records/0/data/files' }],
      });
    });

    it.each([
      ['field', { note: hash }],
      ['string list item', { notes: ['texto', hash] }],
    ])(
      'should refuse an attachment hash stored in a %s without the mark as unmarked-attachment',
      async (_case, data) => {
        const harness = setup();
        harness.attachments.set(hash, 'ok');

        const error = await refusal(harness.register([doc(data)]));

        expect(error).toMatchObject({
          code: 'INVALID_RECORD',
          details: [
            {
              path: `/records/0/data/${Object.keys(data)[0]}`,
              code: 'unmarked-attachment',
              message: expect.stringContaining('create a new process'),
            },
          ],
        });
        expect(harness.processes.counters.appends).toBe(0);
      },
    );

    it('should count a corrupted attachment as stored for the mark guard', async () => {
      const harness = setup();
      harness.attachments.set(hash, 'corrupted');

      const error = await refusal(harness.register([doc({ note: hash })]));

      expect(error).toMatchObject({ details: [{ code: 'unmarked-attachment' }] });
    });

    it.each([
      ['attachment hash that was never stored', { note: hash }],
      ['text that is not shaped like a sha256', { note: 'abc' }],
      ['uppercase sha256', { note: hash.toUpperCase() }],
    ])('should let %s pass the mark guard', async (_case, data) => {
      const harness = setup();

      const result = await harness.register([doc(data)]);

      expect(result.replayed).toBe(false);
    });

    it('should rebuild the INVALID_INPUT path because the data hash is not the /hash field the port assumes', async () => {
      const harness = setup();
      harness.attachments.store.status = () => {
        throw new HexlogError('INVALID_INPUT', 'invalid hash', [
          { path: '/hash', code: 'invalid-hash', message: 'invalid hash' },
        ]);
      };

      const error = await refusal(harness.register([note('a'), doc({ body: hash })]));

      expect(error).toMatchObject({
        code: 'INVALID_INPUT',
        details: [{ path: '/records/1/data/body', code: 'invalid-hash' }],
      });
    });

    it('should not even call the attachment port with no attachment field or hash-shaped string', async () => {
      const harness = setup();

      await harness.register([note('a'), doc({ note: 'x', notes: ['y'] })]);

      expect(harness.attachments.calls).toEqual([]);
    });
  });

  describe('when more than one state check fails (level 6)', () => {
    const hash = sha256hex('anexo');

    it('should check a destination in another process before the attachment', async () => {
      const harness = setup();

      const error = await refusal(
        harness.register([relating(ghostId('nowhere'), 'supports'), doc({ body: hash })]),
      );

      expect(error.code).toBe('RELATION_NOT_FOUND');
    });

    it('should check the attachment before the own-process rules', async () => {
      const harness = setup();
      const target = await seed(harness, ORIGIN, 'e');
      await harness.register([relating(target, 'supersedes', 'v2')]);

      const error = await refusal(
        harness.register([relating(target, 'supersedes', 'fork'), doc({ body: hash })]),
      );

      expect(error.code).toBe('ATTACHMENT_NOT_FOUND');
    });
  });

  describe('with the size cap checked at two points', () => {
    it('should refuse even a valid batch, without writing, on the read under the lock before decide when the log is above the cap', async () => {
      const harness = setup();
      harness.processes.flags.tooLarge.add(ORIGIN);

      const error = await refusal(harness.register([note()]));

      expect(error.code).toBe('PROCESS_TOO_LARGE');
      expect(harness.processes.counters.appends).toBe(0);
    });

    it('should check the batch shape (level 1) before any read: a malformed batch on a source above the cap gives INVALID_INPUT', async () => {
      const harness = setup();
      harness.processes.flags.tooLarge.add(ORIGIN);

      const error = await refusal(harness.register([]));

      expect(error).toMatchObject({
        code: 'INVALID_INPUT',
        details: [{ path: '/records', code: 'batch-size' }],
      });
      expect(harness.processes.counters.reads).toEqual([]);
    });

    it('should take the manifest from readManifest, without the log, so the static refusal beats PROCESS_TOO_LARGE', async () => {
      const harness = setup();
      harness.processes.flags.tooLarge.add(ORIGIN);

      const error = await refusal(harness.register([{ ...note(), data: {} }]));

      expect(error.code).toBe('INVALID_RECORD');
      expect(harness.processes.counters).toMatchObject({ writes: 0, appends: 0 });
    });

    it('should give the violation of a batch that breaks the relation rules and would pass the cap, since the veto comes after the checks', async () => {
      const harness = setup();
      harness.processes.flags.maxBytes = 1;

      const error = await refusal(harness.register([relating(ghostId(ORIGIN), 'supports')]));

      expect(error.code).toBe('RELATION_NOT_FOUND');
    });

    it('should return replayed for an already written key even with the cap exceeded, since replay does not go through the veto', async () => {
      const harness = setup();
      await harness.register([note('a')], { key: 'k' });
      harness.processes.flags.maxBytes = 1;

      const again = await harness.register([note('a')], { key: 'k' });

      expect(again.replayed).toBe(true);
    });
  });

  describe('when the built line is invalid', () => {
    it('should give INTERNAL, without writing or leaking the id, for a uuid outside the v7 format', async () => {
      const harness = setup(() => 'not-a-uuid');

      const error = await refusal(harness.register([note('a')]));

      expect(error).toMatchObject({
        code: 'INTERNAL',
        message: 'built an invalid batch line',
        details: [],
      });
      expect(harness.processes.counters).toMatchObject({ appends: 0, syncsWithoutLine: 0 });
    });
  });
});
