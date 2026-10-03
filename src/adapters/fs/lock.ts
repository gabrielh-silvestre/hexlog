import { randomUUID } from 'node:crypto';
// Import padrão (não `import * as fs`): os specs interceptam `fs` com `jest.spyOn`, como em `atomic.ts`.
import fs from 'node:fs';
import * as path from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { z } from 'zod';
import { HexlogError, type Detail } from '../../errors.ts';
import type { Logger } from '../../shared/logger.ts';
import { errnoCode, writeSynced } from './atomic.ts';

/** D-12: quanto tempo um escritor espera por um dono vivo antes de `LOCK_TIMEOUT` `lock-busy`. */
export const LOCK_BUDGET_MS = 15_000;

const POLL_MS = 10;
const BOOT_ID_FILE = '/proc/sys/kernel/random/boot_id';

/** `bootId` é `null` sem `/proc`; `null` só casa com `null`. */
const HolderSchema = z.object({
  pid: z.int().positive(),
  token: z.string().min(1),
  bootId: z.string().nullable().default(null),
});
type Holder = z.infer<typeof HolderSchema>;

type HolderRead = { kind: 'missing' } | { kind: 'unreadable' } | { kind: 'ok'; holder: Holder };

/** Posse de um lock: o diretório e o token que este processo gravou no `holder`. */
export type Lock = { dir: string; token: string };

export type LockOptions = {
  log: Logger;
  /** Orçamento de espera; injetável para os testes não esperarem 15 s. */
  budgetMs?: number;
  /** `null` simula ausência de `/proc`; sem a opção, lê `/proc/sys/kernel/random/boot_id`. */
  bootId?: string | null;
};

/**
 * `removed`: o token esperado era o do lock movido, que foi apagado. `restored`/`discarded`: a
 * leitura estava velha e o lock movido era de outro dono vivo; foi devolvido ou, se já existe lock
 * novo, apagado. `gone`: o lock já não existia.
 */
export type MoveAsideResult = 'removed' | 'restored' | 'discarded' | 'gone';

// Tokens que este processo segura agora. A entrada e a saída acontecem na mesma sequência síncrona
// do `rename` de aquisição e de liberação (sem `await` no meio), então duas chamadas do mesmo
// servidor nunca veem o conjunto pela metade.
const heldTokens = new Set<string>();

/** O `rename` de diretório sobre outro que já existe e não está vazio (um lock nunca existe vazio). */
function isDirectoryTaken(error: unknown): boolean {
  const code = errnoCode(error);
  return code === 'ENOTEMPTY' || code === 'EEXIST';
}

function readBootId(): string | null {
  try {
    return fs.readFileSync(BOOT_ID_FILE, 'utf8').trim();
  } catch {
    return null;
  }
}

function parseHolder(text: string): HolderRead {
  try {
    const parsed = HolderSchema.safeParse(JSON.parse(text));
    return parsed.success ? { kind: 'ok', holder: parsed.data } : { kind: 'unreadable' };
  } catch {
    return { kind: 'unreadable' };
  }
}

function readHolder(dir: string): HolderRead {
  try {
    return parseHolder(fs.readFileSync(path.join(dir, 'holder'), 'utf8'));
  } catch (error) {
    if (errnoCode(error) === 'ENOENT') return { kind: 'missing' };
    throw error;
  }
}

/** `EPERM` conta como vivo: o pid existe, só não é nosso. */
export function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return errnoCode(error) !== 'ESRCH';
  }
}

/**
 * Órfão: dono de outro boot (qualquer que seja o pid, que o reboot renumera); ou, no mesmo boot,
 * pid morto; ou o pid é o deste processo e o token não é um dos que ele segura (só ele pode afirmar,
 * sem risco de reuso de pid). `ponytail:` reuso de pid por processo alheio no mesmo boot deixa o
 * lock preso até intervenção manual; melhoria: comparar `starttime` de `/proc/<pid>/stat`.
 */
function isOrphan(holder: Holder, bootId: string | null): boolean {
  if (holder.bootId !== bootId) return true;
  if (holder.pid === process.pid) return !heldTokens.has(holder.token);
  return !isPidAlive(holder.pid);
}

function lockTimeout(
  code: 'lock-busy' | 'lock-lost' | 'holder-unreadable',
  message: string,
  pid?: number,
): HexlogError {
  const detail: Detail = { path: '/process', code, message, ...(pid === undefined ? {} : { pid }) };
  return new HexlogError('LOCK_TIMEOUT', message, [detail]);
}

/**
 * Publica o lock atomicamente: o `holder` nasce completo e com fsync num temporário, e o `rename`
 * do diretório só vence se `dir` não existe. `false` quando já existe um lock.
 */
