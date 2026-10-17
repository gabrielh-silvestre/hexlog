import js from '@eslint/js';
import { defineConfig } from 'eslint/config';
import eslintConfigPrettier from 'eslint-config-prettier/flat';
import jest from 'eslint-plugin-jest';
import n from 'eslint-plugin-n';
import tseslint from 'typescript-eslint';
import { boundaryBlocks } from './eslint.boundaries.js';

// Padrão de escrita dos specs (docs/directives/convencoes.md, "Escrita dos testes").
const ACCENT = '[À-ÖØ-öø-ÿ]';
const ID_LABEL =
  '\\b(?:M|N|S|B|I|C|Q|QN|P|TF|TM|TB|SL|SE|E|G|L|f)\\d+\\b|\\b(?:R|U)-\\d+\\b|\\bD-\\d{2}\\b|\\bDE-\\d{2}\\b';

export default defineConfig(
  {
    ignores: [
      'dist/**',
      'coverage/**',
      'reports/**',
      '.stryker-tmp/**',
      '.ignore/**',
      'graphify-out/**',
      '.gitnexus/**',
      '.omc/**',
      '.claude/workflows/**',
      'node_modules/**',
      'test/fixtures/boundaries/**',
    ],
  },
  js.configs.recommended,
  tseslint.configs.recommendedTypeChecked,
  tseslint.configs.stylisticTypeChecked,
  n.configs['flat/recommended-module'],
  {
    files: ['test/**/*.ts'],
    ...jest.configs['flat/recommended'],
    rules: {
      ...jest.configs['flat/recommended'].rules,
      // `itNotRoot` (test/guard.spec.ts) é o `test` que pula como root.
      'jest/no-standalone-expect': ['error', { additionalTestBlockFunctions: ['itNotRoot'] }],
      'jest/expect-expect': [
        'error',
        {
          assertFunctionNames: [
            'expect',
            'expectError',
            'expectDeduplicated',
            'expectDenied',
            'expectAllowed',
          ],
        },
      ],
    },
  },
  {
    // Só specs: test/cleanup.ts tem afterAll no topo.
    files: ['test/**/*.spec.ts'],
    ignores: [
      'test/shared/**',
      'test/adapters/**',
      'test/queries/**',
      'test/commands/**',
      'test/mcp/**',
      'test/*.spec.ts',
    ],
    rules: {
      'jest/consistent-test-it': ['error', { fn: 'it', withinDescribe: 'it' }],
      'jest/valid-title': [
        'error',
        {
          mustMatch: { it: ['^should ', 'it titles start with "should "'] },
          mustNotMatch: {
            describe: [
              `${ID_LABEL}|${ACCENT}`,
              'describe titles carry no ID label and no accented letter',
            ],
            it: [ACCENT, 'titles are in English'],
          },
        },
      ],
      'jest/max-nested-describe': ['error', { max: 2 }],
      'jest/require-top-level-describe': 'error',
      'jest/padding-around-expect-groups': 'error',
    },
  },
  {
    languageOptions: {
      parserOptions: {
        projectService: {
          allowDefaultProject: ['eslint.config.js', 'eslint.boundaries.js', 'commitlint.config.js'],
        },
        tsconfigRootDir: import.meta.dirname,
      },
    },
  },
  {
    rules: {
      '@typescript-eslint/consistent-type-definitions': ['error', 'type'],
    },
  },
  {
    files: ['test/**/*.ts'],
    ignores: ['test/helpers.ts', 'test/global-setup.ts'],
    // Flat config não mescla opções de regra: outro bloco com `no-restricted-syntax` que case
    // `test/**` substitui esta lista (o último vence), então novos seletores entram aqui.
    rules: {
      'no-restricted-syntax': [
        'error',
        ...[
          "CallExpression[callee.name='mkdtempSync']",
          "CallExpression[callee.property.name='mkdtempSync']",
        ].map((selector) => ({
          selector,
          message:
            'Use createTempDir from test/helpers.ts: it registers the directory for cleanup.',
        })),
      ],
    },
  },
  ...boundaryBlocks,
  eslintConfigPrettier,
);
