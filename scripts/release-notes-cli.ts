// CLI do `release.yml`: imprime o corpo do Release da versão pedida.
// Uso: node scripts/release-notes-cli.ts <version> [--pr <number> --repo <owner/repo>]
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { releaseNotes } from './release-notes.ts';

const USAGE = 'usage: release-notes-cli.ts <version> [--pr <number> --repo <owner/repo>]';

const REPO_PATTERN = /^[\w.-]+\/[\w.-]+$/;

function main(): void {
  const { values, positionals } = parseArgs({
    args: process.argv.slice(2),
    options: { pr: { type: 'string' }, repo: { type: 'string' } },
    allowPositionals: true,
    strict: true,
  });
  const [version] = positionals;
  const { pr: prNumber, repo } = values;
  const withPr = prNumber !== undefined && prNumber !== '';
  if (version === undefined || positionals.length > 1) throw new Error(USAGE);
  // --repo vem sempre com --pr (o `release.yml` passa os dois, --pr pode ser vazio)
  if (repo !== undefined && (prNumber === undefined || !REPO_PATTERN.test(repo))) {
    throw new Error(USAGE);
  }
  if (withPr && (!/^\d+$/.test(prNumber) || repo === undefined)) throw new Error(USAGE);
  const changelog = readFileSync(resolve(import.meta.dirname, '..', 'CHANGELOG.md'), 'utf8');
  const pr = withPr
    ? { number: Number(prNumber), url: `https://github.com/${repo}/pull/${prNumber}` }
    : undefined;
  process.stdout.write(releaseNotes(changelog, version, pr));
}

try {
  main();
} catch (error) {
  process.stderr.write(
    `release-notes failed: ${error instanceof Error ? error.message : String(error)}\n`,
  );
  process.exitCode = 1;
}
