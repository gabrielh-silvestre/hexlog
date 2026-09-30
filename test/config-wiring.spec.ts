import { describe, test, expect } from '@jest/globals';
import { spawnSync } from 'node:child_process';
import * as path from 'node:path';
import { z } from 'zod';
import { parseJson } from './helpers.ts';

const repoRoot = path.resolve(__dirname, '..');
const ERROR_SEVERITY = 2;

const RULES = ['no-restricted-imports', 'max-lines', 'no-restricted-syntax'];

const SeveritiesSchema = z.record(z.string(), z.number().nullable());

// O jest roda em CJS e não carrega o `eslint.config.js` (ESM): o ESLint real sobe num filho.
function severitiesFor(file: string): z.infer<typeof SeveritiesSchema> {
  const script = `
    import { ESLint } from 'eslint';
    const config = await new ESLint({ cwd: ${JSON.stringify(repoRoot)} }).calculateConfigForFile(${JSON.stringify(file)});
    const rules = ${JSON.stringify(RULES)};
    console.log(JSON.stringify(Object.fromEntries(rules.map((rule) => [rule, config.rules?.[rule]?.[0] ?? null]))));
  `;
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', script], {
    encoding: 'utf8',
    cwd: repoRoot,
  });
  expect(result.status).toBe(0);
  return parseJson(SeveritiesSchema, result.stdout);
}

// Prova que o `eslint.config.js` realmente inclui as travas: os specs de boundaries
// importam `boundaryBlocks` direto e não percebem se a config deixar de usá-los.
describe('fiação das travas no eslint.config.js', () => {
  test('src/commands: no-restricted-imports e max-lines em error', () => {
    expect(severitiesFor('src/commands/x.ts')).toMatchObject({
      'no-restricted-imports': ERROR_SEVERITY,
      'max-lines': ERROR_SEVERITY,
    });
  });

  test('src/mcp/kernel.ts: no-restricted-imports em error', () => {
    expect(severitiesFor('src/mcp/kernel.ts')).toMatchObject({
      'no-restricted-imports': ERROR_SEVERITY,
    });
  });

  test('test/**: no-restricted-syntax em error', () => {
    expect(severitiesFor('test/x.spec.ts')).toMatchObject({
      'no-restricted-syntax': ERROR_SEVERITY,
    });
  });
});
