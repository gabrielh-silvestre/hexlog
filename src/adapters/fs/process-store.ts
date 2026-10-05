// Import padrão, não `import * as fs`: ver "Common Patterns" em `src/AGENTS.md`.
import fs from 'node:fs';
import * as path from 'node:path';
import { isReservedProcessName, type Name } from '../../domain/ids.ts';
import { Manifest } from '../../domain/manifest.ts';
import { HexlogError, reservedName } from '../../errors.ts';
import type { Decision, ProcessRef, ProcessStore, RawProcess } from '../../ports.ts';
import { errnoCode, writeFileAtomic } from './atomic.ts';
import { dataRoot, MANIFEST_FILE, processPaths } from './data-format.ts';
import {
  existsStrict,
  listDirectories,
  mapIo,
  readIfPresent,
  safeName,
  toHexlogError,
} from './io.ts';
import { createLockManager, type Lock, type LockOptions } from './lock.ts';

export type ProcessStoreOptions = LockOptions & {
  /** `<D>`; com nomes validados por `safeName`, o store grava só em `<D>/.v1/` (D-02). */
  dataDir: string;
};

function notFound(ref: ProcessRef): HexlogError {
  const message = 'process not found';
  return new HexlogError('PROCESS_NOT_FOUND', message, [
    { path: '/process', code: 'not-found', message, process: ref.process },
  ]);
}

function unreadableManifest(ref: ProcessRef): HexlogError {
  const message = 'process manifest is unreadable';
  return new HexlogError('PROCESS_CORRUPTED', message, [
    { path: '/process', code: 'unreadable-manifest', message, process: ref.process },
  ]);
}

/**
 * Teto do `records.jsonl` de um processo (N8, `docs/tetos-dominio-v1.md`): 64 MiB. O lote que
 * faria o arquivo passar disso é recusado na escrita com `PROCESS_TOO_LARGE`; exatamente 64 MiB
 * ainda grava e lê.
 */
export const MAX_LOG_BYTES = 64 * 1024 * 1024;

/** A recomendação de criar outro processo só vale para quem grava: leitura e destino de relação ficam neutros. */
function tooLarge(ref: ProcessRef, advice = false): HexlogError {
  const base = `process '${ref.process}' log exceeds ${MAX_LOG_BYTES / 2 ** 20} MiB`;
  const message = advice ? `${base}; create a new process to keep recording` : base;
  return new HexlogError('PROCESS_TOO_LARGE', message, [
    { path: '/process', code: 'too-large', message, process: ref.process },
  ]);
}

/** Tamanho em bytes do `records.jsonl` (arquivo inexistente vale 0). */
function logSize(file: string): number {
  return fs.statSync(file, { throwIfNoEntry: false })?.size ?? 0;
}

/**
 * Lê o `records.jsonl` (arquivo inexistente vale log vazio). O tamanho é conferido com `stat` antes
 * de ler, então um log acima de `MAX_LOG_BYTES` nunca vira string. Como `write` lê pelo mesmo
 * `createProcessStore#readProcess`, escrever sobre processo acima do teto recusa sem gravar.
 */
function readLogText(file: string, ref: ProcessRef, advice: boolean): string {
  if (logSize(file) > MAX_LOG_BYTES) throw tooLarge(ref, advice);
  return readIfPresent(file) ?? '';
}

function parseManifest(ref: ProcessRef, text: string): Manifest {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw unreadableManifest(ref);
  }
  const parsed = Manifest.safeParse(value);
  if (!parsed.success) throw unreadableManifest(ref);
  return parsed.data;
}

/**
 * Anexa `text` (se houver) e dá o único `fsync` do lote. Sem `text` (replay, D-05) só dá `fsync`,
 * porque um lote de cauda válida pode nunca ter passado por um.
 */
