// Grava o marcador do pré-PR de um trabalho: `node scripts/flow/mark.ts <slug>`. Só grava com os
// gates `pre-pr` e `gaps` verdes (`gate.ts`), então precisa de `node_modules`, ao contrário do hook.
// Quem chama é a skill `flow-run`. Recusa sem gravar nada: exit 1, ou 2 quando o dado do hexlog está
// ilegível (`LEGACY_DATA`, `PROCESS_CORRUPTED`; `cli-error.ts#formatCliError`). Só age como CLI:
// importar o módulo não grava nada (guard `import.meta.main`, como o `gate.ts`).
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

function main(argv: string[]): number {
  try {
    mark(argv[0]);
    return 0;
  } catch (error) {
    if (error instanceof HexlogError) {
      const { text, exitCode } = formatCliError('hexlog flow mark', error);
      process.stderr.write(`${text}\n`);
      return exitCode;
    }
    process.stderr.write(
      `hexlog flow: ${error instanceof Error ? error.message : String(error)}\n`,
    );
    return 1;
  }
}

// eslint-disable-next-line n/no-unsupported-features/node-builtins -- engine >=24.18.1 já suporta import.meta.main, plugin n ainda marca como experimental
if (import.meta.main) process.exitCode = main(process.argv.slice(2));
