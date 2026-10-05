// Import padrão: o spy de `writeSync` só intercepta o que `adapters/fs/process-store.ts` usa assim.
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { expect, jest } from '@jest/globals';
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

/** `fs.writeSync` tem sobrecargas e o mock herdaria só a última; o store usa `(fd, buffer, offset)`, e o espião tipa essa. */
export function spyOnWriteSync(
  implementation: (fd: number, buffer: Buffer, offset: number) => number,
): void {
  jest.spyOn(fs, 'writeSync').mockImplementation(implementation as typeof fs.writeSync);
}

/**
 * P9, exceção declarada ao princípio 3: roteiro de `fs.writeSync` do log. Cada chamada consome um
 * passo: `n >= 0` grava só `n` bytes (de verdade) e devolve `n`; `n < 0` grava `tamanho + n`;
 * `'enospc'` lança `ENOSPC` com o caminho na mensagem, como o fs real. Sem passos, grava tudo.
 */
export function scriptWrites(steps: readonly (number | 'enospc')[], dataDir: string): void {
  const real = fs.writeSync;
  let call = 0;
  spyOnWriteSync((fd, buffer, offset) => {
    const step = steps[call++];
    if (step === undefined) return real(fd, buffer, offset);
    if (step === 'enospc') {
      throw Object.assign(new Error(`ENOSPC: no space left on device, write '${dataDir}'`), {
        code: 'ENOSPC',
      });
    }
    const length = buffer.length - offset;
    return real(fd, buffer, offset, step < 0 ? length + step : Math.min(step, length));
  });
}

/** Erro cru do fs, como o `fs` o lança (`code` em maiúsculas, caminho absoluto na mensagem). */
export const errno = (code: string): Error =>
  Object.assign(new Error(`${code}: /abs/secret/path`), { code });

/** `<xdg>/hexlog` é o `<D>` que o script resolve; `source` vira o conteúdo dele. */
export function copyToXdg(source: string): string {
  const xdg = createTempDir('xdg');
  fs.cpSync(source, path.join(xdg, 'hexlog'), { recursive: true });
  return xdg;
}

/** `caminho → sha256:mtimeMs` de todo arquivo sob `root`, para provar que nada foi escrito. */
export function snapshot(root: string): Record<string, string> {
  const entries: [string, string][] = [];
  const walk = (dir: string) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else {
        const hash = createHash('sha256').update(fs.readFileSync(full)).digest('hex');
        entries.push([path.relative(root, full), `${hash}:${fs.statSync(full).mtimeMs}`]);
      }
    }
  };
  walk(root);
  return Object.fromEntries(entries);
}
