import { createHash } from 'node:crypto';
// Import padrão, não `import * as fs`: ver "Common Patterns" em `src/AGENTS.md`.
import fs from 'node:fs';
import * as path from 'node:path';
import { isEqual, isNotNil, isSubset, isUndefined } from 'es-toolkit';
import * as tar from 'tar';
import { errnoCode, fsyncPath } from './adapters/fs/atomic.ts';
import { ARCHIVE_DIR, detectLegacy } from './adapters/fs/data-format.ts';
import { isPidAlive } from './adapters/fs/lock.ts';
import { sha256hex } from './domain/chain.ts';

/** Arquivo regular do dado 0.x; `path` relativo a `<D>`. */
export type LegacyFile = { path: string; size: number; sha256: string };

/** Tudo que o 0.x deixou em `<D>`; `dirs` (relativos, inclui a própria entrada) sai em ordem de varredura. */
export type LegacyInventory = { files: LegacyFile[]; dirs: string[] };

export type ArchiveOptions = {
  /** Pasta das versões instaladas (`~/.local/lib/hexlog`): um servidor `<libDir>/0.*` vivo impede o arquivamento. */
  libDir: string;
  now: () => Date;
  /** Raiz de processos do sistema; só os testes trocam, para simular `/proc` ausente, sem pid ou com `cmdline` ilegível. */
  procDir?: string;
};

/** `tarPath` falta quando o 0.x só tinha diretórios vazios; `dirs` são os diretórios 0.x removidos. */
export type ArchiveResult =
  { archived: false; files: 0 } | { archived: true; tarPath?: string; files: number; dirs: number };

/** Todo aborto do arquivamento (D-14); o instalador captura e sai com 1. */
export class ArchiveError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ArchiveError';
  }
}

type Listing = { files: string[]; dirs: string[] };

const LEGACY_LOCK_HOLDER_SUFFIX = '/events.jsonl.lock/holder';
const TAR_NAME = /^hexlog-0x-.*\.tar$/;
const PARTIAL_SUFFIX = '.tar.partial';
/** `kill` e `/proc` só enxergam pid int32; acima disso o holder não é de um processo real. */
const INT32_MAX = 2 ** 31 - 1;
/** Errno de `cmdline` que não impede a conclusão: processo que sumiu, ou que o `hidepid` do `/proc` esconde. */
const UNSEEN_PROCESS_ERRNO = new Set(['ENOENT', 'ESRCH', 'EACCES', 'EPERM']);

/**
 * Lista o que o 0.x deixou em `dataDir`: todo arquivo regular (caminho, tamanho e sha256) e todo
 * diretório sob cada entrada de `detectLegacy`, inclusive a própria entrada. Não altera `dataDir`.
 * Symlink, hard link ou arquivo especial lança `ArchiveError`.
 */
export function inspectLegacy(dataDir: string): LegacyInventory {
  return asArchiveError(dataDir, () => hashListing(dataDir, walkLegacy(dataDir)));
}

/**
 * Arquiva o dado 0.x de `dataDir` num `.tar` em `<dataDir>/archive/` e remove só o que listou (D-14).
 * Qualquer aborto lança `ArchiveError` sem apagar nada que não esteja no `.tar` verificado.
 */
export function archiveLegacy(dataDir: string, options: ArchiveOptions): ArchiveResult {
  if (detectLegacy(dataDir).length === 0) return { archived: false, files: 0 };

  return asArchiveError<ArchiveResult>(dataDir, () => {
    const listing = walkLegacy(dataDir);
    assertNoLiveLegacy(dataDir, listing.files, options);
    const inventory = hashListing(dataDir, listing);
    const tarPath =
      inventory.files.length === 0
        ? undefined
        : (findReusablePackage(path.join(dataDir, ARCHIVE_DIR), inventory.files) ??
          createPackage(dataDir, inventory.files, options.now));

    // Gerar o `.tar` pode demorar: relê os originais e repete a checagem de vivos antes de apagar.
    if (!isEqual(inspectLegacy(dataDir), inventory)) {
      throw new ArchiveError(
        '0.x data changed while archiving; the package was kept and nothing was removed',
      );
    }
    assertNoLiveLegacy(
      dataDir,
      inventory.files.map((file) => file.path),
      options,
    );

    removeListed(dataDir, inventory);
    return { archived: true, tarPath, files: inventory.files.length, dirs: inventory.dirs.length };
  });
}

/**
 * Erro de fs sem tratamento vira `ArchiveError` com o caminho do erro (D-14): `ENOENT` é arquivo que
 * sumiu no meio, e rodar de novo retoma. Sem `path` no erro, o caminho citado é `dataDir`.
 */
