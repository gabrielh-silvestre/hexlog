// Slug do trabalho e caminho do marcador do pré-PR. Só builtins do Node: o hook de
// `.claude/hooks/flow-hooks.ts` importa este arquivo e roda em worktree sem `node_modules`. É o
// único lugar do algoritmo do slug e do caminho do `.ok`.
import { spawnSync } from 'node:child_process';
import * as path from 'node:path';

const SLUG_MAX = 63;
const RESERVED_SLUGS = new Set(['main', 'develop']);
const LONG_LIVED_SLUG = /^(directives|audits)(-[0-9]+)?$/;
const MARKER_DIR = 'hexlog-flow';

/** Slug de uma branch (nome do processo do trabalho); lança se vazio ou reservado. */
export function slugOf(branch: string): string {
  const slug = branch
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, SLUG_MAX)
    .replace(/-+$/, '');
  if (slug === '') throw new Error(`branch "${branch}" yields an empty slug`);
  if (RESERVED_SLUGS.has(slug) || LONG_LIVED_SLUG.test(slug)) {
    throw new Error(`branch "${branch}" yields the reserved process name "${slug}"`);
  }
  return slug;
}

/** `git <args>` em `cwd`; devolve a saída sem a quebra final, ou `undefined` se o git sair não-zero. */
export function tryGit(cwd: string, args: string[]): string | undefined {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8' });
  if (result.error) throw result.error;
  return result.status === 0 ? result.stdout.trimEnd() : undefined;
}

export function git(cwd: string, args: string[]): string {
  const output = tryGit(cwd, args);
  if (output === undefined) throw new Error(`git ${args.join(' ')} failed in ${cwd}`);
  return output;
}

export const currentBranch = (cwd: string): string => git(cwd, ['symbolic-ref', '--short', 'HEAD']);

export const markerPath = (cwd: string, slug: string): string =>
  path.join(
    git(cwd, ['rev-parse', '--path-format=absolute', '--git-common-dir']),
    MARKER_DIR,
    `${slug}.ok`,
  );
