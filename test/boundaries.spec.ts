import { describe, it, expect } from '@jest/globals';
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

// Só severidade 2 (error) conta: rebaixar uma regra para 'warn' precisa derrubar o spec.
const errorRuleIds = (messages: { ruleId: string | null; severity: number }[]) =>
  messages.filter((message) => message.severity === 2).map((message) => message.ruleId);

async function ruleIdsOfFile(relativePath: string): Promise<(string | null)[]> {
  const [result] = await eslint.lintFiles([relativePath]);
  return result ? errorRuleIds(result.messages) : ['no result'];
}

async function ruleIdsOfText(relativePath: string, code: string): Promise<(string | null)[]> {
  const [result] = await eslint.lintText(code, { filePath: path.join(fixturesRoot, relativePath) });
  return result ? errorRuleIds(result.messages) : ['no result'];
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
  'ajv/dist/2020.js',
  'ajv-formats/dist/x',
  'minisearch/x',
  'node:http',
  'http',
  'node:worker_threads',
  '@modelcontextprotocol/server/stdio',
  '@modelcontextprotocol/client',
  '../adapters/anchor.ts',
  '../adapters/fs/store.ts',
  '../compose.ts',
];

describe('boundaryBlocks', () => {
  it.each([
    'src/domain/violates-fs.ts',
    'src/shared/violates-sdk.ts',
    'src/ports.ts',
    'src/commands/violates-adapter.ts',
    'src/queries/violates-minisearch.ts',
  ])('should fail the fixture %s on no-restricted-imports (SF1, TB1)', async (file) => {
    expect(await ruleIdsOfFile(file)).toEqual(['no-restricted-imports']);
  });

  it.each(
    RESTRICTED_LAYERS.flatMap((layer) =>
      FORBIDDEN_SPECIFIERS.map((specifier) => [layer, specifier] as const),
    ),
  )('should forbid %s from importing %s (SF1, TB1)', async (layer, specifier) => {
    expect(await ruleIdsOfText(`src/${layer}/probe.ts`, importing(specifier))).toEqual([
      'no-restricted-imports',
    ]);
  });

  it.each(RESTRICTED_LAYERS)(
    'should block the restricted specifier in a deep subdirectory of %s (SF1, TB1)',
    async (layer) => {
      expect(await ruleIdsOfText(`src/${layer}/sub/deep/probe.ts`, importing('node:fs'))).toEqual([
        'no-restricted-imports',
      ]);
    },
  );

  it.each(RESTRICTED_LAYERS)('should allow a local ./ajv in %s (SF1, TB1)', async (layer) => {
    expect(await ruleIdsOfText(`src/${layer}/probe.ts`, importing('./ajv'))).toEqual([]);
  });

  it.each(RESTRICTED_LAYERS)('should forbid a dynamic import in %s (SF1, TB1)', async (layer) => {
    const code = `export const load = () => import('node:path');\n`;

    expect(await ruleIdsOfText(`src/${layer}/probe.ts`, code)).toEqual(['no-restricted-syntax']);
  });

  it('should forbid commands from importing queries (SF1, TB1)', async () => {
    expect(await ruleIdsOfFile('src/commands/violates-queries.ts')).toEqual([
      'no-restricted-imports',
    ]);
  });

  it('should forbid queries from importing commands (SF1, TB1)', async () => {
    expect(await ruleIdsOfFile('src/queries/violates-commands.ts')).toEqual([
      'no-restricted-imports',
    ]);
  });

  it.each(['src/domain/clean.ts', 'src/commands/clean.ts'])(
    'should pass the clean file %s (SF1, TB1)',
    async (file) => {
      expect(await ruleIdsOfFile(file)).toEqual([]);
    },
  );

  it('should leave adapters outside the locks, free to import node:fs and the SDK (SF1, TB1)', async () => {
    const code = `import 'node:fs';\nimport '@modelcontextprotocol/server';\n`;

    expect(await ruleIdsOfText('src/adapters/fs/store.ts', code)).toEqual([]);
  });

  it('should allow mcp to import the MCP SDK (SF1, TB1)', async () => {
    expect(
      await ruleIdsOfText('src/mcp/server.ts', importing('@modelcontextprotocol/server')),
    ).toEqual([]);
  });

  it.each(['../commands/x.ts', '../queries/x.ts', '../mcp/kernel.ts', '../shared/logger.ts'])(
    'should forbid domain from importing %s (N6)',
    async (specifier) => {
      expect(await ruleIdsOfText('src/domain/probe.ts', importing(specifier))).toEqual([
        'no-restricted-imports',
      ]);
    },
  );

  it.each(['node:crypto', '../errors.ts'])(
    'should allow domain to import %s (N6)',
    async (specifier) => {
      expect(await ruleIdsOfText('src/domain/probe.ts', importing(specifier))).toEqual([]);
    },
  );

  it.each(['node:fs', '../adapters/fs/store.ts', '@modelcontextprotocol/server', './compose.ts'])(
    'should forbid ports.ts from importing %s (M6)',
    async (specifier) => {
      expect(await ruleIdsOfText('src/ports.ts', importing(specifier))).toEqual([
        'no-restricted-imports',
      ]);
    },
  );

  it.each(['./domain/ids.ts', './errors.ts'])(
    'should allow ports.ts to import %s (M6)',
    async (specifier) => {
      expect(await ruleIdsOfText('src/ports.ts', importing(specifier))).toEqual([]);
    },
  );

  it.each([
    ['src/shared/probe.ts', '../commands/x.ts'],
    ['src/shared/probe.ts', '../queries/x.ts'],
    ['src/shared/probe.ts', '../mcp/kernel.ts'],
    ['src/ports.ts', './commands/x.ts'],
    ['src/ports.ts', './queries/x.ts'],
    ['src/ports.ts', './mcp/kernel.ts'],
  ])('should forbid %s from importing %s (M12)', async (file, specifier) => {
    expect(await ruleIdsOfText(file, importing(specifier))).toEqual(['no-restricted-imports']);
  });

  it.each([
    ['src/shared/probe.ts', '../domain/ids.ts'],
    ['src/shared/probe.ts', '../ports.ts'],
    ['src/shared/probe.ts', '../errors.ts'],
    ['src/shared/probe.ts', './logger.ts'],
  ])('should allow %s to import %s (M12)', async (file, specifier) => {
    expect(await ruleIdsOfText(file, importing(specifier))).toEqual([]);
  });

  it.each(['commands', 'queries'])('should forbid %s from importing mcp (M12)', async (layer) => {
    expect(await ruleIdsOfText(`src/${layer}/probe.ts`, importing('../mcp/kernel.ts'))).toEqual([
      'no-restricted-imports',
    ]);
  });

  it.each(['commands', 'queries'])(
    'should allow %s to import domain, shared, ports and errors (M12)',
    async (layer) => {
      const code = ['../domain/ids.ts', '../shared/loader.ts', '../ports.ts', '../errors.ts']
        .map((specifier) => `import '${specifier}';\n`)
        .join('');

      expect(await ruleIdsOfText(`src/${layer}/probe.ts`, code)).toEqual([]);
    },
  );

  it.each([
    ['src/mcp/tools/probe.ts', '../../commands/x.ts'],
    ['src/mcp/tools/probe.ts', '../../queries/x.ts'],
  ])('should allow %s to import %s, as mcp calls services (M12)', async (file, specifier) => {
    expect(await ruleIdsOfText(file, importing(specifier))).toEqual([]);
  });

  it.each(['commands', 'queries', 'mcp'])(
    'should forbid adapters from importing %s (M30)',
    async (layer) => {
      expect(
        await ruleIdsOfText('src/adapters/fs/probe.ts', importing(`../../${layer}/x.ts`)),
      ).toEqual(['no-restricted-imports']);
    },
  );

  it('should allow adapters to import domain, ports and errors (M30)', async () => {
    const code = ['../../domain/ids.ts', '../../ports.ts', '../../errors.ts']
      .map((specifier) => `import '${specifier}';\n`)
      .join('');

    expect(await ruleIdsOfText('src/adapters/fs/probe.ts', code)).toEqual([]);
  });

  it.each([
    ['src/mcp/tools/process.ts', '../../adapters/fs/store.ts'],
    ['src/mcp/tools/process.ts', 'node:fs'],
    ['src/mcp/server.ts', 'node:os'],
    ['src/mcp/kernel.ts', 'node:fs'],
    ['src/mcp/kernel.ts', '../adapters/fs/store.ts'],
    ['src/mcp/kernel.ts', './tools/process.ts'],
  ])('should forbid %s from importing %s (N6)', async (file, specifier) => {
    expect(await ruleIdsOfText(file, importing(specifier))).toEqual(['no-restricted-imports']);
  });

  it.each([
    ['src/mcp/server.ts', '../compose.ts'],
    ['src/mcp/tools/process.ts', '../../compose.ts'],
  ])(
    'should forbid %s from importing %s, as only server.ts, scripts and tests use compose.ts (N6)',
    async (file, specifier) => {
      expect(await ruleIdsOfText(file, importing(specifier))).toEqual(['no-restricted-imports']);
    },
  );

  it.each([
    ['src/server.ts', './compose.ts'],
    ['src/adapters/probe.ts', '../compose.ts'],
  ])('should allow %s to import %s, the compose.ts of src/ (N6)', async (file, specifier) => {
    expect(await ruleIdsOfText(file, importing(specifier))).toEqual([]);
  });

  it('should forbid a dynamic import in mcp (N6)', async () => {
    const code = `export const load = () => import('node:path');\n`;

    expect(await ruleIdsOfText('src/mcp/server.ts', code)).toEqual(['no-restricted-syntax']);
  });

  it.each(['commands', 'queries'])(
    'should fail %s with 801 lines on max-lines (SF2, TB2)',
    async (layer) => {
      expect(await ruleIdsOfText(`src/${layer}/big.ts`, linesOfCode(801))).toEqual(['max-lines']);
    },
  );

  it.each(['commands', 'queries'])('should pass %s with 800 lines (SF2, TB2)', async (layer) => {
    expect(await ruleIdsOfText(`src/${layer}/big.ts`, linesOfCode(800))).toEqual([]);
  });

  it.each(['domain', 'shared', 'mcp', 'adapters'])(
    'should not limit the lines of %s (SF2, TB2)',
    async (layer) => {
      expect(await ruleIdsOfText(`src/${layer}/big.ts`, linesOfCode(801))).toEqual([]);
    },
  );

  it('should fail a kernel.ts that imports ./tools/** on no-restricted-imports (TB3)', async () => {
    expect(await ruleIdsOfFile('src/mcp/kernel.ts')).toEqual(['no-restricted-imports']);
  });

  it('should pass a kernel.ts that imports only siblings outside tools (TB3)', async () => {
    expect(await ruleIdsOfText('src/mcp/kernel.ts', importing('./server.ts'))).toEqual([]);
  });

  it('should allow server.ts to import ./tools/process.ts (TB3)', async () => {
    expect(await ruleIdsOfText('src/mcp/server.ts', importing('./tools/process.ts'))).toEqual([]);
  });

  it('should allow a tool to import the kernel (TB3)', async () => {
    expect(await ruleIdsOfText('src/mcp/tools/process.ts', importing('../kernel.ts'))).toEqual([]);
  });

  it.each([
    ['scripts/probe.ts', '../src/adapters/fs/process-store.ts'],
    ['scripts/probe.ts', '../src/mcp/kernel.ts'],
  ])('should forbid %s from importing %s', async (file, specifier) => {
    expect(await ruleIdsOfText(file, importing(specifier))).toEqual(['no-restricted-imports']);
  });

  it.each([
    ['scripts/probe.ts', '../src/compose.ts'],
    ['scripts/probe.ts', '../src/errors.ts'],
    ['scripts/probe.ts', '../src/directory.ts'],
    ['scripts/install.ts', '../src/adapters/fs/data-format.ts'],
    ['scripts/build.ts', '../src/mcp/server.ts'],
  ])('should allow %s to import %s', async (file, specifier) => {
    expect(await ruleIdsOfText(file, importing(specifier))).toEqual([]);
  });

  it.each([
    ['scripts/probe.ts', ['no-restricted-syntax']],
    ['scripts/install.ts', []],
  ])('should report an import() of adapters in %s as %j', async (file, expected) => {
    const code = `export const load = () => import('../src/adapters/fs/process-store.ts');\n`;

    expect(await ruleIdsOfText(file, code)).toEqual(expected);
  });
});
