import * as fs from 'node:fs';
import { afterAll } from '@jest/globals';

// Este arquivo roda antes de todo spec (`setupFilesAfterEnv`) e só importa `node:fs`: carregar
// `helpers.ts` aqui puxaria `src/` para o registro de módulos antes do `jest.mock` dos specs.
const createdTempDirs = new Set<string>();

/** Registra `dir` para ser apagado no `afterAll` do arquivo de spec; chamado por `helpers.ts#createTempDir`. */
export function registerTempDir(dir: string): void {
  createdTempDirs.add(dir);
}

// `afterAll` roda também quando há teste vermelho, então o diretório não vaza na falha. Ele roda
// antes do `afterAll` do próprio spec, que por isso não lê diretório criado por `createTempDir`.
afterAll(() => {
  for (const dir of createdTempDirs) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
  createdTempDirs.clear();
});
