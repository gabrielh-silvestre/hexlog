import { describe, test, expect } from '@jest/globals';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { z } from 'zod';
import { VERSION } from '../src/version.ts';
import { parseJson } from './helpers.ts';

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
  return regexes.flatMap((regex) => [...content.matchAll(regex)].map((m) => m[1]));
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
  return importsForbiddenModule || /\.listen\(/.test(content);
}

const pkg = parseJson(PackageSchema, fs.readFileSync(path.join(repoRoot, 'package.json'), 'utf8'));

describe('N7', () => {
  test('package.json não depende de xstate, hexnucleus, core.poc-motor-log nem uuid', () => {
    const allDeps = { ...pkg.dependencies, ...pkg.devDependencies };
    for (const forbidden of ['xstate', 'hexnucleus', 'core.poc-motor-log', 'uuid']) {
      expect(allDeps).not.toHaveProperty(forbidden);
    }
  });

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

describe('S6', () => {
  test('zod está fixado em 4.6.5', () => {
    expect(pkg.dependencies.zod).toBe('4.6.5');
  });
});

describe('N11', () => {
  // Manifesto literal de §2.2 — versões exatas (npm install --save-exact).
  const EXPECTED_DEPENDENCIES = {
    '@modelcontextprotocol/server': '2.0.0',
    zod: '4.6.5',
    ajv: '8.20.0',
    'ajv-formats': '3.0.1',
    canonicalize: '5.0.0',
    'shell-quote': '1.10.0',
    'jsonc-parser': '3.3.1',
    'es-toolkit': '1.52.0',
    minisearch: '7.2.0',
  };
  const EXPECTED_DEV_DEPENDENCIES = {
    '@modelcontextprotocol/client': '2.0.0',
    jest: '30.5.1',
    '@jest/globals': '30.5.1',
    'ts-jest': '29.4.12',
    typescript: '5.9.2',
    '@types/node': '24.8.1',
    '@types/shell-quote': '1.7.5',
    'fast-check': '4.10.1',
    esbuild: '0.28.2',
    // Deps de lint/format do plano de quality-tooling (fora do manifesto de §2.2).
    eslint: '10.10.0',
    '@eslint/js': '10.0.1',
    'typescript-eslint': '8.70.0',
    prettier: '3.9.7',
    'eslint-config-prettier': '10.1.8',
    husky: '9.1.7',
    'lint-staged': '17.5.1',
  };

  test('dependencies bate exatamente com o manifesto de §2.2 (sem ^/~/faixas)', () => {
    expect(pkg.dependencies).toEqual(EXPECTED_DEPENDENCIES);
  });

  test('devDependencies bate exatamente com o manifesto de §2.2 (sem ^/~/faixas)', () => {
    expect(pkg.devDependencies).toEqual(EXPECTED_DEV_DEPENDENCIES);
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
    // §M5: hexlog é stdio-only — proíbe http/https/http2/net e `.listen(`.
    const violations = listFilesRecursive(path.join(repoRoot, 'src')).filter((file) =>
      usesNetworkServerModule(fs.readFileSync(file, 'utf8')),
    );
    expect(violations).toEqual([]);
  });

  test('detecta import estático de módulo de servidor de rede (from)', () => {
    expect(usesNetworkServerModule(`import { createServer } from 'node:http';`)).toBe(true);
  });

  test('detecta require de módulo de servidor de rede', () => {
    expect(usesNetworkServerModule(`const http = require('node:http');`)).toBe(true);
  });

  test('detecta import dinâmico de módulo de servidor de rede', () => {
    expect(usesNetworkServerModule(`const http = await import('node:http');`)).toBe(true);
  });

  test('detecta chamada .listen(', () => {
    expect(usesNetworkServerModule('server.listen(3000);')).toBe(true);
  });

  test('não dispara em createServer que não vem de módulo de servidor de rede (fábrica do hexlog)', () => {
    expect(usesNetworkServerModule(`import { createServer } from './mcp.ts';`)).toBe(false);
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
