// Grava o marcador do pré-PR de um trabalho: `node scripts/flow/mark.ts <slug>`. Só builtins do
// Node. Recusa com exit 1 (quem chama é a skill `flow-run`) e não grava nada.
import * as fs from 'node:fs';
import * as path from 'node:path';
import { currentBranch, git, markerPath, slugOf } from './marker.ts';

/** Grava o marcador do pré-PR de `slug`, se a árvore está limpa e a branch atual gera esse slug. */
function mark(slug: string | undefined): void {
  const cwd = process.cwd();
  const branch = currentBranch(cwd);
  if (slugOf(branch) !== slug) throw new Error(`branch "${branch}" does not yield slug "${slug}"`);
  if (git(cwd, ['status', '--porcelain']) !== '') throw new Error('working tree is not clean');
  const file = markerPath(cwd, slug);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${branch}\n${git(cwd, ['rev-parse', 'HEAD'])}\n`);
}

try {
  mark(process.argv[2]);
} catch (error) {
  process.stderr.write(`hexlog flow: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
}
