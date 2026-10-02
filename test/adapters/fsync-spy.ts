import { jest } from '@jest/globals';
// Import padrão (não `* as fs`): o spy de `fsyncSync` só intercepta o mesmo objeto que `atomic.ts` usa.
import fs from 'node:fs';

/** `fsync` dados até agora, separados pelo tipo do descritor: arquivo ou diretório. */
type FsyncCounts = { files: number; directories: number };

/**
 * Espia `fs.fsyncSync` com passagem para o real e devolve a contagem corrente. Quem chama restaura
 * no `afterEach` (`jest.restoreAllMocks`), como os demais specs de adapters.
 */
export function countFsyncs(): () => FsyncCounts {
  const realFsync = fs.fsyncSync;
  const counts: FsyncCounts = { files: 0, directories: 0 };
  jest.spyOn(fs, 'fsyncSync').mockImplementation((fd) => {
    counts[fs.fstatSync(fd).isDirectory() ? 'directories' : 'files'] += 1;
    realFsync(fd);
  });
  return () => ({ ...counts });
}
