import { describe, test, expect } from '@jest/globals';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { z } from 'zod';
import { VERSION } from '../src/version.ts';
import { at, parseJson } from './helpers.ts';

const repoRoot = path.resolve(__dirname, '..');
const IGNORED_DIRS = new Set(['node_modules', 'dist', '.omc', '.git', 'coverage']);

// Forma de package.json que este arquivo lê (campos usados nas asserções abaixo).
const PackageSchema = z.object({
  dependencies: z.record(z.string(), z.string()),
  devDependencies: z.record(z.string(), z.string()),
  engines: z.record(z.string(), z.string()),
  version: z.string(),
  bin: z.unknown().optional(),
});

/** Lista recursivamente os arquivos com a extensão dada, pulando diretórios de build/dependências. */
function listFilesRecursive(dir: string, extension = '.ts'): string[] {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const filePath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      return IGNORED_DIRS.has(entry.name) ? [] : listFilesRecursive(filePath, extension);
    }
    return entry.name.endsWith(extension) ? [filePath] : [];
  });
}

/** Lista recursivamente todos os diretórios do repo, pulando node_modules/.git. */
function listDirectories(dir: string): string[] {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    if (!entry.isDirectory() || entry.name === 'node_modules' || entry.name === '.git') return [];
    const dirPath = path.join(dir, entry.name);
    return [dirPath, ...listDirectories(dirPath)];
  });
}

/** Extrai os especificadores de import/require de um arquivo TS (estático, via regex — sem parser de AST). */
function extractSpecifiers(content: string): string[] {
  const regexes = [
    /\bfrom\s+['"]([^'"]+)['"]/g,
    /\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
    /\bimport\s+['"]([^'"]+)['"]/g,
    /\brequire\(\s*['"]([^'"]+)['"]\s*\)/g,
  ];
  return regexes.flatMap((regex) => [...content.matchAll(regex)].map((m) => at(m, 1)));
}

/** Um especificador relativo (`.`) ou absoluto (`/`) que resolve para fora da raiz do repo. */
function leavesRepo(specifier: string, file: string): boolean {
  if (!specifier.startsWith('.') && !specifier.startsWith('/')) return false;
  const target = path.resolve(path.dirname(file), specifier);
  const relative = path.relative(repoRoot, target);
  return relative.startsWith('..') || path.isAbsolute(relative);
}

const FORBIDDEN_SERVER_MODULES = new Set(['http', 'https', 'http2', 'net']);

/**
 * true se `content` importa/requer (estático, dinâmico ou require) um módulo de servidor de
 * rede (http/https/http2/net) ou chama `.listen(`. Usa `extractSpecifiers` — que olha o
 * especificador do import, não o nome do símbolo importado — então não confunde `createServer`
 * próprio do hexlog (fábrica do `McpServer`, importado de `./mcp.ts`) com `http.createServer`.
 */
function usesNetworkServerModule(content: string): boolean {
  const importsForbiddenModule = extractSpecifiers(content).some((specifier) =>
    FORBIDDEN_SERVER_MODULES.has(specifier.replace(/^node:/, '')),
  );
  return importsForbiddenModule || content.includes('.listen(');
}

const pkg = parseJson(PackageSchema, fs.readFileSync(path.join(repoRoot, 'package.json'), 'utf8'));

describe('N7', () => {
  test('nenhum import relativo/absoluto em src/, hook/, scripts/ ou test/ sai do repo', () => {
    const files = ['src', 'hook', 'scripts', 'test'].flatMap((dir) =>
      listFilesRecursive(path.join(repoRoot, dir)),
    );
    const violations = files.flatMap((file) =>
      extractSpecifiers(fs.readFileSync(file, 'utf8'))
        .filter((specifier) => leavesRepo(specifier, file))
        .map((specifier) => `${path.relative(repoRoot, file)}: ${specifier}`),
    );
    expect(violations).toEqual([]);
  });
});