function tryCreate(dir: string, holder: Holder): boolean {
  const tmp = fs.mkdtempSync(`${dir}.tmp-`);
  try {
    writeSynced(path.join(tmp, 'holder'), JSON.stringify(holder));
    fs.renameSync(tmp, dir);
    heldTokens.add(holder.token);
    return true;
  } catch (error) {
    fs.rmSync(tmp, { recursive: true, force: true });
    if (isDirectoryTaken(error)) return false;
    throw error;
  }
}

/** Devolve o lock movido; se já existe lock novo a devolução falha sem dano e o movido é apagado. */
function giveBack(aside: string, dir: string): boolean {
  try {
    fs.renameSync(aside, dir);
    return true;
  } catch (error) {
    if (!isDirectoryTaken(error)) throw error;
    fs.rmSync(aside, { recursive: true, force: true });
    return false;
  }
}

/**
 * Tira o lock do caminho (roubo de órfão e liberação) e confere o dono pelo `holder` do movido,
 * porque a leitura que levou a decisão pode estar velha. Nunca apaga no lugar: `dir` não fica vazio
 * no meio, senão dois escritores poderiam adquirir.
 */
export function moveAside(
  dir: string,
  suffix: string,
  expectedToken: string,
  log: Logger,
): MoveAsideResult {
  const aside = `${dir}${suffix}${randomUUID()}`;
  try {
    fs.renameSync(dir, aside);
  } catch (error) {
    if (errnoCode(error) === 'ENOENT') return 'gone';
    throw error;
  }
  const moved = readHolder(aside);
  if (moved.kind === 'ok' && moved.holder.token === expectedToken) {
    fs.rmSync(aside, { recursive: true, force: true });
    return 'removed';
  }
  const restored = giveBack(aside, dir);
  log({
    level: 'error',
    event: 'lock-lost',
    pid: process.pid,
    holderPid: moved.kind === 'ok' ? moved.holder.pid : null,
    restored,
  });
  return restored ? 'restored' : 'discarded';
}

/**
 * D-12: um lock por processo (`<dir>` = `records.jsonl.lock`), com dono identificado por pid e
 * `bootId`. Erros de I/O saem crus; mapeá-los para `IO_ERROR` cabe ao chamador.
 */
export function createLockManager({
  log,
  budgetMs = LOCK_BUDGET_MS,
  bootId: injected,
}: LockOptions) {
  const bootId = injected === undefined ? readBootId() : injected;

  function timedOut(pid?: number): HexlogError {
    log({ level: 'warn', event: 'lock-timeout', ...(pid === undefined ? {} : { pid }) });
    return lockTimeout('lock-busy', 'timed out waiting for the process lock', pid);
  }

  /** Dono vivo nunca é roubado, mesmo pausado; `holder-unreadable` não é retentável. */
  async function acquire(dir: string): Promise<Lock> {
    const holder: Holder = { pid: process.pid, token: randomUUID(), bootId };
    const deadline = performance.now() + budgetMs;
    let waiting = false;
    for (;;) {
      if (tryCreate(dir, holder)) return { dir, token: holder.token };
      const current = readHolder(dir);
      if (current.kind === 'unreadable') {
        throw lockTimeout('holder-unreadable', 'lock holder is unreadable; manual unlock required');
      }
      if (current.kind === 'missing') {
        if (performance.now() >= deadline) throw timedOut();
        // `ponytail:` o polling de diretório (aqui e em `isHeld`) existe porque não há primitivo do
        // kernel para esperar um diretório; remover esses timers fica pendente.
        await sleep(POLL_MS);
        continue;
      }
      if (isOrphan(current.holder, bootId)) {
        const { pid, token } = current.holder;
        if (moveAside(dir, '.dead-', token, log) === 'removed') {
          log({ level: 'warn', event: 'lock-orphan-removed', pid });
        }
        continue;
      }
      if (performance.now() >= deadline) throw timedOut(current.holder.pid);
      if (!waiting) {
        waiting = true;
        log({ level: 'debug', event: 'lock-wait', pid: current.holder.pid });
      }
      await sleep(POLL_MS);
    }
  }

  /** `ENOENT` (lock fora, no meio de um roubo com leitura velha) relê uma vez depois de 10 ms. */
  async function isHeld({ dir, token }: Lock): Promise<boolean> {
    let current = readHolder(dir);
    if (current.kind === 'missing') {
      await sleep(POLL_MS);
      current = readHolder(dir);
    }
    return current.kind === 'ok' && current.holder.token === token;
  }

  /** Confere a posse antes do `write`; sem ela, nada deve ser gravado. */
  async function confirm(lock: Lock): Promise<void> {
    if (!(await isHeld(lock))) {
      throw lockTimeout('lock-lost', 'process lock was lost before the write');
    }
  }

  /** Token de outro, ou `ENOENT` que persiste: não mexe no que não é seu. */
  async function release(lock: Lock): Promise<void> {
    try {
      if (await isHeld(lock)) moveAside(lock.dir, '.released-', lock.token, log);
    } finally {
      heldTokens.delete(lock.token);
    }
  }

  return { acquire, confirm, release };
}
