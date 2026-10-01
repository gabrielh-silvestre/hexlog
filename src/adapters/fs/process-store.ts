// Import padrão (não `import * as fs`): o spy de `writeSync` do P9 (`jest.spyOn(fs, 'writeSync')`) só
// intercepta assim, porque sob `esModuleInterop` o namespace copia o módulo com getters não
// configuráveis e o teste acabaria espiando um objeto que este módulo não usa.
import fs from 'node:fs';
import * as path from 'node:path';
import { z } from 'zod';
import { Hash, Instant, Name } from '../../domain/ids.ts';
import { HexlogError } from '../../errors.ts';
import type { Decision, Manifest, ProcessRef, ProcessStore, RawProcess } from '../../ports.ts';
import { errnoCode, writeFileAtomic } from './atomic.ts';
import { dataRoot } from './data-format.ts';
import { createLockManager, type Lock, type LockOptions } from './lock.ts';

const MANIFEST_FILE = 'process.json';
const LOG_FILE = 'records.jsonl';
const LOCK_DIR = `${LOG_FILE}.lock`;

/**
 * Só a forma externa: o que `anchor` hasheia é o que está no disco, então o manifesto devolvido é
 * o JSON lido, nunca a saída do parse (que poderia normalizar). Conferir o conteúdo é da cadeia.
 */
const ManifestShape = z.object({
  project: Name,
  process: Name,
  createdAt: Instant,
  fixed: z.object({
    types: z.record(z.string(), z.unknown()),
    relations: z.record(z.string(), z.unknown()),
    gates: z.record(z.string(), z.unknown()),
  }),
  hashes: z.object({ types: Hash, relations: Hash, gates: Hash }),
});

export type ProcessStoreOptions = LockOptions & {
  /** `<D>`; o store grava só em `<D>/.v1/` (D-02). */
  dataDir: string;
};

/** D-26: `IO_ERROR` traz só o errno; o `message` do fs carrega o caminho absoluto. */
function toHexlogError(error: unknown): unknown {
  const code = errnoCode(error);
  if (error instanceof HexlogError || code === undefined || !/^E[A-Z0-9]+$/.test(code)) {
    return error;
  }
  return new HexlogError('IO_ERROR', 'I/O failure', [
    { path: '', code: code.toLowerCase(), message: 'I/O failure' },
  ]);
}

function mapIo<T>(operation: () => T): T {
  try {
    return operation();
  } catch (error) {
    throw toHexlogError(error);
  }
}

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

/** Lê `file`; arquivo inexistente vira `undefined`, qualquer outro erro sai cru. */
function readTextIfPresent(file: string): string | undefined {
  try {
    return fs.readFileSync(file, 'utf8');
  } catch (error) {
    if (errnoCode(error) === 'ENOENT') return undefined;
    throw error;
  }
}

function parseManifest(ref: ProcessRef, text: string): Manifest {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw unreadableManifest(ref);
  }
  if (!ManifestShape.safeParse(value).success) throw unreadableManifest(ref);
  return value as Manifest;
}

/** Diretórios de `dir` que passam em `keep`, em ordem alfabética; `dir` inexistente não tem nenhum. */
function listDirectories(dir: string, keep: (name: string) => boolean = () => true): Name[] {
  try {
    return fs
      .readdirSync(dir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && keep(entry.name))
      .map((entry) => entry.name)
      .sort();
  } catch (error) {
    if (errnoCode(error) === 'ENOENT') return [];
    throw error;
  }
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

  const projectDir = (project: Name) => path.join(root, project);
  const processDir = (ref: ProcessRef) => path.join(projectDir(ref.project), ref.process);

  function readProcess(ref: ProcessRef): RawProcess {
    const dir = processDir(ref);
    const manifestText = readTextIfPresent(path.join(dir, MANIFEST_FILE));
    if (manifestText === undefined) throw notFound(ref);
    const manifest = parseManifest(ref, manifestText);
    // `create` grava o log vazio antes do manifesto, então só uma árvore montada à mão fica sem
    // `records.jsonl`; vale como processo vazio.
    const text = readTextIfPresent(path.join(dir, LOG_FILE)) ?? '';
    return { manifest, text, endsWithNewline: text === '' || text.endsWith('\n') };
  }

  async function writeLocked<T>(
    ref: ProcessRef,
    decide: (raw: RawProcess) => Decision<T>,
  ): Promise<T> {
    const dir = processDir(ref);
    const logFile = path.join(dir, LOG_FILE);
    if (!fs.existsSync(path.join(dir, MANIFEST_FILE))) throw notFound(ref);
    const lock = await locks.acquire(path.join(dir, LOCK_DIR));
    let result: T;
    try {
      const raw = readProcess(ref);
      const decision = decide(raw);
      const text =
        decision.line === undefined
          ? undefined
          : `${raw.endsWithNewline ? '' : '\n'}${decision.line}`;
      if (text !== undefined) await locks.confirm(lock);
      appendAndSync(logFile, text);
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

    list: (project) =>
      mapIo(() =>
        listDirectories(projectDir(project), (name) =>
          // Pastas de definição e anexos do projeto não têm manifesto.
          fs.existsSync(path.join(projectDir(project), name, MANIFEST_FILE)),
        ),
      ),

    listProjects: () => mapIo(() => listDirectories(root)),

    create: (ref, manifest) =>
      mapIo(() => {
        const dir = processDir(ref);
        // ponytail: o fsync cobre só o diretório do processo, não o do projeto nem o `.v1`; queda de
        // energia na primeira criação pode perder o processo. Melhoria: fsync da cadeia de pais criados.
        fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
        // O log nasce antes do manifesto: o `fsyncDir` dele torna as duas entradas duráveis juntas.
        fs.closeSync(fs.openSync(path.join(dir, LOG_FILE), 'a', 0o600));
        try {
          writeFileAtomic(path.join(dir, MANIFEST_FILE), JSON.stringify(manifest), {
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