function appendAndSync(file: string, text: string | undefined): void {
  const fd = fs.openSync(file, 'a', 0o600);
  try {
    if (text !== undefined) fs.writeFileSync(fd, Buffer.from(text));
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
}

/** D-25: `ProcessStore` sobre `<D>/.v1/<project>/<process>/{process.json,records.jsonl}` (D-02). */
export function createProcessStore({ dataDir, ...lockOptions }: ProcessStoreOptions): ProcessStore {
  const root = dataRoot(dataDir);
  const locks = createLockManager(lockOptions);

  const projectDir = (project: Name) => path.join(root, safeName(project, '/project'));
  const pathsOf = (ref: ProcessRef) =>
    processPaths(dataDir, {
      project: safeName(ref.project, '/project'),
      process: safeName(ref.process, '/process'),
    });

  function readManifest(ref: ProcessRef): Manifest {
    const manifestText = readIfPresent(pathsOf(ref).manifest);
    if (manifestText === undefined) throw notFound(ref);
    return parseManifest(ref, manifestText);
  }

  function readProcess(ref: ProcessRef, advice = false): RawProcess {
    const manifest = readManifest(ref);
    const text = readLogText(pathsOf(ref).log, ref, advice);
    return { manifest, text, endsWithNewline: text === '' || text.endsWith('\n') };
  }

  async function writeLocked<T>(
    ref: ProcessRef,
    decide: (raw: RawProcess) => Decision<T>,
  ): Promise<T> {
    const paths = pathsOf(ref);
    if (!existsStrict(paths.manifest)) throw notFound(ref);
    const lock = await locks.acquire(paths.lock);
    let result: T;
    try {
      const raw = readProcess(ref, true);
      const decision = decide(raw);
      const text =
        decision.line === undefined
          ? undefined
          : `${raw.endsWithNewline ? '' : '\n'}${decision.line}`;
      if (text !== undefined) {
        if (logSize(paths.log) + Buffer.byteLength(text) > MAX_LOG_BYTES) throw tooLarge(ref, true);
        await locks.confirm(lock);
      }
      appendAndSync(paths.log, text);
      result = decision.result;
    } catch (error) {
      await releaseAfterFailure(lock);
      throw error;
    }
    await locks.release(lock);
    return result;
  }

  /** Com o erro do `try` em voo, falha do `release` não o substitui: vai só para o log (D-26). */
  async function releaseAfterFailure(lock: Lock): Promise<void> {
    try {
      await locks.release(lock);
    } catch (releaseError) {
      lockOptions.log({ level: 'error', event: 'release-failed', code: errnoCode(releaseError) });
    }
  }

  return {
    read: (ref) => mapIo(() => readProcess(ref)),

    readManifest: (ref) => mapIo(() => readManifest(ref)),

    list: (project) =>
      mapIo(() => {
        const dir = projectDir(project);
        // Pastas de definição e anexos do projeto não têm manifesto.
        return listDirectories(dir, (name) => existsStrict(path.join(dir, name, MANIFEST_FILE)));
      }),

    listProjects: () => mapIo(() => listDirectories(root)),

    create: (ref, manifest) =>
      mapIo(() => {
        const paths = pathsOf(ref);
        if (isReservedProcessName(ref.process)) throw reservedName();
        if (manifest.project !== ref.project || manifest.process !== ref.process) {
          throw new HexlogError('INTERNAL', 'manifest does not match ref');
        }
        // ponytail: o fsync cobre só o diretório do processo, não o do projeto nem o `.v1`; queda de
        // energia na primeira criação pode perder o processo. Melhoria: fsync da cadeia de pais criados.
        fs.mkdirSync(paths.dir, { recursive: true, mode: 0o700 });
        // O log nasce antes do manifesto: o `fsyncDir` dele torna as duas entradas duráveis juntas.
        fs.closeSync(fs.openSync(paths.log, 'a', 0o600));
        try {
          writeFileAtomic(paths.manifest, JSON.stringify(manifest), {
            exclusive: true,
            fsyncDir: true,
          });
          return true;
        } catch (error) {
          if (errnoCode(error) === 'EEXIST') return false;
          throw error;
        }
      }),

    write: async (ref, decide) => {
      try {
        return await writeLocked(ref, decide);
      } catch (error) {
        throw toHexlogError(error);
      }
    },
  };
}
