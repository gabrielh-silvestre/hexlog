import { describe, test, expect } from '@jest/globals';
import * as fs from 'node:fs';
import * as path from 'node:path';
import ts from 'typescript';
import { listNewTreeFiles, NEW_TREE_KNOWN_FILES, repoRoot, srcRoot } from './new-tree.ts';

const FLOW_TERMS = new Set([
  'phase',
  'fase',
  'plan',
  'plano',
  'critic',
  'milestone',
  'verdict',
  'claim',
  'omc',
]);

// Quebra nas fronteiras de camelCase, inclusive siglas ("HTTPServer" -> "HTTP", "Server").
function splitCamelCase(chunk: string): string[] {
  return chunk
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
    .split(' ')
    .map((word) => word.toLowerCase());
}

// Identificador: `_`, `-` e dígitos separam palavras.
const wordsOfIdentifier = (text: string): string[] =>
  text.split(/[^A-Za-z]+/).flatMap(splitCamelCase);

// Literal: qualquer caractere não alfanumérico separa; dígitos ficam colados à palavra.
const wordsOfLiteral = (text: string): string[] =>
  text.split(/[^A-Za-z0-9]+/).flatMap(splitCamelCase);

function wordsOfNode(node: ts.Node): string[] {
  if (ts.isIdentifier(node) || ts.isPrivateIdentifier(node)) return wordsOfIdentifier(node.text);
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) {
    return wordsOfLiteral(node.text);
  }
  if (ts.isTemplateHead(node) || ts.isTemplateMiddle(node) || ts.isTemplateTail(node)) {
    return wordsOfLiteral(node.text);
  }
  return [];
}

/** Termos de fluxo encontrados em identificadores e literais (nunca em comentários), com a linha. */
function findFlowTerms(fileName: string, code: string): string[] {
  const source = ts.createSourceFile(fileName, code, ts.ScriptTarget.Latest, false);
  const found: string[] = [];
  const visit = (node: ts.Node): void => {
    for (const word of wordsOfNode(node)) {
      if (!FLOW_TERMS.has(word)) continue;
      const { line } = source.getLineAndCharacterOfPosition(node.getStart(source));
      found.push(`${word}@${line + 1}`);
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return found;
}

describe('D1: árvore nova sem termo de fluxo', () => {
  test('a varredura acha os arquivos da árvore nova', () => {
    const scanned = listNewTreeFiles().map((file) => path.relative(srcRoot, file));
    expect(scanned).toEqual(expect.arrayContaining(NEW_TREE_KNOWN_FILES));
  });

  test('nenhum arquivo da árvore nova usa termo de fluxo em identificador ou literal', () => {
    const violations = listNewTreeFiles().flatMap((file) =>
      findFlowTerms(file, fs.readFileSync(file, 'utf8')).map(
        (hit) => `${path.relative(repoRoot, file)}: ${hit}`,
      ),
    );
    expect(violations).toEqual([]);
  });

  test.each([
    ['identificador', 'const phase = 1;', ['phase@1']],
    ['camelCase em identificador', 'function planArchive() {}', ['plan@1']],
    ['chave de objeto', 'const o = { milestone: 1 };', ['milestone@1']],
    ['snake_case e dígito', 'const omc_2 = 1;', ['omc@1']],
    ['literal de string', `const s = 'the verdict';`, ['verdict@1']],
    ['literal separado por hífen', `const s = 'plan-ready';`, ['plan@1']],
    ['literal em camelCase', `const s = 'claimOwner';`, ['claim@1']],
    ['parte de template', 'const s = `x ${y} fase`;', ['fase@1']],
    ['termo em português', 'const plano = 1;', ['plano@1']],
    ['linha correta', 'const a = 1;\nconst critic = 2;', ['critic@2']],
  ])('detecta %s', (_label, code, expected) => {
    expect(findFlowTerms('probe.ts', code)).toEqual(expected);
  });

  test.each([
    ['critical não casa critic', 'const critical = 1;'],
    ['planet não casa plan', 'const planet = 1;'],
    ['literal com palavra maior', `const s = 'explanation';`],
    ['dígito cola no literal', `const s = 'plan2';`],
    ['comentário é ignorado', '// phase and plan\n/* verdict */ const a = 1;'],
  ])('não dispara: %s', (_label, code) => {
    expect(findFlowTerms('probe.ts', code)).toEqual([]);
  });
});
