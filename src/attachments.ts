import { randomBytes } from 'node:crypto';
// import default (não `* as fs`): mesmo motivo de `log.ts`. Sob esModuleInterop, `* as` copia o
// módulo com getters não configuráveis e `jest.spyOn(fs, 'fstatSync')` não interceptaria estas
// chamadas a partir do teste.
import fs from 'node:fs';
import * as path from 'node:path';
import { isEqual } from 'es-toolkit';
import { sha256hex, type AttachmentStatus } from './chain.ts';
import { HexlogError } from './errors.ts';
import { Hash, Name } from './events.ts';
import { sliceChars } from './pages.ts';
import { ioError, resolveSafePath } from './storage.ts';

/** Teto de um anexo, em bytes UTF-8 (não em caracteres). */
export const ATTACHMENT_MAX_BYTES = 1_048_576;

/** Página de `get`: `limit` padrão e máximo, em caracteres. */
export const PAGE_DEFAULT_CHARS = 12_000;
export const PAGE_MAX_CHARS = 24_000;

const ATTACHMENTS_DIR = 'attachments';

// Único diretório que `path` pode ler, relativo ao `cwd` do servidor.
const PLANS_DIR = path.join('.omc', 'plans');

export type PutResult = { hash: string; bytes: number; deduplicated: boolean };

export type Page = {
  hash: string;
  bytes: number;
  total: number;
  offset: number;
  text: string;
  nextOffset: number | null;
};

type Blob = { status: 'ok'; bytes: Buffer } | { status: 'missing' } | { status: 'corrupted' };

function invalidInput(pointer: string, code: string, message: string): HexlogError {
  return new HexlogError('INVALID_INPUT', message, [{ path: pointer, code, message }]);
}

function errnoOf(e: unknown): string | undefined {
  return (e as NodeJS.ErrnoException).code;
}

function attachmentNotFound(hash: string): HexlogError {
  return new HexlogError('ATTACHMENT_NOT_FOUND', `attachment '${hash}' not found`);
}

function attachmentCorrupted(hash: string): HexlogError {
  return new HexlogError('ATTACHMENT_CORRUPTED', `attachment '${hash}' does not match its hash`);
}

/**
 * Abre para leitura sem seguir symlink no componente final (ELOOP) e sem travar num FIFO com esse
 * nome (`O_NONBLOCK`).
 */
function openForRead(file: string): number {
  const { O_RDONLY, O_NOFOLLOW, O_NONBLOCK } = fs.constants;
  return fs.openSync(file, O_RDONLY | O_NOFOLLOW | O_NONBLOCK);
}

/**
 * Lê o fd até o fim, mas no máximo `ATTACHMENT_MAX_BYTES + 1` bytes: um resultado acima do teto
 * sinaliza arquivo grande demais (ou que cresceu depois do `fstat`) sem carregá-lo inteiro.
 */
function readBounded(fd: number): Buffer {
  const buffer = Buffer.allocUnsafe(ATTACHMENT_MAX_BYTES + 1);
  let length = 0;
  while (length < buffer.length) {
    const read = fs.readSync(fd, buffer, length, buffer.length - length, null);
    if (read === 0) break;
    length += read;
  }
  return buffer.subarray(0, length);
}

/** Diretório do projeto; `PROJECT_NOT_FOUND` se não existe (nunca o cria). */
export function requireProject(dir: string, project: string): string {
  // o CLI passa o argv direto: só nome válido chega ao sistema de arquivos
  if (!Name.safeParse(project).success) {
    throw invalidInput('/project', 'bad_args', 'invalid project name');
  }
  const projectDir = resolveSafePath(dir, project);
  if (!fs.existsSync(projectDir)) {
    throw new HexlogError('PROJECT_NOT_FOUND', `project '${project}' not found`);
  }
  return projectDir;
}

function blobFile(dir: string, project: string, hash: string): string {
  if (!Hash.safeParse(hash).success) throw invalidInput('/hash', 'bad_args', 'invalid hash');
  return resolveSafePath(dir, project, ATTACHMENTS_DIR, hash);
}

/**
 * Lê o blob e confere o sha256 dos bytes contra o nome do arquivo. Symlink, arquivo que não é
 * regular (FIFO, diretório) ou acima do teto contam como `corrupted`: nunca são seguidos nem lidos.
 */
