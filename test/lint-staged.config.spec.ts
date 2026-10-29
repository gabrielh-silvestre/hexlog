import { describe, expect, it } from '@jest/globals';
import path from 'node:path';
import config from '../lint-staged.config.ts';

type Task = string | ((files: readonly string[]) => string | string[]);

const abs = (file: string): string => path.resolve(file);
const staged = (...files: string[]): string | string[] => {
  const tasks = config['*.ts'] as Task[];
  const task = tasks.at(-1);
  if (typeof task !== 'function') throw new Error('staged-specs task missing');
  return task(files.map(abs));
};
const patternsOf = (command: string | string[]): RegExp[] => {
  const text = [command].flat().join(' ');
  return [...text.matchAll(/'([^']+)'/g)].map((match) => new RegExp(match[1] ?? ''));
};
const matchesAny = (patterns: RegExp[], file: string): boolean =>
  patterns.some((pattern) => pattern.test(abs(file)));
/** Se o comando para o arquivo em stage `file` roda o `spec`. */
const stagedMatches = (file: string, spec: string): boolean =>
  matchesAny(patternsOf(staged(file)), spec);

describe('lint-staged config', () => {
  it('should fix, format, typecheck and run the staged specs in sequence for .ts', () => {
    const tasks = config['*.ts'] as Task[];

    expect(tasks.slice(0, 2)).toEqual(['eslint --fix', 'prettier --write']);
    expect((tasks[2] as () => string)()).toBe('npm run typecheck');
  });

  it('should lint, spell-check and run the doc specs in sequence for .md', () => {
    const tasks = config['*.md'] as Task[];

    expect(tasks.slice(0, 2)).toEqual([
      'markdownlint-cli2',
      'cspell --no-progress --no-must-find-files',
    ]);
    expect((tasks[2] as () => string)()).toBe(
      'npm test -- test/directives.spec.ts test/skill-coherence.spec.ts',
    );
  });

  it('should map src/x/y.ts to the spec and the property spec of the same name', () => {
    const patterns = patternsOf(staged('src/domain/inheritance.ts'));

    expect(matchesAny(patterns, 'test/domain/inheritance.spec.ts')).toBe(true);
    expect(matchesAny(patterns, 'test/domain/inheritance.property.spec.ts')).toBe(true);
    expect(matchesAny(patterns, 'test/queries/inheritance-extra.spec.ts')).toBe(false);
  });

  it('should find the spec by name in any folder of test/', () => {
    const patterns = patternsOf(staged('src/adapters/fs/lock.ts'));

    expect(matchesAny(patterns, 'test/adapters/lock.spec.ts')).toBe(true);
    expect(matchesAny(patterns, 'test/lock.spec.ts')).toBe(true);
    expect(matchesAny(patterns, 'test/adapters/unlock.spec.ts')).toBe(false);
  });

  it('should map a file outside src/ to the spec of the same name', () => {
    const patterns = patternsOf(staged('scripts/export.ts', '.claude/hooks/flow-hooks.ts'));

    expect(matchesAny(patterns, 'test/export.spec.ts')).toBe(true);
    expect(matchesAny(patterns, 'test/flow-hooks.spec.ts')).toBe(true);
    expect(matchesAny(patterns, 'test/flowXhooks.spec.ts')).toBe(false);
  });

  it('should run a staged spec itself', () => {
    expect(stagedMatches('test/export.spec.ts', 'test/export.spec.ts')).toBe(true);
  });

  it('should run no spec of its own for a staged helper', () => {
    expect(stagedMatches('test/helpers.ts', 'test/helpers.spec.ts')).toBe(false);
  });

  it('should always run the core, even for a file without a spec', () => {
    const patterns = patternsOf(staged('scripts/timeline.ts'));

    expect(matchesAny(patterns, 'test/domain/chain.spec.ts')).toBe(true);
    expect(matchesAny(patterns, 'test/shared/loader.spec.ts')).toBe(true);
    expect(matchesAny(patterns, 'test/commands/register.spec.ts')).toBe(true);
    expect(matchesAny(patterns, 'test/commands/register-state.spec.ts')).toBe(true);
    expect(matchesAny(patterns, 'test/commands/define.spec.ts')).toBe(false);
  });

  it('should pass the command with --passWithNoTests so a file without a spec exits 0', () => {
    expect(staged('src/server.ts')).toContain('--passWithNoTests');
  });
});
