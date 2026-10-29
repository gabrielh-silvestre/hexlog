import { afterEach, describe, expect, it, jest } from '@jest/globals';
import { fingerprint, sha256hex } from '../../src/domain/chain.ts';
import type { RecordType } from '../../src/domain/definitions.ts';
import { BATCH_MAX } from '../../src/domain/record.ts';
import type { BatchItem } from '../../src/domain/record.ts';
import {
  AUTHOR,
  ORIGIN,
  PROJECT,
  ghostId,
  manifestOf,
  note,
  refusal,
  setup,
  verifiedOf,
} from './fakes.ts';

const LIMITED: RecordType = {
  type: 'object',
  properties: { name: { type: 'string', maxLength: 3 }, count: { type: 'integer', minimum: 1 } },
  required: ['name', 'count'],
};

const LISTED: RecordType = {
  type: 'object',
  properties: { items: { type: 'array', items: { type: 'string' } } },
  required: ['items'],
};

const COSTLY: RecordType = {
  type: 'object',
  properties: {
    items: {
      type: 'array',
      items: { allOf: Array.from({ length: 900 }, () => ({ type: 'string' })) },
    },
  },
  required: ['items'],
};

const costly = (): BatchItem => ({
  type: 'costly',
  target: 'run.step',
  data: { items: Array.from({ length: 40 }, () => 1) },
});

const numbers = (length: number): BatchItem => ({
  type: 'listed',
  target: 'run.step',
  data: { items: Array.from({ length }, () => 1) },
});

const supersedesElsewhere = (): BatchItem =>
  note('x', { relations: [{ to: ghostId('other'), kind: 'supersedes' }] });

const notes = (count: number): BatchItem[] => Array.from({ length: count }, () => note());

