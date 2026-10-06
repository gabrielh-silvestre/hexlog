import { randomBytes } from 'node:crypto';
// Import padrão, não `import * as fs`: ver `docs/directives/convencoes.md`, seção "Import padrão de fs".
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
 * `ponytail:` um kill entre o temporário e o `rename`/`link` deixa o temporário órfão na pasta
 * (nenhuma rotina o varre), e `fsyncDir` sincroniza só a pasta folha, não os pais que o `mkdir`
 * criou. Teto aceito; melhoria: varrer temporários antigos e dar `fsync` na cadeia de pais criados.
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
    if (fsyncDir) fsyncPath(dir);
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

/** `fsync` de um arquivo ou diretório (qualquer caminho abrível em leitura); `archive.ts` reusa. */
export function fsyncPath(target: string): void {
  const fd = fs.openSync(target, 'r');
  try {
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
}
