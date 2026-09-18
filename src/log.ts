import { randomBytes, randomUUIDv7 } from 'node:crypto';
// import default (não `* as fs`): sob esModuleInterop, `* as` copia o módulo com getters
// não configuráveis, o que impede `jest.spyOn(fs, 'fsyncSync')` de interceptar esta chamada
// a partir do teste (test/log.spec.ts precisa espiar o mesmo objeto `fs` que este módulo usa).
import fs from 'node:fs';
import * as path from 'node:path';
import { delay } from 'es-toolkit';
import { isEmpty, isNil } from 'es-toolkit/compat';
import { expectedPrevHash, isValidLink, nextSeq } from './chain.ts';
import { HexlogError } from './errors.ts';
import type { EventLine } from './events.ts';

export type LogRecord = {
  level: 'debug' | 'info' | 'warn' | 'error';
  event: string;
  [field: string]: unknown;
};
export type Logger = (record: LogRecord) => void;

const LOCK_TIMEOUT_MS = 5_000;
const LOCK_RETRY_MS = 10;
const LOCK_ORPHAN_MS = 10_000;

const HOLDER_FILE = 'holder';

type Base = {
  seq: number;
  timestamp: string;
  prevHash: string;
  uuid: string;
  lastLink: EventLine | null;
};

/** Leitura sem lock. Arquivo inexistente conta como log vazio. */
export function readText(file: string): string {
  try {
    return fs.readFileSync(file, 'utf8');
  } catch {
    return '';
  }
}

/**
 * Anexa um elo ao log JSONL sob lock exclusivo por diretório (§4.7). A espera pela aquisição do
 * lock é assíncrona (retry com `await` de sleep); a partir daqui, `build` roda dentro da seção
 * crítica síncrona (sem `await`): recebe a base já calculada (`seq`/`prevHash`/`uuid`/`timestamp`/
 * `lastLink`) e devolve a `EventLine` a gravar.
 */
export async function append(
  file: string,
  manifest: unknown,
  build: (base: Base) => EventLine,
  options: { log: Logger; timeoutMs?: number; orphanMs?: number; clock?: () => Date },
): Promise<EventLine> {
  const {
    log,
    timeoutMs = LOCK_TIMEOUT_MS,
    orphanMs = LOCK_ORPHAN_MS,
    clock = () => new Date(),
  } = options;
  const lockDir = `${file}.lock`;
  const token = await acquireLock(lockDir, { log, timeoutMs, orphanMs });

  try {
    const context = prepareContext(file, manifest, clock);
    const line = build(context);

    if (readToken(lockDir) !== token) {
      log({ level: 'error', event: 'lock-lost' });
      throw new HexlogError('LOCK_LOST', 'lock lost before write');
    }

    writeLine(file, context.endsWithNewline, line);
    return line;
  } finally {
    releaseLock(lockDir, token);
  }
}

function prepareContext(
  file: string,
  manifest: unknown,
  clock: () => Date,
): Base & { endsWithNewline: boolean } {
  const text = readText(file);
  const endsWithNewline = isEmpty(text) || text.endsWith('\n');
  // A cauda sem '\n' (escrita em andamento ou rasgo ainda não reparado) entra na busca do
  // último elo (mesma regra de verifyChain em chain.ts, mas aqui sem descartá-la).
  const lines = isEmpty(text) ? [] : text.split('\n').slice(0, endsWithNewline ? -1 : undefined);
  const { lastLink, linesAfter } = lastLinkAndLinesAfter(lines);

  return {
    seq: nextSeq(lastLink, linesAfter),
    timestamp: clock().toISOString(),
    prevHash: expectedPrevHash(lastLink, manifest),
    uuid: randomUUIDv7(),
    lastLink,
    endsWithNewline,
  };
}

/** Primeira linha, de trás pra frente, que passa em `isValidLink`; e quantas vêm depois dela. */
function lastLinkAndLinesAfter(lines: string[]): {
  lastLink: EventLine | null;
  linesAfter: number;
} {
  for (let index = lines.length - 1; index >= 0; index--) {
    const link = isValidLink(lines[index]);
    if (!isNil(link)) return { lastLink: link, linesAfter: lines.length - 1 - index };
  }
  return { lastLink: null, linesAfter: lines.length };
}

function writeLine(file: string, endsWithNewline: boolean, line: EventLine): void {
  const fd = fs.openSync(file, 'a', 0o600);
  try {
    fs.writeSync(fd, `${endsWithNewline ? '' : '\n'}${JSON.stringify(line)}\n`);
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
}
// ponytail: reread O(n) por append; medido ~18 ms a 10k linhas com fsync; upgrade: sidecar de tail/índice.

async function acquireLock(
  lockDir: string,
  options: { log: Logger; timeoutMs: number; orphanMs: number },
): Promise<string> {
  const start = Date.now();
  let warnedWait = false;

  for (;;) {
    try {
      return createLock(lockDir);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;

      if (!warnedWait) {
        options.log({ level: 'debug', event: 'lock-wait' });
        warnedWait = true;
      }

      if (isLockOrphan(lockDir, options.orphanMs)) {
        removeLock(lockDir);
        options.log({ level: 'warn', event: 'lock-orphan-removed' });
        continue;
      }

      if (Date.now() - start > options.timeoutMs) {
        throw new HexlogError('LOCK_TIMEOUT', `lock not released within ${options.timeoutMs}ms`);
      }
      await delay(LOCK_RETRY_MS);
    }
  }
}

function createLock(lockDir: string): string {
  fs.mkdirSync(lockDir, 0o700);
  const token = `${process.pid}-${randomBytes(16).toString('hex')}`;
  fs.writeFileSync(path.join(lockDir, HOLDER_FILE), token, { mode: 0o600 });
  return token;
}

function isLockOrphan(lockDir: string, orphanMs: number): boolean {
  try {
    return Date.now() - fs.statSync(lockDir).mtimeMs > orphanMs;
  } catch {
    return false; // sumiu entre o EEXIST e o stat: outro processo já resolveu
  }
}

function removeLock(lockDir: string): void {
  try {
    fs.rmSync(lockDir, { recursive: true, force: true });
  } catch {
    // já removido por outro processo
  }
}

function releaseLock(lockDir: string, token: string): void {
  if (readToken(lockDir) !== token) return; // não é mais nosso: não mexe no lock de outro dono
  removeLock(lockDir);
}

function readToken(lockDir: string): string | null {
  try {
    return fs.readFileSync(path.join(lockDir, HOLDER_FILE), 'utf8');
  } catch {
    return null;
  }
}
