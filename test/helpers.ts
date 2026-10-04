import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { expect } from '@jest/globals';
import { parse as parseRawJson } from 'jsonc-parser';
import { z } from 'zod';
import { HexlogError } from '../src/errors.ts';
import type { Logger, LogRecord } from '../src/shared/logger.ts';
import { registerTempDir } from './cleanup.ts';

/**
 * Cria `hexlog-<prefix>-XXXXXX` sob `os.tmpdir()` e registra para `test/cleanup.ts` apagar no `afterAll`.
 * Só chame dentro de hook ou teste, nunca na coleta do `describe`: a criação na coleta roda até com `-t` e vaza o diretório.
 */
export function createTempDir(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `hexlog-${prefix}-`));
  registerTempDir(dir);
  return dir;
}

/** Parseia `text` (JSON ou JSONC) e valida o formato com `schema`, lançando erro claro se não bater. */
export function parseJson<T extends z.ZodType>(schema: T, text: string): z.infer<T> {
  const result = schema.safeParse(parseRawJson(text));
  if (!result.success) {
    throw new Error(`JSON does not match the expected schema:\n${z.prettifyError(result.error)}`);
  }
  return result.data;
}

/** Acessa `items[index]` e lança um erro claro se a posição não existir — usa quando o tamanho do array já é garantido pelo setup do teste. */
export function at<T>(items: readonly T[], index: number): T {
  const value = items[index];
  if (value === undefined) {
    throw new Error(`índice ${index} fora do array (tamanho ${items.length})`);
  }
  return value;
}

/** Executa `fn`, afirma que lançou `HexlogError` e devolve o erro para asserções específicas. */
export function captureError(fn: () => unknown): HexlogError {
  try {
    fn();
  } catch (error) {
    expect(error).toBeInstanceOf(HexlogError);
    return error as HexlogError;
  }
  throw new Error('expected the function to throw HexlogError');
}

/** Confere que nem `message` nem `details` do erro trazem `secret` (D-26); `JSON.stringify(error)` não vê o `message`. */
export function expectNoLeak(error: HexlogError, secret: string): void {
  expect(error.message + JSON.stringify(error.details)).not.toContain(secret);
}

/** Espera a rejeição com `HexlogError`, aplica `expectNoLeak` com `secret` (D-26) e a devolve. */
export async function rejectionOf(promise: Promise<unknown>, secret: string): Promise<HexlogError> {
  const error = await promise.then(
    () => undefined,
    (reason: unknown) => reason,
  );
  expect(error).toBeInstanceOf(HexlogError);
  expectNoLeak(error as HexlogError, secret);
  return error as HexlogError;
}

/** Logger de teste que junta os registros em `records`, na ordem em que chegam. */
export function captureLog(): { records: LogRecord[]; log: Logger } {
  const records: LogRecord[] = [];
  return { records, log: (record) => void records.push(record) };
}
