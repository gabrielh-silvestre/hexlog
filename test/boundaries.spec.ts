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

// Só severidade 2 (error) conta: rebaixar uma regra para 'warn' precisa derrubar o spec.
const errorRuleIds = (messages: { ruleId: string | null; severity: number }[]) =>
  messages.filter((message) => message.severity === 2).map((message) => message.ruleId);

async function ruleIdsOfFile(relativePath: string): Promise<(string | null)[]> {
  const [result] = await eslint.lintFiles([relativePath]);
  return result ? errorRuleIds(result.messages) : ['sem resultado'];
}

async function ruleIdsOfText(relativePath: string, code: string): Promise<(string | null)[]> {
  const [result] = await eslint.lintText(code, { filePath: path.join(fixturesRoot, relativePath) });
  return result ? errorRuleIds(result.messages) : ['sem resultado'];
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
  'safe-regex2',
  'safe-regex2/lib/x',
  'node:http',
  'http',
  'node:worker_threads',
  '@modelcontextprotocol/server/stdio',
  '@modelcontextprotocol/client',
  '../adapters/anchor.ts',
  '../adapters/fs/store.ts',
  '../compose.ts',
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

  test.each(RESTRICTED_LAYERS)('%s barra o especificador em subdiretório fundo', async (layer) => {
    expect(await ruleIdsOfText(`src/${layer}/sub/deep/probe.ts`, importing('node:fs'))).toEqual([
      'no-restricted-imports',
    ]);
  });

  test.each(RESTRICTED_LAYERS)('%s permite ./ajv local', async (layer) => {
    expect(await ruleIdsOfText(`src/${layer}/probe.ts`, importing('./ajv'))).toEqual([]);
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

  test('adapters fica fora das travas e pode importar node:fs e o SDK', async () => {
    const code = `import 'node:fs';\nimport '@modelcontextprotocol/server';\n`;
    expect(await ruleIdsOfText('src/adapters/fs/store.ts', code)).toEqual([]);
  });

  test('mcp pode importar o SDK do MCP', async () => {
    expect(
      await ruleIdsOfText('src/mcp/server.ts', importing('@modelcontextprotocol/server')),
    ).toEqual([]);
  });
});

describe('domain sem camadas de fora do núcleo (N6)', () => {
  test.each(['../commands/x.ts', '../queries/x.ts', '../mcp/kernel.ts', '../shared/logger.ts'])(
    'domain não importa %s',
    async (specifier) => {
      expect(await ruleIdsOfText('src/domain/probe.ts', importing(specifier))).toEqual([
        'no-restricted-imports',
      ]);
    },
  );

  test.each(['node:crypto', '../errors.ts'])('domain pode importar %s', async (specifier) => {
    expect(await ruleIdsOfText('src/domain/probe.ts', importing(specifier))).toEqual([]);
  });
});

describe('mcp sem builtins nem adapters (N6)', () => {
  test.each([
    ['src/mcp/tools/process.ts', '../../adapters/fs/store.ts'],
    ['src/mcp/tools/process.ts', 'node:fs'],
    ['src/mcp/server.ts', 'node:os'],
    ['src/mcp/kernel.ts', 'node:fs'],
    ['src/mcp/kernel.ts', '../adapters/fs/store.ts'],
    ['src/mcp/kernel.ts', './tools/process.ts'],
  ])('%s não importa %s', async (file, specifier) => {
    expect(await ruleIdsOfText(file, importing(specifier))).toEqual(['no-restricted-imports']);
  });

  test.each([
    ['src/mcp/server.ts', '../compose.ts'],
    ['src/mcp/tools/process.ts', '../../compose.ts'],
  ])(
    '%s não importa %s (só server.ts, scripts e testes usam compose.ts)',
    async (file, specifier) => {
      expect(await ruleIdsOfText(file, importing(specifier))).toEqual(['no-restricted-imports']);
    },
  );

  test.each([
    ['src/server.ts', './compose.ts'],
    ['src/adapters/probe.ts', '../compose.ts'],
  ])('%s pode importar %s (o compose.ts de src/)', async (file, specifier) => {
    expect(await ruleIdsOfText(file, importing(specifier))).toEqual([]);
  });

  test('mcp não usa import dinâmico', async () => {
    const code = `export const load = () => import('node:path');\n`;
    expect(await ruleIdsOfText('src/mcp/server.ts', code)).toEqual(['no-restricted-syntax']);
  });
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

  test('server.ts pode importar ./tools/process.ts', async () => {
    expect(await ruleIdsOfText('src/mcp/server.ts', importing('./tools/process.ts'))).toEqual([]);
  });

  test('uma tool pode importar o kernel', async () => {
    expect(await ruleIdsOfText('src/mcp/tools/process.ts', importing('../kernel.ts'))).toEqual([]);
  });
});

describe('scripts de leitura só leem por compose.ts', () => {
  test.each([
    ['scripts/probe.ts', '../src/adapters/fs/process-store.ts'],
    ['scripts/probe.ts', '../src/mcp/kernel.ts'],
  ])('%s não importa %s', async (file, specifier) => {
    expect(await ruleIdsOfText(file, importing(specifier))).toEqual(['no-restricted-imports']);
  });

  test.each([
    ['scripts/probe.ts', '../src/compose.ts'],
    ['scripts/probe.ts', '../src/errors.ts'],
    ['scripts/probe.ts', '../src/directory.ts'],
    ['scripts/install.ts', '../src/adapters/fs/data-format.ts'],
    ['scripts/build.ts', '../src/mcp/server.ts'],
  ])('%s pode importar %s', async (file, specifier) => {
    expect(await ruleIdsOfText(file, importing(specifier))).toEqual([]);
  });
});
