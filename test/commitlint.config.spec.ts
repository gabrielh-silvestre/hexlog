import { spawnSync } from 'node:child_process';
import * as path from 'node:path';
import { describe, expect, it } from '@jest/globals';

const ROOT = path.resolve(__dirname, '..');
const COMMITLINT = path.join(ROOT, 'node_modules', '.bin', 'commitlint');
const CLI_TIMEOUT = 30_000;

const lint = (message: string): { status: number | null; output: string } => {
  const result = spawnSync(COMMITLINT, [], {
    cwd: ROOT,
    input: message,
    encoding: 'utf8',
    timeout: CLI_TIMEOUT,
  });
  return { status: result.status, output: result.stdout + result.stderr };
};

describe('commitlint.config.js', () => {
  it(
    'should accept a conventional header without a body',
    () => {
      expect(lint('fix(hook): deny the glob escape').status).toBe(0);
    },
    CLI_TIMEOUT,
  );

  it(
    'should reject a header that is not conventional',
    () => {
      const result = lint('update the hook');

      expect(result.status).not.toBe(0);
      expect(result.output).toContain('type-empty');
    },
    CLI_TIMEOUT,
  );

  it(
    'should reject a header of 81 characters and accept one of 80',
    () => {
      const header = (length: number): string => `fix: ${'x'.repeat(length - 5)}`;

      expect(lint(header(80)).status).toBe(0);
      const result = lint(header(81));
      expect(result.status).not.toBe(0);
      expect(result.output).toContain('header-max-length');
    },
    CLI_TIMEOUT * 2,
  );

  it(
    'should reject a commit with a body',
    () => {
      const result = lint('fix: a change\n\nwhy it changed');

      expect(result.status).not.toBe(0);
      expect(result.output).toContain('body-empty');
    },
    CLI_TIMEOUT,
  );

  it(
    'should accept the Dependabot commit identified by its Signed-off-by footer',
    () => {
      const message = [
        'Bump zod from 4.0.0 to 4.0.1',
        '',
        'Release notes and a long body outside the rule.',
        '',
        'Signed-off-by: dependabot[bot] <support@github.com>',
      ].join('\n');

      expect(lint(message).status).toBe(0);
    },
    CLI_TIMEOUT,
  );

  it(
    'should still reject a body with another Signed-off-by footer',
    () => {
      const message = 'fix: a change\n\nwhy it changed\n\nSigned-off-by: someone <a@b.c>';

      expect(lint(message).status).not.toBe(0);
    },
    CLI_TIMEOUT,
  );
});
