import type { Hash, Name } from '../domain/ids.ts';
import { invalidInput } from '../errors.ts';
import type { AttachmentReader } from '../ports.ts';
import { sliceChars } from '../shared/pages.ts';

/**
 * D-20: teto de uma página. Na `query` conta os caracteres do JSON dos registros (as tools o passam em
 * `maxChars`); no `readAttachment`, os do `text`, e é o padrão sem `maxChars`.
 *
 * Limite conhecido na `query`: o 1º registro da página sai inteiro mesmo acima do teto, e `in`/`out`
 * saem completos. Um registro citado por muitos (ex.: 1.000 relações de entrada, ~99 mil caracteres)
 * passa do teto; `docs/tetos-dominio-v1.md` registra o gatilho de revisão.
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
    // Em `charCodeAt`, fora do texto dá NaN e as comparações falham: `offset === text.length` passa.
    const high = text.charCodeAt(offset - 1);
    const low = text.charCodeAt(offset);
    if (offset > 0 && high >= 0xd800 && high <= 0xdbff && low >= 0xdc00 && low <= 0xdfff) {
      throw invalidInput('/offset', 'mid-surrogate-pair', 'offset splits a surrogate pair');
    }
    const page = sliceChars(text, offset, maxChars);
    return {
      text: page.text,
      ...(page.nextOffset === null ? {} : { next: page.nextOffset }),
      status: 'ok',
    };
  };
}
