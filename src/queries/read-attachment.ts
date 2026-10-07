import type { Hash, Name } from '../domain/ids.ts';
import { invalidInput } from '../errors.ts';
import type { AttachmentReader } from '../ports.ts';
import { sliceChars } from '../shared/pages.ts';

/**
 * D-20: teto de uma página. Na `query` conta os caracteres do JSON dos registros (as tools o passam em
 * `maxChars`); no `readAttachment`, os do `text`, e é o padrão sem `maxChars`.
 */
export const PAGE_CHARS_CAP = 24_000;

export type ReadAttachmentInput = {
  project: Name;
  hash: Hash;
  /** Posição em caracteres; o `next` da página anterior. */
  offset?: number;
  maxChars?: number;
};

export type AttachmentPage = {
  text: string;
  /** Offset da próxima página; ausente na última. */
  next?: number;
  /** Sempre `ok`: anexo ausente ou corrompido não devolve página, lança. */
  status: 'ok';
};

export function createReadAttachment(deps: {
  attachments: AttachmentReader;
}): (input: ReadAttachmentInput) => AttachmentPage {
  const { attachments } = deps;

  return ({ project, hash, offset = 0, maxChars = PAGE_CHARS_CAP }) => {
    const text = attachments.read(project, hash);
    if (offset > text.length) {
      throw invalidInput('/offset', 'out-of-range', 'offset is past the end of the attachment');
    }
    const page = sliceChars(text, offset, maxChars);
    return {
      text: page.text,
      ...(page.nextOffset === null ? {} : { next: page.nextOffset }),
      status: 'ok',
    };
  };
}
