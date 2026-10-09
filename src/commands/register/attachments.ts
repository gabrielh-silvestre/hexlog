import { isString, isUndefined } from 'es-toolkit';
import { attachmentFields } from '../../domain/definitions.ts';
import { Hash, type Name } from '../../domain/ids.ts';
import { HexlogError } from '../../errors.ts';
import type { AttachmentReader, AttachmentStatus } from '../../ports.ts';
import { invalidRecord, withPath } from './errors.ts';
import type { PreparedItem } from './static.ts';

// Mensagem fixa de D-16: aponta as duas saídas para quem ficou preso a um tipo sem a marca.
const UNMARKED_MESSAGE =
  'value is the hash of a stored attachment but the field lacks format "attachment"; to continue a supersedes/revokes lineage when this field is optional in the pinned type, omit it and cite the attachment through another type pinned in this process that marks it, linked by a relation; if the field is required or no pinned type marks it, create a new process pinned to a type version that marks the field (define it with breaking: true), which cannot supersede or revoke records of this process';

/** Strings de primeiro nível de `data`: o próprio valor, ou os itens string de uma lista. */
function stringsOf(value: unknown): string[] {
  if (isString(value)) return [value];
  return Array.isArray(value) ? value.filter(isString) : [];
}

function missingOrCorrupted(path: string, hash: Hash, status: AttachmentStatus): HexlogError {
  const [code, message] =
    status === 'missing'
      ? (['ATTACHMENT_NOT_FOUND', `attachment '${hash}' not found`] as const)
      : (['ATTACHMENT_CORRUPTED', `attachment '${hash}' does not match its hash`] as const);
  return new HexlogError(code, message, [
    { path, code: status === 'missing' ? 'not-found' : 'corrupted', message },
  ]);
}

/**
 * D-16, só em `decide` (depois da busca da `key`): cada anexo citado em campo marcado existe e está
 * íntegro (`ATTACHMENT_NOT_FOUND`/`ATTACHMENT_CORRUPTED`), e valor com forma de sha256 em campo sem a
 * marca que é hash de anexo guardado é recusado (`unmarked-attachment`). Cada hash é consultado uma
 * vez por chamada.
 */
export function checkAttachments(
  project: Name,
  items: readonly PreparedItem[],
  attachments: AttachmentReader,
): void {
  const statuses = new Map<Hash, AttachmentStatus>();
  const statusOf = (hash: Hash, path: string): AttachmentStatus => {
    const known = statuses.get(hash);
    if (!isUndefined(known)) return known;
    try {
      const status = attachments.status(project, hash);
      statuses.set(hash, status);
      return status;
    } catch (error) {
      // O `hash` veio de `records[i].data`, não do campo `/hash` que a porta presume.
      throw withPath(error, path);
    }
  };

  for (const [index, { item, schema }] of items.entries()) {
    const marked = new Set(attachmentFields(schema));
    for (const [field, value] of Object.entries(item.data)) {
      const path = `/records/${index}/data/${field}`;
      for (const hash of stringsOf(value)) {
        if (marked.has(field)) {
          const status = statusOf(hash, path);
          if (status !== 'ok') throw missingOrCorrupted(path, hash, status);
        } else if (Hash.safeParse(hash).success && statusOf(hash, path) !== 'missing') {
          throw invalidRecord([{ path, code: 'unmarked-attachment', message: UNMARKED_MESSAGE }]);
        }
      }
    }
  }
}