describe('N11', () => {
  // Nomes esperados: o conjunto de pacotes é travado, a versão não. Cada um fica em `^X.Y.Z` e o lock
  // fixa a resolvida.
  const EXPECTED_DEPENDENCIES = [
    '@modelcontextprotocol/server',
    'zod',
    'ajv',
    'ajv-formats',
    'canonicalize',
    'shell-quote',
    'jsonc-parser',
    'es-toolkit',
    'minisearch',
  ];
  const EXPECTED_DEV_DEPENDENCIES = [
    '@modelcontextprotocol/client',
    'jest',
    '@jest/globals',
    'ts-jest',
    'typescript',
    '@types/node',
    'fast-check',
    'esbuild',
    // Deps de lint/format do plano de quality-tooling (fora do conjunto inicial de dependências).
    'eslint',
    '@eslint/js',
    'typescript-eslint',
    'eslint-plugin-jest',
    'eslint-plugin-n',
    'prettier',
    'eslint-config-prettier',
    'husky',
    'lint-staged',
    'tar',
    // Rascunho do CHANGELOG.md a partir dos Conventional Commits (cliff.toml).
    'git-cliff',
    // Código, arquivo e dependência mortos no CI (knip.json).
    'knip',
    // Mensagem de commit no hook commit-msg e no CI (commitlint.config.js).
    '@commitlint/cli',
    '@commitlint/config-conventional',
    // Lint e ortografia dos `.md` no commit e no CI (.markdownlint-cli2.jsonc, cspell.json).
    'markdownlint-cli2',
    'cspell',
    '@cspell/dict-pt-br',
    // Teste de mutação dos unitários (stryker.config.json).
    '@stryker-mutator/core',
    '@stryker-mutator/jest-runner',
    '@stryker-mutator/typescript-checker',
  ];
  const CARET_RANGE = /^\^\d+\.\d+\.\d+$/;
  const outsideCaret = (deps: Record<string, string>) =>
    Object.entries(deps)
      .filter(([, range]) => !CARET_RANGE.test(range))
      .map(([name, range]) => `${name}@${range}`);

  test('dependencies tem exatamente os pacotes esperados, todos em ^X.Y.Z', () => {
    expect(Object.keys(pkg.dependencies).sort()).toEqual([...EXPECTED_DEPENDENCIES].sort());
    expect(outsideCaret(pkg.dependencies)).toEqual([]);
  });

  test('devDependencies tem exatamente os pacotes esperados, todos em ^X.Y.Z', () => {
    expect(Object.keys(pkg.devDependencies).sort()).toEqual([...EXPECTED_DEV_DEPENDENCIES].sort());
    expect(outsideCaret(pkg.devDependencies)).toEqual([]);
  });

  test('engines.node é >=24.18.1', () => {
    expect(pkg.engines).toEqual({ node: '>=24.18.1' });
  });

  test('VERSION de src/version.ts bate com package.json.version', () => {
    expect(VERSION).toBe(pkg.version);
  });

  test('.gitignore contém a linha dist/', () => {
    const gitignore = fs.readFileSync(path.join(repoRoot, '.gitignore'), 'utf8');
    expect(gitignore.split('\n')).toContain('dist/');
  });
});

describe('M5', () => {
  test('package.json não declara bin', () => {
    expect(pkg.bin).toBeUndefined();
  });

  test('nenhum arquivo em src/ importa módulo de servidor de rede nem chama .listen(', () => {
    // M5: hexlog é stdio-only — proíbe http/https/http2/net e `.listen(`.
    const violations = listFilesRecursive(path.join(repoRoot, 'src')).filter((file) =>
      usesNetworkServerModule(fs.readFileSync(file, 'utf8')),
    );
    expect(violations).toEqual([]);
  });

  test('não existe diretório cli no repo (fora de node_modules)', () => {
    const hasCliDir = listDirectories(repoRoot).some((dir) => path.basename(dir) === 'cli');
    expect(hasCliDir).toBe(false);
  });
});

describe('M6 (estático)', () => {
  test('nenhum arquivo .ts em src/ usa console de depuração ou process.stdout.write', () => {
    const FORBIDDEN_OUTPUT_REGEX =
      /console\.(log|info|debug|dir|table|trace)|process\.stdout\.write/;
    const violations = listFilesRecursive(path.join(repoRoot, 'src')).filter((file) =>
      FORBIDDEN_OUTPUT_REGEX.test(fs.readFileSync(file, 'utf8')),
    );
    expect(violations).toEqual([]);
  });
});

describe('I1 (parcial)', () => {
  test('src/directory.ts só importa node:* e es-toolkit, nunca zod/canonicalize/minisearch', () => {
    const content = fs.readFileSync(path.join(repoRoot, 'src/directory.ts'), 'utf8');
    const violations = extractSpecifiers(content).filter(
      (specifier) =>
        !specifier.startsWith('node:') &&
        specifier !== 'es-toolkit' &&
        !specifier.startsWith('es-toolkit/'),
    );
    expect(violations).toEqual([]);
  });
});
