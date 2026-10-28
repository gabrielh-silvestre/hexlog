import fs from 'node:fs';
import * as path from 'node:path';
import { describe, expect, it } from '@jest/globals';

const HOOK = path.resolve(__dirname, '..', '.husky', 'pre-commit');

describe('.husky/pre-commit', () => {
  it('should run lint-staged with one task group at a time', () => {
    const hook = fs.readFileSync(HOOK, 'utf8');

    expect(hook).toContain('lint-staged --concurrent false');
  });
});
