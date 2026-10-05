// Import padrão, não `import * as fs`: ver "Common Patterns" em `src/AGENTS.md`.
import { isUtf8 } from 'node:buffer';
import fs from 'node:fs';
import * as path from 'node:path';
import { sha256hex } from '../../domain/chain.ts';
import { Hash, Name } from '../../domain/ids.ts';
import { HexlogError, invalidInput } from '../../errors.ts';
import type { AttachmentPut, AttachmentStatus, AttachmentStore } from '../../ports.ts';
import { errnoCode, writeFileAtomic } from './atomic.ts';
import { blobFile } from './data-format.ts';
import { mapIo, safeName } from './io.ts';

/** Teto de um anexo, em bytes UTF-8 (não em caracteres). */
export const ATTACHMENT_MAX_BYTES = 1_048_576;

// ponytail: mapa limpo ao passar de 1.000 entradas; trocar por LRU se o teto incomodar.
const MEMO_MAX = 1_000;

export type AttachmentStoreOptions = {
  /** `<D>`: os blobs vão para `<D>/.v1/<projeto>/attachments/`, e `putPath` nunca lê de dentro dele (D-15). */
  dataDir: string;
  /** Raiz de `putPath` (D-15): só lê arquivo dentro de `realpath(cwd)`. Injetado; nada de `process.cwd()`. */
  cwd: string;
};

type BlobRead = { status: 'ok'; bytes: Buffer } | { status: 'missing' } | { status: 'corrupted' };

function attachmentNotFound(hash: string): HexlogError {
  return new HexlogError('ATTACHMENT_NOT_FOUND', `attachment '${hash}' not found`);
}

function attachmentCorrupted(hash: string): HexlogError {
  return new HexlogError('ATTACHMENT_CORRUPTED', `attachment '${hash}' does not match its hash`);
}

/** Abre sem seguir symlink no componente final (`ELOOP`) e sem travar num FIFO com esse nome. */
function openForRead(file: string): number {
  const { O_RDONLY, O_NOFOLLOW, O_NONBLOCK } = fs.constants;
  return fs.openSync(file, O_RDONLY | O_NOFOLLOW | O_NONBLOCK);
}

/**
 * Lê o fd até o fim, mas no máximo `size + 1` bytes (`size` é o do `fstat`): um resultado maior que
 * `size` sinaliza que o arquivo cresceu depois do `fstat`, sem carregar o excedente.
 */
function readBounded(fd: number, size: number): Buffer {
  const buffer = Buffer.allocUnsafe(size + 1);
  let length = 0;
  while (length < buffer.length) {
    const read = fs.readSync(fd, buffer, length, buffer.length - length, null);
    if (read === 0) break;
    length += read;
  }
  return buffer.subarray(0, length);
}

/**
 * Lê o blob e confere o sha256 dos bytes contra o nome do arquivo. Symlink, arquivo que não é
 * regular (FIFO, diretório) ou acima do teto contam como `corrupted`: nunca são seguidos nem lidos.
 */
function readBlob(file: string, hash: Hash): BlobRead {
  let fd: number;
  try {
    fd = openForRead(file);
  } catch (error) {
    const code = errnoCode(error);
    if (code === 'ENOENT') return { status: 'missing' };
    if (code === 'ELOOP') return { status: 'corrupted' };
    throw error;
  }

  try {
    const stat = fs.fstatSync(fd);
    if (!stat.isFile() || stat.size > ATTACHMENT_MAX_BYTES) return { status: 'corrupted' };
    const bytes = readBounded(fd, stat.size);
    const intact = bytes.length === stat.size && sha256hex(bytes) === hash;
    return intact ? { status: 'ok', bytes } : { status: 'corrupted' };
  } finally {
    fs.closeSync(fd);
  }
}

function isWithin(root: string, target: string): boolean {
  const relative = path.relative(root, target);
  return relative !== '..' && !relative.startsWith(`..${path.sep}`);
}

function outsideAllowedRoot(): HexlogError {
  return invalidInput('/path', 'outside-allowed-root', 'path is outside the allowed root');
}

function tooBigFile(): HexlogError {
  return invalidInput('/path', 'too-big', `file exceeds ${ATTACHMENT_MAX_BYTES} bytes`);
}

