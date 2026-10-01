// Import padrão (não `import * as fs`): o spy de `writeSync` do P9 (`jest.spyOn(fs, 'writeSync')`) só
// intercepta assim, porque sob `esModuleInterop` o namespace copia o módulo com getters não
// configuráveis e o teste acabaria espiando um objeto que este módulo não usa.
import fs from 'node:fs';
import * as path from 'node:path';
import { Name, RESERVED_PROCESS_NAMES } from '../../domain/ids.ts';
import { Manifest } from '../../domain/manifest.ts';
import { HexlogError } from '../../errors.ts';
import type { Decision, ProcessRef, ProcessStore, RawProcess } from '../../ports.ts';
import { errnoCode, writeFileAtomic } from './atomic.ts';
import { dataRoot, MANIFEST_FILE, processPaths } from './data-format.ts';
import { createLockManager, type Lock, type LockOptions } from './lock.ts';

export type ProcessStoreOptions = LockOptions & {
  /** `<D>`; com nomes validados por `safeName`, o store grava só em `<D>/.v1/` (D-02). */
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

/** Todo nome que vira segmento de caminho passa por aqui, antes de qualquer I/O. */
function safeName(value: string, field: string): Name {
  if (!Name.safeParse(value).success) {
    const message = 'invalid name';
    throw new HexlogError('INVALID_INPUT', message, [
      { path: field, code: 'invalid-name', message },
    ]);
  }
  return value;
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
  const parsed = Manifest.safeParse(value);
  if (!parsed.success) throw unreadableManifest(ref);
  return parsed.data;
}

/** Diretórios de `dir` com nome válido que passam em `keep`, em ordem alfabética; `dir` inexistente não tem nenhum. */
function listDirectories(dir: string, keep: (name: string) => boolean = () => true): Name[] {
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

  function readProcess(ref: ProcessRef): RawProcess {
    const paths = pathsOf(ref);
    const manifestText = readTextIfPresent(paths.manifest);
    if (manifestText === undefined) throw notFound(ref);
    const manifest = parseManifest(ref, manifestText);
    // `create` grava o log vazio antes do manifesto, então só uma árvore montada à mão fica sem
    // `records.jsonl`; vale como processo vazio.
    // ponytail: não há teto de tamanho do arquivo; o limite real é o do Node (~512 MiB,
    // `buffer.constants.MAX_STRING_LENGTH`), onde `ERR_STRING_TOO_LONG` vira `INTERNAL` e não há rota
    // de recuperação. O teto de 64 MiB com o erro `PROCESS_TOO_LARGE` entra na F3: a recusa fica em
    // `writeLocked`, checando `size + tamanho do lote` (ver `docs/tetos-dominio-v1.md`).
    const text = readTextIfPresent(paths.log) ?? '';
    return { manifest, text, endsWithNewline: text === '' || text.endsWith('\n') };
  }

  async function writeLocked<T>(
    ref: ProcessRef,
    decide: (raw: RawProcess) => Decision<T>,
  ): Promise<T> {
    const paths = pathsOf(ref);
    if (!fs.existsSync(paths.manifest)) throw notFound(ref);
    const lock = await locks.acquire(paths.lock);
    let result: T;
    try {
      const raw = readProcess(ref);
      const decision = decide(raw);
      const text =
        decision.line === undefined
          ? undefined
          : `${raw.endsWithNewline ? '' : '\n'}${decision.line}`;
      if (text !== undefined) await locks.confirm(lock);
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
