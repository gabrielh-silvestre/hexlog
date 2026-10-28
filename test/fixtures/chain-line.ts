import { anchor, hashLink, sha256hex, type Expected, type Link } from '../../src/domain/chain.ts';
import type { RecordId } from '../../src/domain/ids.ts';
import type { Manifest } from '../../src/domain/manifest.ts';
import type { ProcessRef } from '../../src/ports.ts';
import { formatLine } from '../../src/shared/loader.ts';

type ChainLineOptions = {
  agent: string;
  /** Texto do elo `item` do lote. */
  text: (item: number) => string;
  /** Com `key`, o primeiro elo leva `batch.key`. */
  key?: string;
};

/** Manifesto sem definições fixas, com os três hashes do conjunto vazio. */
export function emptyManifest(ref: ProcessRef, createdAt = '2026-09-30T12:00:00.000Z'): Manifest {
  return {
    project: ref.project,
    process: ref.process,
    createdAt,
    fixed: { types: {}, relations: {}, gates: {} },
    hashes: { types: sha256hex(''), relations: sha256hex(''), gates: sha256hex('') },
  };
}

/** Id de elo bem formado de `processName`: o contador `n` vira os 12 dígitos hexadecimais finais do UUID. */
export const idAt = (processName: string, n: number): RecordId =>
  `${processName}:0198f4a0-0000-7000-8000-${n.toString(16).padStart(12, '0')}`;

/** Elo `expected.seq` com os campos de teste; `overrides` troca qualquer um. */
export function linkAt(expected: Expected, overrides: Partial<Link> = {}): Link {
  return {
    seq: expected.seq,
    id: idAt('proc', expected.seq),
    type: 'note',
    at: '2026-09-30T12:00:00.000Z',
    target: 'repo.feature',
    author: { agent: 'test', client: 'test' },
    data: { text: '' },
    relations: [],
    prevHash: expected.prevHash,
    ...overrides,
  };
}

/** Lote de `count` elos encadeados a partir de `end`, numa linha só. */
export function chainLine(
  processName: string,
  end: Expected,
  count: number,
  { agent, text, key }: ChainLineOptions,
): string {
  let expected = end;
  const links: Link[] = [];
  for (let item = 0; item < count; item += 1) {
    const link = linkAt(expected, {
      id: idAt(processName, expected.seq),
      author: { agent, client: 'test' },
      data: { text: text(item) },
      ...(item === 0 && key !== undefined ? { batch: { fingerprint: sha256hex(key), key } } : {}),
    });
    links.push(link);
    expected = { seq: link.seq + 1, prevHash: hashLink(link) };
  }
  return formatLine(links);
}

/**
 * `count` elos encadeados a partir da âncora de `manifest`: o `seq` N tem o id N+1 do processo e o
 * `prevHash` do elo anterior; `batchOf` põe o `batch` de cada elo.
 */
export function chainOf(
  manifest: Manifest,
  count: number,
  batchOf: (seq: number) => Link['batch'] = () => undefined,
): Link[] {
  const links: Link[] = [];
  let expected: Expected = { seq: 0, prevHash: anchor(manifest) };
  for (let seq = 0; seq < count; seq++) {
    const batch = batchOf(seq);
    const link = linkAt(expected, {
      id: idAt(manifest.process, seq + 1),
      author: { agent: 'luffy', client: 'claude-code' },
      data: { text: `record ${seq}` },
      ...(batch === undefined ? {} : { batch }),
    });
    links.push(link);
    expected = { seq: seq + 1, prevHash: hashLink(link) };
  }
  return links;
}
