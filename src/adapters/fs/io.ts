// Import padrão (não `import * as fs`): o spy do jest só intercepta assim (ver `process-store.ts`).
import fs from 'node:fs';
import { Name } from '../../domain/ids.ts';
import { HexlogError } from '../../errors.ts';
import { errnoCode } from './atomic.ts';

/** D-26: `IO_ERROR` traz só o errno; o `message` do fs carrega o caminho absoluto. */
export function toHexlogError(error: unknown): unknown {
  const code = errnoCode(error);
  if (error instanceof HexlogError || code === undefined || !/^E[A-Z0-9]+$/.test(code)) {
    return error;
  }
  return new HexlogError('IO_ERROR', 'I/O failure', [
    { path: '', code: code.toLowerCase(), message: 'I/O failure' },
  ]);
}

export function mapIo<T>(operation: () => T): T {
  try {
    return operation();
  } catch (error) {
    throw toHexlogError(error);
  }
}

/** Todo nome que vira segmento de caminho passa por aqui, antes de qualquer I/O. */
export function safeName(value: string, field: string): Name {
  if (!Name.safeParse(value).success) {
    const message = 'invalid name';
    throw new HexlogError('INVALID_INPUT', message, [
      { path: field, code: 'invalid-name', message },
    ]);
  }
  return value;
}

/** Lê `file`; arquivo inexistente vira `undefined`, qualquer outro erro sai cru. */
export function readIfPresent(file: string): string | undefined {
  try {
    return fs.readFileSync(file, 'utf8');
  } catch (error) {
    if (errnoCode(error) === 'ENOENT') return undefined;
    throw error;
  }
}

/** Diretórios de `dir` com nome válido que passam em `keep`, em ordem alfabética; `dir` inexistente não tem nenhum. */
export function listDirectories(dir: string, keep: (name: string) => boolean = () => true): Name[] {
  try {
    return fs
      .readdirSync(dir, { withFileTypes: true })
      .filter(
        (entry) => entry.isDirectory() && Name.safeParse(entry.name).success && keep(entry.name),
      )
      .map((entry) => entry.name)
      .sort();
  } catch (error) {
    if (errnoCode(error) === 'ENOENT') return [];
    throw error;
  }
}
