// Grava o marcador do pré-PR de um trabalho: `node scripts/flow/mark.ts <slug>`. Só grava com os
// gates `pre-pr` e `gaps` verdes (`gate.ts`), então precisa de `node_modules`, ao contrário do hook.
// Recusa com exit 1 (quem chama é a skill `flow-run`) e não grava nada.
import * as fs from 'node:fs';
import * as path from 'node:path';
import { HexlogError } from '../../src/errors.ts';
import { formatCliError, openReadOnly } from '../cli-error.ts';
import { describeFailures, gateFailures } from './gate.ts';
import { currentBranch, git, markerPath, slugOf } from './marker.ts';

/** Grava o marcador do pré-PR de `slug`, se a branch atual gera esse slug e os gates estão verdes. */
function mark(slug: string | undefined): void {
  const cwd = process.cwd();
  const branch = currentBranch(cwd);
  if (slugOf(branch) !== slug) throw new Error(`branch "${branch}" does not yield slug "${slug}"`);
  const failures = gateFailures(openReadOnly(), slug);
  if (failures.length > 0) throw new Error(`gates are not green\n${describeFailures(failures)}`);
  const file = markerPath(cwd, slug);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${branch}\n${git(cwd, ['rev-parse', 'HEAD'])}\n`);
}

try {
  mark(process.argv[2]);
} catch (error) {
  if (error instanceof HexlogError) {
    const { text, exitCode } = formatCliError('hexlog flow mark', error);
    process.stderr.write(`${text}\n`);
    process.exitCode = exitCode;
  } else {
    process.stderr.write(
      `hexlog flow: ${error instanceof Error ? error.message : String(error)}\n`,
    );
    process.exitCode = 1;
  }
}
