import { randomBytes } from 'node:crypto';
// Import padrão, não `import * as fs`: ver "Common Patterns" em `src/AGENTS.md`.
import fs from 'node:fs';
import * as path from 'node:path';

/** O `code` de um erro do fs (`ENOENT`, `EEXIST`...); `undefined` se `error` não traz um. */
export function errnoCode(error: unknown): string | undefined {
  return typeof error === 'object' && error !== null && 'code' in error
    ? String(error.code)
    : undefined;
}

export type WriteFileAtomicOptions = {
  /** `true`: não sobrescreve. Se `file` já existe, lança o `EEXIST` do `linkSync`, sem empacotar. */
  exclusive?: boolean;
  /** `true`: dá `fsync` no diretório depois de publicar o arquivo, para o nome sobreviver a queda de energia. */
  fsyncDir?: boolean;
};

/**
 * Grava `content` em `file` atomicamente: temporário no mesmo diretório, `fsync` do arquivo,
 * depois `rename` (substitui) ou `link` (exclusivo, vence quem chega primeiro). Nunca deixa
 * `file` pela metade, e o temporário é removido com sucesso ou com falha.
 * Erros de I/O saem crus (`ErrnoException`); mapeá-los para `IO_ERROR` cabe ao chamador.
 * `ponytail:` só Linux: `exclusive` depende de hard link (`linkSync`) e `fsyncDir` de `fsync` de
 * diretório, então FAT, exFAT, drvfs (`/mnt/c` no WSL) e Windows ficam fora; macOS não foi testado.
 */
export function writeFileAtomic(
  file: string,
  content: string | Uint8Array,
  { exclusive = false, fsyncDir = false }: WriteFileAtomicOptions = {},
): void {
  const dir = path.dirname(file);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });

  const tmp = path.join(
    dir,
    `.${path.basename(file)}.${process.pid}.${randomBytes(8).toString('hex')}`,
  );
  try {
    writeSynced(tmp, content);
    if (exclusive) fs.linkSync(tmp, file);
    else fs.renameSync(tmp, file);
    if (fsyncDir) fsyncDirectory(dir);
  } finally {
    fs.rmSync(tmp, { force: true });
  }
}

/** Cria `file` (`wx`, 0o600), grava `content` e dá `fsync`; quem precisa de conteúdo durável num arquivo novo reusa. */
export function writeSynced(file: string, content: string | Uint8Array): void {
  const fd = fs.openSync(file, 'wx', 0o600);
  try {
    fs.writeFileSync(fd, content);
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
}

/** `fsync` de um diretório (ou de qualquer caminho abrível em leitura); `archive.ts` reusa. */
export function fsyncDirectory(dir: string): void {
  const fd = fs.openSync(dir, 'r');
  try {
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
}
