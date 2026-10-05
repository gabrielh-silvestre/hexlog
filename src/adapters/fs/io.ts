// Import padrão, não `import * as fs`: ver "Common Patterns" em `src/AGENTS.md`.
import fs from 'node:fs';
import { isUndefined } from 'es-toolkit';
import { Name } from '../../domain/ids.ts';
import { HexlogError, invalidInput } from '../../errors.ts';
import { errnoCode } from './atomic.ts';

/** D-26: `IO_ERROR` traz só o errno; o `message` do fs carrega o caminho absoluto. */
export function toHexlogError(error: unknown): unknown {
  const code = errnoCode(error);
  if (error instanceof HexlogError || isUndefined(code) || !/^E[A-Z0-9]+$/.test(code)) {
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
  if (!Name.safeParse(value).success) throw invalidInput(field, 'invalid-name', 'invalid name');
  return value;
}

/** Resultado de `operation`, ou `fallback` se ela falha com `ENOENT`; qualquer outro erro sai cru. */
export function orIfMissing<T, F>(operation: () => T, fallback: F): T | F {
  try {
    return operation();
  } catch (error) {
    if (errnoCode(error) === 'ENOENT') return fallback;
    throw error;
  }
}

/**
 * Lê `file`; arquivo inexistente vira `undefined`, qualquer outro erro sai cru. `ponytail:` segue
 * symlink e um FIFO trava o servidor (`<D>` é confiável, ADR 0009 item 9); se `<D>` deixar de ser,
 * abrir com `O_NOFOLLOW` e recusar arquivo não regular, aqui e nos outros pontos que seguem link
 * (`statSync` do tamanho do log, `openSync` de append).
 */
export function readIfPresent(file: string): string | undefined {
  return orIfMissing(() => fs.readFileSync(file, 'utf8'), undefined);
}

/** `fs.existsSync` que só trata `ENOENT` como ausente: `EACCES`, `EIO` e afins saem crus em vez de virar `false`. */
export function existsStrict(file: string): boolean {
  return !isUndefined(fs.statSync(file, { throwIfNoEntry: false }));
}

/** Diretórios de `dir` com nome válido que passam em `keep`, em ordem alfabética; `dir` inexistente não tem nenhum. */
export function listDirectories(dir: string, keep: (name: string) => boolean = () => true): Name[] {
  return orIfMissing(() => fs.readdirSync(dir, { withFileTypes: true }), [])
    .filter(
      (entry) => entry.isDirectory() && Name.safeParse(entry.name).success && keep(entry.name),
    )
    .map((entry) => entry.name)
    .sort();
}
