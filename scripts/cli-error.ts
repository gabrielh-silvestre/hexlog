import { parseArgs, type ParseArgsOptionsConfig } from 'node:util';
import { isEmpty } from 'es-toolkit/compat';
import { composeReader } from '../src/compose.ts';
import { dataDir } from '../src/directory.ts';
import { HexlogError, legacyDataError } from '../src/errors.ts';

/** Recusa que o operador resolve no dado, não no comando: sai com 2. */
const DATA_CODES = new Set(['LEGACY_DATA', 'PROCESS_CORRUPTED']);

/** Linha de erro dos scripts de leitura (`<prefix> failed: code: message (detalhes)`) e o exit code dela. */
export function formatCliError(prefix: string, error: unknown): { text: string; exitCode: number } {
  const { code, message, details } =
    error instanceof HexlogError ? error : new HexlogError('INTERNAL', String(error));
  const detail = details
    // detalhe sem processo que só repete a mensagem (`project not found`) não acrescenta nada
    .filter((item) => item.process !== undefined || item.message !== message)
    .map((item) => (item.process === undefined ? item.message : `${item.process}: ${item.message}`))
    .join('; ');
  return {
    text: `${prefix} failed: ${code}: ${message}${isEmpty(detail) ? '' : ` (${detail})`}`,
    exitCode: DATA_CODES.has(code) ? 2 : 1,
  };
}

/** Lado de leitura sobre o `<D>` de `XDG_DATA_HOME`; dado 0.x lança `LEGACY_DATA`. */
export function openReadOnly() {
  const reader = composeReader({
    dataDir: dataDir(process.env),
    cwd: process.cwd(),
    logger: () => undefined,
  });
  if (reader.isLegacy()) throw legacyDataError();
  return reader;
}

/** `parseArgs` estrito (opção desconhecida ou sem valor recusada): `undefined` quando o argv não vale. */
export function parseCliArgs<const T extends ParseArgsOptionsConfig>(argv: string[], options: T) {
  try {
    return parseArgs({ args: argv, options, allowPositionals: true, strict: true });
  } catch {
    return undefined;
  }
}
