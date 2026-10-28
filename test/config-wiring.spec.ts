import { beforeAll, describe, it, expect } from '@jest/globals';
import { spawnSync } from 'node:child_process';
import * as path from 'node:path';
import { z } from 'zod';
import { parseJson } from './helpers.ts';

const repoRoot = path.resolve(__dirname, '..');
const ERROR_SEVERITY = 2;
const ESLINT_TIMEOUT = 60_000;

const RULES = ['no-restricted-imports', 'max-lines', 'no-restricted-syntax'];
const FILES = ['src/commands/x.ts', 'src/mcp/kernel.ts', 'test/x.spec.ts'];

const SeveritiesSchema = z.record(z.string(), z.record(z.string(), z.number().nullable()));

// O jest roda em CJS e não carrega o `eslint.config.js` (ESM): o ESLint real sobe num filho, uma vez para todos os arquivos.
function severitiesByFile(): z.infer<typeof SeveritiesSchema> {
  const script = `
    import { ESLint } from 'eslint';
    const eslint = new ESLint({ cwd: ${JSON.stringify(repoRoot)} });
    const rules = ${JSON.stringify(RULES)};
    const files = ${JSON.stringify(FILES)};
    const entries = await Promise.all(files.map(async (file) => {
      const config = await eslint.calculateConfigForFile(file);
      return [file, Object.fromEntries(rules.map((rule) => [rule, config.rules?.[rule]?.[0] ?? null]))];
    }));
    console.log(JSON.stringify(Object.fromEntries(entries)));
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
describe('eslint.config.js', () => {
  let severities: z.infer<typeof SeveritiesSchema>;

  beforeAll(() => {
    severities = severitiesByFile();
  }, ESLINT_TIMEOUT);

  it('should set no-restricted-imports and max-lines to error for src/commands', () => {
    expect(severities['src/commands/x.ts']).toMatchObject({
      'no-restricted-imports': ERROR_SEVERITY,
      'max-lines': ERROR_SEVERITY,
    });
  });

  it('should set no-restricted-imports to error for src/mcp/kernel.ts', () => {
    expect(severities['src/mcp/kernel.ts']).toMatchObject({
      'no-restricted-imports': ERROR_SEVERITY,
    });
  });

  it('should set no-restricted-syntax to error for test/**', () => {
    expect(severities['test/x.spec.ts']).toMatchObject({
      'no-restricted-syntax': ERROR_SEVERITY,
    });
  });
});
