import { z } from 'zod';
import { Hash, Name, RecordId } from '../domain/ids.ts';
import { HexlogError, issueDetails } from '../errors.ts';

/**
 * Teto do texto do cursor, conferido antes de decodificar. **Palpite**: um cursor real tem
 * ~2.200 caracteres, e o pior caso (o nome de cada processo no marcador e no hash de cabeça, sem
 * teto de processos por projeto) passa de 400 caracteres por processo; 65.536 cobre ~160 processos
 * de nome máximo. Ver `docs/tetos-dominio-v1.md`.
 */
export const CURSOR_MAX_CHARS = 65_536;

/**
 * D-20: o que o cursor fixa para a página seguinte recomeçar igual. `marker` e `markerHashes`
 * cobrem todo processo lido (D-24); `lastId` é o último registro entregue.
 */
export const CursorPayload = z.strictObject({
  scope: z.enum(['process', 'project']),
  project: Name,
  process: Name.optional(),
  marker: z.record(Name, RecordId.nullable()),
  markerHashes: z.record(Name, Hash.nullable()),
  filtersHash: Hash,
  lastId: RecordId,
});
export type CursorPayload = z.infer<typeof CursorPayload>;

/**
 * D-20: `base64url(JSON(payload))`. Sem checksum nem autenticação: cursor truncado ou editado cai em
 * `malformed` ou no schema, e a barreira contra forja é a releitura do serviço
 * (`query-service.ts#assertSameQuery`, `assertSameContent`).
 */
export function encodeCursor(payload: CursorPayload): string {
  return Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
}

/** `INVALID_CURSOR` com um único `Detail` em `/cursor`. */
export function invalidCursor(code: string, message: string): HexlogError {
  return new HexlogError('INVALID_CURSOR', 'Invalid cursor', [{ path: '/cursor', code, message }]);
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(Buffer.from(text, 'base64url').toString('utf8'));
  } catch {
    throw invalidCursor('malformed', 'Cursor payload is not valid JSON');
  }
}

/** D-20: JSON ou campo inválido dão `INVALID_CURSOR`; alcance, filtros e marcador são do serviço. */
export function decodeCursor(text: string): CursorPayload {
  if (text.length > CURSOR_MAX_CHARS) {
    throw invalidCursor('too-long', `Cursor must have at most ${CURSOR_MAX_CHARS} characters`);
  }
  const result = CursorPayload.safeParse(parseJson(text));
  if (!result.success) {
    throw new HexlogError(
      'INVALID_CURSOR',
      'Invalid cursor',
      issueDetails(result.error.issues, '/cursor'),
    );
  }
  return result.data;
}
