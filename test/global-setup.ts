import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

/**
 * Isola o `TMPDIR` da execução num `hexlog-suite-*`: os workers herdam a variável, então
 * `os.tmpdir()` aponta para lá e o `global-teardown.ts` enxerga qualquer diretório que sobrar.
 */
export default function setup(): void {
  process.env.TMPDIR = fs.mkdtempSync(path.join(os.tmpdir(), 'hexlog-suite-'));
}
