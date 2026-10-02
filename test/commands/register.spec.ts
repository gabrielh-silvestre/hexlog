import { afterEach, describe, expect, jest, test } from '@jest/globals';
import { fingerprint, sha256hex } from '../../src/domain/chain.ts';
import { BATCH_MAX } from '../../src/domain/record.ts';
import type { BatchItem } from '../../src/domain/record.ts';
import {
  AUTHOR,
  NOW,
  ORIGIN,
  PROJECT,
  ghostId,
  note,
  refusal,
  setup,
  verifiedOf,
} from './register-fakes.ts';

afterEach(() => {
  jest.restoreAllMocks();
});

const supersedesElsewhere = (): BatchItem =>
  note('x', { relations: [{ to: ghostId('other'), kind: 'supersedes' }] });

describe('register: gravação', () => {
  test('grava o lote numa linha só, com elos encadeados, ids da origem e o mesmo at', async () => {
    const { register, processes } = setup();

    const result = await register([note('a', { alias: 'first' }), note('b')], { key: 'k1' });

    const { records, chain } = verifiedOf(processes);
    expect(chain).toMatchObject({ ok: true, totalRecords: 2 });
    expect(processes.textOf(ORIGIN).split('\n')).toHaveLength(2);
    expect(records.map(({ id }) => id)).toEqual(result.records.map(({ id }) => id));
    expect(records.map(({ seq, at }) => [seq, at])).toEqual([
      [0, NOW.toISOString()],
      [1, NOW.toISOString()],
    ]);
    expect(result.records[0]).toEqual({ alias: 'first', id: expect.stringMatching(/^run-1:/) });
    expect(result.records[1]).not.toHaveProperty('alias');
    expect(result).toMatchObject({ replayed: false, marker: { [ORIGIN]: result.records[1]?.id } });
  });

  test('só o primeiro elo leva batch, com impressão, chave e apelidos', async () => {
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

  test('sem chave nem apelido o batch leva só a impressão', async () => {
    const { register, processes } = setup();

    await register([note()]);

    expect(Object.keys(verifiedOf(processes).records[0]?.batch ?? {})).toEqual(['fingerprint']);
  });

  test('o segundo lote continua o seq e o hash do primeiro', async () => {
    const { register, processes } = setup();

    await register([note('a')]);
    await register([note('b'), note('c')]);

    const verified = verifiedOf(processes);
    expect(verified.chain.ok).toBe(true);
    expect(verified.records.map(({ seq }) => seq)).toEqual([0, 1, 2]);
    expect(verified.end.seq).toBe(3);
  });

  test('o at é o instante do clock injetado, o mesmo para o lote todo', async () => {
    const { register, processes, setNow } = setup();
    const later = new Date('2027-01-01T00:00:00.000Z');
    setNow(later);

    await register([note('a'), note('b')]);

    expect(verifiedOf(processes).records.map(({ at }) => at)).toEqual([
      later.toISOString(),
      later.toISOString(),
    ]);
  });

  test('o autor chega por parâmetro: client vai para o elo, e model ausente não deixa chave', async () => {
    const { register, processes } = setup();

    await register([note('a')], { author: { agent: 'a1', client: 'my-client' } });
    await register([note('b')], { author: AUTHOR });

    const [withoutModel, withModel] = verifiedOf(processes).records;
    expect(withoutModel?.author).toStrictEqual({ agent: 'a1', client: 'my-client' });
    expect(withModel?.author).toStrictEqual(AUTHOR);
  });

  test('apelido vira o id do item anterior, e as vira o kind da relação gravada', async () => {
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

  test('sem chave o mesmo lote grava de novo, e com 50 itens ainda cabe', async () => {
    const { register, processes } = setup();
    const batch = Array.from({ length: BATCH_MAX }, () => note());

    const first = await register(batch);
    const second = await register(batch);

    expect(second.replayed).toBe(false);
    expect(first.records).toHaveLength(BATCH_MAX);
    expect(verifiedOf(processes).chain.totalRecords).toBe(2 * BATCH_MAX);
  });
});

describe('register: forma do lote (nível 1)', () => {
  test.each([
    ['vazio', []],
    ['acima de 50 itens', Array.from({ length: BATCH_MAX + 1 }, () => note())],
  ])('lote %s é INVALID_INPUT batch-size, sem ler o processo', async (_case, batch) => {
    const { register, processes } = setup();

    const error = await refusal(register(batch));

    expect(error).toMatchObject({
      code: 'INVALID_INPUT',
      details: [{ path: '/records', code: 'batch-size' }],
    });
    expect(processes.counters.reads).toEqual([]);
  });

  test('apelido repetido aponta o segundo item', async () => {
    const { register } = setup();

    const error = await refusal(
      register([note('a', { alias: 'dup' }), note('b'), note('c', { alias: 'dup' })]),
    );

    expect(error).toMatchObject({
      code: 'INVALID_INPUT',
      details: [{ path: '/records/2/alias', code: 'duplicate-alias' }],
    });
  });

  test.each([
    ['item posterior', 'later', 'forward-alias'],
    ['o próprio item', 'self', 'forward-alias'],
    ['apelido que não existe', 'nobody', 'unknown-alias'],
  ])('@alias para %s é recusado', async (_case, alias, code) => {
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

describe('register: manifesto da origem (nível 2)', () => {
  test('processo inexistente dá PROCESS_NOT_FOUND', async () => {
    const { register } = setup();

    const error = await refusal(register([note()], {}, 'ghost'));

    expect(error).toMatchObject({ code: 'PROCESS_NOT_FOUND', details: [{ path: '/process' }] });
  });

  test('manifesto ilegível vem antes de qualquer recusa estática', async () => {
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

describe('register: recusas estáticas (nível 3)', () => {
  test.each(['nobody', 'constructor'])(
    'tipo %s não fixado no processo é TYPE_NOT_PINNED, mesmo com nome de Object.prototype',
    async (type) => {
      const { register } = setup();

      const error = await refusal(register([note('a'), { ...note('b'), type }]));

      expect(error).toMatchObject({
        code: 'TYPE_NOT_PINNED',
        details: [{ path: '/records/1/type', code: 'not-pinned' }],
      });
    },
  );

  test('data fora do schema fixado dá INVALID_RECORD com o path refeito para o item', async () => {
    const { register } = setup();

    const error = await refusal(register([note('ok'), { ...note(), data: { text: 5 } }]));

    expect(error).toMatchObject({
      code: 'INVALID_RECORD',
      details: [{ path: '/records/1/data/text' }],
    });
  });

  test('details é por registro: só o primeiro item inválido sai, e o lote não os soma', async () => {
    const { register, validate } = setup();

    const error = await refusal(
      register([note('ok'), { ...note(), data: { text: 5 } }, { ...note(), data: { text: 6 } }]),
    );

    expect(error.details.length).toBeGreaterThan(0);
    expect(error.details.every(({ path }) => path.startsWith('/records/1/data'))).toBe(true);
    expect(validate).toHaveBeenCalledTimes(2);
  });

  test('pior caso: item com dezenas de erros sai com um só detalhe, o primeiro que o validador achar', async () => {
    const { register } = setup();
    const extras = Object.fromEntries(Array.from({ length: 80 }, (_, n) => [`extra${n}`, n]));

    const error = await refusal(register([{ ...note(), data: { ...extras } }]));

    expect(error.details).toHaveLength(1);
    expect(error.details.every(({ path }) => path.startsWith('/records/0/data'))).toBe(true);
  });

  test.each([
    ['as que o processo não fixou', { to: ghostId(ORIGIN), as: 'nope' }, 'unknown-relation-name'],
    [
      'as e kind que não batem',
      { to: ghostId(ORIGIN), as: 'approves', kind: 'answers' },
      'kind-mismatch',
    ],
  ] as const)('%s é INVALID_RECORD, antes de ler o log', async (_case, relation, code) => {
    const { register, processes } = setup();

    const error = await refusal(register([note('a', { relations: [relation] })]));

    expect(error).toMatchObject({
      code: 'INVALID_RECORD',
      details: [{ path: '/records/0/relations/0', code }],
    });
    expect(processes.counters.writes).toBe(0);
  });

  test.each([
    ['kind explícito', { to: ghostId('other'), kind: 'supersedes' }],
    ['kind vindo de as', { to: ghostId('other'), as: 'replaces' }],
    ['revokes', { to: ghostId('other'), kind: 'revokes' }],
  ] as const)(
    'supersedes e revokes para outro processo (%s) dão cross-process-currency',
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

  test('a ordem das passadas é schema, as→kind e cross-process-currency, e não a do item', async () => {
    const { register } = setup();
    const unknownAs = note('a', { relations: [{ to: ghostId(ORIGIN), as: 'nope' }] });

    const bySchema = await refusal(
      register([supersedesElsewhere(), unknownAs, { ...note(), data: {} }]),
    );
    const byName = await refusal(register([supersedesElsewhere(), unknownAs]));
    const byScope = await refusal(register([supersedesElsewhere()]));

    expect(bySchema.details[0]?.path).toMatch(/^\/records\/2\/data/);
    expect(byName.details[0]).toMatchObject({ code: 'unknown-relation-name' });
    expect(byScope.details[0]).toMatchObject({ code: 'cross-process-currency' });
  });

  test('destino do próprio processo com supersedes não é cross-process-currency', async () => {
    const { register } = setup();
    const first = await register([note('a')]);

    const second = await register([
      note('b', { relations: [{ to: first.records[0]?.id ?? '', kind: 'supersedes' }] }),
    ]);

    expect(second.replayed).toBe(false);
  });
});

describe('register: chave e precedência de D-06', () => {
  test('chave: lote malformado para processo inexistente dá INVALID_INPUT', async () => {
    const { register } = setup();

    const error = await refusal(
      register(
        Array.from({ length: BATCH_MAX + 1 }, () => note()),
        { key: 'k' },
        'ghost',
      ),
    );

    expect(error.code).toBe('INVALID_INPUT');
  });

  test('chave: processo inexistente com supersedes cruzado dá PROCESS_NOT_FOUND', async () => {
    const { register } = setup();

    const error = await refusal(register([supersedesElsewhere()], { key: 'k' }, 'ghost'));

    expect(error.code).toBe('PROCESS_NOT_FOUND');
  });

  test('chave: supersedes cruzado numa origem com cadeia quebrada dá cross-process-currency', async () => {
    const { register, processes } = setup();
    await register([note()], { key: 'k' });
    processes.setText(ORIGIN, `${processes.textOf(ORIGIN)}{"links":[1]}\n`);

    const error = await refusal(register([supersedesElsewhere()], { key: 'k' }));

    expect(error).toMatchObject({
      code: 'INVALID_RECORD',
      details: [{ code: 'cross-process-currency' }],
    });
  });

  test.each([
    ['mesma impressão', [note()]],
    ['impressão diferente', [note('outro')]],
  ])(
    'chave: chave já gravada numa origem que depois quebrou dá broken-chain (%s)',
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

  test('chave: mesma impressão devolve replayed sem linha, com os ids e apelidos do original e o fsync', async () => {
    const { register, processes, logger } = setup();
    const batch = [note('a', { alias: 'first' }), note('b')];
    const original = await register(batch, { key: 'k' });
    const before = processes.textOf(ORIGIN);
    expect(logger).not.toHaveBeenCalled();

    const again = await register(batch, { key: 'k' });

    expect(again).toEqual({ ...original, replayed: true });
    expect(processes.textOf(ORIGIN)).toBe(before);
    expect(processes.counters).toMatchObject({ appends: 1, syncsWithoutLine: 1 });
    expect(logger).toHaveBeenCalledTimes(1);
    expect(logger).toHaveBeenCalledWith({
      level: 'info',
      event: 'batch-replayed',
      project: PROJECT,
      process: ORIGIN,
      key: 'k',
    });
  });

  test('chave: o replay traz o marker da cabeça lida em decide, não o do lote original', async () => {
    const { register } = setup();
    const original = await register([note('a')], { key: 'k' });
    const later = await register([note('b')]);

    const again = await register([note('a')], { key: 'k' });

    expect(again.replayed).toBe(true);
    expect(again.records).toEqual(original.records);
    expect(again.marker).toEqual({ [ORIGIN]: later.records[0]?.id });
  });

  test('chave: a impressão ignora key, agent e model', async () => {
    const { register } = setup();
    await register([note('a')], { key: 'k1', author: AUTHOR });

    const again = await register([note('a')], {
      key: 'k1',
      author: { agent: 'other', client: 'c' },
    });

    expect(again.replayed).toBe(true);
  });

  test('chave: impressão diferente dá IDEMPOTENCY_CONFLICT sem gravar', async () => {
    const { register, processes } = setup();
    await register([note('a')], { key: 'k' });

    const error = await refusal(register([note('b')], { key: 'k' }));

    expect(error).toMatchObject({
      code: 'IDEMPOTENCY_CONFLICT',
      details: [{ path: '/key', code: 'key-conflict' }],
    });
    expect(processes.counters.appends).toBe(1);
  });

  test('chave: IDEMPOTENCY_CONFLICT vem antes das checagens que dependem de estado', async () => {
    const { register } = setup();
    await register([note('a')], { key: 'k' });

    const error = await refusal(
      register([note('b', { relations: [{ to: ghostId(ORIGIN), kind: 'supports' }] })], {
        key: 'k',
      }),
    );

    expect(error.code).toBe('IDEMPOTENCY_CONFLICT');
  });

  test('chave nova não impede as checagens de estado', async () => {
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

  test('chave: o reenvio depois de IO_ERROR incerto devolve replayed mesmo com destino e anexo mudados', async () => {
    const { register, processes, attachments, logger } = setup();
    const hash = sha256hex('anexo');
    processes.add('other');
    attachments.set(hash, 'ok');
    const target = await register([note('destino', { alias: 'e' })], {}, 'other');
    const batch = [
      note('apoio', { relations: [{ to: target.records[0]?.id ?? '', kind: 'supports' }] }),
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

    expect(again.replayed).toBe(true);
    const verified = verifiedOf(processes);
    expect(verified.chain.totalRecords).toBe(2);
    expect(again.records.map(({ id }) => id)).toEqual(verified.records.map(({ id }) => id));
    expect(logger).toHaveBeenCalledTimes(1);
  });

  test('chave: o reenvio devolve replayed mesmo quando um anexo novo passou a casar a guarda unmarked-attachment', async () => {
    const { register, attachments } = setup();
    const hash = sha256hex('mais tarde');
    const batch = [{ type: 'doc', target: 'run.doc', data: { note: hash } }];
    await register(batch, { key: 'k' });
    attachments.set(hash, 'ok');

    const again = await register(batch, { key: 'k' });

    expect(again.replayed).toBe(true);
    await expect(register(batch)).rejects.toMatchObject({ code: 'INVALID_RECORD' });
  });
});

describe('register: leitura única do log da origem (SL2)', () => {
  test.each([
    ['sem chave', undefined],
    ['com chave nova', 'novo'],
    ['com chave em replay', 'antigo'],
  ])('uma leitura: cada linha do log da origem é parseada uma vez, %s', async (_case, key) => {
    const { register, processes } = setup();
    await register([note('a')], { key: 'antigo' });
    await register([note('b'), note('c')]);
    const lines = processes.textOf(ORIGIN).split('\n').filter(Boolean);
    const parse = jest.spyOn(JSON, 'parse');
    processes.counters.reads.length = 0;

    await register([note('a')], key === undefined ? {} : { key });

    const calls = parse.mock.calls.map(([text]) => text);
    expect(lines.map((line) => calls.filter((text) => text === line).length)).toEqual([1, 1]);
    expect(processes.counters.reads.filter((name) => name === ORIGIN)).toHaveLength(1);
  });
});

test('nenhuma recusa estática grava ou chega ao write', async () => {
  const { register, processes } = setup();

  await refusal(register([{ ...note(), data: {} }]));
  await refusal(register([supersedesElsewhere()]));
  await refusal(register([]));

  expect(processes.counters).toMatchObject({ writes: 0, appends: 0 });
});
