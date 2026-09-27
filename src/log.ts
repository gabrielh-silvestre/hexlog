import { randomBytes, randomUUIDv7 } from 'node:crypto';
// import default (não `* as fs`): sob esModuleInterop, `* as` copia o módulo com getters
// não configuráveis, o que impede `jest.spyOn(fs, 'fsyncSync')` de interceptar esta chamada
// a partir do teste (test/log.spec.ts precisa espiar o mesmo objeto `fs` que este módulo usa).
import fs from 'node:fs';
import * as path from 'node:path';
import { delay } from 'es-toolkit';
import { isEmpty, isNil } from 'es-toolkit/compat';
import { expectedPrevHash, hashLine, isValidLink, nextSeq } from './chain.ts';
import { HexlogError } from './errors.ts';
import type { EventLine } from './events.ts';

export type LogRecord = {
  level: 'debug' | 'info' | 'warn' | 'error';
  event: string;
  [field: string]: unknown;
};
export type Logger = (record: LogRecord) => void;

// Invariante: TIMEOUT_MS >= ORPHAN_MS. Um lock genuinamente órfão só é detectável depois de
// ORPHAN_MS; com TIMEOUT_MS menor, o chamador desiste antes de o ramo de órfão ter chance de agir
// (lock vivo entre 5s e 10s estourava LOCK_TIMEOUT sem nunca ser avaliado como órfão).
const LOCK_TIMEOUT_MS = 15_000;
const LOCK_RETRY_MS = 10;
const LOCK_ORPHAN_MS = 10_000;

const HOLDER_FILE = 'holder';

export type Base = {
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

/**
 * Anexa N elos ao log JSONL sob uma única aquisição de lock — mesma mecânica de `append`, mas
 * `builds[i]` recebe a base encadeada a partir do elo escrito por `builds[i-1]`, sem reler o
 * arquivo entre um item e outro (o lock exclusivo garante que nada mais escreve no meio). O 1º
 * item usa o `endsWithNewline` real de `prepareContext` (corrige uma cauda rasgada
 * pré-existente); os demais sempre usam `true`, porque depois que `writeLine` grava qualquer
 * linha o arquivo sempre termina em `\n` — reusar o valor do 1º item faria os seguintes
 * prefixarem um `\n` supérfluo. `readToken` é revalidado antes de cada escrita, não só uma vez no
 * início, para pegar o lock sendo roubado no meio de um lote longo em disco degradado. Falha a
 * meio do laço (erro de disco, `LOCK_LOST`) deixa os itens já escritos gravados: log append-only,
 * sem rollback.
 */
export async function appendBatch(
  file: string,
  manifest: unknown,
  builds: readonly ((base: Base) => EventLine)[],
  options: { log: Logger; timeoutMs?: number; orphanMs?: number; clock?: () => Date },
): Promise<EventLine[]> {
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
    let base: Base = context;
    let endsWithNewline = context.endsWithNewline;
    const lines: EventLine[] = [];

    for (const build of builds) {
      const line = build(base);

      if (readToken(lockDir) !== token) {
        log({ level: 'error', event: 'lock-lost' });
        throw new HexlogError('LOCK_LOST', 'lock lost before write');
      }

      writeLine(file, endsWithNewline, line);
      lines.push(line);

      endsWithNewline = true;
      base = {
        seq: line.seq + 1,
        timestamp: base.timestamp,
        prevHash: hashLine(line),
        uuid: randomUUIDv7(),
        lastLink: line,
      };
    }

    return lines;
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
