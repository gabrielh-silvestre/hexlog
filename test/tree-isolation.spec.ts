import { describe, test, expect } from '@jest/globals';
import * as fs from 'node:fs';
import * as path from 'node:path';
import ts from 'typescript';
import {
  NEW_TREE_DIRS,
  NEW_TREE_KNOWN_FILES,
  listNewTreeFiles,
  repoRoot,
  srcRoot,
} from './new-tree.ts';

const PREVIEW_SERVER = path.join(repoRoot, 'test', 'fixtures', 'preview-server.ts');
const NON_LITERAL = '<non-literal>';

// Módulos da raiz legada que a árvore nova pode importar, e os arquivos de topo da própria árvore.
const ALLOWED_TARGETS = new Set(
  ['errors', 'directory', 'version', 'ports', 'compose', 'archive'].map((name) =>
    path.join(srcRoot, name),
  ),
);

const stripExtension = (target: string): string => target.replace(/\.(ts|js)$/, '');

const literalText = (node: ts.Node | undefined): string =>
  node && ts.isStringLiteralLike(node) ? node.text : NON_LITERAL;

/** Especificadores de import estático, `import type`, `export … from`, `import()` e `import x = require()`. */
function specifiersOf(code: string): string[] {
  const source = ts.createSourceFile('probe.ts', code, ts.ScriptTarget.Latest, false);
  const found: string[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) {
      if (node.moduleSpecifier) found.push(literalText(node.moduleSpecifier));
    } else if (ts.isImportEqualsDeclaration(node)) {
      if (ts.isExternalModuleReference(node.moduleReference)) {
        found.push(literalText(node.moduleReference.expression));
      }
    } else if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword) {
      found.push(literalText(node.arguments[0]));
    } else if (ts.isImportTypeNode(node)) {
      found.push(
        ts.isLiteralTypeNode(node.argument) ? literalText(node.argument.literal) : NON_LITERAL,
      );
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return found;
}

function isInsideNewTree(target: string): boolean {
  return (
    ALLOWED_TARGETS.has(stripExtension(target)) ||
    NEW_TREE_DIRS.some((dir) => target.startsWith(dir + path.sep))
  );
}

/** Imports de `file` que saem da árvore nova; módulos de pacote e `node:` não contam. */
function forbiddenImports(file: string, code: string): string[] {
  return specifiersOf(code).filter((specifier) => {
    if (specifier === NON_LITERAL) return true;
    if (!specifier.startsWith('.')) return false;
    return !isInsideNewTree(path.resolve(path.dirname(file), specifier));
  });
}

describe('P6: árvore nova isolada da raiz legada', () => {
  test('a varredura acha os arquivos da árvore nova', () => {
    const scanned = listNewTreeFiles([PREVIEW_SERVER]);
    expect(scanned.map((file) => path.relative(srcRoot, file))).toEqual(
      expect.arrayContaining(NEW_TREE_KNOWN_FILES),
    );
  });

  test('a árvore nova e a entry de prévia só importam errors, directory, version ou a própria árvore', () => {
    const violations = listNewTreeFiles([PREVIEW_SERVER]).flatMap((file) =>
      forbiddenImports(file, fs.readFileSync(file, 'utf8')).map(
        (specifier) => `${path.relative(repoRoot, file)}: ${specifier}`,
      ),
    );
    expect(violations).toEqual([]);
  });

  const probe = path.join(srcRoot, 'domain', 'probe.ts');

  test.each([
    ['import estático da raiz legada', `import { x } from '../log.ts';`],
    ['import type', `import type { X } from '../events.ts';`],
    ['export from', `export { x } from '../guard.ts';`],
    ['export * from', `export * from '../state.ts';`],
    ['import dinâmico', `export const load = () => import('../storage.ts');`],
    ['import dinâmico não literal', `export const load = (m: string) => import(m);`],
    ['import() em tipo', `export type T = import('../chain.ts').Link;`],
    ['import = require', `import log = require('../log.ts');`],
    ['import só de efeito', `import '../server.ts';`],
    ['pasta de nome parecido com a da árvore nova', `import { x } from '../domainx/a.ts';`],
  ])('detecta %s', (_label, code) => {
    expect(forbiddenImports(probe, code)).toHaveLength(1);
  });

  test.each([
    ['raiz permitida', `import { HexlogError } from '../errors.ts';`],
    ['directory e version', `import '../directory.ts';\nimport '../version.ts';`],
    ['irmão da árvore nova', `import { x } from './ids.ts';`],
    ['outra camada nova', `import { x } from '../shared/loader.ts';`],
    ['compose e archive', `import '../compose.ts';\nimport '../archive.ts';`],
    ['pacote e node:', `import * as fs from 'node:fs';\nimport { z } from 'zod';`],
    ['export sem from', `const a = 1;\nexport { a };`],
  ])('não dispara: %s', (_label, code) => {
    expect(forbiddenImports(probe, code)).toEqual([]);
  });

  test('a entry de prévia fora de src alcança a árvore nova por caminho relativo', () => {
    // Montado por path para o texto cru não parecer um import que sai do repo em test/package.spec.ts.
    const composeFromPreview = path.relative(
      path.dirname(PREVIEW_SERVER),
      path.join(srcRoot, 'compose.ts'),
    );
    expect(
      forbiddenImports(PREVIEW_SERVER, `import { compose } from '${composeFromPreview}';`),
    ).toEqual([]);
  });
});
