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

describe('register: destinos de outro processo (D-10)', () => {
  test('supports para registro vigente de outro processo grava, lendo cada destino uma vez e sem travá-lo', async () => {
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

  test('processo-destino inexistente é RELATION_NOT_FOUND missing, no path da relação', async () => {
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

  test('registro inexistente num processo que existe é RELATION_NOT_FOUND missing', async () => {
    const harness = setup();
    await seed(harness, OTHER);

    const error = await refusal(harness.register([relating(ghostId(OTHER), 'supports')]));

    expect(error).toMatchObject({ code: 'RELATION_NOT_FOUND', details: [{ code: 'missing' }] });
  });

  test.each([
    ['cadeia quebrada', (h: Harness) => h.processes.setText(OTHER, '{"links":[1]}\n')],
    ['manifesto ilegível', (h: Harness) => h.processes.flags.unreadable.add(OTHER)],
  ])(
    'destino com %s é RELATION_NOT_FOUND destination-corrupted com o processo',
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

  test('supports para destino substituído é stale-destination com a versão atual', async () => {
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
    '%s para destino substituído não confere vigência: só supports confere',
    async (kind) => {
      const harness = setup();
      const target = await seed(harness, OTHER);
      await harness.register([relating(target, 'supersedes', 'v2')], {}, OTHER);

      const result = await harness.register([relating(target, kind)]);

      expect(result.replayed).toBe(false);
    },
  );

  test('as com pontas por tipo: tipo fora de from é endpoint-type', async () => {
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

  test('erro das portas na leitura do destino sai intacto (PROCESS_TOO_LARGE)', async () => {
    const harness = setup();
    const target = await seed(harness, OTHER);
    harness.processes.flags.tooLarge.add(OTHER);

    const error = await refusal(harness.register([relating(target, 'supports')]));

    expect(error.code).toBe('PROCESS_TOO_LARGE');
  });
});

describe('register: regras de D-10 no próprio processo', () => {
  test('supersedes de registro já substituído é FORK_REJECTED com a versão atual', async () => {
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

  test('bifurcação: revokes de registro já substituído é FORK_REJECTED com a versão atual', async () => {
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
    'linhagem revogada encerra: %s dela é FORK_REJECTED com current null',
    async (kind) => {
      const harness = setup();
      const first = await seed(harness, ORIGIN, 'v1');
      await harness.register([relating(first, 'revokes', 'cancel')]);

      const error = await refusal(harness.register([relating(first, kind)]));

      expect(error).toMatchObject({ code: 'FORK_REJECTED', details: [{ current: null }] });
    },
  );

  test('dois supersedes do mesmo alvo no lote: o segundo é FORK_REJECTED, apontando o item', async () => {
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
    ['supersedes antes de supports', ['supersedes', 'supports'], 1],
    ['supports antes de supersedes', ['supports', 'supersedes'], 0],
  ] as const)(
    'o supports confere a vigência do lote inteiro: %s é stale-destination',
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

  test('supports de item posterior do lote para o registro que um item anterior substituiu', async () => {
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

  test('supersedes entre tipos diferentes é type-mismatch', async () => {
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

  test.each([
    ['supports e contradicts', ['supports', 'contradicts'], 'supports-and-contradicts'],
    ['supersedes e revokes', ['supersedes', 'revokes'], 'supersedes-and-revokes'],
  ] as const)('%s ao mesmo destino é %s', async (_case, kinds, code) => {
    const harness = setup();
    const target = await seed(harness, ORIGIN, 'e');

    const error = await refusal(
      harness.register([note('x', { relations: kinds.map((kind) => ({ to: target, kind })) })]),
    );

    expect(error).toMatchObject({ code: 'INVALID_RECORD', details: [{ code }] });
  });

  test('id do próprio processo que não existe é RELATION_NOT_FOUND missing', async () => {
    const harness = setup();

    const error = await refusal(harness.register([relating(ghostId(ORIGIN), 'supports')]));

    expect(error).toMatchObject({
      code: 'RELATION_NOT_FOUND',
      details: [{ path: '/records/0/relations/0', code: 'missing' }],
    });
  });

  test('o lote cita item anterior por apelido: supersedes encadeado dentro do lote é aceito', async () => {
    const harness = setup();

    const result = await harness.register([
      note('v1', { alias: 'v1' }),
      note('v2', { alias: 'v2', relations: [{ to: '@v1', kind: 'supersedes' }] }),
    ]);

    expect(result.replayed).toBe(false);
  });

  test('hasCycle recusa com CYCLE_REJECTED, com a aresta montada à mão na origem', async () => {
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

describe('register: tudo ou nada nas recusas de estado (SE1)', () => {
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
    'tudo ou nada: %s no terceiro item de um lote de três não grava os dois anteriores',
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

describe('register: anexos (D-16)', () => {
  const hash = sha256hex('anexo');

  test('campo marcado com anexo íntegro grava, e cada hash é consultado uma vez por chamada', async () => {
    const harness = setup();
    harness.attachments.set(hash, 'ok');

    const result = await harness.register([doc({ body: hash }), doc({ files: [hash, hash] })]);

    expect(result.replayed).toBe(false);
    expect(harness.attachments.calls).toEqual([hash]);
  });

  test.each([
    ['inexistente', 'missing', 'ATTACHMENT_NOT_FOUND', 'not-found'],
    ['corrompido', 'corrupted', 'ATTACHMENT_CORRUPTED', 'corrupted'],
  ] as const)('anexo %s em campo marcado é %s', async (_case, status, code, subcode) => {
    const harness = setup();
    harness.attachments.set(hash, status);

    const error = await refusal(harness.register([note('a'), doc({ body: hash })]));

    expect(error).toMatchObject({
      code,
      details: [{ path: '/records/1/data/body', code: subcode }],
    });
    expect(harness.processes.counters.appends).toBe(0);
  });

  test('item de lista de anexos marcada que não existe também é recusado', async () => {
    const harness = setup();
    harness.attachments.set(hash, 'ok');

    const error = await refusal(harness.register([doc({ files: [hash, sha256hex('outro')] })]));

    expect(error).toMatchObject({
      code: 'ATTACHMENT_NOT_FOUND',
      details: [{ path: '/records/0/data/files' }],
    });
  });

  test.each([
    ['campo', { note: hash }],
    ['item de lista de strings', { notes: ['texto', hash] }],
  ])('hash de anexo guardado em %s sem a marca é unmarked-attachment', async (_case, data) => {
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
  });

  test('anexo corrompido também conta como guardado para a guarda de marca', async () => {
    const harness = setup();
    harness.attachments.set(hash, 'corrupted');

    const error = await refusal(harness.register([doc({ note: hash })]));

    expect(error).toMatchObject({ details: [{ code: 'unmarked-attachment' }] });
  });

  test.each([
    ['hash de anexo que nunca foi guardado', { note: hash }],
    ['texto que não tem forma de sha256', { note: 'abc' }],
    ['sha256 em maiúsculas', { note: hash.toUpperCase() }],
  ])('%s passa na guarda de marca', async (_case, data) => {
    const harness = setup();

    const result = await harness.register([doc(data)]);

    expect(result.replayed).toBe(false);
  });

  test('o hash de data não é o campo /hash que a porta presume: o path de INVALID_INPUT é refeito', async () => {
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

  test('sem campo de anexo nem string em forma de hash, a porta de anexos nem é chamada', async () => {
    const harness = setup();

    await harness.register([note('a'), doc({ note: 'x', notes: ['y'] })]);

    expect(harness.attachments.calls).toEqual([]);
  });
});

describe('register: ordem das checagens de estado (nível 6)', () => {
  const hash = sha256hex('anexo');

  test('destino de outro processo vem antes do anexo', async () => {
    const harness = setup();

    const error = await refusal(
      harness.register([relating(ghostId('nowhere'), 'supports'), doc({ body: hash })]),
    );

    expect(error.code).toBe('RELATION_NOT_FOUND');
  });

  test('anexo vem antes das regras do próprio processo', async () => {
    const harness = setup();
    const target = await seed(harness, ORIGIN, 'e');
    await harness.register([relating(target, 'supersedes', 'v2')]);

    const error = await refusal(
      harness.register([relating(target, 'supersedes', 'fork'), doc({ body: hash })]),
    );

    expect(error.code).toBe('ATTACHMENT_NOT_FOUND');
  });
});

describe('register: PROCESS_TOO_LARGE em dois pontos (D-06)', () => {
  test('na leitura sob o lock, antes de decide: log acima do teto recusa mesmo um lote válido, sem gravar', async () => {
    const harness = setup();
    harness.processes.flags.tooLarge.add(ORIGIN);

    const error = await refusal(harness.register([note()]));

    expect(error.code).toBe('PROCESS_TOO_LARGE');
    expect(harness.processes.counters.appends).toBe(0);
  });

  test('o manifesto vem de readManifest, sem o log: a recusa estática vence PROCESS_TOO_LARGE', async () => {
    const harness = setup();
    harness.processes.flags.tooLarge.add(ORIGIN);

    const error = await refusal(harness.register([{ ...note(), data: {} }]));

    expect(error.code).toBe('INVALID_RECORD');
    expect(harness.processes.counters).toMatchObject({ writes: 0, appends: 0 });
  });

  test('no veto do lote, depois das checagens: o lote que passaria do teto não grava e o log segue legível', async () => {
    const harness = setup();
    await harness.register([note('a')]);
    const before = harness.processes.textOf(ORIGIN);
    harness.processes.flags.maxBytes = Buffer.byteLength(before) + 10;

    const error = await refusal(harness.register([note('b')]));

    expect(error.code).toBe('PROCESS_TOO_LARGE');
    expect(harness.processes.textOf(ORIGIN)).toBe(before);
    expect(verifiedOf(harness.processes).chain).toMatchObject({ ok: true, totalRecords: 1 });
  });

  test('o veto vem depois das checagens: lote que viola D-10 e passaria do teto dá a violação', async () => {
    const harness = setup();
    harness.processes.flags.maxBytes = 1;

    const error = await refusal(harness.register([relating(ghostId(ORIGIN), 'supports')]));

    expect(error.code).toBe('RELATION_NOT_FOUND');
  });

  test('replay não passa pelo veto: a chave já gravada devolve replayed mesmo com o teto estourado', async () => {
    const harness = setup();
    await harness.register([note('a')], { key: 'k' });
    harness.processes.flags.maxBytes = 1;

    const again = await harness.register([note('a')], { key: 'k' });

    expect(again.replayed).toBe(true);
  });
});
