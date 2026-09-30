import { describe, test, expect } from '@jest/globals';
import { ESLint } from 'eslint';
import * as path from 'node:path';
import tseslint from 'typescript-eslint';
import { boundaryBlocks } from '../eslint.boundaries.js';

// Fixtures em test/fixtures/boundaries/src espelham o layout 1.0 e ficam fora do `eslint .` do repo
// (ver `ignores` em eslint.config.js); aqui o ESLint roda só com os blocos de fronteira.
const fixturesRoot = path.join(__dirname, 'fixtures', 'boundaries');

const eslint = new ESLint({
  cwd: fixturesRoot,
  overrideConfigFile: true,
  overrideConfig: [
    { files: ['**/*.ts'], languageOptions: { parser: tseslint.parser } },
    ...boundaryBlocks,
  ],
});

async function ruleIdsOfFile(relativePath: string): Promise<(string | null)[]> {
  const [result] = await eslint.lintFiles([relativePath]);
  return result?.messages.map((message) => message.ruleId) ?? ['sem resultado'];
}

async function ruleIdsOfText(relativePath: string, code: string): Promise<(string | null)[]> {
  const [result] = await eslint.lintText(code, { filePath: path.join(fixturesRoot, relativePath) });
  return result?.messages.map((message) => message.ruleId) ?? ['sem resultado'];
}

const importing = (specifier: string) => `import x from '${specifier}';\nexport default x;\n`;

const linesOfCode = (count: number) =>
  Array.from({ length: count }, (_, i) => `export const v${i} = ${i};`).join('\n');

const RESTRICTED_LAYERS = ['domain', 'shared', 'commands', 'queries'];
const FORBIDDEN_SPECIFIERS = [
  'node:fs',
  'fs',
  'node:fs/promises',
  'fs/promises',
  'node:child_process',
  'child_process',
  'node:os',
  'os',
  'node:net',
  'net',
  '@modelcontextprotocol/server',
  'ajv',
  'ajv-formats',
  'minisearch',
  '../adapters/anchor.ts',
];

describe('travas de fronteira (SF1/TB1)', () => {
  test.each([
    'src/domain/violates-fs.ts',
    'src/shared/violates-sdk.ts',
    'src/commands/violates-adapter.ts',
    'src/queries/violates-minisearch.ts',
  ])('fixture %s falha em no-restricted-imports', async (file) => {
    expect(await ruleIdsOfFile(file)).toEqual(['no-restricted-imports']);
  });

  test.each(
    RESTRICTED_LAYERS.flatMap((layer) =>
      FORBIDDEN_SPECIFIERS.map((specifier) => [layer, specifier] as const),
    ),
  )('%s não importa %s', async (layer, specifier) => {
    expect(await ruleIdsOfText(`src/${layer}/probe.ts`, importing(specifier))).toEqual([
      'no-restricted-imports',
    ]);
  });

  test.each(RESTRICTED_LAYERS)('%s não usa import dinâmico', async (layer) => {
    const code = `export const load = () => import('node:path');\n`;
    expect(await ruleIdsOfText(`src/${layer}/probe.ts`, code)).toEqual(['no-restricted-syntax']);
  });

  test('commands não importa queries', async () => {
    expect(await ruleIdsOfFile('src/commands/violates-queries.ts')).toEqual([
      'no-restricted-imports',
    ]);
  });

  test('queries não importa commands', async () => {
    expect(await ruleIdsOfFile('src/queries/violates-commands.ts')).toEqual([
      'no-restricted-imports',
    ]);
  });

  test.each(['src/domain/clean.ts', 'src/commands/clean.ts'])(
    'arquivo limpo %s passa',
    async (file) => {
      expect(await ruleIdsOfFile(file)).toEqual([]);
    },
  );

  test.each(['src/mcp/server.ts', 'src/adapters/fs/store.ts', 'src/mcp/tools/process.ts'])(
    '%s fica fora das travas e pode importar node:fs e o SDK',
    async (file) => {
      const code = `import 'node:fs';\nimport '@modelcontextprotocol/server';\n`;
      expect(await ruleIdsOfText(file, code)).toEqual([]);
    },
  );
});

describe('limite de tamanho (SF2/TB2)', () => {
  test.each(['commands', 'queries'])('%s com 801 linhas falha em max-lines', async (layer) => {
    expect(await ruleIdsOfText(`src/${layer}/big.ts`, linesOfCode(801))).toEqual(['max-lines']);
  });

  test.each(['commands', 'queries'])('%s com 800 linhas passa', async (layer) => {
    expect(await ruleIdsOfText(`src/${layer}/big.ts`, linesOfCode(800))).toEqual([]);
  });

  test.each(['domain', 'shared', 'mcp', 'adapters'])(
    '%s não tem limite de linhas',
    async (layer) => {
      expect(await ruleIdsOfText(`src/${layer}/big.ts`, linesOfCode(801))).toEqual([]);
    },
  );
});

describe('kernel MCP sem tools (TB3)', () => {
  test('kernel.ts que importa ./tools/** falha em no-restricted-imports', async () => {
    expect(await ruleIdsOfFile('src/mcp/kernel.ts')).toEqual(['no-restricted-imports']);
  });

  test('kernel.ts que importa só irmãos fora de tools passa', async () => {
    expect(await ruleIdsOfText('src/mcp/kernel.ts', importing('./server.ts'))).toEqual([]);
  });

  test('uma tool pode importar o kernel', async () => {
    expect(await ruleIdsOfText('src/mcp/tools/process.ts', importing('../kernel.ts'))).toEqual([]);
  });
});
