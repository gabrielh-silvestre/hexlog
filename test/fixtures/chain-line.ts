import { hashLink, sha256hex, type Expected, type Link } from '../../src/domain/chain.ts';
import { formatLine } from '../../src/shared/loader.ts';

export type ChainLineOptions = {
  agent: string;
  /** Texto do elo `item` do lote. */
  text: (item: number) => string;
  /** Com `key`, o primeiro elo leva `batch.key` (D-06). */
  key?: string;
};

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
    const link: Link = {
      seq: expected.seq,
      id: `${processName}:0198f4a0-0000-7000-8000-${expected.seq.toString(16).padStart(12, '0')}`,
      type: 'note',
      at: '2026-09-30T12:00:00.000Z',
      target: 'repo.feature',
      author: { agent, client: 'test' },
      data: { text: text(item) },
      relations: [],
      prevHash: expected.prevHash,
      ...(item === 0 && key !== undefined ? { batch: { fingerprint: sha256hex(key), key } } : {}),
    };
    links.push(link);
    expected = { seq: link.seq + 1, prevHash: hashLink(link) };
  }
  return formatLine(links);
}
