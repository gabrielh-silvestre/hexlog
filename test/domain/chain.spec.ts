import { describe, test, expect } from '@jest/globals';
import { randomUUIDv7 } from 'node:crypto';
import canonicalize from 'canonicalize';
import { omit } from 'es-toolkit';
import {
  anchor,
  fingerprint,
  hashLink,
  isValidLink,
  sha256hex,
  type Link,
} from '../../src/domain/chain.ts';

const manifest = { project: 'demo', process: 'proc-1', createdAt: '2026-09-30T12:00:00.000Z' };

function link(overrides: Partial<Link> = {}): Link {
  return {
    seq: 0,
    id: `proc-1:${randomUUIDv7()}`,
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

  test('independe da ordem das chaves do manifesto', () => {
    const reordered = { createdAt: manifest.createdAt, process: manifest.process, project: 'demo' };
    expect(anchor(reordered)).toBe(anchor(manifest));
  });
});

describe('hashLink', () => {
  test('é sha256(prevHash + JCS do elo sem prevHash)', () => {
    const l = link();
    const { prevHash, ...rest } = l;
    expect(hashLink(l)).toBe(sha256hex(prevHash + (canonicalize(rest) ?? '')));
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
});

describe('isValidLink', () => {
  const expected = { seq: 0, prevHash: anchor(manifest) };

  test('aceita o elo na posição esperada', () => {
    const l = link();
    expect(isValidLink(l, expected)).toEqual(l);
  });

  test('aceita o primeiro elo do lote com batch', () => {
    const l = link({
      batch: {
        fingerprint: sha256hex('x'),
        key: 'k1',
        aliases: { first: 'proc-1:0198f4a0-0000-7000-8000-000000000001' },
      },
    });
    expect(isValidLink(l, expected)).toEqual(l);
  });

  test('ancora o primeiro elo no hash do manifesto', () => {
    expect(isValidLink(link({ prevHash: sha256hex('outro') }), expected)).toBeNull();
  });

  test('recusa seq fora da posição esperada', () => {
    expect(isValidLink(link({ seq: 1 }), expected)).toBeNull();
  });

  test('recusa prevHash adulterado', () => {
    const tampered = link({ prevHash: `${anchor(manifest).slice(0, 63)}0` });
    expect(isValidLink(tampered, expected)).toBeNull();
  });

  test('o elo seguinte encadeia no hash do anterior', () => {
    const first = link();
    const second = link({ seq: 1, prevHash: hashLink(first) });
    expect(isValidLink(second, { seq: 1, prevHash: hashLink(first) })).toEqual(second);
    expect(isValidLink(second, { seq: 1, prevHash: hashLink(link()) })).toBeNull();
  });

  test('adulterar o conteúdo do elo anterior quebra o encadeamento', () => {
    const first = link();
    const second = link({ seq: 1, prevHash: hashLink(first) });
    const tamperedFirst = { ...first, data: { text: 'adulterado' } };
    expect(isValidLink(second, { seq: 1, prevHash: hashLink(tamperedFirst) })).toBeNull();
  });

  test('recusa campo desconhecido, campo ausente e valor que não é objeto', () => {
    expect(isValidLink({ ...link(), extra: 1 }, expected)).toBeNull();
    expect(isValidLink(omit(link(), ['author']), expected)).toBeNull();
    expect(isValidLink('texto', expected)).toBeNull();
    expect(isValidLink(null, expected)).toBeNull();
  });

  test('recusa batch com fingerprint que não é hash', () => {
    const l = { ...link(), batch: { fingerprint: 'curto' } };
    expect(isValidLink(l, expected)).toBeNull();
  });
});
