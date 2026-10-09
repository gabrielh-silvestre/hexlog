import { describe, expect, test } from '@jest/globals';
import fc from 'fast-check';
import { anchor, hashLink, type Expected, type Link } from '../../src/domain/chain.ts';
import { checkExpectedHead, formatLine, verifyProcess } from '../../src/shared/loader.ts';
import { emptyManifest, linkAt } from '../fixtures/chain-line.ts';

const manifest = emptyManifest({ project: 'demo', process: 'proc-1' }, '2026-09-30T12:00:00.000Z');

/** Log de `count` elos encadeados, um por linha, a partir da âncora. */
function chainOf(count: number): Link[] {
  const links: Link[] = [];
  let expected: Expected = { seq: 0, prevHash: anchor(manifest) };
  for (let seq = 0; seq < count; seq++) {
    const link = linkAt(expected, {
      id: `proc-1:0198f4a0-0000-7000-8000-${(seq + 1).toString(16).padStart(12, '0')}`,
      author: { agent: 'luffy', client: 'claude-code' },
      data: { text: `registro ${seq}` },
    });
    links.push(link);
    expected = { seq: seq + 1, prevHash: hashLink(link) };
  }
  return links;
}

const verifiedOf = (links: readonly Link[]) =>
  verifyProcess({
    manifest,
    text: links.map((link) => formatLine([link])).join(''),
    endsWithNewline: true,
  });

// Um log de 1 a 20 elos e um corte de sufixo que sempre deixa algum elo apagado.
const cut = fc
  .integer({ min: 1, max: 20 })
  .chain((total) => fc.tuple(fc.constant(total), fc.integer({ min: 1, max: total })));

describe('checkExpectedHead: propriedades', () => {
  test('o head de antes de apagar um sufixo não vazio do log vira head-not-found', () => {
    fc.assert(
      fc.property(cut, ([total, dropped]) => {
        const links = chainOf(total);
        const headBefore = hashLink(links.at(-1)!);
        const kept = verifiedOf(links.slice(0, total - dropped));

        const chain = checkExpectedHead(kept, headBefore);

        expect(chain.ok).toBe(false);
        expect(chain.breaks.at(-1)).toEqual({ index: total - dropped, reason: 'head-not-found' });
      }),
    );
  });

  test('o hash de qualquer prefixo do log segue aceito depois de o log crescer', () => {
    fc.assert(
      fc.property(cut, ([total, prefix]) => {
        const links = chainOf(total);
        const grown = verifiedOf(links);

        const chain = checkExpectedHead(grown, hashLink(links[prefix - 1]!));

        expect(chain).toBe(grown.chain);
      }),
    );
  });
});
