import { jest } from '@jest/globals';
// Import padrão (não `* as fs`): o spy só intercepta o mesmo objeto que os módulos de `adapters/fs/` usam.
import fs from 'node:fs';

/**
 * Espia `fs.renameSync` com passagem para o real; `intercept` roda antes de cada rename e pode lançar
 * ou mexer no disco. Quem chama restaura no `afterEach` (`jest.restoreAllMocks`).
 */
export function spyOnRename(intercept: (from: string, to: string) => void = () => undefined) {
  const realRename = fs.renameSync;
  return jest.spyOn(fs, 'renameSync').mockImplementation((from, to) => {
    intercept(String(from), String(to));
    realRename(from, to);
  });
}

/** Espia `fs.openSync` com passagem para o real; `onOpen` vê o caminho de cada abertura. */
export function spyOnOpen(onOpen: (file: string) => void) {
  const realOpen = fs.openSync;
  return jest.spyOn(fs, 'openSync').mockImplementation((file, flags, mode) => {
    onOpen(String(file));
    return realOpen(file, flags, mode);
  });
}
