import { describe, it, expect } from '@jest/globals';
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
import { idAt } from '../fixtures/chain-line.ts';

const manifest = { project: 'demo', process: 'proc-1', createdAt: '2026-09-30T12:00:00.000Z' };

const FIRST_ID = idAt('proc-1', 1);

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

describe('hashOfJcs', () => {
  it('should ignore the order of the keys, at any level', () => {
    expect(hashOfJcs({ types: ['note'], where: { a: 1, b: 2 } })).toBe(
      hashOfJcs({ where: { b: 2, a: 1 }, types: ['note'] }),
    );
  });

  it('should be a sha256 hex of 64 characters', () => {
    expect(hashOfJcs({})).toMatch(/^[0-9a-f]{64}$/);
  });

  it.each([
    ['a filter value', { types: ['note'] }, { types: ['decision'] }],
    ['an extra filter', { types: ['note'] }, { types: ['note'], text: 'x' }],
    ['the order of a list', { types: ['a', 'b'] }, { types: ['b', 'a'] }],
    ['null against absent', { target: null }, {}],
  ])('should give a different hash for %s', (_label, left, right) => {
    expect(hashOfJcs(left)).not.toBe(hashOfJcs(right));
  });

  it('should treat a key with undefined as an absent key', () => {
    expect(hashOfJcs({ text: undefined, types: ['note'] })).toBe(hashOfJcs({ types: ['note'] }));
  });
});

describe('anchor', () => {
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

describe('hashLink', () => {
  const golden = link({
    id: idAt('p', 1),
    prevHash: '0'.repeat(64),
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
    const ordered = link({ data: { a: 1, b: 2 } });
    const reordered: Link = {
      prevHash: anchor(manifest),
      relations: [],
      data: { b: 2, a: 1 },
      author: { client: 'claude-code', agent: 'luffy' },
      target: 'repo.feature',
      at: '2026-09-30T12:00:00.000Z',
      type: 'note',
      id: FIRST_ID,
      seq: 0,
    };

    expect(hashLink(reordered)).toBe(hashLink(ordered));
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

  it('should match the fixed vector with the whole item, including alias and relations', () => {
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
  const first = link();
  const second = link({ seq: 1, prevHash: hashLink(first) });
  const relations = (count: number) =>
    Array.from({ length: count }, () => ({ kind: 'supports' as const, to: FIRST_ID }));

  it('should accept the link at the expected position', () => {
    const valid = link();

    expect(isValidLink(valid, expected)).toEqual({ link: valid });
  });

  it('should accept the first link of the batch with batch', () => {
    const batched = link({
      batch: {
        fingerprint: sha256hex('x'),
        key: 'k1',
        aliases: { first: FIRST_ID },
      },
    });

    expect(isValidLink(batched, expected)).toEqual({ link: batched });
  });

  it('should reject a seq out of the expected position', () => {
    expect(isValidLink(link({ seq: 1 }), expected)).toEqual({ reasons: ['diverging-seq'] });
  });

  it('should return both position reasons for a diverging seq and prevHash together', () => {
    const both = link({ seq: 1, prevHash: sha256hex('outro') });

    expect(isValidLink(both, expected)).toEqual({ reasons: ['diverging-seq', 'hash-mismatch'] });
  });

  it('should chain the next link on the hash of the previous one', () => {
    expect(isValidLink(second, { seq: 1, prevHash: hashLink(first) })).toEqual({ link: second });
  });

  it.each<[string, unknown, Expected]>([
    [
      'a first link not anchored on the manifest hash',
      link({ prevHash: sha256hex('outro') }),
      expected,
    ],
    [
      'a next link chained on the hash of another link',
      second,
      { seq: 1, prevHash: hashLink(link({ seq: 9 })) },
    ],
    [
      'a next link whose previous link was tampered with',
      second,
      { seq: 1, prevHash: hashLink({ ...first, data: { text: 'adulterado' } }) },
    ],
  ])('should report hash-mismatch for %s', (_label, value, position) => {
    expect(isValidLink(value, position)).toEqual({ reasons: ['hash-mismatch'] });
  });

  it.each([
    ['a string', 'texto'],
    ['null', null],
  ])('should reject %s as invalid-line', (_label, value) => {
    expect(isValidLink(value, expected)).toEqual({ reasons: ['invalid-line'] });
  });

  // `expected` acompanha o `seq` do elo quando é ele o inválido, para o schema ser o único a recusar.
  it.each<[string, object, Partial<Expected>]>([
    ['an extra key', { extra: 1 }, {}],
    ['an extra key with the position also wrong', { seq: 7, extra: 1 }, {}],
    ['a missing author', { author: undefined }, {}],
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
    ['batch with a fingerprint that is not a hash', { batch: { fingerprint: 'curto' } }, {}],
    [
      'relation with an extra key',
      { relations: [{ kind: 'supports', to: FIRST_ID, extra: 1 }] },
      {},
    ],
    // `canonicalize` recusa surrogate solto; a recusa vira `invalid-line`, sem lançar.
    ['data with a lone surrogate', { data: { text: '\ud800' } }, {}],
    // Sem teto de profundidade: o aninhamento além da pilha do parse também é `invalid-line`.
    ['nesting beyond the parse stack', { data: nested(2000) }, {}],
  ])('should reject %s as invalid-line', (_label, overrides, position) => {
    const value = { ...link(), ...overrides };

    expect(isValidLink(value, { ...expected, ...position })).toEqual({
      reasons: ['invalid-line'],
    });
  });

  it.each([
    { count: RELATIONS_MAX, accepted: true, outcome: { link: expect.anything() } },
    { count: RELATIONS_MAX + 1, accepted: false, outcome: { reasons: ['invalid-line'] } },
  ])('should return success $accepted for $count relations', ({ count, outcome }) => {
    expect(isValidLink(link({ relations: relations(count) }), expected)).toMatchObject(outcome);
  });
});

describe('BATCH_KEY_MAX', () => {
  it('should be 200', () => {
    expect(BATCH_KEY_MAX).toBe(200);
  });
});

describe('BATCH_ALIASES_MAX', () => {
  it('should be 50', () => {
    expect(BATCH_ALIASES_MAX).toBe(50);
  });
});

describe('Batch', () => {
  const fingerprintOnly = { fingerprint: sha256hex('x') };
  const aliases = (count: number) =>
    Object.fromEntries(Array.from({ length: count }, (_, i) => [`a${i}`, FIRST_ID]));

  it.each([
    { length: BATCH_KEY_MAX, accepted: true },
    { length: BATCH_KEY_MAX + 1, accepted: false },
  ])('should return success $accepted for a key of $length characters', ({ length, accepted }) => {
    expect(Batch.safeParse({ ...fingerprintOnly, key: 'k'.repeat(length) }).success).toBe(accepted);
  });

  it.each([
    { count: BATCH_ALIASES_MAX, accepted: true },
    { count: BATCH_ALIASES_MAX + 1, accepted: false },
  ])('should return success $accepted for $count aliases', ({ count, accepted }) => {
    expect(Batch.safeParse({ ...fingerprintOnly, aliases: aliases(count) }).success).toBe(accepted);
  });
});
