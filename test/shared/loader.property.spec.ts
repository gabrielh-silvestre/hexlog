import { describe, expect, it } from '@jest/globals';
import fc from 'fast-check';
import { anchor, hashLink, type Link } from '../../src/domain/chain.ts';
import { checkExpectedHead, formatLine, verifyProcess } from '../../src/shared/loader.ts';
import { chainOf as chainFrom, emptyManifest } from '../fixtures/chain-line.ts';
import { at } from '../helpers.ts';

const manifest = emptyManifest({ project: 'demo', process: 'proc-1' }, '2026-09-30T12:00:00.000Z');

/** Log de `count` elos encadeados, um por linha, a partir da âncora. */
const chainOf = (count: number) => chainFrom(manifest, count);

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

describe('checkExpectedHead', () => {
  it('should always accept the process anchor, with or without a link in the log', () => {
    const totals = fc.integer({ min: 0, max: 20 });

    fc.assert(
      fc.property(totals, (total) => {
        const verified = verifiedOf(chainOf(total));

        expect(checkExpectedHead(verified, anchor(manifest))).toBe(verified.chain);
      }),
    );
  });

  it('should turn the head from before dropping a non-empty suffix of the log into head-not-found', () => {
    fc.assert(
      fc.property(cut, ([total, dropped]) => {
        const links = chainOf(total);
        const headBefore = hashLink(at(links, total - 1));
        const kept = verifiedOf(links.slice(0, total - dropped));

        const chain = checkExpectedHead(kept, headBefore);

        expect(chain.ok).toBe(false);
        expect(chain.breaks.at(-1)).toEqual({ index: total - dropped, reason: 'head-not-found' });
      }),
    );
  });

  it('should keep accepting the hash of any prefix of the log after the log grows', () => {
    fc.assert(
      fc.property(cut, ([total, prefix]) => {
        const links = chainOf(total);
        const grown = verifiedOf(links);

        const chain = checkExpectedHead(grown, hashLink(at(links, prefix - 1)));

        expect(chain).toBe(grown.chain);
      }),
    );
  });
});
