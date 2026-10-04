// Import padrão, não `import * as fs`: ver "Common Patterns" em `src/AGENTS.md`.
import fs from 'node:fs';
import * as path from 'node:path';
import { RESERVED_PROCESS_NAMES, type Name } from '../../domain/ids.ts';
import { Manifest } from '../../domain/manifest.ts';
import { HexlogError } from '../../errors.ts';
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

function tooLarge(): HexlogError {
  const message = 'process log exceeds the size limit; create a new process to keep recording';
  return new HexlogError('PROCESS_TOO_LARGE', message, [
    { path: '/process', code: 'too-large', message },
  ]);
}

/** Tamanho em bytes do `records.jsonl` (arquivo inexistente vale 0). */
function logSize(file: string): number {
  try {
    return fs.statSync(file).size;
  } catch (error) {
    if (errnoCode(error) === 'ENOENT') return 0;
    throw error;
  }
}

/**
 * Lê o `records.jsonl` (arquivo inexistente vale log vazio). O tamanho é conferido com `stat` antes
 * de ler, então um log acima de `MAX_LOG_BYTES` nunca vira string. Como `write` lê pelo mesmo
 * `createProcessStore#readProcess`, escrever sobre processo acima do teto recusa sem gravar.
 */
function readLogText(file: string): string {
  if (logSize(file) > MAX_LOG_BYTES) throw tooLarge();
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
 * D-05: grava até somar o tamanho do buffer (o POSIX permite escrita parcial; o retorno de
 * `writeSync` não pode ser ignorado). Erro no meio deixa o que já entrou: resto que o leitor trata.
 */
function writeFully(fd: number, buffer: Buffer): void {
  let offset = 0;
  while (offset < buffer.length) offset += fs.writeSync(fd, buffer, offset);
}

/**
 * Anexa `text` (se houver) e dá o único `fsync` do lote. Sem `text` (replay, D-05) só dá `fsync`,
 * porque um lote de cauda válida pode nunca ter passado por um.
 */
function appendAndSync(file: string, text: string | undefined): void {
  const fd = fs.openSync(file, 'a', 0o600);
  try {
    if (text !== undefined) writeFully(fd, Buffer.from(text));
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

  function readProcess(ref: ProcessRef): RawProcess {
    const manifest = readManifest(ref);
    const text = readLogText(pathsOf(ref).log);
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
      const raw = readProcess(ref);
      const decision = decide(raw);
      const text =
        decision.line === undefined
          ? undefined
          : `${raw.endsWithNewline ? '' : '\n'}${decision.line}`;
      if (text !== undefined) {
        if (logSize(paths.log) + Buffer.byteLength(text) > MAX_LOG_BYTES) throw tooLarge();
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
      mapIo(() =>
        listDirectories(projectDir(project), (name) =>
          // Pastas de definição e anexos do projeto não têm manifesto.
          existsStrict(path.join(projectDir(project), name, MANIFEST_FILE)),
        ),
      ),

    listProjects: () => mapIo(() => listDirectories(root)),

    create: (ref, manifest) =>
      mapIo(() => {
        const paths = pathsOf(ref);
        if ((RESERVED_PROCESS_NAMES as readonly string[]).includes(ref.process)) {
          const message = 'reserved process name';
          throw new HexlogError('RESERVED_NAME', message, [
            { path: '/process', code: 'reserved-name', message },
          ]);
        }
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