function asArchiveError<T>(dataDir: string, run: () => T): T {
  try {
    return run();
  } catch (error) {
    const code = errnoCode(error);
    if (isUndefined(code)) throw error;
    const target = (error as { path?: string }).path ?? dataDir;
    throw new ArchiveError(
      code === 'ENOENT'
        ? `0.x file vanished while archiving: ${target}; rerun to resume`
        : `0.x archiving failed (${code}): ${target}`,
    );
  }
}

function walkLegacy(dataDir: string): Listing {
  const listing: Listing = { files: [], dirs: [] };
  const visit = (relative: string): void => {
    const absolute = path.join(dataDir, relative);
    const stat = fs.lstatSync(absolute);
    if (stat.isFile()) {
      // O `tar` grava o 2º nome de um hard link como `Link`, e a conferência 1:1 do pacote falharia.
      if (stat.nlink > 1) {
        throw new ArchiveError(`unsupported entry in 0.x data (hard link): ${relative}`);
      }
      listing.files.push(relative);
      return;
    }
    if (!stat.isDirectory()) {
      throw new ArchiveError(
        `unsupported entry in 0.x data (symlink or special file): ${relative}`,
      );
    }
    listing.dirs.push(relative);
    for (const name of fs.readdirSync(absolute).sort()) visit(path.join(relative, name));
  };
  detectLegacy(dataDir).forEach(visit);
  return listing;
}

function hashListing(dataDir: string, { files, dirs }: Listing): LegacyInventory {
  return {
    files: files.map((file) => {
      const bytes = fs.readFileSync(path.join(dataDir, file));
      return { path: file, size: bytes.length, sha256: sha256hex(bytes) };
    }),
    dirs,
  };
}

/** Passo 2 e passo 5 de D-14: a mesma checagem roda antes de gerar o pacote e de novo antes de apagar. */
function assertNoLiveLegacy(dataDir: string, files: string[], options: ArchiveOptions): void {
  assertNoLiveServer(options.libDir, options.procDir ?? '/proc');
  files
    .filter((file) => file.endsWith(LEGACY_LOCK_HOLDER_SUFFIX))
    .forEach((holder) => assertLockHolderDead(path.join(dataDir, holder)));
}

function assertNoLiveServer(libDir: string, procDir: string): void {
  const pids = listPids(procDir);
  // `libDir` cru e resolvido (uma vez, fora do laço): o `cmdline` pode citar o caminho por qualquer um dos dois.
  const serverPrefixes = [libDir, realpathOrSelf(libDir)].map((dir) => path.join(dir, '0.'));
  const live = pids.find((pid) =>
    readCmdline(procDir, pid).some(
      (arg) =>
        path.basename(arg) === 'server.mjs' &&
        serverPrefixes.some((prefix) => arg.startsWith(prefix)),
    ),
  );
  if (isNotNil(live)) {
    throw new ArchiveError(
      `a 0.x server is running (pid ${live}); close every Claude Code session and retry`,
    );
  }
}

/** `libDir` pode não existir (nada instalado ainda): o `realpath` falha e vale o caminho lexical. */
function realpathOrSelf(dir: string): string {
  try {
    return fs.realpathSync(dir);
  } catch {
    return dir;
  }
}

function listPids(procDir: string): string[] {
  const unconfirmed = (): ArchiveError =>
    new ArchiveError(`cannot confirm that no 0.x server is running: ${procDir} is not readable`);
  let entries: string[];
  try {
    entries = fs.readdirSync(procDir);
  } catch {
    throw unconfirmed();
  }
  const pids = entries.filter((name) => /^\d+$/.test(name));
  if (pids.length === 0) throw unconfirmed();
  return pids;
}

/**
 * Processo que some entre o `readdir` e a leitura, ou que o `hidepid` esconde (`EPERM`/`EACCES`),
 * não é servidor que possamos ver: o 0.x do dono roda no mesmo uid e é legível. Outro errno
 * (`EIO`, `EMFILE`...) não deixa confirmar que nenhum servidor roda.
 */
function readCmdline(procDir: string, pid: string): string[] {
  const file = path.join(procDir, pid, 'cmdline');
  try {
    return fs.readFileSync(file, 'utf8').split('\0');
  } catch (error) {
    const code = errnoCode(error);
    if (isNotNil(code) && UNSEEN_PROCESS_ERRNO.has(code)) return [];
    throw new ArchiveError(
      `cannot confirm that no 0.x server is running: cannot read ${file} (${code ?? 'unknown error'})`,
    );
  }
}