/** `realpath` de `target`, ou `undefined` se falhar (ENOENT, ENOTDIR, permissão...). */
function realpathOrUndefined(target: string): string | undefined {
  try {
    return fs.realpathSync(target);
  } catch {
    return undefined;
  }
}

/**
 * `directory` resolvido por `realpath`, se estiver dentro de `realpath(cwd)` e fora de
 * `realpath(dataDir)`. Qualquer falha do `realpath` de `directory` ou de `cwd` é só "fora da raiz"
 * para o agente: sem errno e sem caminho absoluto. `dataDir` inexistente não tem o que recusar;
 * como a checagem é feita depois do `realpath`, symlink de diretório para dentro dele não escapa.
 */
function allowedDirectory({ cwd, dataDir }: AttachmentStoreOptions, directory: string): string {
  const real = realpathOrUndefined(directory);
  const root = realpathOrUndefined(cwd);
  if (real === undefined || root === undefined || !isWithin(root, real)) {
    throw outsideAllowedRoot();
  }
  const data = realpathOrUndefined(dataDir);
  if (data !== undefined && isWithin(data, real)) {
    throw invalidInput('/path', 'inside-data-dir', 'path is inside the data directory');
  }
  return real;
}

function openCandidate(file: string): number {
  try {
    return openForRead(file);
  } catch (error) {
    const code = errnoCode(error);
    if (code === 'ELOOP') throw invalidInput('/path', 'not-regular', 'path is a symlink');
    if (code === 'ENOENT') throw invalidInput('/path', 'not-found', 'file not found');
    throw error;
  }
}

/**
 * O `fd` aberto é mesmo `file`? O `realpath` do diretório e o `open` são duas chamadas, e um
 * componente do diretório pode virar symlink entre elas: com /proc, o kernel diz o caminho do fd;
 * sem /proc (macOS, contêiner restrito), `recheckDirectory` refaz a checagem do diretório e o
 * `dev`/`ino` do fd é comparado com o do caminho resolvido.
 */
function isOpenedAt(
  fd: number,
  file: string,
  stat: fs.Stats,
  recheckDirectory: () => string,
): boolean {
  const opened = realpathOrUndefined(`/proc/self/fd/${fd}`);
  if (opened !== undefined) return opened === file;
  try {
    const current = fs.statSync(file);
    return (
      recheckDirectory() === path.dirname(file) &&
      current.dev === stat.dev &&
      current.ino === stat.ino
    );
  } catch {
    return false;
  }
}

/**
 * Lê `candidate` (relativo a `cwd` ou absoluto) só se for um arquivo regular, de um único link, em
 * qualquer subpasta de `realpath(cwd)` fora de `realpath(dataDir)` (D-15). O diretório é resolvido
 * com `realpath`; o componente final é aberto com `O_NOFOLLOW` (symlink final → `ELOOP`). Depois do
 * `open`, o fd é conferido contra o caminho esperado (corrida no diretório) e `nlink > 1` é
 * recusado (hardlink para fora). A ordem das recusas é fixa: só a primeira sai.
 */
function readFileWithin(options: AttachmentStoreOptions, candidate: string): Buffer {
  const resolved = path.resolve(options.cwd, candidate);
  const directory = path.dirname(resolved);
  const file = path.join(allowedDirectory(options, directory), path.basename(resolved));
  const fd = openCandidate(file);
  try {
    const stat = fs.fstatSync(fd);
    if (!stat.isFile() || stat.nlink > 1) {
      throw invalidInput('/path', 'not-regular', 'path is not a regular file with a single link');
    }
    if (!isOpenedAt(fd, file, stat, () => allowedDirectory(options, directory))) {
      throw outsideAllowedRoot();
    }
    if (stat.size > ATTACHMENT_MAX_BYTES) throw tooBigFile();

    const bytes = readBounded(fd, stat.size);
    if (bytes.length > stat.size) throw tooBigFile();
    return bytes;
  } finally {
    fs.closeSync(fd);
  }
}

