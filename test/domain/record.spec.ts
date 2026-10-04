import { describe, test, expect } from '@jest/globals';
import { randomUUIDv7 } from 'node:crypto';
import canonicalize from 'canonicalize';
import {
  Author,
  BATCH_MAX,
  BatchItem,
  DATA_MAX_CHARS,
  HexRecord,
  RELATIONS_MAX,
  Relation,
  RelationInput,
  RelationKind,
} from '../../src/domain/record.ts';

const id = () => `proc-1:${randomUUIDv7()}`;
const author = { agent: 'naruto', client: 'claude-code' };

/** Objeto cujo JCS tem exatamente `chars` caracteres. */
function dataWithCanonicalLength(chars: number) {
  const overhead = (canonicalize({ k: '' }) ?? '').length;
  return { k: 'x'.repeat(chars - overhead) };
}

describe('tetos', () => {
  test('teto de data é 16.000, o de lote é 50 e o de relações é 100', () => {
    expect(DATA_MAX_CHARS).toBe(16_000);
    expect(BATCH_MAX).toBe(50);
    expect(RELATIONS_MAX).toBe(100);
  });
});

describe('RelationKind', () => {
  test('lista os oito tipos de relação', () => {
    expect(RelationKind.options).toEqual([
      'supersedes',
      'revokes',
      'supports',
      'contradicts',
      'answers',
      'derivesFrom',
      'complements',
      'reopens',
    ]);
  });
});

describe('Author', () => {
  test('model é opcional', () => {
    expect(Author.safeParse(author).success).toBe(true);
    expect(Author.safeParse({ ...author, model: 'opus' }).success).toBe(true);
  });

  test.each([{ client: 'c' }, { agent: 'a' }, { ...author, agent: '' }, { ...author, extra: 1 }])(
    '%j é inválido',
    (value) => {
      expect(Author.safeParse(value).success).toBe(false);
    },
  );

  test.each(['agent', 'model', 'client'])('%s com surrogate solitário é inválido', (field) => {
    expect(Author.safeParse({ ...author, [field]: 'x\ud800' }).success).toBe(false);
  });
});

describe('Relation', () => {
  test('kind e to são obrigatórios e as é opcional', () => {
    expect(Relation.safeParse({ kind: 'supports', to: id() }).success).toBe(true);
    expect(Relation.safeParse({ kind: 'supports', to: id(), as: 'approves' }).success).toBe(true);
    expect(Relation.safeParse({ to: id() }).success).toBe(false);
  });

  test('recusa chave desconhecida', () => {
    expect(Relation.safeParse({ kind: 'supports', to: id(), extra: 1 }).success).toBe(false);
  });

  test('to gravado nunca é alias', () => {
    expect(Relation.safeParse({ kind: 'supports', to: '@a' }).success).toBe(false);
  });
});

describe('RelationInput', () => {
  test('aceita id ou @alias em to, com kind ou as', () => {
    expect(RelationInput.safeParse({ to: id(), kind: 'supports' }).success).toBe(true);
    expect(RelationInput.safeParse({ to: '@plan-1', kind: 'supports' }).success).toBe(true);
    expect(RelationInput.safeParse({ to: '@plan-1', as: 'approves' }).success).toBe(true);
    expect(
      RelationInput.safeParse({ to: '@plan-1', kind: 'supports', as: 'approves' }).success,
    ).toBe(true);
  });

  test('recusa relação sem kind e sem as', () => {
    const result = RelationInput.safeParse({ to: id() });
    expect(result.success).toBe(false);
    expect(result.error?.issues).toEqual([
      expect.objectContaining({ path: ['kind'], message: 'relation needs kind or as' }),
    ]);
  });

  test.each([{}, { to: 'plan-1' }, { to: '@' }, { to: '@A' }, { to: id(), kind: 'likes' }])(
    '%j é inválido',
    (value) => {
      expect(RelationInput.safeParse(value).success).toBe(false);
    },
  );
});

