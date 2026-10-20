import { describe, expect, test } from '@jest/globals';
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

describe('register: destinations in another process (D-10)', () => {
  test('supports to a current record of another process writes, reading each destination once and without locking it', async () => {
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

  test('two distinct destinations: each is read once, even with several relations to it', async () => {
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

  test('the second relation to the same destination violates a rule without reading the destination again', async () => {
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
    const readsNow = harness.processes.counters.reads.filter((read) => read === OTHER).length;
    expect(readsNow).toBe(readsBefore + 1);
  });

  test('a nonexistent destination process is RELATION_NOT_FOUND missing, at the relation path', async () => {
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

  test('a nonexistent record in an existing process is RELATION_NOT_FOUND missing', async () => {
    const harness = setup();
    await seed(harness, OTHER);

    const error = await refusal(harness.register([relating(ghostId(OTHER), 'supports')]));

    expect(error).toMatchObject({ code: 'RELATION_NOT_FOUND', details: [{ code: 'missing' }] });
  });

  test.each([
    ['broken chain', (h: Harness) => h.processes.setText(OTHER, '{"links":[1]}\n')],
    ['unreadable manifest', (h: Harness) => h.processes.flags.unreadable.add(OTHER)],
  ])(
    'destination with %s is RELATION_NOT_FOUND destination-corrupted with the process',
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

  test('supports to a superseded destination is stale-destination with the current version', async () => {
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

  test.each(['contradicts', 'answers', 'derivesFrom', 'complements', 'reopens'] as const)(
    '%s to a superseded destination does not check vigency: only supports does',
    async (kind) => {
      const harness = setup();
      const target = await seed(harness, OTHER);
      await harness.register([relating(target, 'supersedes', 'v2')], {}, OTHER);

      const result = await harness.register([relating(target, kind)]);

      expect(result.replayed).toBe(false);
    },
  );

  test('as with endpoints by type: a type outside from is endpoint-type', async () => {
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

  test('PROCESS_TOO_LARGE reading the destination points at the relation `to` and names the destination', async () => {
    const harness = setup();
    const target = await seed(harness, OTHER);
    harness.processes.flags.tooLarge.add(OTHER);

    const error = await refusal(harness.register([relating(target, 'supports')]));

    expect(error).toMatchObject({
      code: 'PROCESS_TOO_LARGE',
      details: [{ path: '/records/0/relations/0/to', code: 'too-large', process: OTHER }],
    });
  });

  test('IO_ERROR reading the destination points at the relation `to` and names the destination', async () => {
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

describe('register: D-10 rules within the own process', () => {
  test('supersedes of an already superseded record is FORK_REJECTED with the current version', async () => {
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

  test('fork: revokes of an already superseded record is FORK_REJECTED with the current version', async () => {
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

  test.each(['revokes', 'supersedes'] as const)(
    'a revoked lineage is closed: %s of it is FORK_REJECTED with current null',
    async (kind) => {
      const harness = setup();
      const first = await seed(harness, ORIGIN, 'v1');
      await harness.register([relating(first, 'revokes', 'cancel')]);

      const error = await refusal(harness.register([relating(first, kind)]));

      expect(error).toMatchObject({ code: 'FORK_REJECTED', details: [{ current: null }] });
    },
  );

  test('two supersedes of the same target in the batch: the second is FORK_REJECTED, pointing at the item', async () => {
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

  test.each([
    ['supersedes before supports', ['supersedes', 'supports'], 1],
    ['supports before supersedes', ['supports', 'supersedes'], 0],
  ] as const)(
    'supports checks the vigency of the whole batch: %s is stale-destination',
    async (_case, kinds, supportsAt) => {
      const harness = setup();
      const target = await seed(harness, ORIGIN, 'e');

      const error = await refusal(
        harness.register([note('v2', { relations: kinds.map((kind) => ({ to: target, kind })) })]),
      );

      expect(error).toMatchObject({
        code: 'INVALID_RECORD',
        details: [{ path: `/records/0/relations/${supportsAt}`, code: 'stale-destination' }],
      });
    },
  );

  test('supports from a later batch item to the record an earlier item superseded', async () => {
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

  test('supersedes between different types is type-mismatch', async () => {
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

  test('supersedes to a record of another target is target-mismatch and nothing is written', async () => {
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

  test('supersedes by alias to a batch item on another target is target-mismatch on the item', async () => {
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

  test('revokes of a record of another target is accepted', async () => {
    const harness = setup();
    const previous = await seed(harness, ORIGIN, 'e');

    const result = await harness.register([
      note('x', { target: 'run.other', relations: [{ to: previous, kind: 'revokes' }] }),
    ]);

    expect(result.replayed).toBe(false);
  });

  test('the recommended way to change target is accepted: revokes on the old one and a new record with derivesFrom', async () => {
    const harness = setup();
    const previous = await seed(harness, ORIGIN, 'e');

    const result = await harness.register([
      note('revoke', { relations: [{ to: previous, kind: 'revokes' }] }),
      note('moved', {
        target: 'run.other',
        relations: [{ to: previous, kind: 'derivesFrom' }],
      }),
    ]);

    expect(result.records).toHaveLength(2);
  });

  test.each([
    ['supports and contradicts', ['supports', 'contradicts'], 'supports-and-contradicts'],
    ['supersedes and revokes', ['supersedes', 'revokes'], 'supersedes-and-revokes'],
  ] as const)('%s to the same destination is %s', async (_case, kinds, code) => {
    const harness = setup();
    const target = await seed(harness, ORIGIN, 'e');

    const error = await refusal(
      harness.register([note('x', { relations: kinds.map((kind) => ({ to: target, kind })) })]),
    );

    expect(error).toMatchObject({ code: 'INVALID_RECORD', details: [{ code }] });
  });

  test('an id of the own process that does not exist is RELATION_NOT_FOUND missing', async () => {
    const harness = setup();

    const error = await refusal(harness.register([relating(ghostId(ORIGIN), 'supports')]));

    expect(error).toMatchObject({
      code: 'RELATION_NOT_FOUND',
      details: [{ path: '/records/0/relations/0', code: 'missing' }],
    });
  });

  test('the batch cites an earlier item by alias: chained supersedes inside the batch is accepted', async () => {
    const harness = setup();

    const result = await harness.register([
      note('v1', { alias: 'v1' }),
      note('v2', { alias: 'v2', relations: [{ to: '@v1', kind: 'supersedes' }] }),
    ]);

    expect(result.replayed).toBe(false);
  });

  test('hasCycle refuses with CYCLE_REJECTED, with the edge hand-built at the source', async () => {
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

    expect(error).toMatchObject({ code: 'CYCLE_REJECTED', details: [{ path: '', code: 'cycle' }] });
    expect(harness.processes.counters.appends).toBe(0);
  });
});

describe('register: all or nothing on state refusals (SE1)', () => {
  /** Monta o estado e devolve o item que viola a regra; vai sempre como terceiro de um lote de três. */
  type Violation = (harness: Harness) => Promise<BatchItem>;
  const supersededTarget = async (harness: Harness) => {
    const first = await seed(harness, ORIGIN, 'v1');
    await harness.register([relating(first, 'supersedes', 'v2')]);
    return first;
  };

  test.each([
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
    'all or nothing: %s on the third item of a three-item batch does not write the two before',
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

describe('register: attachments (D-16)', () => {
  const hash = sha256hex('anexo');

  test('a marked field with an intact attachment writes, and each hash is queried once per call', async () => {
    const harness = setup();
    harness.attachments.set(hash, 'ok');

    const result = await harness.register([doc({ body: hash }), doc({ files: [hash, hash] })]);

    expect(result.replayed).toBe(false);
    expect(harness.attachments.calls).toEqual([hash]);
  });

  test('a record with two marked fields (body and files): both are checked', async () => {
    const harness = setup();
    const other = sha256hex('outro anexo');
    harness.attachments.set(hash, 'ok');
    harness.attachments.set(other, 'ok');

    const result = await harness.register([doc({ body: hash, files: [other] })]);

    expect(result.replayed).toBe(false);
    expect(harness.attachments.calls).toEqual([hash, other]);
  });

  test('a record with two marked fields: the missing second one is refused at its own path', async () => {
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

  test.each([
    ['nonexistent', 'missing', 'ATTACHMENT_NOT_FOUND', 'not-found'],
    ['corrupted', 'corrupted', 'ATTACHMENT_CORRUPTED', 'corrupted'],
  ] as const)('attachment %s in a marked field is %s', async (_case, status, code, subcode) => {
    const harness = setup();
    harness.attachments.set(hash, status);

    const error = await refusal(harness.register([note('a'), doc({ body: hash })]));

    expect(error).toMatchObject({
      code,
      details: [{ path: '/records/1/data/body', code: subcode }],
    });
    expect(harness.processes.counters.appends).toBe(0);
  });

  test('a nonexistent item of a marked attachment list is also refused', async () => {
    const harness = setup();
    harness.attachments.set(hash, 'ok');

    const error = await refusal(harness.register([doc({ files: [hash, sha256hex('outro')] })]));

    expect(error).toMatchObject({
      code: 'ATTACHMENT_NOT_FOUND',
      details: [{ path: '/records/0/data/files' }],
    });
  });

  test.each([
    ['field', { note: hash }],
    ['string list item', { notes: ['texto', hash] }],
  ])(
    'attachment hash stored in %s without the mark is unmarked-attachment',
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

  test('a corrupted attachment also counts as stored for the mark guard', async () => {
    const harness = setup();
    harness.attachments.set(hash, 'corrupted');

    const error = await refusal(harness.register([doc({ note: hash })]));

    expect(error).toMatchObject({ details: [{ code: 'unmarked-attachment' }] });
  });

  test.each([
    ['attachment hash that was never stored', { note: hash }],
    ['text that is not shaped like a sha256', { note: 'abc' }],
    ['uppercase sha256', { note: hash.toUpperCase() }],
  ])('%s passes the mark guard', async (_case, data) => {
    const harness = setup();

    const result = await harness.register([doc(data)]);

    expect(result.replayed).toBe(false);
  });

  test('the data hash is not the /hash field the port assumes: the INVALID_INPUT path is rebuilt', async () => {
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

  test('with no attachment field or hash-shaped string, the attachment port is not even called', async () => {
    const harness = setup();

    await harness.register([note('a'), doc({ note: 'x', notes: ['y'] })]);

    expect(harness.attachments.calls).toEqual([]);
  });
});

describe('register: order of the state checks (level 6)', () => {
  const hash = sha256hex('anexo');

  test('a destination in another process comes before the attachment', async () => {
    const harness = setup();

    const error = await refusal(
      harness.register([relating(ghostId('nowhere'), 'supports'), doc({ body: hash })]),
    );

    expect(error.code).toBe('RELATION_NOT_FOUND');
  });

  test('the attachment comes before the own-process rules', async () => {
    const harness = setup();
    const target = await seed(harness, ORIGIN, 'e');
    await harness.register([relating(target, 'supersedes', 'v2')]);

    const error = await refusal(
      harness.register([relating(target, 'supersedes', 'fork'), doc({ body: hash })]),
    );

    expect(error.code).toBe('ATTACHMENT_NOT_FOUND');
  });
});

describe('register: PROCESS_TOO_LARGE at two points (D-06)', () => {
  test('on the read under the lock, before decide: a log above the cap refuses even a valid batch, without writing', async () => {
    const harness = setup();
    harness.processes.flags.tooLarge.add(ORIGIN);

    const error = await refusal(harness.register([note()]));

    expect(error.code).toBe('PROCESS_TOO_LARGE');
    expect(harness.processes.counters.appends).toBe(0);
  });

  test('the batch shape (level 1) comes before any read: a malformed batch on a source above the cap gives INVALID_INPUT', async () => {
    const harness = setup();
    harness.processes.flags.tooLarge.add(ORIGIN);

    const error = await refusal(harness.register([]));

    expect(error).toMatchObject({
      code: 'INVALID_INPUT',
      details: [{ path: '/records', code: 'batch-size' }],
    });
    expect(harness.processes.counters.reads).toEqual([]);
  });

  test('the manifest comes from readManifest, without the log: the static refusal beats PROCESS_TOO_LARGE', async () => {
    const harness = setup();
    harness.processes.flags.tooLarge.add(ORIGIN);

    const error = await refusal(harness.register([{ ...note(), data: {} }]));

    expect(error.code).toBe('INVALID_RECORD');
    expect(harness.processes.counters).toMatchObject({ writes: 0, appends: 0 });
  });

  test('the veto comes after the checks: a batch that violates D-10 and would pass the cap gives the violation', async () => {
    const harness = setup();
    harness.processes.flags.maxBytes = 1;

    const error = await refusal(harness.register([relating(ghostId(ORIGIN), 'supports')]));

    expect(error.code).toBe('RELATION_NOT_FOUND');
  });

  test('replay does not go through the veto: an already written key returns replayed even with the cap exceeded', async () => {
    const harness = setup();
    await harness.register([note('a')], { key: 'k' });
    harness.processes.flags.maxBytes = 1;

    const again = await harness.register([note('a')], { key: 'k' });

    expect(again.replayed).toBe(true);
  });
});

describe('register: invalid built line', () => {
  test('a uuid outside the v7 format gives INTERNAL without writing or leaking the id', async () => {
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
