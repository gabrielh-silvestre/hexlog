import fs from 'node:fs';
import { describe, expect, it } from '@jest/globals';
import { blobFile } from '../../src/adapters/fs/data-format.ts';
import { sha256hex } from '../../src/domain/chain.ts';
import type { AttachmentPage } from '../../src/queries/query-service.ts';
import { captureError } from '../helpers.ts';
import { PROJECT, querySetup } from './query-setup.ts';

function attachmentSetup() {
  const setup = querySetup();
  const stored = (text: string) => setup.attachments.putText(PROJECT, text).hash;
  const read = (hash: string, extra: { offset?: number; maxChars?: number } = {}) =>
    setup.queries.readAttachment({ project: PROJECT, hash, ...extra });
  return { ...setup, stored, read };
}

describe('QueryService.readAttachment', () => {
  it('should read the whole text of the blob by hash, with status ok and no next page', () => {
    const { stored, read } = attachmentSetup();

    expect(read(stored('olá, anexo'))).toEqual({ text: 'olá, anexo', status: 'ok' });
  });

  it('should paginate by offset: the next of a page is the offset of the following one and the last has no next', () => {
    const { stored, read } = attachmentSetup();
    const hash = stored('abcdefghij');
    const pages: AttachmentPage[] = [];

    for (
      let page = read(hash, { maxChars: 4 });
      ;
      page = read(hash, { maxChars: 4, offset: page.next })
    ) {
      pages.push(page);
      if (page.next === undefined) break;
    }

    expect(pages.map(({ text }) => text)).toEqual(['abcd', 'efgh', 'ij']);
    expect(pages.map(({ next }) => next)).toEqual([4, 8, undefined]);
  });

  it('should not split a surrogate pair on a page', () => {
    const { stored, read } = attachmentSetup();
    const hash = stored('a😀b');

    expect(read(hash, { maxChars: 2 })).toEqual({ text: 'a', next: 1, status: 'ok' });
    expect(read(hash, { maxChars: 2, offset: 1 })).toMatchObject({ text: '😀' });
  });

  it('should return an empty page for an offset at the end', () => {
    const { stored, read } = attachmentSetup();
    const hash = stored('abc');

    expect(read(hash, { offset: 3 })).toEqual({ text: '', status: 'ok' });
  });

  it('should refuse an offset beyond the end with INVALID_INPUT at /offset', () => {
    const { stored, read } = attachmentSetup();
    const hash = stored('abc');

    const error = captureError(() => read(hash, { offset: 4 }));

    expect(error.code).toBe('INVALID_INPUT');
    expect(error.details[0]).toMatchObject({ path: '/offset', code: 'out-of-range' });
  });

  it('should refuse an offset in the middle of a surrogate pair with INVALID_INPUT at /offset, accepting the ones around it', () => {
    const { stored, read } = attachmentSetup();
    const hash = stored('a😀b');

    const error = captureError(() => read(hash, { offset: 2 }));

    expect(error.code).toBe('INVALID_INPUT');
    expect(error.details[0]).toMatchObject({ path: '/offset', code: 'mid-surrogate-pair' });
    expect(read(hash, { offset: 1 })).toMatchObject({ text: '😀b' });
    expect(read(hash, { offset: 3 })).toMatchObject({ text: 'b' });
    // Texto que termina em par: o offset no fim fica fora do texto e não é recusado.
    expect(read(stored('a😀'), { offset: 3 })).toMatchObject({ text: '' });
  });

  it('should refuse a hash that nobody stored with ATTACHMENT_NOT_FOUND', () => {
    const { read } = attachmentSetup();

    expect(captureError(() => read(sha256hex('nunca guardado'))).code).toBe('ATTACHMENT_NOT_FOUND');
  });

  it('should refuse a blob whose bytes do not match the sha256 with ATTACHMENT_CORRUPTED', () => {
    const { dataDir, stored, read } = attachmentSetup();
    const hash = stored('original');
    fs.writeFileSync(blobFile(dataDir, PROJECT, hash), 'adulterado');

    expect(captureError(() => read(hash)).code).toBe('ATTACHMENT_CORRUPTED');
  });
});
