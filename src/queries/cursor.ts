import { z } from 'zod';
import { jcs, sha256hex } from '../domain/chain.ts';
import { Hash, Name, RecordId } from '../domain/ids.ts';
import { HexlogError, issueDetails } from '../errors.ts';

/**
 * Teto do texto do cursor, conferido antes do `split` e do sha256. **Palpite**: um cursor real tem
 * ~2.200 caracteres, e o pior caso (o nome de cada processo no marcador e no hash de cabeça, sem
 * teto de processos por projeto) passa de 400 caracteres por processo; 65.536 cobre ~160 processos
 * de nome máximo. Ver `docs/tetos-dominio-v1.md`.
 */
export const CURSOR_MAX_CHARS = 65_536;

/** Hex do checksum: 8 bytes do sha256 do trecho base64url. */
const CHECKSUM_HEX_LENGTH = 16;
const CHECKSUM = new RegExp(`^[0-9a-f]{${CHECKSUM_HEX_LENGTH}}$`);

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

function checksumOf(body: string): string {
  return sha256hex(body).slice(0, CHECKSUM_HEX_LENGTH);
}

/** D-20: `base64url(JCS(payload)).checksum`; o ponto não existe no alfabeto base64url. */
export function encodeCursor(payload: CursorPayload): string {
  const body = Buffer.from(jcs(payload), 'utf8').toString('base64url');
  return `${body}.${checksumOf(body)}`;
}

function invalidCursor(code: string, message: string): HexlogError {
  return new HexlogError('INVALID_CURSOR', 'Invalid cursor', [{ path: '/cursor', code, message }]);
}

/** Separa corpo e checksum e confere o checksum, sem tocar no conteúdo do corpo. */
function verifiedBody(text: string): string {
  const parts = text.split('.');
  const [body, checksum] = parts;
  if (
    parts.length !== 2 ||
    body === undefined ||
    checksum === undefined ||
    !CHECKSUM.test(checksum)
  ) {
    throw invalidCursor('malformed', 'Cursor must be <payload>.<checksum>');
  }
  if (checksumOf(body) !== checksum) {
    throw invalidCursor('checksum-mismatch', 'Cursor checksum does not match its payload');
  }
  return body;
}

function parseJson(body: string): unknown {
  try {
    return JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
  } catch {
    throw invalidCursor('malformed', 'Cursor payload is not valid JSON');
  }
}

/** D-20: checksum, JSON ou campo inválido dão `INVALID_CURSOR`; alcance, filtros e marcador são do serviço. */
export function decodeCursor(text: string): CursorPayload {
  if (text.length > CURSOR_MAX_CHARS) {
    throw invalidCursor('too-long', `Cursor must have at most ${CURSOR_MAX_CHARS} characters`);
  }
  const result = CursorPayload.safeParse(parseJson(verifiedBody(text)));
  if (!result.success) {
    throw new HexlogError(
      'INVALID_CURSOR',
      'Invalid cursor',
      issueDetails(result.error.issues, '/cursor'),
    );
  }
  return result.data;
}

/** D-20: hash dos filtros da consulta; a ordem das chaves não importa (JCS). */
export function filtersHash(filters: Record<string, unknown>): Hash {
  return sha256hex(jcs(filters));
}
