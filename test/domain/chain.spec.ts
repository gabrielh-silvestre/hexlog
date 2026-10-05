import { describe, test, expect } from '@jest/globals';
import canonicalize from 'canonicalize';
import { omit } from 'es-toolkit';
import {
  anchor,
  BATCH_ALIASES_MAX,
  BATCH_KEY_MAX,
  Batch,
  fingerprint,
  hashLink,
  hashOfJcs,
  isValidLink,
  sha256hex,
  type Expected,
  type Link,
} from '../../src/domain/chain.ts';
import { RELATIONS_MAX } from '../../src/domain/record.ts';
import { HexlogError } from '../../src/errors.ts';

const manifest = { project: 'demo', process: 'proc-1', createdAt: '2026-09-30T12:00:00.000Z' };

const FIRST_ID = 'proc-1:0198f4a0-0000-7000-8000-000000000001';

function link(overrides: Partial<Link> = {}): Link {
  return {
    seq: 0,
    id: FIRST_ID,
    type: 'note',
    at: '2026-09-30T12:00:00.000Z',
    target: 'repo.feature',
    author: { agent: 'luffy', client: 'claude-code' },
    data: { text: 'olá' },
    relations: [],
    prevHash: anchor(manifest),
    ...overrides,
  };
}

/** Objeto com `depth` níveis de aninhamento, além do que a pilha do parse aguenta. */
function nested(depth: number): Link['data'] {
  let value: Link['data'] = {};
  for (let level = 0; level < depth; level += 1) value = { a: value };
  return value;
}

describe('sha256hex', () => {
  test('dá o sha256 conhecido de "abc"', () => {
    expect(sha256hex('abc')).toBe(
      'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
    );
  });

  test('bytes e string equivalentes dão o mesmo hash', () => {
    expect(sha256hex(new TextEncoder().encode('abc'))).toBe(sha256hex('abc'));
  });
});

describe('anchor', () => {
  test('é o sha256 do JCS do manifesto', () => {
    expect(anchor(manifest)).toBe(sha256hex(canonicalize(manifest) ?? ''));
  });

  test('vetor fixo do formato em disco (JCS conferido com implementação independente)', () => {
    expect(anchor(manifest)).toBe(
      'd12892a7e456a2217df197429f4a28ed5ffe8ba1f712a735db0b01a4df2e9ab4',
    );
  });

  test('independe da ordem das chaves do manifesto', () => {
    const reordered = { createdAt: manifest.createdAt, process: manifest.process, project: 'demo' };
    expect(anchor(reordered)).toBe(anchor(manifest));
  });

  test.each([
    ['undefined', undefined],
    ['função', () => 1],
  ])('valor sem forma JSON (%s) lança INTERNAL em vez de dar o hash de ""', (_label, value) => {
    expect(() => anchor(value)).toThrow(HexlogError);
    expect(() => anchor(value)).toThrow(expect.objectContaining({ code: 'INTERNAL' }));
  });
});

describe('hashOfJcs', () => {
  test('é o sha256 do JCS do valor, e a âncora é o mesmo hash do manifesto', () => {
    const definition = { type: 'object', properties: { b: {}, a: {} } };

    expect(hashOfJcs(definition)).toBe(sha256hex(canonicalize(definition) ?? ''));
    expect(anchor(manifest)).toBe(hashOfJcs(manifest));
  });
});

describe('hashLink', () => {
  test('é sha256(prevHash + JCS do elo sem prevHash)', () => {
    const l = link();
    const { prevHash, ...rest } = l;
    expect(hashLink(l)).toBe(sha256hex(prevHash + (canonicalize(rest) ?? '')));
  });

  test('vetores fixos do formato em disco, sem e com batch', () => {
    const golden = link({
      id: 'p:0198f4a0-0000-7000-8000-000000000001',
      prevHash: '0'.repeat(64),
    });
    expect(hashLink(golden)).toBe(
      '530b7254fabda81a351210e74c3a0b1746bf042b33c484e732f5272607064961',
    );
    const batched = {
      ...golden,
      batch: { fingerprint: 'a'.repeat(64), key: 'k', aliases: { first: golden.id } },
    };
    expect(hashLink(batched)).toBe(
      'c8ca92b3af8381e861678807d165b1a45e05cad906a226e6ae921107753d4b03',
    );
  });

  test('dois elos com as mesmas chaves em ordem diferente dão o mesmo hash', () => {
    const a = link({ id: 'proc-1:0198f4a0-0000-7000-8000-000000000001', data: { a: 1, b: 2 } });
    const b = Object.fromEntries(Object.entries(a).reverse()) as Link;
    b.data = { b: 2, a: 1 };
    expect(hashLink(b)).toBe(hashLink(a));
  });

  test('mudar o conteúdo ou o prevHash muda o hash', () => {
    const base = link();
    expect(hashLink({ ...base, data: { text: 'outro' } })).not.toBe(hashLink(base));
    expect(hashLink({ ...base, prevHash: sha256hex('x') })).not.toBe(hashLink(base));
  });

  test('o batch entra no hash', () => {
    const base = link();
    const batched = { ...base, batch: { fingerprint: sha256hex('x') } };
    expect(hashLink(batched)).not.toBe(hashLink(base));
  });
});

