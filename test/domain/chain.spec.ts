import { describe, it, expect } from '@jest/globals';
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
  it('should return the known sha256 of "abc"', () => {
    expect(sha256hex('abc')).toBe(
      'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
    );
  });

  it('should return the same hash for equivalent bytes and string', () => {
    expect(sha256hex(new TextEncoder().encode('abc'))).toBe(sha256hex('abc'));
  });
});

describe('anchor', () => {
  it('should be the sha256 of the JCS of the manifest', () => {
    expect(anchor(manifest)).toBe(sha256hex(canonicalize(manifest) ?? ''));
  });

  it('should match the fixed vector of the on-disk format (JCS checked against an independent implementation)', () => {
    expect(anchor(manifest)).toBe(
      'd12892a7e456a2217df197429f4a28ed5ffe8ba1f712a735db0b01a4df2e9ab4',
    );
  });

  it('should not depend on the key order of the manifest', () => {
    const reordered = { createdAt: manifest.createdAt, process: manifest.process, project: 'demo' };

    expect(anchor(reordered)).toBe(anchor(manifest));
  });

  it('should be the same hash as the hashOfJcs of the manifest', () => {
    expect(anchor(manifest)).toBe(hashOfJcs(manifest));
  });

  it.each([
    ['undefined', undefined],
    ['function', () => 1],
  ])(
    'should throw INTERNAL instead of the hash of "" for a value without JSON form: %s',
    (_label, value) => {
      expect(() => anchor(value)).toThrow(HexlogError);
      expect(() => anchor(value)).toThrow(expect.objectContaining({ code: 'INTERNAL' }));
    },
  );
});

describe('hashOfJcs', () => {
  it('should be the sha256 of the JCS of the value', () => {
    const definition = { type: 'object', properties: { b: {}, a: {} } };

    expect(hashOfJcs(definition)).toBe(sha256hex(canonicalize(definition) ?? ''));
  });
});

describe('hashLink', () => {
  const golden = link({
    id: 'p:0198f4a0-0000-7000-8000-000000000001',
    prevHash: '0'.repeat(64),
  });

  it('should be sha256(prevHash + JCS of the link without prevHash)', () => {
    const l = link();
    const { prevHash, ...rest } = l;

    expect(hashLink(l)).toBe(sha256hex(prevHash + (canonicalize(rest) ?? '')));
  });

  it.each<[string, Link, string]>([
    ['without batch', golden, '530b7254fabda81a351210e74c3a0b1746bf042b33c484e732f5272607064961'],
    [
      'with batch',
      {
        ...golden,
        batch: { fingerprint: 'a'.repeat(64), key: 'k', aliases: { first: golden.id } },
      },
      'c8ca92b3af8381e861678807d165b1a45e05cad906a226e6ae921107753d4b03',
    ],
  ])('should match the fixed vector of the on-disk format %s', (_label, value, hash) => {
    expect(hashLink(value)).toBe(hash);
  });

  it('should give the same hash to two links with the same keys in a different order', () => {
    const a = link({ id: 'proc-1:0198f4a0-0000-7000-8000-000000000001', data: { a: 1, b: 2 } });
    const b = Object.fromEntries(Object.entries(a).reverse()) as Link;
    b.data = { b: 2, a: 1 };

    expect(hashLink(b)).toBe(hashLink(a));
  });

  it('should change the hash when the content or the prevHash changes', () => {
    const base = link();

    expect(hashLink({ ...base, data: { text: 'outro' } })).not.toBe(hashLink(base));
    expect(hashLink({ ...base, prevHash: sha256hex('x') })).not.toBe(hashLink(base));
  });

  it('should include the batch in the hash', () => {
    const base = link();
    const batched = { ...base, batch: { fingerprint: sha256hex('x') } };

    expect(hashLink(batched)).not.toBe(hashLink(base));
  });
});

