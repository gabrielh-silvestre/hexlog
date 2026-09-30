// Travas de fronteira da arquitetura 1.0: cada camada só importa o que o layout permite.
// Flat config não mescla `no-restricted-imports` entre blocos que casam o mesmo arquivo
// (o último vence), então cada bloco declara a lista completa da sua camada.

const FORBIDDEN_PACKAGES = [
  'node:fs',
  'fs',
  'node:fs/promises',
  'ajv',
  'ajv-formats',
  'minisearch',
].map((name) => ({ name, message: 'Esta camada não acessa I/O nem libs de infraestrutura.' }));

const FORBIDDEN_GROUPS = [
  { group: ['@modelcontextprotocol/*'], message: 'Só mcp/ conhece o SDK do MCP.' },
  { group: ['**/adapters/**'], message: 'Esta camada depende de portas, nunca de adapters.' },
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
    ...extraRules,
  },
});

export const boundaryBlocks = [
  restrictImports(['src/domain/**/*.ts']),
  restrictImports(['src/shared/**/*.ts']),
  restrictImports(['src/commands/**/*.ts'], {
    extraGroups: [{ group: ['**/queries/**'], message: 'commands não importa queries.' }],
    extraRules: MAX_LINES,
  }),
  restrictImports(['src/queries/**/*.ts'], {
    extraGroups: [{ group: ['**/commands/**'], message: 'queries não importa commands.' }],
    extraRules: MAX_LINES,
  }),
  {
    files: ['src/mcp/kernel.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        { patterns: [{ group: ['**/tools/**'], message: 'O kernel MCP não importa tools.' }] },
      ],
    },
  },
];