function readBlob(file: string, hash: string): Blob {
  let fd: number;
  try {
    fd = openForRead(file);
  } catch (e) {
    const code = errnoOf(e);
    if (code === 'ENOENT') return { status: 'missing' };
    if (code === 'ELOOP') return { status: 'corrupted' };
    throw ioError(e);
  }

  try {
    const stat = fs.fstatSync(fd);
    if (!stat.isFile() || stat.size > ATTACHMENT_MAX_BYTES) return { status: 'corrupted' };
    const bytes = readBounded(fd);
    const intact = bytes.length <= ATTACHMENT_MAX_BYTES && sha256hex(bytes) === hash;
    return intact ? { status: 'ok', bytes } : { status: 'corrupted' };
  } catch (e) {
    throw ioError(e);
  } finally {
    fs.closeSync(fd);
  }
}

/** Decodifica UTF-8 estrito, mantendo o BOM; `undefined` se os bytes não forem UTF-8 válido. */
function decodeUtf8(bytes: Uint8Array): string | undefined {
  try {
    return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
  } catch {
    return undefined;
  }
}

function fsyncDirectory(dir: string): void {
  const fd = fs.openSync(dir, fs.constants.O_RDONLY);
  try {
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
}

/** Grava `bytes` em `tmp` (com fsync) e o linka como `file`; `true` se `file` já existia (dedupe). */
function writeThenLink(tmp: string, file: string, bytes: Buffer): boolean {
  const fd = fs.openSync(tmp, 'wx', 0o600);
  try {
    fs.writeFileSync(fd, bytes);
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  try {
    fs.linkSync(tmp, file);
    return false;
  } catch (e) {
    if (errnoOf(e) === 'EEXIST') return true;
    throw e;
  }
}

/**
 * Grava `bytes` em `<projeto>/attachments/<sha256>`: tmp no mesmo diretório + fsync + `link`
 * exclusivo + fsync do diretório. `EEXIST` é dedupe: o blob existente é relido e comparado, nunca
 * sobrescrito. Erro de fs vira `IO_ERROR`.
 */
function storeBlob(projectDir: string, bytes: Buffer): PutResult {
  const hash = sha256hex(bytes);
  const attachments = path.join(projectDir, ATTACHMENTS_DIR);
  const file = path.join(attachments, hash);
  const tmp = path.join(attachments, `.${hash}.${process.pid}.${randomBytes(4).toString('hex')}`);

  let deduplicated: boolean;
  try {
    fs.mkdirSync(attachments, { recursive: true, mode: 0o700 });
    deduplicated = writeThenLink(tmp, file, bytes);
    if (!deduplicated) fsyncDirectory(attachments);
  } catch (e) {
    throw ioError(e);
  } finally {
    fs.rmSync(tmp, { force: true });
  }

  if (deduplicated && readBlob(file, hash).status !== 'ok') throw attachmentCorrupted(hash);
  return { hash, bytes: bytes.length, deduplicated };
}

/** Guarda `text` (UTF-8, ≤ 1 MiB em bytes, sem surrogate solto) como anexo do projeto. */
export function putAttachmentText(dir: string, project: string, text: string): PutResult {
  const projectDir = requireProject(dir, project);
  if (text.length === 0) throw invalidInput('/text', 'bad_args', 'text must not be empty');
  if (Buffer.byteLength(text, 'utf8') > ATTACHMENT_MAX_BYTES) {
    throw invalidInput('/text', 'too_big', `text exceeds ${ATTACHMENT_MAX_BYTES} bytes`);
  }
  const bytes = Buffer.from(text, 'utf8');
  if (bytes.toString('utf8') !== text) {
    throw invalidInput('/text', 'lone_surrogate', 'text contains a lone surrogate');
  }
  return storeBlob(projectDir, bytes);
}

function outsideAllowedRoot(): HexlogError {
  return invalidInput('/path', 'outside_allowed_root', 'path is outside <cwd>/.omc/plans');
}

/** `IO_ERROR` do arquivo do plano: só o errno, nunca a mensagem do fs (ela traz o caminho absoluto). */
function planFileError(e: unknown): HexlogError {
  return new HexlogError('IO_ERROR', 'I/O failure', [
    { path: '/path', code: errnoOf(e) ?? 'unknown', message: 'could not read the plan file' },
  ]);
}

function tooBigFile(): HexlogError {
  return invalidInput('/path', 'too_big', `file exceeds ${ATTACHMENT_MAX_BYTES} bytes`);
}

/**
 * `directory` resolvido por `realpath`, se for exatamente `realpath(cwd)/.omc/plans`. Qualquer
 * falha do `realpath` (ENOENT, ENOTDIR, permissão) é só "fora da raiz" para o agente: sem errno e
 * sem caminho absoluto. É o caso da sessão iniciada em subdiretório, que a regra de degradação cobre.
 */
function allowedPlansDirectory(cwd: string, directory: string): string {
  try {
    const real = fs.realpathSync(directory);
    if (real === path.join(fs.realpathSync(cwd), PLANS_DIR)) return real;
  } catch {
    // cai no erro uniforme abaixo
  }
  throw outsideAllowedRoot();
}

function openPlanFile(file: string): number {
  try {
    return openForRead(file);
  } catch (e) {
    const code = errnoOf(e);
    if (code === 'ELOOP') throw invalidInput('/path', 'not_regular', 'path is a symlink');
    if (code === 'ENOENT') throw invalidInput('/path', 'not_found', 'file not found');
    throw planFileError(e);
  }
}

/** Caminho que o kernel resolveu para `fd`, ou `undefined` sem /proc (macOS, contêiner restrito). */
function procPathOf(fd: number): string | undefined {
  try {
    return fs.realpathSync(`/proc/self/fd/${fd}`);
  } catch {
    return undefined;
  }
}

/**
 * O `fd` aberto é mesmo `file` (`<realpath(cwd)>/.omc/plans/<nome>`)? O `realpath` do diretório e o
 * `open` são duas chamadas, e um componente do diretório pode virar symlink entre elas: com /proc,
 * o kernel diz o caminho do fd; sem /proc, `recheckDirectory` refaz a checagem do diretório e o
 * `dev`/`ino` do fd é comparado com o do caminho resolvido.
 */
function isOpenedAt(
  fd: number,
  file: string,
  stat: fs.Stats,
  recheckDirectory: () => string,
): boolean {
  const opened = procPathOf(fd);
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
 * Lê `candidate` (relativo a `cwd` ou absoluto) só se for um `.md` regular, de um único link, direto
 * em `realpath(cwd)/.omc/plans`. O diretório é resolvido com `realpath`; o componente final é
 * aberto com `O_NOFOLLOW` (symlink final → ELOOP). Depois do `open`, o fd é conferido contra o
 * caminho esperado (corrida no diretório) e `nlink > 1` é recusado (hardlink para fora).
 */
function readPlanFile(cwd: string, candidate: string): Buffer {
  if (candidate.includes('\0')) throw invalidInput('/path', 'bad_args', 'path contains NUL');

  const resolved = path.resolve(cwd, candidate);
  const name = path.basename(resolved);
  if (!name.endsWith('.md')) throw invalidInput('/path', 'not_md', 'path must end in .md');

  const dirname = path.dirname(resolved);
  const file = path.join(allowedPlansDirectory(cwd, dirname), name);
  const fd = openPlanFile(file);
  try {
    const stat = fs.fstatSync(fd);
    if (!stat.isFile() || stat.nlink > 1) {
      throw invalidInput('/path', 'not_regular', 'path is not a regular file with a single link');
    }
    if (!isOpenedAt(fd, file, stat, () => allowedPlansDirectory(cwd, dirname))) {
      throw outsideAllowedRoot();
    }
    if (stat.size > ATTACHMENT_MAX_BYTES) throw tooBigFile();

    const bytes = readBounded(fd);
    if (bytes.length > ATTACHMENT_MAX_BYTES) throw tooBigFile();
    return bytes;
  } catch (e) {
    throw e instanceof HexlogError ? e : planFileError(e);
  } finally {
    fs.closeSync(fd);
  }
}

/** Guarda o arquivo `candidate` de `<cwd>/.omc/plans` como anexo do projeto (bytes UTF-8 válidos). */
export function putAttachmentPath(
  dir: string,
  project: string,
  cwd: string,
  candidate: string,
): PutResult {
  const projectDir = requireProject(dir, project);
  const bytes = readPlanFile(cwd, candidate);
  if (bytes.length === 0) throw invalidInput('/path', 'bad_args', 'file is empty');
  if (decodeUtf8(bytes) === undefined) {
    throw invalidInput('/path', 'invalid_utf8', 'file is not valid UTF-8');
  }
  return storeBlob(projectDir, bytes);
}

function loadVerified(dir: string, project: string, hash: string): { bytes: Buffer; text: string } {
  const blob = readBlob(blobFile(dir, project, hash), hash);
  if (blob.status === 'missing') throw attachmentNotFound(hash);
  const text = blob.status === 'ok' ? decodeUtf8(blob.bytes) : undefined;
  if (blob.status === 'corrupted' || text === undefined) throw attachmentCorrupted(hash);
  return { bytes: blob.bytes, text };
}

/** Uma página de `limit` caracteres do anexo `hash`, a partir de `offset`. */
export function readAttachmentPage(
  dir: string,
  project: string,
  hash: string,
  offset: number,
  limit: number,
): Page {
  requireProject(dir, project);
  const { bytes, text } = loadVerified(dir, project, hash);
  return {
    hash,
    bytes: bytes.length,
    total: text.length,
    offset,
    ...sliceChars(text, offset, limit),
  };
}

/** Texto integral do anexo, ou `undefined` se ausente ou adulterado. Usado por `timeline full`. */
export function readAttachmentText(dir: string, project: string, hash: string): string | undefined {
  const blob = readBlob(blobFile(dir, project, hash), hash);
  return blob.status === 'ok' ? decodeUtf8(blob.bytes) : undefined;
}

/** Estado do blob: relê e re-hasheia sempre. Usado por `chain` e `timeline`. */
export function checkAttachment(dir: string, project: string, hash: string): AttachmentStatus {
  return readBlob(blobFile(dir, project, hash), hash).status;
}

/** `ATTACHMENT_NOT_FOUND` ou `ATTACHMENT_CORRUPTED` se o blob não estiver íntegro. Usado por `register`. */
export function assertAttachmentIntact(dir: string, project: string, hash: string): void {
  const status = checkAttachment(dir, project, hash);
  if (status === 'missing') throw attachmentNotFound(hash);
  if (status === 'corrupted') throw attachmentCorrupted(hash);
}

type Fingerprint = { ino: number; size: number; mtimeMs: number; ctimeMs: number };

// ponytail: mapa global limpo ao passar de 1.000 entradas; trocar por LRU se o teto incomodar.
const MEMO_MAX = 1_000;
const verified = new Map<string, Fingerprint>();

/**
 * Como `checkAttachment`, mas pula o re-hash de um blob já visto `ok` com o mesmo
 * `(ino, size, mtimeMs, ctimeMs)`. Escrita in place muda o `ctime`, então adulterar sem mudar
 * `size` e `mtime` é visto; o resíduo é falsificar o `ctime`. Só o caminho do `state` usa.
 */
export function checkAttachmentMemoized(
  dir: string,
  project: string,
  hash: string,
): AttachmentStatus {
  const file = blobFile(dir, project, hash);
  let stat: fs.Stats;
  try {
    stat = fs.lstatSync(file);
  } catch (e) {
    if (errnoOf(e) === 'ENOENT') return 'missing';
    throw ioError(e);
  }

  const fingerprint = {
    ino: stat.ino,
    size: stat.size,
    mtimeMs: stat.mtimeMs,
    ctimeMs: stat.ctimeMs,
  };
  if (isEqual(verified.get(file), fingerprint)) return 'ok';

  const { status } = readBlob(file, hash);
  if (status !== 'ok') {
    verified.delete(file);
    return status;
  }
  if (verified.size >= MEMO_MAX) verified.clear();
  verified.set(file, fingerprint);
  return status;
}

/** Estado de cada hash de `hashes`, pelo verificador `check` (sem memo por padrão). */
export function checkAttachments(
  dir: string,
  project: string,
  hashes: readonly string[],
  check: typeof checkAttachment = checkAttachment,
): Map<string, AttachmentStatus> {
  return new Map(hashes.map((hash) => [hash, check(dir, project, hash)]));
}
