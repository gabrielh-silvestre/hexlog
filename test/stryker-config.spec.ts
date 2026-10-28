import fs from 'node:fs';
import * as path from 'node:path';
import { describe, expect, it } from '@jest/globals';
import { z } from 'zod';
import { parseJson } from './helpers.ts';

const repoRoot = path.resolve(__dirname, '..');
const ROOT_DIR_PREFIX = '<rootDir>/';

const StrykerConfig = z.object({
  mutate: z.array(z.string()),
  jest: z.object({ config: z.object({ testMatch: z.array(z.string()) }) }),
});

const config = parseJson(
  StrykerConfig,
  fs.readFileSync(path.join(repoRoot, 'stryker.config.json'), 'utf8'),
);

const missing = (paths: readonly string[]) =>
  paths.filter((file) => !fs.existsSync(path.join(repoRoot, file)));

describe('stryker.config.json', () => {
  it('should list only mutate paths that exist', () => {
    expect(missing(config.mutate)).toEqual([]);
  });

  it('should list only testMatch paths that exist', () => {
    const specs = config.jest.config.testMatch.map((spec) => spec.replace(ROOT_DIR_PREFIX, ''));

    expect(missing(specs)).toEqual([]);
  });
});
