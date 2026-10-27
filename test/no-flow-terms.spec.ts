import { describe, it, expect } from '@jest/globals';
import * as fs from 'node:fs';
import * as path from 'node:path';
import ts from 'typescript';
import { listFiles } from './helpers.ts';

const repoRoot = path.resolve(__dirname, '..');
const SCANNED_DIRS = ['src', 'hook', 'scripts'];
// `scripts/flow/` é código do fluxo por definição (`sync-plan`, `planSync` e `SyncPlan` usam `plan`).
const FLOW_SCRIPTS_DIR = path.join('scripts', 'flow') + path.sep;

// Arquivos que a varredura tem de achar, senão um filtro quebrado a faria passar sem olhar nada.
const KNOWN_FILES = [
  'src/domain/chain.ts',
  'src/mcp/kernel.ts',
  'hook/bash-guard.ts',
  'scripts/build.ts',
];

/** Arquivos .ts de src/, hook/ e scripts/ (menos scripts/flow/), em qualquer profundidade. */
function listScannedFiles(): string[] {
  return SCANNED_DIRS.flatMap((dir) => listFiles(path.join(repoRoot, dir), '.ts')).filter(
    (file) => !file.startsWith(path.join(repoRoot, FLOW_SCRIPTS_DIR)),
  );
}

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

describe('{src,hook,scripts}/**/*.ts', () => {
  it('should find the files of src/, hook/ and scripts/ in the scan', () => {
    const scanned = listScannedFiles().map((file) => path.relative(repoRoot, file));

    expect(scanned).toEqual(expect.arrayContaining(KNOWN_FILES));
  });

  it('should use no flow term in any identifier or literal of src/, hook/ or scripts/', () => {
    const violations = listScannedFiles().flatMap((file) =>
      findFlowTerms(file, fs.readFileSync(file, 'utf8')).map(
        (hit) => `${path.relative(repoRoot, file)}: ${hit}`,
      ),
    );

    expect(violations).toEqual([]);
  });
});

describe('findFlowTerms', () => {
  it.each([
    ['an identifier', 'const phase = 1;', ['phase@1']],
    ['a camelCase identifier', 'function planArchive() {}', ['plan@1']],
    ['an object key', 'const o = { milestone: 1 };', ['milestone@1']],
    ['a snake_case identifier with a digit', 'const omc_2 = 1;', ['omc@1']],
    ['a string literal', `const s = 'the verdict';`, ['verdict@1']],
    ['a hyphen-separated literal', `const s = 'plan-ready';`, ['plan@1']],
    ['a camelCase literal', `const s = 'claimOwner';`, ['claim@1']],
    ['a template part', 'const s = `x ${y} fase`;', ['fase@1']],
    ['a Portuguese term', 'const plano = 1;', ['plano@1']],
    ['a later line, reporting its number', 'const a = 1;\nconst critic = 2;', ['critic@2']],
  ])('should detect a flow term in %s', (_label, code, expected) => {
    expect(findFlowTerms('probe.ts', code)).toEqual(expected);
  });

  it.each([
    ['critical, which is not critic', 'const critical = 1;'],
    ['planet, which is not plan', 'const planet = 1;'],
    ['a literal with a longer word', `const s = 'explanation';`],
    ['a digit glued to the literal', `const s = 'plan2';`],
    ['a comment', '// phase and plan\n/* verdict */ const a = 1;'],
  ])('should not flag %s', (_label, code) => {
    expect(findFlowTerms('probe.ts', code)).toEqual([]);
  });
});
