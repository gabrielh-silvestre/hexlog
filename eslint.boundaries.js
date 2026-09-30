import { builtinModules } from 'node:module';

// Travas de fronteira da arquitetura 1.0: cada camada só importa o que o layout permite.
// Flat config não mescla `no-restricted-imports` entre blocos que casam o mesmo arquivo
// (o último vence), então cada bloco declara a lista completa da sua camada.

// Todo builtin do Node, com e sem `node:`, exceto `crypto`: o domínio usa `node:crypto` legitimamente
// (layout do plano: "domain: puro; zod, canonicalize, es-toolkit, node:crypto"), então ele fica liberado.
const FORBIDDEN_BUILTINS = [...new Set(builtinModules.map((name) => name.replace(/^node:/, '')))]
  .filter((name) => name !== 'crypto')
  .flatMap((name) => [name, `node:${name}`]);

const INFRA_PACKAGES = ['ajv', 'ajv-formats', 'minisearch'];

const NO_IO_MESSAGE = 'Esta camada não acessa I/O nem libs de infraestrutura.';

/** @param {string[]} names */
const toPaths = (names) => names.map((name) => ({ name, message: NO_IO_MESSAGE }));

// `paths` só casa o especificador exato; o grupo cobre subcaminhos como `ajv/dist/2020.js`.
const FORBIDDEN_PACKAGES = toPaths([...FORBIDDEN_BUILTINS, ...INFRA_PACKAGES]);
const INFRA_SUBPATHS = {
  group: INFRA_PACKAGES.map((name) => `${name}/**`),
  message: NO_IO_MESSAGE,
};

const FORBIDDEN_GROUPS = [
  INFRA_SUBPATHS,
  { group: ['@modelcontextprotocol/*'], message: 'Só mcp/ conhece o SDK do MCP.' },
  { group: ['**/adapters/**'], message: 'Esta camada depende de portas, nunca de adapters.' },
];

// `no-restricted-imports` não enxerga `import('...')`, então o import dinâmico é barrado por sintaxe.
const NO_DYNAMIC_IMPORT = [
  'error',
  {
    selector: 'ImportExpression',
    message: 'Esta camada não usa import dinâmico: ele contornaria as travas de import.',
  },
];

const MAX_LINES = { 'max-lines': ['error', { max: 800 }] };

/**
 * @param {string[]} files
 * @param {{ extraGroups?: { group: string[]; message: string }[]; extraRules?: Record<string, unknown> }} [options]
 */
const restrictImports = (files, { extraGroups = [], extraRules = {} } = {}) => ({
  files,
  rules: {
    'no-restricted-imports': [
      'error',
      { paths: FORBIDDEN_PACKAGES, patterns: [...FORBIDDEN_GROUPS, ...extraGroups] },
    ],
    'no-restricted-syntax': NO_DYNAMIC_IMPORT,
    ...extraRules,
  },
});

// mcp só fala com serviços: pode usar o SDK do MCP, mas não builtins nem adapters. O kernel repete a
// lista inteira porque o último bloco vence, e acrescenta a trava de tools.
/**
 * @param {string[]} files
 * @param {{ group: string[]; message: string }[]} [extraGroups]
 */
const mcpBlock = (files, extraGroups = []) => ({
  files,
  rules: {
    'no-restricted-imports': [
      'error',
      {
        paths: toPaths(FORBIDDEN_BUILTINS),
        patterns: [
          { group: ['**/adapters/**'], message: 'mcp chama serviços, nunca adapters.' },
          ...extraGroups,
        ],
      },
    ],
    'no-restricted-syntax': NO_DYNAMIC_IMPORT,
  },
});

export const boundaryBlocks = [
  restrictImports(['src/domain/**/*.ts'], {
    extraGroups: ['commands', 'queries', 'mcp', 'shared'].map((layer) => ({
      group: [`**/${layer}/**`],
      message: 'domain não importa camadas de fora do núcleo.',
    })),
  }),
  restrictImports(['src/shared/**/*.ts']),
  restrictImports(['src/commands/**/*.ts'], {
    extraGroups: [{ group: ['**/queries/**'], message: 'commands não importa queries.' }],
    extraRules: MAX_LINES,
  }),
  restrictImports(['src/queries/**/*.ts'], {
    extraGroups: [{ group: ['**/commands/**'], message: 'queries não importa commands.' }],
    extraRules: MAX_LINES,
  }),
  mcpBlock(['src/mcp/**/*.ts']),
  mcpBlock(
    ['src/mcp/kernel.ts'],
    [{ group: ['**/tools/**'], message: 'O kernel MCP não importa tools.' }],
  ),
];
