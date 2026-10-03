import fs from 'node:fs';
import { describe, expect, test } from '@jest/globals';
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

describe('readAttachment', () => {
  test('lê o texto inteiro do blob pelo hash, com status ok e sem próxima página', () => {
    const { stored, read } = attachmentSetup();

    expect(read(stored('olá, anexo'))).toEqual({ text: 'olá, anexo', status: 'ok' });
  });

  test('pagina por offset: o `next` de uma página é o `offset` da seguinte e a última não tem `next`', () => {
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

  test('a página não parte um par surrogate', () => {
    const { stored, read } = attachmentSetup();
    const hash = stored('a😀b');

    expect(read(hash, { maxChars: 2 })).toEqual({ text: 'a', next: 1, status: 'ok' });
    expect(read(hash, { maxChars: 2, offset: 1 })).toMatchObject({ text: '😀' });
  });

  test('offset no fim dá página vazia e além do fim é INVALID_INPUT em /offset', () => {
    const { stored, read } = attachmentSetup();
    const hash = stored('abc');

    expect(read(hash, { offset: 3 })).toEqual({ text: '', status: 'ok' });
    const error = captureError(() => read(hash, { offset: 4 }));
    expect(error.code).toBe('INVALID_INPUT');
    expect(error.details[0]).toMatchObject({ path: '/offset', code: 'out-of-range' });
  });

  test('hash que ninguém guardou é ATTACHMENT_NOT_FOUND', () => {
    const { read } = attachmentSetup();

    expect(captureError(() => read(sha256hex('nunca guardado'))).code).toBe('ATTACHMENT_NOT_FOUND');
  });

  test('blob cujos bytes não batem com o sha256 é ATTACHMENT_CORRUPTED', () => {
    const { dataDir, stored, read } = attachmentSetup();
    const hash = stored('original');
    fs.writeFileSync(blobFile(dataDir, PROJECT, hash), 'adulterado');

    expect(captureError(() => read(hash)).code).toBe('ATTACHMENT_CORRUPTED');
  });
});