describe('BatchItem', () => {
  const item = { type: 'note', target: 'a.b', data: { text: 'oi' } };

  test('alias e relations são opcionais', () => {
    expect(BatchItem.safeParse(item).success).toBe(true);
    expect(
      BatchItem.safeParse({
        ...item,
        alias: 'first',
        relations: [{ to: '@other', as: 'approves' }],
      }).success,
    ).toBe(true);
  });

  test.each([
    { ...item, type: undefined },
    { ...item, target: 'A.b' },
    { ...item, data: 'texto' },
    { ...item, id: id() },
    { ...item, alias: '@first' },
  ])('%j é inválido', (value) => {
    expect(BatchItem.safeParse(value).success).toBe(false);
  });

  test('data no teto canônico passa e um caractere a mais cai', () => {
    const atCap = dataWithCanonicalLength(DATA_MAX_CHARS);
    expect((canonicalize(atCap) ?? '').length).toBe(DATA_MAX_CHARS);
    expect(BatchItem.safeParse({ ...item, data: atCap }).success).toBe(true);
    expect(
      BatchItem.safeParse({ ...item, data: dataWithCanonicalLength(DATA_MAX_CHARS + 1) }).success,
    ).toBe(false);
  });

  test('o teto de data conta unidades UTF-16 do JCS: com emoji (2 unidades), 7996 cabem e 7997 não', () => {
    const emojis = (count: number) => ({ k: '😀'.repeat(count) });
    expect((canonicalize(emojis(7996)) ?? '').length).toBe(DATA_MAX_CHARS);
    expect(BatchItem.safeParse({ ...item, data: emojis(7996) }).success).toBe(true);
    expect(BatchItem.safeParse({ ...item, data: emojis(7997) }).success).toBe(false);
  });

  test('data com surrogate solitário é recusado sem lançar', () => {
    expect(BatchItem.safeParse({ ...item, data: { text: '\ud800' } }).success).toBe(false);
  });

  test('relations no teto passam e uma a mais cai', () => {
    const relations = (count: number) =>
      Array.from({ length: count }, () => ({ to: id(), kind: 'supports' }));
    expect(BatchItem.safeParse({ ...item, relations: relations(RELATIONS_MAX) }).success).toBe(
      true,
    );
    expect(BatchItem.safeParse({ ...item, relations: relations(RELATIONS_MAX + 1) }).success).toBe(
      false,
    );
  });

  test('data que não é JSON é recusado', () => {
    expect(BatchItem.safeParse({ ...item, data: { fn: () => 1 } }).success).toBe(false);
    expect(BatchItem.safeParse({ ...item, data: { missing: undefined } }).success).toBe(false);
  });
});

describe('HexRecord', () => {
  const record = {
    id: id(),
    type: 'note',
    at: new Date().toISOString(),
    target: 'a.b',
    author,
    data: { text: 'oi' },
    relations: [{ kind: 'supports', to: id() }],
  };

  test('aceita o registro completo', () => {
    expect(HexRecord.safeParse(record).success).toBe(true);
  });

  test('relations no teto passam e uma a mais cai', () => {
    const relations = (count: number) =>
      Array.from({ length: count }, () => ({ kind: 'supports', to: id() }));
    expect(HexRecord.safeParse({ ...record, relations: relations(RELATIONS_MAX) }).success).toBe(
      true,
    );
    expect(
      HexRecord.safeParse({ ...record, relations: relations(RELATIONS_MAX + 1) }).success,
    ).toBe(false);
  });

  test.each([
    { ...record, relations: undefined },
    { ...record, relations: [{ to: id() }] },
    { ...record, at: '2026-09-30' },
    { ...record, seq: 1 },
  ])('%j é inválido', (value) => {
    expect(HexRecord.safeParse(value).success).toBe(false);
  });
});
