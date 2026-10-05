import * as fs from 'node:fs';
import * as path from 'node:path';

/** Falha a execução se algum teste deixou algo no `TMPDIR` da suíte (criado pelo `global-setup.ts`) e o apaga. */
export default function teardown(): void {
  const suiteDir = process.env.TMPDIR;
  // o prefixo protege contra apagar um `TMPDIR` real caso o setup não tenha rodado
  if (suiteDir === undefined || !path.basename(suiteDir).startsWith('hexlog-suite-')) return;
  if (!fs.existsSync(suiteDir)) return;
  const leftovers = fs.readdirSync(suiteDir);
  fs.rmSync(suiteDir, { recursive: true, force: true });
  if (leftovers.length > 0) {
    throw new Error(`temporary directories left behind by the suite: ${leftovers.join(', ')}`);
  }
}
