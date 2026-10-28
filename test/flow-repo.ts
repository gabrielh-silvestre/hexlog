import { expect } from '@jest/globals';
import { spawnSync, type SpawnSyncReturns } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { createTempDir } from './helpers.ts';

export const repoRoot = path.resolve(__dirname, '..');
export const hookPath = path.join(repoRoot, '.claude/hooks/flow-hooks.ts');
export const flowPath = path.join(repoRoot, 'scripts/flow/flow.ts');
export const markPath = path.join(repoRoot, 'scripts/flow/mark.ts');

export const MCP_CREATE = 'mcp__github-official__create_pull_request';
export const MCP_UPDATE = 'mcp__github-official__update_pull_request';
const ORIGIN_URL = 'git@github.com:acme/widgets.git';

export const NO_MARKER = /no valid pre-PR marker/;

export type RunResult = SpawnSyncReturns<string>;

type RunOptions = { input?: string; cwd?: string; env?: NodeJS.ProcessEnv };

/** Roda um script `.ts` do repositório no Node, sem shell. */
export function runNode(script: string, args: string[], options: RunOptions = {}): RunResult {
  return spawnSync(process.execPath, [script, ...args], {
    input: options.input ?? '',
    cwd: options.cwd ?? repoRoot,
    env: options.env,
    encoding: 'utf8',
  });
}

export function git(cwd: string, ...args: string[]): string {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8' });
  if (result.status !== 0) throw new Error(`git ${args.join(' ')}: ${result.stderr}`);
  return result.stdout.trim();
}

/**
 * Repositório temporário: checkout principal em `feat/x`, worktree real em `feat/y`.
 * `refs/remotes/origin/*` é criado à mão com `update-ref`, sem rede. O estado fica aqui porque
 * o lint exige o hook dentro de `describe`, então cada alvo chama `createRepo` no seu `beforeAll`.
 */
export const repoState = { repo: '', worktree: '', baseSha: '', tipSha: '', markerDir: '' };

export function createRepo(): void {
  const root = createTempDir('flow-hooks');
  const repo = path.join(root, 'repo');
  const worktree = path.join(root, 'wt');
  fs.mkdirSync(repo);
  git(repo, 'init', '-q', '-b', 'main');
  git(repo, 'config', 'user.email', 'test@example.com');
  git(repo, 'config', 'user.name', 'Test');
  git(repo, 'commit', '-q', '--allow-empty', '-m', 'base');
  const baseSha = git(repo, 'rev-parse', 'HEAD');
  git(repo, 'checkout', '-q', '-b', 'feat/x');
  git(repo, 'commit', '-q', '--allow-empty', '-m', 'work');
  const tipSha = git(repo, 'rev-parse', 'HEAD');
  git(repo, 'remote', 'add', 'origin', ORIGIN_URL);
  git(repo, 'branch', 'feat/y', 'feat/x');
  git(repo, 'worktree', 'add', '-q', worktree, 'feat/y');
  fs.mkdirSync(path.join(repo, 'sub'));
  Object.assign(repoState, {
    repo,
    worktree,
    baseSha,
    tipSha,
    markerDir: path.join(repo, '.git', 'hexlog-flow'),
  });
}

export function resetRepo(): void {
  fs.rmSync(repoState.markerDir, { recursive: true, force: true });
  git(repoState.repo, 'remote', 'set-url', 'origin', ORIGIN_URL);
}

export function dropOriginRef(): void {
  git(repoState.repo, 'update-ref', '-d', 'refs/remotes/origin/feat/x');
}

export const runHook = (args: string[], options: RunOptions = {}): RunResult =>
  runNode(hookPath, args, { cwd: repoState.repo, ...options });

export function preHook(toolName: string, toolInput: object, cwd = repoState.repo): RunResult {
  return runHook(['pre-pr'], {
    input: JSON.stringify({ tool_name: toolName, tool_input: toolInput, cwd }),
  });
}

export const bash = (command: string, cwd = repoState.repo): RunResult =>
  preHook('Bash', { command }, cwd);

export const mcpCreate = (head: string, extra: object = {}, cwd = repoState.repo): RunResult =>
  preHook(MCP_CREATE, { owner: 'acme', repo: 'widgets', head, base: 'main', ...extra }, cwd);

export function writeMarker(branch: string, sha: string): void {
  fs.mkdirSync(repoState.markerDir, { recursive: true });
  const slug = runNode(flowPath, ['slug', branch]).stdout.trim();
  fs.writeFileSync(path.join(repoState.markerDir, `${slug}.ok`), `${branch}\n${sha}\n`);
}

export function expectDenied(result: RunResult, message: RegExp): void {
  expect(result.status).toBe(2);
  expect(result.stderr).toMatch(message);
}

export function expectAllowed(result: RunResult): void {
  expect(result.status).toBe(0);
  expect(result.stderr).toBe('');
}