/**
 * `AttachmentStore` sobre `<D>/.v1/<projeto>/attachments/<sha256>` (D-02): blob imutável, endereçado
 * pelo sha256 dos bytes UTF-8, publicado por `link` exclusivo e nunca sobrescrito. Só recusa o que
 * depende de disco ou de caminho; texto vazio e surrogate solto em `putText` são regras puras do
 * serviço `commands/attachment.ts` (F4), conferidas antes de qualquer I/O (D-15).
 */
export function createAttachmentStore(options: AttachmentStoreOptions): AttachmentStore {
  const verified = new Map<string, string>();

  /** Nome de projeto e hash viram segmento de caminho: passam por aqui antes de qualquer I/O. */
  function checkedBlobFile(project: Name, hash: Hash): string {
    safeName(project, '/project');
    if (!Hash.safeParse(hash).success) {
      throw invalidInput('/hash', 'invalid-hash', 'invalid hash');
    }
    return blobFile(options.dataDir, project, hash);
  }

  /**
   * Publica `bytes` com `link` exclusivo. Blob que já existe é dedupe: relido e comparado, nunca
   * sobrescrito (se não confere, `ATTACHMENT_CORRUPTED`). O `lstat` antes poupa o temporário e os
   * `fsync` no caso comum; o `EEXIST` do `link` cobre quem publica entre o `lstat` e o `link`.
   */
  function storeBlob(project: Name, bytes: Buffer): AttachmentPut {
    const hash = sha256hex(bytes);
    const file = checkedBlobFile(project, hash);
    if (fs.lstatSync(file, { throwIfNoEntry: false }) === undefined) {
      try {
        writeFileAtomic(file, bytes, { exclusive: true, fsyncDir: true });
        return { hash, bytes: bytes.length, deduplicated: false };
      } catch (error) {
        if (errnoCode(error) !== 'EEXIST') throw error;
      }
    }
    if (readBlob(file, hash).status !== 'ok') throw attachmentCorrupted(hash);
    return { hash, bytes: bytes.length, deduplicated: true };
  }

  /**
   * Relê o blob só quando a impressão `(ino, size, mtimeMs, ctimeMs)` mudou desde a última
   * verificação `ok`. Escrita no lugar muda o `ctime`, então adulterar sem mudar `size` e `mtime`
   * é visto; o resíduo é falsificar o `ctime`.
   */
  function statusOf(file: string, hash: Hash): AttachmentStatus {
    const stat = fs.lstatSync(file, { throwIfNoEntry: false });
    if (stat === undefined) return 'missing';

    const fingerprint = `${stat.ino}:${stat.size}:${stat.mtimeMs}:${stat.ctimeMs}`;
    if (verified.get(file) === fingerprint) return 'ok';

    const { status } = readBlob(file, hash);
    if (status !== 'ok') {
      verified.delete(file);
      return status;
    }
    if (verified.size >= MEMO_MAX) verified.clear();
    verified.set(file, fingerprint);
    return status;
  }

  return {
    putText: (project, text) =>
      mapIo(() => {
        safeName(project, '/project');
        if (Buffer.byteLength(text, 'utf8') > ATTACHMENT_MAX_BYTES) {
          throw invalidInput('/text', 'too-big', `text exceeds ${ATTACHMENT_MAX_BYTES} bytes`);
        }
        return storeBlob(project, Buffer.from(text, 'utf8'));
      }),

    putPath: (project, candidate) =>
      mapIo(() => {
        safeName(project, '/project');
        const bytes = readFileWithin(options, candidate);
        if (bytes.length === 0) throw invalidInput('/path', 'bad-args', 'file is empty');
        if (!isUtf8(bytes)) throw invalidInput('/path', 'invalid-utf8', 'file is not valid UTF-8');
        return storeBlob(project, bytes);
      }),

    status: (project, hash) => mapIo(() => statusOf(checkedBlobFile(project, hash), hash)),

    read: (project, hash) =>
      mapIo(() => {
        const blob = readBlob(checkedBlobFile(project, hash), hash);
        if (blob.status === 'missing') throw attachmentNotFound(hash);
        const text =
          blob.status === 'ok' && isUtf8(blob.bytes) ? blob.bytes.toString('utf8') : undefined;
        if (text === undefined) throw attachmentCorrupted(hash);
        return text;
      }),
  };
}
