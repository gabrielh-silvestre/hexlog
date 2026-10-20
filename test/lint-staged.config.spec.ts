import { describe, expect, it } from '@jest/globals';
import path from 'node:path';
import config from '../lint-staged.config.ts';

type Task = string | ((files: readonly string[]) => string | string[]);

const abs = (file: string): string => path.resolve(file);
const mirror = (...files: string[]): string | string[] => {
  const tasks = config['*.ts'] as Task[];
  const task = tasks.at(-1);
  if (typeof task !== 'function') throw new Error('mirror task missing');
  return task(files.map(abs));
};
const patternsOf = (command: string | string[]): RegExp[] => {
  const text = [command].flat().join(' ');
  return [...text.matchAll(/'([^']+)'/g)].map((match) => new RegExp(match[1] ?? ''));
};
const matchesAny = (patterns: RegExp[], file: string): boolean =>
  patterns.some((pattern) => pattern.test(abs(file)));

describe('lint-staged config', () => {
  it('should fix, format, typecheck and run the mirror specs in sequence for .ts', () => {
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

  it('should map src/x/y.ts to the spec and the property spec of the same folder', () => {
    const patterns = patternsOf(mirror('src/domain/inheritance.ts'));

    expect(matchesAny(patterns, 'test/domain/inheritance.spec.ts')).toBe(true);
    expect(matchesAny(patterns, 'test/domain/inheritance.property.spec.ts')).toBe(true);
    expect(matchesAny(patterns, 'test/domain/inheritance-extra.spec.ts')).toBe(false);
    expect(matchesAny(patterns, 'test/queries/inheritance.spec.ts')).toBe(false);
  });

  it('should map a file outside src/ to the root of test/', () => {
    const patterns = patternsOf(mirror('scripts/export.ts', '.claude/hooks/flow-hooks.ts'));

    expect(matchesAny(patterns, 'test/export.spec.ts')).toBe(true);
    expect(matchesAny(patterns, 'test/flow-hooks.spec.ts')).toBe(true);
    expect(matchesAny(patterns, 'test/flowXhooks.spec.ts')).toBe(false);
  });

  it('should run a staged spec itself and nothing for a staged helper', () => {
    expect(matchesAny(patternsOf(mirror('test/export.spec.ts')), 'test/export.spec.ts')).toBe(true);
    expect(mirror('test/helpers.ts')).toEqual([]);
  });

  it('should pass the command with --passWithNoTests so a file without a mirror exits 0', () => {
    expect(mirror('src/server.ts')).toEqual([expect.stringContaining('--passWithNoTests')]);
  });
});
