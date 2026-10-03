import { isEmpty } from 'es-toolkit/compat';
import { HexlogError } from '../src/errors.ts';

/** Recusa que o operador resolve no dado, não no comando: sai com 2. */
const DATA_CODES = new Set(['LEGACY_DATA', 'PROCESS_CORRUPTED']);

/** Linha de erro dos scripts de leitura (`<prefix> failed: code: message (detalhes)`) e o exit code dela. */
export function formatCliError(prefix: string, error: unknown): { text: string; exitCode: number } {
  const { code, message, details } =
    error instanceof HexlogError ? error : new HexlogError('INTERNAL', String(error));
  const detail = details
    .map((item) => (item.process === undefined ? item.message : `${item.process}: ${item.message}`))
    .join('; ');
  return {
    text: `${prefix} failed: ${code}: ${message}${isEmpty(detail) ? '' : ` (${detail})`}`,
    exitCode: DATA_CODES.has(code) ? 2 : 1,
  };
}
