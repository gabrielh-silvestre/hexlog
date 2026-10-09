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

const COMPOSE_ONLY_ROOT = {
  group: ['**/compose.ts'],
  message: 'Só server.ts, scripts e testes importam compose.ts.',
};

const FORBIDDEN_GROUPS = [
  INFRA_SUBPATHS,
  { group: ['@modelcontextprotocol/*'], message: 'Só mcp/ conhece o SDK do MCP.' },
  { group: ['**/adapters/**'], message: 'Esta camada depende de portas, nunca de adapters.' },
  COMPOSE_ONLY_ROOT,
];

// `no-restricted-imports` não enxerga `import('...')`, então o import dinâmico é barrado por sintaxe.
const NO_DYNAMIC_IMPORT = [
  'error',
  {
    selector: 'ImportExpression',
    message: 'Esta camada não usa import dinâmico: ele contornaria as travas de import.',
  },
];

/**
 * @param {string[]} layers
 * @param {string} message
 */
const forbidLayers = (layers, message) =>
  layers.map((layer) => ({ group: [`**/${layer}/**`], message }));

const ABOVE_MESSAGE = 'Esta camada fica abaixo dos serviços e da camada MCP.';
const MCP_ABOVE_MESSAGE = 'Serviços ficam abaixo da camada MCP: nunca a importam.';

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
          COMPOSE_ONLY_ROOT,
          ...extraGroups,
        ],
      },
    ],
    'no-restricted-syntax': NO_DYNAMIC_IMPORT,
  },
});

// adapters implementam portas: nunca importam a camada de serviços nem a MCP. Sem as travas de
// builtin, de infra e de SDK das outras camadas: é aqui que o I/O mora.
const adaptersBlock = {
  files: ['src/adapters/**/*.ts'],
  rules: {
    'no-restricted-imports': [
      'error',
      {
        patterns: ['commands', 'queries', 'mcp'].map((layer) => ({
          group: [`**/${layer}/**`],
          message: `adapters implementam portas, nunca importam ${layer}.`,
        })),
      },
    ],
  },
};

// Scripts de leitura passam por compose.ts (D-25): nunca importam adapters nem a camada MCP.
// install.ts (arquivamento e instalação) e build.ts (bundle) são a exceção.
const scriptsBlock = {
  files: ['scripts/**/*.ts'],
  ignores: ['scripts/install.ts', 'scripts/build.ts'],
  rules: {
    'no-restricted-imports': [
      'error',
      {
        patterns: [
          { group: ['**/adapters/**'], message: 'Scripts de leitura passam por compose.ts.' },
          { group: ['**/mcp/**'], message: 'Scripts de leitura não importam a camada MCP.' },
        ],
      },
    ],
    'no-restricted-syntax': NO_DYNAMIC_IMPORT,
  },
};

export const boundaryBlocks = [
  restrictImports(['src/domain/**/*.ts'], {
    extraGroups: forbidLayers(
      ['commands', 'queries', 'mcp', 'shared'],
      'domain não importa camadas de fora do núcleo.',
    ),
  }),
  restrictImports(['src/shared/**/*.ts'], {
    extraGroups: forbidLayers(['commands', 'queries', 'mcp'], ABOVE_MESSAGE),
  }),
  // `ports.ts` está na raiz de `src/`, fora de qualquer glob de camada: só declara contratos.
  restrictImports(['src/ports.ts'], {
    extraGroups: forbidLayers(['commands', 'queries', 'mcp'], ABOVE_MESSAGE),
  }),
  restrictImports(['src/commands/**/*.ts'], {
    extraGroups: [
      ...forbidLayers(['queries'], 'commands não importa queries.'),
      ...forbidLayers(['mcp'], MCP_ABOVE_MESSAGE),
    ],
    extraRules: MAX_LINES,
  }),
  restrictImports(['src/queries/**/*.ts'], {
    extraGroups: [
      ...forbidLayers(['commands'], 'queries não importa commands.'),
      ...forbidLayers(['mcp'], MCP_ABOVE_MESSAGE),
    ],
    extraRules: MAX_LINES,
  }),
  adaptersBlock,
  mcpBlock(['src/mcp/**/*.ts']),
  mcpBlock(
    ['src/mcp/kernel.ts'],
    [{ group: ['**/tools/**'], message: 'O kernel MCP não importa tools.' }],
  ),
  scriptsBlock,
];