/** O holder do 0.x (o `createLock` do log 0.x) é `<pid>-<hex>`; holder ausente ou de 0 byte é lock criado e nunca preenchido. */
function assertLockHolderDead(holderFile: string): void {
  let token: string;
  try {
    token = fs.readFileSync(holderFile, 'utf8');
  } catch (error) {
    if (errnoCode(error) === 'ENOENT') return;
    throw error;
  }
  if (token === '') return;

  const pid = Number(/^(\d+)-/.exec(token)?.[1]);
  const lockDir = path.dirname(holderFile);
  if (!Number.isInteger(pid) || pid < 1 || pid > INT32_MAX) {
    throw new ArchiveError(
      `cannot confirm that the 0.x lock is dead, unreadable holder: ${holderFile}; ` +
        `with every Claude Code session closed, remove ${lockDir} by hand and retry`,
    );
  }
  if (isPidAlive(pid)) {
    throw new ArchiveError(
      `a 0.x lock is held by a live process (pid ${pid}): ${holderFile}; ` +
        `if every Claude Code session is closed the pid was reused: remove ${lockDir} by hand and retry`,
    );
  }
}

/** `<sha256>  <path>` de cada arquivo, ordenado: a conferência 1:1 do pacote contra a lista. */
function signatures(entries: { path: string; sha256: string }[]): string[] {
  return entries.map((entry) => `${entry.sha256}  ${entry.path}`).sort();
}

/** Relê o `.tar` com o parser do `tar` e devolve a assinatura dos arquivos regulares; diretórios não entram. */
function readPackage(tarFile: string): string[] {
  const entries: { path: string; sha256: string }[] = [];
  tar.list({
    file: tarFile,
    sync: true,
    onReadEntry: (entry) => {
      if (entry.type !== 'File') return;
      const hash = createHash('sha256');
      entry.on('data', (chunk: Buffer) => hash.update(chunk));
      entry.on('end', () => entries.push({ path: entry.path, sha256: hash.digest('hex') }));
    },
  });
  return signatures(entries);
}

/** Retomada (D-14 passo 4): o `.tar` mais novo que contém todo arquivo restante com o mesmo sha256. */
function findReusablePackage(archiveDir: string, files: LegacyFile[]): string | undefined {
  let names: string[];
  try {
    names = fs.readdirSync(archiveDir);
  } catch (error) {
    if (errnoCode(error) === 'ENOENT') return undefined;
    throw error;
  }
  const wanted = signatures(files);
  return names
    .filter((name) => TAR_NAME.test(name))
    .sort()
    .reverse()
    .map((name) => path.join(archiveDir, name))
    .find((tarFile) => {
      return isSubset(readPackage(tarFile), wanted);
    });
}

function createPackage(dataDir: string, files: LegacyFile[], now: () => Date): string {
  const archiveDir = path.join(dataDir, ARCHIVE_DIR);
  fs.mkdirSync(archiveDir, { recursive: true, mode: 0o700 });
  for (const name of fs.readdirSync(archiveDir)) {
    if (name.endsWith(PARTIAL_SUFFIX)) fs.rmSync(path.join(archiveDir, name), { force: true });
  }

  const stamp = now()
    .toISOString()
    .replace(/[-:]|\.\d{3}/g, '');
  const tarPath = path.join(archiveDir, `hexlog-0x-${stamp}.tar`);
  const partial = `${tarPath}.partial`;
  tar.create(
    { file: partial, cwd: dataDir, sync: true, portable: true, mode: 0o600 },
    files.map((file) => file.path),
  );
  fsyncPath(partial);

  if (!isEqual(readPackage(partial), signatures(files))) {
    fs.rmSync(partial, { force: true });
    throw new ArchiveError('the 0.x package does not match the listed files; nothing was removed');
  }
  // ponytail: o nome tem resolução de segundo; um segundo arquivamento no mesmo segundo que precise de
  // pacote novo sobrescreve o `.tar` anterior, que pode guardar arquivos já apagados (teto aceito em
  // 2026-09-30: a checagem de servidor vivo e a retomada tornam o caso remoto). Melhoria: `linkSync`
  // exclusivo com sufixo `-<n>`.
  fs.renameSync(partial, tarPath);
  fsyncPath(archiveDir);
  return tarPath;
}

/** Remove só o que está na lista: arquivos, depois diretórios do mais fundo ao mais raso, sem recursão. */
function removeListed(dataDir: string, { files, dirs }: LegacyInventory): void {
  for (const file of files) fs.unlinkSync(path.join(dataDir, file.path));

  const depth = (dir: string): number => dir.split(path.sep).length;
  for (const dir of [...dirs].sort((a, b) => depth(b) - depth(a))) {
    try {
      fs.rmdirSync(path.join(dataDir, dir));
    } catch (error) {
      const code = errnoCode(error);
      if (code !== 'ENOTEMPTY' && code !== 'EEXIST') throw error;
      throw new ArchiveError(`0.x directory did not empty (a new file appeared): ${dir}`);
    }
  }
  fsyncPath(dataDir);
}
