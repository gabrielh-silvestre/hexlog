import { jest } from '@jest/globals';
// Import padrão (não `* as fs`): o spy de `fsyncSync` só intercepta o mesmo objeto que `atomic.ts` usa.
import fs from 'node:fs';

/** `fsync` dados até agora, separados pelo tipo do descritor: arquivo ou diretório. */
type FsyncCounts = { files: number; directories: number };

/**
 * Espia `fs.fsyncSync` com passagem para o real; `onFsync` vê cada descritor antes do `fsync`. Quem chama
 * restaura no `afterEach` (`jest.restoreAllMocks`), como os demais specs de adapters.
 */
export function spyOnFsync(onFsync: (fd: number) => void): void {
  const realFsync = fs.fsyncSync;
  jest.spyOn(fs, 'fsyncSync').mockImplementation((fd) => {
    onFsync(fd);
    realFsync(fd);
  });
}

/** Espia `fsync` e devolve a contagem corrente, separada por arquivo e diretório. */
export function countFsyncs(): () => FsyncCounts {
  const counts: FsyncCounts = { files: 0, directories: 0 };
  spyOnFsync((fd) => {
    counts[fs.fstatSync(fd).isDirectory() ? 'directories' : 'files'] += 1;
  });
  return () => ({ ...counts });
}

/** Conta só os `fsync` dados no arquivo `file` (pelo inode: o lock e o diretório não entram). */
export function countFsyncsOf(file: string): () => number {
  const ino = fs.statSync(file).ino;
  let count = 0;
  spyOnFsync((fd) => {
    if (fs.fstatSync(fd).ino === ino) count += 1;
  });
  return () => count;
}