describe('fingerprint', () => {
  const item = { type: 'note', target: 'repo.feature', data: { a: 1, b: 2 } };
  const items = [item];

  test('dois lotes iguais com chaves em ordem diferente dão a mesma impressão', () => {
    const reordered = [{ data: { b: 2, a: 1 }, target: 'repo.feature', type: 'note' }];
    expect(fingerprint(reordered)).toBe(fingerprint(items));
  });

  test('conteúdo diferente dá impressão diferente', () => {
    expect(fingerprint([{ ...item, data: { a: 1 } }])).not.toBe(fingerprint(items));
  });

  test('é o sha256 do JCS dos itens', () => {
    expect(fingerprint(items)).toBe(sha256hex(canonicalize(items) ?? ''));
  });

  test('vetor fixo: o item inteiro entra, com alias e relations (D-06)', () => {
    const full = [
      {
        type: 'note',
        target: 'a.b',
        data: { b: 2, a: 1 },
        alias: 'first',
        relations: [{ to: '@x', kind: 'supports' as const }],
      },
    ];
    expect(fingerprint(full)).toBe(
      '914b338a713495d5df281d4e98f1bda7d75e291f488c31ba58e306881bc33eff',
    );
  });
});

describe('isValidLink', () => {
  const expected = { seq: 0, prevHash: anchor(manifest) };

  test('aceita o elo na posição esperada', () => {
    const l = link();
    expect(isValidLink(l, expected)).toEqual({ link: l });
  });

  test('aceita o primeiro elo do lote com batch', () => {
    const l = link({
      batch: {
        fingerprint: sha256hex('x'),
        key: 'k1',
        aliases: { first: 'proc-1:0198f4a0-0000-7000-8000-000000000001' },
      },
    });
    expect(isValidLink(l, expected)).toEqual({ link: l });
  });

  test('ancora o primeiro elo no hash do manifesto', () => {
    expect(isValidLink(link({ prevHash: sha256hex('outro') }), expected)).toEqual({
      reasons: ['hash-mismatch'],
    });
  });

  test('recusa seq fora da posição esperada', () => {
    expect(isValidLink(link({ seq: 1 }), expected)).toEqual({ reasons: ['diverging-seq'] });
  });

  test('seq e prevHash divergentes juntos devolvem as duas razões de posição', () => {
    const both = link({ seq: 1, prevHash: sha256hex('outro') });
    expect(isValidLink(both, expected)).toEqual({ reasons: ['diverging-seq', 'hash-mismatch'] });
  });

  test('o elo seguinte encadeia no hash do anterior', () => {
    const first = link();
    const second = link({ seq: 1, prevHash: hashLink(first) });
    expect(isValidLink(second, { seq: 1, prevHash: hashLink(first) })).toEqual({ link: second });
    expect(isValidLink(second, { seq: 1, prevHash: hashLink(link({ seq: 9 })) })).toEqual({
      reasons: ['hash-mismatch'],
    });
  });

  test('adulterar o conteúdo do elo anterior quebra o encadeamento', () => {
    const first = link();
    const second = link({ seq: 1, prevHash: hashLink(first) });
    const tamperedFirst = { ...first, data: { text: 'adulterado' } };
    expect(isValidLink(second, { seq: 1, prevHash: hashLink(tamperedFirst) })).toEqual({
      reasons: ['hash-mismatch'],
    });
  });

  test('recusa campo desconhecido, campo ausente e valor que não é objeto', () => {
    const invalidLine = { reasons: ['invalid-line'] };
    expect(isValidLink({ ...link(), extra: 1 }, expected)).toEqual(invalidLine);
    expect(isValidLink(omit(link(), ['author']), expected)).toEqual(invalidLine);
    expect(isValidLink('texto', expected)).toEqual(invalidLine);
    expect(isValidLink(null, expected)).toEqual(invalidLine);
  });

  test('forma inválida é só invalid-line, mesmo com a posição também errada', () => {
    const wrongShapeAndPosition = { ...link({ seq: 7 }), extra: 1 };
    expect(isValidLink(wrongShapeAndPosition, expected)).toEqual({ reasons: ['invalid-line'] });
  });

  // `expected` acompanha o `seq` do elo quando é ele o inválido, para o schema ser o único a recusar.
  test.each<[string, object, Partial<Expected>]>([
    ['seq negativo', { seq: -1 }, { seq: -1 }],
    ['seq fracionário', { seq: 1.5 }, { seq: 1.5 }],
    ['seq string', { seq: '1' }, {}],
    ['batch.key vazia', { batch: { fingerprint: sha256hex('x'), key: '' } }, {}],
    [
      'alias com @ na chave',
      { batch: { fingerprint: sha256hex('x'), aliases: { '@x': FIRST_ID } } },
      {},
    ],
    [
      'alias com valor que não é id',
      { batch: { fingerprint: sha256hex('x'), aliases: { x: 'nope' } } },
      {},
    ],
    ['batch com chave extra', { batch: { fingerprint: sha256hex('x'), extra: 1 } }, {}],
    ['relação com chave extra', { relations: [{ kind: 'supports', to: FIRST_ID, extra: 1 }] }, {}],
  ])('recusa %s com a posição certa', (_label, overrides, position) => {
    const value = { ...link(), ...overrides };
    expect(isValidLink(value, { ...expected, ...position })).toEqual({
      reasons: ['invalid-line'],
    });
  });

  test('recusa batch com fingerprint que não é hash', () => {
    const l = { ...link(), batch: { fingerprint: 'curto' } };
    expect(isValidLink(l, expected)).toEqual({ reasons: ['invalid-line'] });
  });

  test('data que o canonicalize recusa (surrogate solitário) é invalid-line, não exceção', () => {
    expect(isValidLink(link({ data: { text: '\ud800' } }), expected)).toEqual({
      reasons: ['invalid-line'],
    });
  });

  test('aninhamento além da pilha do parse é invalid-line, sem teto de profundidade', () => {
    expect(isValidLink(link({ data: nested(2000) }), expected)).toEqual({
      reasons: ['invalid-line'],
    });
  });

  test('relações no teto passam e uma a mais cai (tetos do N8)', () => {
    const relations = (count: number) =>
      Array.from({ length: count }, () => ({ kind: 'supports' as const, to: FIRST_ID }));
    expect(isValidLink(link({ relations: relations(RELATIONS_MAX) }), expected)).toHaveProperty(
      'link',
    );
    expect(isValidLink(link({ relations: relations(RELATIONS_MAX + 1) }), expected)).toEqual({
      reasons: ['invalid-line'],
    });
  });
});

describe('Batch (tetos do N8)', () => {
  const fingerprintOnly = { fingerprint: sha256hex('x') };

  test('key no teto passa e um caractere a mais cai', () => {
    expect(BATCH_KEY_MAX).toBe(200);
    expect(Batch.safeParse({ ...fingerprintOnly, key: 'k'.repeat(BATCH_KEY_MAX) }).success).toBe(
      true,
    );
    expect(
      Batch.safeParse({ ...fingerprintOnly, key: 'k'.repeat(BATCH_KEY_MAX + 1) }).success,
    ).toBe(false);
  });

  test('aliases no teto passam e uma entrada a mais cai', () => {
    const aliases = (count: number) =>
      Object.fromEntries(Array.from({ length: count }, (_, i) => [`a${i}`, FIRST_ID]));
    expect(BATCH_ALIASES_MAX).toBe(50);
    expect(
      Batch.safeParse({ ...fingerprintOnly, aliases: aliases(BATCH_ALIASES_MAX) }).success,
    ).toBe(true);
    expect(
      Batch.safeParse({ ...fingerprintOnly, aliases: aliases(BATCH_ALIASES_MAX + 1) }).success,
    ).toBe(false);
  });
});
