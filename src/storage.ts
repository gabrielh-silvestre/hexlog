import { randomBytes } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { isNil } from 'es-toolkit';
import { HexlogError } from './errors.ts';

/**
 * Resolve `dir/...parts` e afirma, em defesa de profundidade, que o resultado não escapou
 * de `dir` (§4.2). Nomes já são validados por `Nome` antes de chegar aqui; este é o último gate.
 */
export function resolveSafePath(dir: string, ...parts: string[]): string {
  const resolved = path.resolve(dir, ...parts);
  if (resolved !== dir && !resolved.startsWith(dir + path.sep)) {
    throw new HexlogError('INTERNAL', 'resolved path escapes the data directory');
  }
  return resolved;
}

/** Grava `value` como JSON em `file` atomicamente: tmp no mesmo diretório + fsync + rename. */
export function writeJsonAtomic(file: string, value: unknown): void {
  const dir = path.dirname(file);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });

  const tmp = path.join(
    dir,
    `.${path.basename(file)}.${process.pid}.${randomBytes(4).toString('hex')}`,
  );
  const fd = fs.openSync(tmp, 'w');
  try {
    fs.writeSync(fd, JSON.stringify(value, null, 2));
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  fs.renameSync(tmp, file);
}

/** Lê `file` como JSON. Inexistente → `null`. Ilegível (fs ou parse) → `HexlogError('IO_ERROR')`. */
export function readJson(file: string): unknown {
  let text: string;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw ioError(e);
  }

  try {
    return JSON.parse(text);
  } catch (e) {
    throw ioError(e);
  }
}

/** Mapeia uma exceção de I/O (errno de fs, ou de parse) para `HexlogError('IO_ERROR')` (§4.13). */
export function ioError(e: unknown): HexlogError {
  const error = e as NodeJS.ErrnoException;
  const code = isNil(error.code) ? 'unknown' : error.code;
  return new HexlogError('IO_ERROR', 'I/O failure', [{ path: '', code, message: error.message }]);
}
