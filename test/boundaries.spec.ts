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
    'src/commands/violates-queries.ts',
    'src/queries/violates-commands.ts',
    'src/mcp/kernel.ts',
  ])('should fail the fixture %s on no-restricted-imports', async (file) => {
    expect(await ruleIdsOfFile(file)).toEqual(['no-restricted-imports']);
  });

  it.each(
    RESTRICTED_LAYERS.flatMap((layer) =>
      FORBIDDEN_SPECIFIERS.map((specifier) => [layer, specifier] as const),
    ),
  )('should forbid %s from importing %s', async (layer, specifier) => {
    expect(await ruleIdsOfText(`src/${layer}/probe.ts`, importing(specifier))).toEqual([
      'no-restricted-imports',
    ]);
  });

  it.each(RESTRICTED_LAYERS)(
    'should block the restricted specifier in a deep subdirectory of %s',
    async (layer) => {
      expect(await ruleIdsOfText(`src/${layer}/sub/deep/probe.ts`, importing('node:fs'))).toEqual([
        'no-restricted-imports',
      ]);
    },
  );

  it.each(RESTRICTED_LAYERS)('should allow a local ./ajv in %s', async (layer) => {
    expect(await ruleIdsOfText(`src/${layer}/probe.ts`, importing('./ajv'))).toEqual([]);
  });

  it.each([...RESTRICTED_LAYERS, 'mcp'])('should forbid a dynamic import in %s', async (layer) => {
    const code = `export const load = () => import('node:path');\n`;

    expect(await ruleIdsOfText(`src/${layer}/probe.ts`, code)).toEqual(['no-restricted-syntax']);
  });

  it.each(['src/domain/clean.ts', 'src/commands/clean.ts'])(
    'should pass the clean file %s',
    async (file) => {
      expect(await ruleIdsOfFile(file)).toEqual([]);
    },
  );

  it('should leave adapters outside the locks, free to import node:fs and the SDK', async () => {
    const code = `import 'node:fs';\nimport '@modelcontextprotocol/server';\n`;

    expect(await ruleIdsOfText('src/adapters/fs/store.ts', code)).toEqual([]);
  });

  it('should allow mcp to import the MCP SDK', async () => {
    expect(
      await ruleIdsOfText('src/mcp/server.ts', importing('@modelcontextprotocol/server')),
    ).toEqual([]);
  });

  it.each(['../commands/x.ts', '../queries/x.ts', '../mcp/kernel.ts', '../shared/logger.ts'])(
    'should forbid domain from importing %s',
    async (specifier) => {
      expect(await ruleIdsOfText('src/domain/probe.ts', importing(specifier))).toEqual([
        'no-restricted-imports',
      ]);
    },
  );

  it.each(['node:crypto', '../errors.ts'])(
    'should allow domain to import %s',
    async (specifier) => {
      expect(await ruleIdsOfText('src/domain/probe.ts', importing(specifier))).toEqual([]);
    },
  );

  it.each(['node:fs', '../adapters/fs/store.ts', '@modelcontextprotocol/server', './compose.ts'])(
    'should forbid ports.ts from importing %s',
    async (specifier) => {
      expect(await ruleIdsOfText('src/ports.ts', importing(specifier))).toEqual([
        'no-restricted-imports',
      ]);
    },
  );

  it.each(['./domain/ids.ts', './errors.ts'])(
    'should allow ports.ts to import %s',
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
  ])('should forbid %s from importing %s', async (file, specifier) => {
    expect(await ruleIdsOfText(file, importing(specifier))).toEqual(['no-restricted-imports']);
  });

  it.each([
    ['src/shared/probe.ts', '../domain/ids.ts'],
    ['src/shared/probe.ts', '../ports.ts'],
    ['src/shared/probe.ts', '../errors.ts'],
    ['src/shared/probe.ts', './logger.ts'],
  ])('should allow %s to import %s', async (file, specifier) => {
    expect(await ruleIdsOfText(file, importing(specifier))).toEqual([]);
  });

  it.each(['commands', 'queries'])('should forbid %s from importing mcp', async (layer) => {
    expect(await ruleIdsOfText(`src/${layer}/probe.ts`, importing('../mcp/kernel.ts'))).toEqual([
      'no-restricted-imports',
    ]);
  });

  it.each(['commands', 'queries'])(
    'should allow %s to import domain, shared, ports and errors',
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
  ])('should allow %s to import %s, as mcp calls services', async (file, specifier) => {
    expect(await ruleIdsOfText(file, importing(specifier))).toEqual([]);
  });

  it.each(['commands', 'queries', 'mcp'])(
    'should forbid adapters from importing %s',
    async (layer) => {
      expect(
        await ruleIdsOfText('src/adapters/fs/probe.ts', importing(`../../${layer}/x.ts`)),
      ).toEqual(['no-restricted-imports']);
    },
  );

  it('should allow adapters to import domain, ports and errors', async () => {
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
  ])('should forbid %s from importing %s', async (file, specifier) => {
    expect(await ruleIdsOfText(file, importing(specifier))).toEqual(['no-restricted-imports']);
  });

  it.each([
    ['src/mcp/server.ts', '../compose.ts'],
    ['src/mcp/tools/process.ts', '../../compose.ts'],
  ])(
    'should forbid %s from importing %s, as only server.ts, scripts and tests use compose.ts',
    async (file, specifier) => {
      expect(await ruleIdsOfText(file, importing(specifier))).toEqual(['no-restricted-imports']);
    },
  );

  it.each([
    ['src/server.ts', './compose.ts'],
    ['src/adapters/probe.ts', '../compose.ts'],
  ])('should allow %s to import %s, the compose.ts of src/', async (file, specifier) => {
    expect(await ruleIdsOfText(file, importing(specifier))).toEqual([]);
  });

  it.each(['commands', 'queries'])('should fail %s with 801 lines on max-lines', async (layer) => {
    expect(await ruleIdsOfText(`src/${layer}/big.ts`, linesOfCode(801))).toEqual(['max-lines']);
  });

  it.each(['commands', 'queries'])('should pass %s with 800 lines', async (layer) => {
    expect(await ruleIdsOfText(`src/${layer}/big.ts`, linesOfCode(800))).toEqual([]);
  });

  it.each(['domain', 'shared', 'mcp', 'adapters'])(
    'should not limit the lines of %s',
    async (layer) => {
      expect(await ruleIdsOfText(`src/${layer}/big.ts`, linesOfCode(801))).toEqual([]);
    },
  );

  it('should pass a kernel.ts that imports only siblings outside tools', async () => {
    expect(await ruleIdsOfText('src/mcp/kernel.ts', importing('./server.ts'))).toEqual([]);
  });

  it('should allow server.ts to import ./tools/process.ts', async () => {
    expect(await ruleIdsOfText('src/mcp/server.ts', importing('./tools/process.ts'))).toEqual([]);
  });

  it('should allow a tool to import the kernel', async () => {
    expect(await ruleIdsOfText('src/mcp/tools/process.ts', importing('../kernel.ts'))).toEqual([]);
  });

  it.each([
    ['scripts/probe.ts', '../src/adapters/fs/process-store.ts'],
    ['scripts/probe.ts', '../src/mcp/kernel.ts'],
    ['scripts/flow/writer.ts', '../src/adapters/fs/process-store.ts'],
    ['scripts/flow/writer.ts', '../src/mcp/kernel.ts'],
  ])('should forbid %s from importing %s', async (file, specifier) => {
    expect(await ruleIdsOfText(file, importing(specifier))).toEqual(['no-restricted-imports']);
  });

  it.each([
    ['scripts/probe.ts', '../src/errors.ts'],
    ['scripts/probe.ts', '../src/directory.ts'],
    ['scripts/install.ts', '../src/adapters/fs/data-format.ts'],
    ['scripts/build.ts', '../src/mcp/server.ts'],
  ])('should allow %s to import %s', async (file, specifier) => {
    expect(await ruleIdsOfText(file, importing(specifier))).toEqual([]);
  });

  it.each(['scripts/probe.ts', 'scripts/flow/probe.ts'])(
    'should allow %s to import composeReader',
    async (file) => {
      const code = `import { composeReader } from '../src/compose.ts';\nexport { composeReader };\n`;

      expect(await ruleIdsOfText(file, code)).toEqual([]);
    },
  );

  it.each(['scripts/install.ts', 'scripts/build.ts', 'scripts/flow/writer.ts'])(
    'should allow %s to import compose',
    async (file) => {
      const code = `import { compose } from '../src/compose.ts';\nexport { compose };\n`;

      expect(await ruleIdsOfText(file, code)).toEqual([]);
    },
  );

  describe.each(['scripts/probe.ts', 'scripts/flow/probe.ts'])('with %s', (file) => {
    it.each([
      ['import { compose }', `import { compose } from '../src/compose.ts';\nexport { compose };\n`],
      [
        'import type { compose }',
        `import type { compose } from '../src/compose.ts';\nexport type { compose };\n`,
      ],
      ['import * as', `import * as x from '../src/compose.ts';\nexport default x;\n`],
      ['export { compose } from', `export { compose } from '../src/compose.ts';\n`],
    ])('should forbid %s of compose', async (_form, code) => {
      expect(await ruleIdsOfText(file, code)).toEqual(['no-restricted-imports']);
    });
  });

  it.each([
    ['scripts/probe.ts', ['no-restricted-syntax']],
    ['scripts/install.ts', []],
  ])('should report an import() of adapters in %s as %j', async (file, expected) => {
    const code = `export const load = () => import('../src/adapters/fs/process-store.ts');\n`;

    expect(await ruleIdsOfText(file, code)).toEqual(expected);
  });

  describe('with the telemetry capability', () => {
    const OTEL_SPECIFIERS = [
      '@opentelemetry/api',
      '@opentelemetry/sdk-trace',
      '@opentelemetry/otlp-exporter-base/node-http',
      '@opentelemetry/sdk-trace/build/src/index.js',
    ];
    const OTEL_FORBIDDEN_FILES = [
      'src/domain/probe.ts',
      'src/shared/probe.ts',
      'src/ports.ts',
      'src/commands/probe.ts',
      'src/queries/probe.ts',
      'src/mcp/kernel.ts',
      'src/mcp/server.ts',
      'src/mcp/tools/probe.ts',
      'src/adapters/probe.ts',
      'src/adapters/fs/probe.ts',
    ];
    const TELEMETRY_TYPES = ['Telemetry', 'CallProbe', 'LoadReport'];

    it.each(
      OTEL_FORBIDDEN_FILES.flatMap((file) =>
        OTEL_SPECIFIERS.map((specifier) => [file, specifier] as const),
      ),
    )('should forbid %s from importing %s', async (file, specifier) => {
      expect(await ruleIdsOfText(file, importing(specifier))).toEqual(['no-restricted-imports']);
    });

    it.each(['src/adapters/telemetry/otel.ts', 'src/adapters/telemetry/sub/exporter.ts'])(
      'should allow %s to import the whole SDK, subpaths included',
      async (file) => {
        const code = OTEL_SPECIFIERS.map((specifier) => `import '${specifier}';\n`).join('');

        expect(await ruleIdsOfText(file, code)).toEqual([]);
      },
    );

    it.each(['commands', 'queries', 'mcp'])(
      'should forbid adapters/telemetry from importing %s',
      async (layer) => {
        expect(
          await ruleIdsOfText('src/adapters/telemetry/otel.ts', importing(`../../${layer}/x.ts`)),
        ).toEqual(['no-restricted-imports']);
      },
    );

    it('should allow adapters/telemetry to import domain, ports and errors', async () => {
      const code = ['../../domain/ids.ts', '../../ports.ts', '../../errors.ts']
        .map((specifier) => `import '${specifier}';\n`)
        .join('');

      expect(await ruleIdsOfText('src/adapters/telemetry/otel.ts', code)).toEqual([]);
    });

    it.each(
      ['domain', 'shared'].flatMap((layer) =>
        TELEMETRY_TYPES.map((name) => [layer, name] as const),
      ),
    )('should forbid %s from importing the type %s from ports.ts', async (layer, name) => {
      const code = `import type { ${name} } from '../ports.ts';\nexport type Alias = ${name};\n`;

      expect(await ruleIdsOfText(`src/${layer}/probe.ts`, code)).toEqual(['no-restricted-imports']);
    });

    it.each(['domain', 'shared'])(
      'should forbid %s from a mixed import of ProcessStore and Telemetry',
      async (layer) => {
        const code = `import type { ProcessStore, Telemetry } from '../ports.ts';\nexport type A = [ProcessStore, Telemetry];\n`;

        expect(await ruleIdsOfText(`src/${layer}/probe.ts`, code)).toEqual([
          'no-restricted-imports',
        ]);
      },
    );

    it.each(['commands', 'queries'])(
      'should allow %s to import the telemetry types from ports.ts',
      async (layer) => {
        const code = `import type { Telemetry, CallProbe, LoadReport } from '../ports.ts';\nexport type A = [Telemetry, CallProbe, LoadReport];\n`;

        expect(await ruleIdsOfText(`src/${layer}/probe.ts`, code)).toEqual([]);
      },
    );

    it.each(['shared', 'commands', 'queries'])(
      'should allow %s to import ProcessStore from ports.ts',
      async (layer) => {
        const code = `import type { ProcessStore } from '../ports.ts';\nexport type A = ProcessStore;\n`;

        expect(await ruleIdsOfText(`src/${layer}/probe.ts`, code)).toEqual([]);
      },
    );

    it.each(['src/adapters/fs/probe.ts', 'src/adapters/telemetry/otel.ts'])(
      'should allow %s to import the telemetry types from ports.ts',
      async (file) => {
        const ports = '../../ports.ts';
        const code = `import type { Telemetry, CallProbe, LoadReport } from '${ports}';\nexport type A = [Telemetry, CallProbe, LoadReport];\n`;

        expect(await ruleIdsOfText(file, code)).toEqual([]);
      },
    );

    it.each(['src/mcp/kernel.ts', 'src/mcp/server.ts', 'src/mcp/tools/probe.ts'])(
      'should allow %s to import shared/logger.ts and the types Telemetry and CallProbe',
      async (file) => {
        const up = file.split('/').length > 3 ? '../..' : '..';
        const code = [
          `import type { Logger } from '${up}/shared/logger.ts';`,
          `import type { Telemetry, CallProbe } from '${up}/ports.ts';`,
          'export type A = [Logger, Telemetry, CallProbe];',
        ].join('\n');

        expect(await ruleIdsOfText(file, code)).toEqual([]);
      },
    );

    it.each([
      ['../shared/loader.ts', 'import type { VerifiedProcess } from "../shared/loader.ts";'],
      ['../shared/pages.ts', 'import { sliceChars } from "../shared/pages.ts";'],
      ['ProcessStore', 'import type { ProcessStore } from "../ports.ts";'],
      ['PROJECT_INDEX', 'import { PROJECT_INDEX } from "../ports.ts";'],
      ['LoadReport', 'import type { LoadReport } from "../ports.ts";'],
      ['a mixed import', 'import type { Telemetry, ProcessStore } from "../ports.ts";'],
    ])('should forbid mcp/kernel.ts from importing %s', async (_label, code) => {
      expect(await ruleIdsOfText('src/mcp/kernel.ts', `${code}\n`)).toEqual([
        'no-restricted-imports',
      ]);
    });
  });
});