describe('register', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  describe('when the batch is valid', () => {
    it('should write the batch as one line of chained links with the origin ids', async () => {
      const { register, processes } = setup();

      const result = await register([note('a'), note('b')], { key: 'k1' });
      const { records, chain } = verifiedOf(processes);

      expect(chain).toMatchObject({ ok: true, totalRecords: 2 });
      expect(processes.textOf(ORIGIN).split('\n')).toHaveLength(2);
      expect(records.map(({ seq }) => seq)).toEqual([0, 1]);
      expect(records.map(({ id }) => id)).toEqual(result.records.map(({ id }) => id));
    });

    it('should return the alias and the marker of the written batch', async () => {
      const { register } = setup();

      const result = await register([note('a', { alias: 'first' }), note('b')]);

      expect(result.records[0]).toEqual({ alias: 'first', id: expect.stringMatching(/^run-1:/) });
      expect(result.records[1]).not.toHaveProperty('alias');
      expect(result).toMatchObject({
        replayed: false,
        marker: { [ORIGIN]: result.records[1]?.id },
      });
    });

    it('should put batch only on the first link, with the fingerprint, the key and the aliases', async () => {
      const { register, processes } = setup();
      const items = [note('a', { alias: 'first' }), note('b')];

      const result = await register(items, { key: 'k1' });
      const [first, second] = verifiedOf(processes).records;

      expect(first?.batch).toEqual({
        fingerprint: fingerprint(items),
        key: 'k1',
        aliases: { first: result.records[0]?.id },
      });
      expect(second).not.toHaveProperty('batch');
    });

    it('should carry only the fingerprint in batch when there is no key or alias', async () => {
      const { register, processes } = setup();

      await register([note()]);

      expect(Object.keys(verifiedOf(processes).records[0]?.batch ?? {})).toEqual(['fingerprint']);
    });

    it('should continue the seq and the hash of the first batch in the second one', async () => {
      const { register, processes } = setup();
      await register([note('a')]);

      await register([note('b'), note('c')]);
      const verified = verifiedOf(processes);

      expect(verified.chain.ok).toBe(true);
      expect(verified.records.map(({ seq }) => seq)).toEqual([0, 1, 2]);
      expect(verified.end.seq).toBe(3);
    });

    it('should stamp the whole batch with the instant of the injected clock', async () => {
      const { register, processes, setNow } = setup();
      const later = new Date('2027-01-01T00:00:00.000Z');
      setNow(later);

      await register([note('a'), note('b')]);

      expect(verifiedOf(processes).records.map(({ at }) => at)).toEqual([
        later.toISOString(),
        later.toISOString(),
      ]);
    });

    it.each([
      ['the model is absent', { agent: 'a1', client: 'my-client' }],
      ['the model is given', AUTHOR],
    ])(
      'should record the author given by parameter on the link as it is, when %s',
      async (_case, author) => {
        const { register, processes } = setup();

        await register([note('a')], { author });

        expect(verifiedOf(processes).records[0]?.author).toStrictEqual(author);
      },
    );

    it('should write each relation with the id of the earlier item for @alias and the kind that as names', async () => {
      const { register, processes } = setup();

      const result = await register([
        note('a', { alias: 'base' }),
        note('b', {
          relations: [
            { to: '@base', as: 'approves' },
            { to: '@base', kind: 'derivesFrom' },
          ],
        }),
      ]);
      const baseId = result.records[0]?.id;

      expect(verifiedOf(processes).records[1]?.relations).toEqual([
        { kind: 'supports', to: baseId, as: 'approves' },
        { kind: 'derivesFrom', to: baseId },
      ]);
    });

    it('should accept a batch of exactly 50 items', async () => {
      const { register } = setup();

      const result = await register(notes(BATCH_MAX));

      expect(result.records).toHaveLength(BATCH_MAX);
    });

    it('should write the same batch again when there is no key', async () => {
      const { register, processes } = setup();
      const batch = notes(BATCH_MAX);
      await register(batch);

      const second = await register(batch);

      expect(second.replayed).toBe(false);
      expect(verifiedOf(processes).chain.totalRecords).toBe(2 * BATCH_MAX);
    });
  });

  describe('when the batch has the wrong shape', () => {
    it.each([
      ['empty', []],
      ['above 50 items', notes(BATCH_MAX + 1)],
    ])(
      'should refuse a batch that is %s with INVALID_INPUT batch-size, without reading the process',
      async (_case, batch) => {
        const { register, processes } = setup();

        const error = await refusal(register(batch));

        expect(error).toMatchObject({
          code: 'INVALID_INPUT',
          details: [{ path: '/records', code: 'batch-size' }],
        });
        expect(processes.counters.reads).toEqual([]);
      },
    );

    it('should point at the second use of a repeated alias', async () => {
      const { register } = setup();

      const error = await refusal(
        register([note('a', { alias: 'dup' }), note('b'), note('c', { alias: 'dup' })]),
      );

      expect(error).toMatchObject({
        code: 'INVALID_INPUT',
        details: [{ path: '/records/2/alias', code: 'duplicate-alias' }],
      });
    });

    it.each([
      ['a later item', 'later', 'forward-alias'],
      ['the item itself', 'self', 'forward-alias'],
      ['an alias that does not exist', 'nobody', 'unknown-alias'],
    ])('should refuse an @alias to %s', async (_case, alias, code) => {
      const { register, processes } = setup();

      const error = await refusal(
        register([
          note('a', { alias: 'self', relations: [{ to: `@${alias}`, kind: 'complements' }] }),
          note('b', { alias: 'later' }),
        ]),
      );

      expect(error).toMatchObject({
        code: 'INVALID_INPUT',
        details: [{ path: '/records/0/relations/0/to', code }],
      });
      expect(processes.counters.reads).toEqual([]);
    });
  });

  describe('when the origin manifest is read', () => {
    it('should refuse a nonexistent process with PROCESS_NOT_FOUND', async () => {
      const { register } = setup();

      const error = await refusal(register([note()], {}, 'ghost'));

      expect(error).toMatchObject({ code: 'PROCESS_NOT_FOUND', details: [{ path: '/process' }] });
    });

    it('should refuse an unreadable manifest before any static refusal', async () => {
      const { register, processes, validate } = setup();
      processes.flags.unreadable.add(ORIGIN);

      const error = await refusal(
        register([{ type: 'nobody', target: 'a', data: {}, relations: [] }, supersedesElsewhere()]),
      );

      expect(error).toMatchObject({
        code: 'PROCESS_CORRUPTED',
        details: [{ path: '/process', code: 'unreadable-manifest', process: ORIGIN }],
      });
      expect(validate).not.toHaveBeenCalled();
    });
  });

  describe('when a static check refuses the batch', () => {
    it.each(['nobody', 'constructor'])(
      'should refuse the type %s that the process did not pin with TYPE_NOT_PINNED, even with an Object.prototype name',
      async (type) => {
        const { register } = setup();

        const error = await refusal(register([note('a'), { ...note('b'), type }]));

        expect(error).toMatchObject({
          code: 'TYPE_NOT_PINNED',
          details: [{ path: '/records/1/type', code: 'not-pinned' }],
        });
      },
    );

    it('should refuse data outside the pinned schema with INVALID_RECORD, with the path rebuilt for the item', async () => {
      const { register } = setup();

      const error = await refusal(register([note('ok'), { ...note(), data: { text: 5 } }]));

      expect(error).toMatchObject({
        code: 'INVALID_RECORD',
        details: [{ path: '/records/1/data/text' }],
      });
    });

    it('should join in details the schema violations of every record of the batch', async () => {
      const { register, processes } = setup();

      const error = await refusal(
        register([note('ok'), { ...note(), data: { text: 5 } }, { ...note(), data: { text: 6 } }]),
      );

      expect(error.details.map(({ path, code }) => ({ path, code }))).toEqual([
        { path: '/records/1/data/text', code: 'type' },
        { path: '/records/2/data/text', code: 'type' },
      ]);
      expect(processes.counters.writes).toBe(0);
    });

    it('should return every violation of a record with several, with the record path', async () => {
      const { register } = setup();

      const error = await refusal(register([{ ...note(), data: { other: 1, extra: 2 } }]));

      expect(error.details.map(({ path, code }) => ({ path, code }))).toEqual([
        { path: '/records/0/data/text', code: 'required' },
        { path: '/records/0/data/other', code: 'additional-properties' },
        { path: '/records/0/data/extra', code: 'additional-properties' },
      ]);
    });

    it('should give every violation of each record when two records of the batch are invalid', async () => {
      const { register, processes } = setup();

      const error = await refusal(
        register([
          { ...note(), data: { other: 1, extra: 2 } },
          note('ok'),
          { ...note(), data: { text: 5, other: 1 } },
        ]),
      );

      expect(error.details.map(({ path }) => path).sort()).toEqual([
        '/records/0/data/extra',
        '/records/0/data/other',
        '/records/0/data/text',
        '/records/2/data/other',
        '/records/2/data/text',
      ]);
      expect(processes.counters.writes).toBe(0);
    });

    it('should count in the last detail every violation a record left out past the 50', async () => {
      const { register, processes } = setup();
      processes.setManifest(ORIGIN, manifestOf(ORIGIN, { listed: LISTED }));

      const error = await refusal(register([numbers(5_000)]));

      expect(error.details).toHaveLength(51);
      expect(error.details.at(-1)).toEqual({
        path: '',
        code: 'too-many-errors',
        message: '4950 more errors omitted',
      });
    }, 15_000);

    it('should count the violations of every record in the last detail when two records overflow', async () => {
      const { register, processes } = setup();
      processes.setManifest(ORIGIN, manifestOf(ORIGIN, { listed: LISTED }));

      const error = await refusal(register([numbers(3_000), numbers(3_000)]));

      expect(error.details).toHaveLength(51);
      expect(error.details.at(-1)).toEqual({
        path: '',
        code: 'too-many-errors',
        message: '5950 more errors omitted',
      });
    }, 15_000);

    it('should report the measured value of a size limit next to another violation of the same record', async () => {
      const { register, processes } = setup();
      processes.setManifest(ORIGIN, manifestOf(ORIGIN, { limited: LIMITED }));

      const error = await refusal(
        register([{ type: 'limited', target: 'run.step', data: { name: 'abcdef', count: 0 } }]),
      );

      expect(error.details).toEqual([
        {
          path: '/records/0/data/name',
          code: 'max-length',
          message: 'must NOT have more than 3 characters (got 6)',
        },
        {
          path: '/records/0/data/count',
          code: 'minimum',
          message: 'must be >= 1 (got 0)',
        },
      ]);
    });

    it('should point to describe_type with the type name when the cost ceiling cut the violations of a record', async () => {
      const { register, processes } = setup();
      processes.setManifest(ORIGIN, manifestOf(ORIGIN, { costly: COSTLY }));

      const error = await refusal(register([costly()]));

      expect(error.details).toEqual([
        { path: '/records/0/data/items/0', code: 'type', message: 'must be string' },
        {
          path: '/records/0/data',
          code: 'violations-capped',
          message: expect.stringContaining("type 'costly' is too costly"),
        },
      ]);
    });

    it('should add the violations-capped detail only to the records the ceiling cut', async () => {
      const { register, processes } = setup();
      processes.setManifest(ORIGIN, manifestOf(ORIGIN, { costly: COSTLY, listed: LISTED }));

      const error = await refusal(register([numbers(3), costly(), costly()]));

      expect(
        error.details.filter(({ code }) => code === 'violations-capped').map(({ path }) => path),
      ).toEqual(['/records/1/data', '/records/2/data']);
    });

    it('should keep the violations-capped detail of every record inside the 50 of a cut batch', async () => {
      const { register, processes } = setup();
      processes.setManifest(ORIGIN, manifestOf(ORIGIN, { costly: COSTLY, listed: LISTED }));

      const error = await refusal(register([numbers(5_000), costly()]));

      expect(error.details).toHaveLength(51);
      expect(error.details.at(-2)).toMatchObject({
        path: '/records/1/data',
        code: 'violations-capped',
      });
      expect(error.details.at(-1)).toEqual({
        path: '',
        code: 'too-many-errors',
        message: '4952 more errors omitted',
      });
    }, 15_000);

    it('should refuse with the TYPE_NOT_PINNED of a record over the INVALID_RECORD data refusal of an earlier one', async () => {
      const { register, validate } = setup();

      const error = await refusal(
        register([
          { ...note(), data: { text: 5 } },
          { ...note('b'), type: 'nobody' },
        ]),
      );

      expect(error).toMatchObject({
        code: 'TYPE_NOT_PINNED',
        details: [{ path: '/records/1/type', code: 'not-pinned' }],
      });
      expect(validate).not.toHaveBeenCalled();
    });

    it.each([
      [
        'an as name that the process did not pin',
        { to: ghostId(ORIGIN), as: 'nope' },
        'unknown-relation-name',
      ],
      [
        'an as and a kind that do not match',
        { to: ghostId(ORIGIN), as: 'approves', kind: 'answers' },
        'kind-mismatch',
      ],
    ] as const)(
      'should refuse %s with INVALID_RECORD, before reading the log',
      async (_case, relation, code) => {
        const { register, processes } = setup();

        const error = await refusal(register([note('a', { relations: [relation] })]));

        expect(error).toMatchObject({
          code: 'INVALID_RECORD',
          details: [{ path: '/records/0/relations/0', code }],
        });
        expect(processes.counters.reads).toEqual([]);
      },
    );

    it('should return the kind of the pinned name in the detail of a kind-mismatch', async () => {
      const { register } = setup();
      const relation = { to: ghostId(ORIGIN), as: 'approves', kind: 'answers' } as const;

      const error = await refusal(register([note('a', { relations: [relation] })]));

      expect(error.details).toEqual([
        {
          path: '/records/0/relations/0',
          code: 'kind-mismatch',
          message: expect.stringContaining('kind "supports"'),
          kind: 'supports',
        },
      ]);
    });

    it('should accept an as with a kind equal to the pinned one and write the resolved kind', async () => {
      const { register, processes } = setup();

      const result = await register([
        note('a', { alias: 'base' }),
        note('b', { relations: [{ to: '@base', as: 'approves', kind: 'supports' }] }),
      ]);

      expect(verifiedOf(processes).records[1]?.relations).toEqual([
        { kind: 'supports', to: result.records[0]?.id, as: 'approves' },
      ]);
    });

    it.each([
      ['an explicit kind', { to: ghostId('other'), kind: 'supersedes' }],
      ['a kind that comes from as', { to: ghostId('other'), as: 'replaces' }],
      ['revokes', { to: ghostId('other'), kind: 'revokes' }],
    ] as const)(
      'should refuse a supersedes or revokes to another process (%s) with cross-process-currency',
      async (_case, relation) => {
        const { register, processes } = setup();

        const error = await refusal(register([note('a', { relations: [relation] })]));

        expect(error).toMatchObject({
          code: 'INVALID_RECORD',
          details: [{ path: '/records/0/relations/0', code: 'cross-process-currency' }],
        });
        expect(processes.counters.writes).toBe(0);
      },
    );

    it('should list the schema violations first and then the relation violations by record and relation', async () => {
      const { register } = setup();
      const unknownAs = note('a', { relations: [{ to: ghostId(ORIGIN), as: 'nope' }] });

      const error = await refusal(
        register([supersedesElsewhere(), unknownAs, { ...note(), data: { text: 5 } }]),
      );

      expect(error.details.map(({ path, code }) => [path, code])).toEqual([
        ['/records/2/data/text', expect.any(String)],
        ['/records/0/relations/0', 'cross-process-currency'],
        ['/records/1/relations/0', 'unknown-relation-name'],
      ]);
    });

    it('should join a kind-mismatch with the schema violation of the same record', async () => {
      const { register, processes } = setup();
      const relation = { to: ghostId(ORIGIN), as: 'approves', kind: 'answers' } as const;

      const error = await refusal(
        register([{ ...note('a', { relations: [relation] }), data: { text: 5 } }]),
      );

      expect(error.details.map(({ path, code }) => [path, code])).toEqual([
        ['/records/0/data/text', expect.any(String)],
        ['/records/0/relations/0', 'kind-mismatch'],
      ]);
      expect(processes.counters.reads).toEqual([]);
    });

    it('should count the relation violations in the cap of the details', async () => {
      const { register } = setup();
      const relation = { to: ghostId(ORIGIN), as: 'nope' } as const;

      const error = await refusal(
        register(
          Array.from({ length: BATCH_MAX }, () => note('a', { relations: [relation, relation] })),
        ),
      );

      expect(error.details).toHaveLength(51);
      expect(error.details.at(-1)).toEqual({
        path: '',
        code: 'too-many-errors',
        message: `${BATCH_MAX * 2 - 50} more errors omitted`,
      });
    });

    it('should accept a supersedes whose destination is in the own process', async () => {
      const { register, processes } = setup();
      const first = await register([note('a')]);
      const target = first.records[0]?.id ?? '';

      await register([note('b', { relations: [{ to: target, kind: 'supersedes' }] })]);

      expect(verifiedOf(processes).records[1]?.relations).toEqual([
        { kind: 'supersedes', to: target },
      ]);
    });
  });

  describe('with a key', () => {
    it('should refuse a malformed batch for a nonexistent process with INVALID_INPUT', async () => {
      const { register } = setup();

      const error = await refusal(register(notes(BATCH_MAX + 1), { key: 'k' }, 'ghost'));

      expect(error.code).toBe('INVALID_INPUT');
    });

    it('should refuse a nonexistent process with PROCESS_NOT_FOUND even with a cross-process supersedes', async () => {
      const { register } = setup();

      const error = await refusal(register([supersedesElsewhere()], { key: 'k' }, 'ghost'));

      expect(error.code).toBe('PROCESS_NOT_FOUND');
    });

    it('should refuse a cross-process supersedes with cross-process-currency on an origin with a broken chain', async () => {
      const { register, processes } = setup();
      await register([note()], { key: 'k' });
      processes.setText(ORIGIN, `${processes.textOf(ORIGIN)}{"links":[1]}\n`);

      const error = await refusal(register([supersedesElsewhere()], { key: 'k' }));

      expect(error).toMatchObject({
        code: 'INVALID_RECORD',
        details: [{ code: 'cross-process-currency' }],
      });
    });

    it.each([
      ['the same fingerprint', [note()]],
      ['a different fingerprint', [note('other')]],
    ])(
      'should refuse with broken-chain a key already written on an origin that later broke, with %s',
      async (_case, batch) => {
        const { register, processes } = setup();
        await register([note()], { key: 'k' });
        processes.setText(ORIGIN, `${processes.textOf(ORIGIN)}{"links":[1]}\n`);

        const error = await refusal(register(batch, { key: 'k' }));

        expect(error).toMatchObject({
          code: 'PROCESS_CORRUPTED',
          details: [{ path: '/process', code: 'broken-chain', process: ORIGIN }],
        });
      },
    );

    it('should return replayed with the original ids and aliases and without a new line for the same fingerprint', async () => {
      const { register, processes } = setup();
      const batch = [note('a', { alias: 'first' }), note('b')];
      const original = await register(batch, { key: 'k' });
      const before = processes.textOf(ORIGIN);

      const again = await register(batch, { key: 'k' });

      expect(again).toEqual({ ...original, replayed: true });
      expect(processes.textOf(ORIGIN)).toBe(before);
      expect(processes.counters.appends).toBe(1);
    });

    it('should fsync and log batch-replayed on the replay of the same fingerprint', async () => {
      const { register, processes, logger } = setup();
      const batch = [note('a')];
      await register(batch, { key: 'k' });

      expect(logger).not.toHaveBeenCalled();

      await register(batch, { key: 'k' });

      expect(processes.counters.syncsWithoutLine).toBe(1);
      expect(logger).toHaveBeenCalledTimes(1);
      expect(logger).toHaveBeenCalledWith({
        level: 'info',
        event: 'batch-replayed',
        project: PROJECT,
        process: ORIGIN,
        key: 'k',
      });
    });

    it.each([
      ['the same fingerprint', [note('a')]],
      ['a different fingerprint', [note('b')]],
    ])(
      'should not collide on the same key in another origin, since the lookup is per origin, with %s',
      async (_case, batch) => {
        const { register, processes } = setup();
        processes.add('run-2');
        await register([note('a')], { key: 'k' });

        const other = await register(batch, { key: 'k' }, 'run-2');

        expect(other.replayed).toBe(false);
        expect(verifiedOf(processes, 'run-2').records).toHaveLength(1);
        expect(verifiedOf(processes).records).toHaveLength(1);
      },
    );

    it('should write a new batch for the same fingerprint with another key, not a replay', async () => {
      const { register, processes } = setup();
      await register([note('a')], { key: 'k1' });

      const again = await register([note('a')], { key: 'k2' });

      expect(again.replayed).toBe(false);
      expect(verifiedOf(processes).records).toHaveLength(2);
    });

    it('should return in the replay the marker of the head read in decide, not the one of the original batch', async () => {
      const { register } = setup();
      const original = await register([note('a')], { key: 'k' });
      const later = await register([note('b')]);

      const again = await register([note('a')], { key: 'k' });

      expect(again.replayed).toBe(true);
      expect(again.records).toEqual(original.records);
      expect(again.marker).toEqual({ [ORIGIN]: later.records[0]?.id });
    });

    it('should ignore the author (agent, model and client) in the fingerprint', async () => {
      const { register } = setup();
      await register([note('a')], { key: 'k1', author: AUTHOR });

      const again = await register([note('a')], {
        key: 'k1',
        author: { agent: 'other', client: 'c' },
      });

      expect(again.replayed).toBe(true);
    });

    it('should refuse a different fingerprint with IDEMPOTENCY_CONFLICT without writing', async () => {
      const { register, processes } = setup();
      await register([note('a')], { key: 'k' });

      const error = await refusal(register([note('b')], { key: 'k' }));

      expect(error).toMatchObject({
        code: 'IDEMPOTENCY_CONFLICT',
        details: [{ path: '/key', code: 'key-conflict' }],
      });
      expect(processes.counters.appends).toBe(1);
    });

    it('should refuse with IDEMPOTENCY_CONFLICT before the checks that depend on state', async () => {
      const { register } = setup();
      await register([note('a')], { key: 'k' });

      const error = await refusal(
        register([note('b', { relations: [{ to: ghostId(ORIGIN), kind: 'supports' }] })], {
          key: 'k',
        }),
      );

      expect(error.code).toBe('IDEMPOTENCY_CONFLICT');
    });

    it('should still run the state checks with a new key', async () => {
      const { register, processes } = setup();
      await register([note('a')], { key: 'k1' });

      const error = await refusal(
        register([note('b', { relations: [{ to: ghostId(ORIGIN), kind: 'supports' }] })], {
          key: 'k2',
        }),
      );

      expect(error.code).toBe('RELATION_NOT_FOUND');
      expect(processes.counters.appends).toBe(1);
    });

    it('should return replayed on the resend after an uncertain IO_ERROR, even with the destination and the attachment changed', async () => {
      const { register, processes, attachments, logger } = setup();
      const hash = sha256hex('attachment');
      processes.add('other');
      attachments.set(hash, 'ok');
      const target = await register([note('target', { alias: 'e' })], {}, 'other');
      const batch = [
        note('support', { relations: [{ to: target.records[0]?.id ?? '', kind: 'supports' }] }),
        { type: 'doc', target: 'run.doc', data: { body: hash } },
      ];
      processes.flags.ioErrorAfterAppend = true;

      await expect(register(batch, { key: 'k' })).rejects.toMatchObject({ code: 'IO_ERROR' });

      processes.flags.ioErrorAfterAppend = false;
      await register(
        [note('v2', { relations: [{ to: target.records[0]?.id ?? '', kind: 'supersedes' }] })],
        {},
        'other',
      );
      attachments.set(hash, 'missing');

      expect(logger).not.toHaveBeenCalled();

      const again = await register(batch, { key: 'k' });
      const verified = verifiedOf(processes);

      expect(again.replayed).toBe(true);
      expect(verified.chain.totalRecords).toBe(2);
      expect(again.records.map(({ id }) => id)).toEqual(verified.records.map(({ id }) => id));
      expect(logger).toHaveBeenCalledTimes(1);
    });

    it('should refuse the resend without a key when a new attachment now matches the unmarked-attachment guard', async () => {
      const { register, attachments } = setup();
      const hash = sha256hex('later');
      const batch = [{ type: 'doc', target: 'run.doc', data: { note: hash } }];
      await register(batch, { key: 'k' });
      attachments.set(hash, 'ok');

      await expect(register(batch)).rejects.toMatchObject({ code: 'INVALID_RECORD' });
    });

    it('should return replayed on the resend even when a new attachment now matches the unmarked-attachment guard', async () => {
      const { register, attachments } = setup();
      const hash = sha256hex('later');
      const batch = [{ type: 'doc', target: 'run.doc', data: { note: hash } }];
      await register(batch, { key: 'k' });
      attachments.set(hash, 'ok');

      await refusal(register(batch));

      const again = await register(batch, { key: 'k' });

      expect(again.replayed).toBe(true);
    });
  });

  describe('when the origin log is read', () => {
    it.each([
      ['with no key', undefined],
      ['with a new key', 'new'],
      ['with a key that replays', 'old'],
    ])(
      'should read the origin log once and parse each of its lines once, %s',
      async (_case, key) => {
        const { register, processes } = setup();
        await register([note('a')], { key: 'old' });
        await register([note('b'), note('c')]);
        const lines = processes.textOf(ORIGIN).split('\n').filter(Boolean);
        const parse = jest.spyOn(JSON, 'parse');
        processes.counters.reads.length = 0;

        await register([note('a')], key === undefined ? {} : { key });
        const calls = parse.mock.calls.map(([text]) => text);

        expect(lines.map((line) => calls.filter((text) => text === line).length)).toEqual([1, 1]);
        expect(processes.readsOf(ORIGIN)).toBe(1);
      },
    );
  });
});