describe('fingerprint', () => {
  const item = { type: 'note', target: 'repo.feature', data: { a: 1, b: 2 } };
  const items = [item];

  it('should give the same fingerprint to two equal batches with keys in a different order', () => {
    const reordered = [{ data: { b: 2, a: 1 }, target: 'repo.feature', type: 'note' }];

    expect(fingerprint(reordered)).toBe(fingerprint(items));
  });

  it('should give a different fingerprint to different content', () => {
    expect(fingerprint([{ ...item, data: { a: 1 } }])).not.toBe(fingerprint(items));
  });

  it('should be the sha256 of the JCS of the items', () => {
    expect(fingerprint(items)).toBe(sha256hex(canonicalize(items) ?? ''));
  });

  it('should match the fixed vector with the whole item, including alias and relations (D-06)', () => {
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
  const relations = (count: number) =>
    Array.from({ length: count }, () => ({ kind: 'supports' as const, to: FIRST_ID }));

  it('should accept the link at the expected position', () => {
    const l = link();

    expect(isValidLink(l, expected)).toEqual({ link: l });
  });

  it('should accept the first link of the batch with batch', () => {
    const l = link({
      batch: {
        fingerprint: sha256hex('x'),
        key: 'k1',
        aliases: { first: 'proc-1:0198f4a0-0000-7000-8000-000000000001' },
      },
    });

    expect(isValidLink(l, expected)).toEqual({ link: l });
  });

  it('should anchor the first link on the manifest hash', () => {
    expect(isValidLink(link({ prevHash: sha256hex('outro') }), expected)).toEqual({
      reasons: ['hash-mismatch'],
    });
  });

  it('should reject a seq out of the expected position', () => {
    expect(isValidLink(link({ seq: 1 }), expected)).toEqual({ reasons: ['diverging-seq'] });
  });

  it('should return both position reasons for a diverging seq and prevHash together', () => {
    const both = link({ seq: 1, prevHash: sha256hex('outro') });

    expect(isValidLink(both, expected)).toEqual({ reasons: ['diverging-seq', 'hash-mismatch'] });
  });

  it('should chain the next link on the hash of the previous one', () => {
    const first = link();
    const second = link({ seq: 1, prevHash: hashLink(first) });

    expect(isValidLink(second, { seq: 1, prevHash: hashLink(first) })).toEqual({ link: second });
    expect(isValidLink(second, { seq: 1, prevHash: hashLink(link({ seq: 9 })) })).toEqual({
      reasons: ['hash-mismatch'],
    });
  });

  it('should break the chaining when the content of the previous link is tampered with', () => {
    const first = link();
    const second = link({ seq: 1, prevHash: hashLink(first) });
    const tamperedFirst = { ...first, data: { text: 'adulterado' } };

    expect(isValidLink(second, { seq: 1, prevHash: hashLink(tamperedFirst) })).toEqual({
      reasons: ['hash-mismatch'],
    });
  });

  it('should reject a malformed line as invalid-line', () => {
    const invalidLine = { reasons: ['invalid-line'] };

    expect(isValidLink({ ...link(), extra: 1 }, expected)).toEqual(invalidLine);
    expect(isValidLink(omit(link(), ['author']), expected)).toEqual(invalidLine);
    expect(isValidLink('texto', expected)).toEqual(invalidLine);
    expect(isValidLink(null, expected)).toEqual(invalidLine);
  });

  it('should return only invalid-line for an invalid shape, even with the position also wrong', () => {
    const wrongShapeAndPosition = { ...link({ seq: 7 }), extra: 1 };

    expect(isValidLink(wrongShapeAndPosition, expected)).toEqual({ reasons: ['invalid-line'] });
  });

  // `expected` acompanha o `seq` do elo quando é ele o inválido, para o schema ser o único a recusar.
  it.each<[string, object, Partial<Expected>]>([
    ['negative seq', { seq: -1 }, { seq: -1 }],
    ['fractional seq', { seq: 1.5 }, { seq: 1.5 }],
    ['string seq', { seq: '1' }, {}],
    ['empty batch.key', { batch: { fingerprint: sha256hex('x'), key: '' } }, {}],
    [
      'alias with @ in the key',
      { batch: { fingerprint: sha256hex('x'), aliases: { '@x': FIRST_ID } } },
      {},
    ],
    [
      'alias with a value that is not an id',
      { batch: { fingerprint: sha256hex('x'), aliases: { x: 'nope' } } },
      {},
    ],
    ['batch with an extra key', { batch: { fingerprint: sha256hex('x'), extra: 1 } }, {}],
    [
      'relation with an extra key',
      { relations: [{ kind: 'supports', to: FIRST_ID, extra: 1 }] },
      {},
    ],
  ])('should reject %s with the right position', (_label, overrides, position) => {
    const value = { ...link(), ...overrides };

    expect(isValidLink(value, { ...expected, ...position })).toEqual({
      reasons: ['invalid-line'],
    });
  });

  it('should reject a batch with a fingerprint that is not a hash', () => {
    const l = { ...link(), batch: { fingerprint: 'curto' } };

    expect(isValidLink(l, expected)).toEqual({ reasons: ['invalid-line'] });
  });

  it('should return invalid-line, not throw, for data that canonicalize refuses (lone surrogate)', () => {
    expect(isValidLink(link({ data: { text: '\ud800' } }), expected)).toEqual({
      reasons: ['invalid-line'],
    });
  });

  it('should return invalid-line for nesting beyond the parse stack, with no depth ceiling', () => {
    expect(isValidLink(link({ data: nested(2000) }), expected)).toEqual({
      reasons: ['invalid-line'],
    });
  });

  it('should accept relations at the ceiling (N8)', () => {
    expect(isValidLink(link({ relations: relations(RELATIONS_MAX) }), expected)).toHaveProperty(
      'link',
    );
  });

  it('should reject one relation over the ceiling (N8)', () => {
    expect(isValidLink(link({ relations: relations(RELATIONS_MAX + 1) }), expected)).toEqual({
      reasons: ['invalid-line'],
    });
  });
});

describe('Batch', () => {
  const fingerprintOnly = { fingerprint: sha256hex('x') };
  const aliases = (count: number) =>
    Object.fromEntries(Array.from({ length: count }, (_, i) => [`a${i}`, FIRST_ID]));

  it('should accept a key at the ceiling (N8)', () => {
    expect(BATCH_KEY_MAX).toBe(200);

    expect(Batch.safeParse({ ...fingerprintOnly, key: 'k'.repeat(BATCH_KEY_MAX) }).success).toBe(
      true,
    );
  });

  it('should reject a key one character over the ceiling (N8)', () => {
    expect(
      Batch.safeParse({ ...fingerprintOnly, key: 'k'.repeat(BATCH_KEY_MAX + 1) }).success,
    ).toBe(false);
  });

  it('should accept aliases at the ceiling (N8)', () => {
    expect(BATCH_ALIASES_MAX).toBe(50);

    expect(
      Batch.safeParse({ ...fingerprintOnly, aliases: aliases(BATCH_ALIASES_MAX) }).success,
    ).toBe(true);
  });

  it('should reject one alias entry over the ceiling (N8)', () => {
    expect(
      Batch.safeParse({ ...fingerprintOnly, aliases: aliases(BATCH_ALIASES_MAX + 1) }).success,
    ).toBe(false);
  });
});
