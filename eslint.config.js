import js from '@eslint/js';
import { defineConfig } from 'eslint/config';
import eslintConfigPrettier from 'eslint-config-prettier/flat';
import jest from 'eslint-plugin-jest';
import n from 'eslint-plugin-n';
import tseslint from 'typescript-eslint';
import { boundaryBlocks } from './eslint.boundaries.js';

export default defineConfig(
  {
    ignores: [
      'dist/**',
      'coverage/**',
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
      'jest/expect-expect': [
        'error',
        { assertFunctionNames: ['expect', 'expectError', 'expectDeduplicated'] },
      ],
    },
  },
  {
    languageOptions: {
      parserOptions: {
        projectService: { allowDefaultProject: ['eslint.config.js', 'eslint.boundaries.js'] },
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
    ignores: [
      'test/helpers.ts',
      'test/global-setup.ts',
      // temporário: a F6 apaga estes specs
      'test/{attachments,event-tools,log,audit-types,definitions}.spec.ts',
    ],
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
