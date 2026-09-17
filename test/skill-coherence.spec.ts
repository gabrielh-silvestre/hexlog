import { describe, test, expect } from '@jest/globals';
import * as fs from 'node:fs';
import * as path from 'node:path';
import {
  RESERVED_PROCESS_NAMES,
  RESERVED_TYPE_NAMES,
  BUILTIN_GATE_NAMES,
} from '../src/definitions.ts';

const repoRoot = path.resolve(__dirname, '..');
const SKILL_PATH = path.join(repoRoot, 'skills/hexlog/SKILL.md');

// ---- extração de tokens do SKILL.md (puras: recebem `content`, não leem arquivo) ----

/**
 * Remove blocos de código cercados (```) antes de extrair crase simples: o bloco de exemplo da skill
 * usa sintaxe de chamada completa (`tool({ campo: valor })`), não identificadores isolados que façam
 * sentido confrontar um a um contra o código.
 */
function stripFencedCodeBlocks(content: string): string {
  return content.replace(/```[\s\S]*?```/g, '');
}

/** Tokens entre crase simples (`` `x` ``), fora de blocos cercados. */
function extractInlineBackticks(content: string): string[] {
  return [...stripFencedCodeBlocks(content).matchAll(/`([^`]+)`/g)].map((m) => m[1]);
}

const SCREAMING_SNAKE_CASE = /^[A-Z][A-Z0-9_]*$/;
// snake/kebab minúsculo: nomes de tool (`register_vocabulary`) e valores reservados com hífen (`no-orphans`).
const LOWER_IDENTIFIER = /^[a-z][a-z0-9_-]*$/;
// Exige ao menos uma maiúscula depois da primeira letra: `^[a-z][a-zA-Z0-9]*$` sozinho também casaria
// com token minúsculo puro (`register`, `list`), que não é camelCase e não deve entrar nesta checagem.
const CAMEL_CASE_IDENTIFIER = /^[a-z][a-z0-9]*[A-Z][a-zA-Z0-9]*$/;

/** Nomes entre aspas do 1º argumento de cada `server.registerTool(` em `content`. */
function toolNamesFrom(content: string): string[] {
  return [...content.matchAll(/server\.registerTool\(\s*['"]([^'"]+)['"]/g)].map((m) => m[1]);
}

/** Nomes SCREAMING_SNAKE_CASE de `export const NOME` em `content`. */
function exportedConstantNamesFrom(content: string): string[] {
  return [...content.matchAll(/export const ([A-Za-z][A-Za-z0-9_]*)/g)]
    .map((m) => m[1])
    .filter((name) => SCREAMING_SNAKE_CASE.test(name));
}

/** Códigos do union literal `export type ErrorCode = 'A' | 'B' | ...;` em `content` (§4.13). */
function errorCodeCatalogFrom(content: string): string[] {
  const start = content.indexOf('export type ErrorCode =');
  const unionBlock = content.slice(start, content.indexOf(';', start));
  return [...unionBlock.matchAll(/'([A-Z_]+)'/g)].map((m) => m[1]);
}

/** Nomes de declarações de função (`export function X`, `async function X`, `function X`) em `content`. */
function functionNamesFrom(content: string): string[] {
  return [...content.matchAll(/(?:^|\s)function ([A-Za-z][A-Za-z0-9]*)/g)].map((m) => m[1]);
}

describe('extratores (unitário, sobre string literal)', () => {
  test('extractInlineBackticks ignora crase dentro de bloco cercado e pega a de fora', () => {
    const content = '`fora` texto\n```\n`dentro` não conta\n```\n`tambem-fora`';
    expect(extractInlineBackticks(content)).toEqual(['fora', 'tambem-fora']);
  });

  test('toolNamesFrom extrai o nome entre aspas do 1º argumento de server.registerTool(', () => {
    const content = `server.registerTool(\n    'minha_tool',\n    { title: 'X' },\n  );`;
    expect(toolNamesFrom(content)).toEqual(['minha_tool']);
  });

  test('exportedConstantNamesFrom pega só o SCREAMING_SNAKE_CASE, não nomes mistos como Registered', () => {
    const content = `export const MINHA_CONSTANTE = [1] as const;\nexport const Registered = z.object({});`;
    expect(exportedConstantNamesFrom(content)).toEqual(['MINHA_CONSTANTE']);
  });

  test('errorCodeCatalogFrom extrai os literais do union até o `;`, sem pegar o que vem depois', () => {
    const content = `export type ErrorCode =\n  | 'A'\n  | 'B';\nexport const OUTRA = 'C';`;
    expect(errorCodeCatalogFrom(content)).toEqual(['A', 'B']);
  });

  test('functionNamesFrom pega export function, async function e function simples', () => {
    const content = `export function minhaFuncao() {}\nasync function outraFuncao() {}\nfunction terceira() {}`;
    expect(functionNamesFrom(content)).toEqual(['minhaFuncao', 'outraFuncao', 'terceira']);
  });
});

// ---- catálogo real, extraído do código (nunca copiado à mão) ----

const registeredTools = ['src/definition-tools.ts', 'src/event-tools.ts'].flatMap((relativeFile) =>
  toolNamesFrom(fs.readFileSync(path.join(repoRoot, relativeFile), 'utf8')),
);

const exportedConstantNames = exportedConstantNamesFrom(
  fs.readFileSync(path.join(repoRoot, 'src/definitions.ts'), 'utf8'),
);

const errorCodeCatalog = errorCodeCatalogFrom(
  fs.readFileSync(path.join(repoRoot, 'src/errors.ts'), 'utf8'),
);

const srcDir = path.join(repoRoot, 'src');
const declaredFunctionNames = fs
  .readdirSync(srcDir)
  .filter((file) => file.endsWith('.ts'))
  .flatMap((file) => functionNamesFrom(fs.readFileSync(path.join(srcDir, file), 'utf8')));

const reservedNameValues: readonly string[] = [
  ...RESERVED_PROCESS_NAMES,
  ...RESERVED_TYPE_NAMES,
  ...BUILTIN_GATE_NAMES,
];

/**
 * SCREAMING_SNAKE_CASE citados na skill que não pertencem ao catálogo de `ErrorCode` por desenho, não
 * por erro de digitação:
 * - `UNKNOWN_VOCABULARY`: código de **aviso** (campo `result` do Veredito, vocabulário aberto), não um
 *   `ErrorCode` — a skill documenta essa distinção de propósito (ver teste dedicado abaixo).
 * - `TYPE_NOT_FIXED`: citado de propósito como contraste ("não `TYPE_NOT_FIXED`, esse código não
 *   existe") — a skill afirma que ele NÃO existe; exigi-lo no catálogo inverteria a checagem.
 */
const DELIBERATE_NON_ERROR_CODES = new Set(['UNKNOWN_VOCABULARY', 'TYPE_NOT_FIXED']);

/**
 * Palavras de domínio (campo/valor de exemplo) citadas em crase na skill que coincidem em forma
 * (lowercase, sem hífen) com nome de tool ou de valor reservado, mas não são nenhum dos dois — allow-
 * list explícita em vez de afrouxar o regex de identificador.
 */
const FIELD_NAME_ALLOWLIST = new Set([
  'owner',
  'name',
  'result',
  'gate',
  'id',
  'type',
  'agent',
  'data',
  'process',
  // campos de schema (z.object), não funções: `milestoneType` em event-tools.ts,
  // `builtinGates` em definition-tools.ts.
  'milestoneType',
  'builtinGates',
]);

// ---- tokens citados na skill hoje ----

const skillContent = fs.readFileSync(SKILL_PATH, 'utf8');
const backtickTokens = extractInlineBackticks(skillContent);
const citedScreamingSnakeTokens = [
  ...new Set(backtickTokens.filter((t) => SCREAMING_SNAKE_CASE.test(t))),
];
const citedLowerIdentifiers = [...new Set(backtickTokens.filter((t) => LOWER_IDENTIFIER.test(t)))];
const citedCamelCaseTokens = [
  ...new Set(backtickTokens.filter((t) => CAMEL_CASE_IDENTIFIER.test(t))),
];

describe('coerência SKILL.md × código', () => {
  test('a extração não está vazia (sanity: se a skill mudar de forma, isso quebra antes das checagens abaixo)', () => {
    expect(registeredTools.length).toBeGreaterThan(0);
    expect(citedScreamingSnakeTokens.length).toBeGreaterThan(0);
    expect(citedLowerIdentifiers.length).toBeGreaterThan(0);
    expect(errorCodeCatalog.length).toBeGreaterThan(0);
    expect(citedCamelCaseTokens.length).toBeGreaterThan(0);
  });

  test('toda tool citada na skill está de fato registrada (definition-tools.ts ou event-tools.ts)', () => {
    const known = new Set([...registeredTools, ...reservedNameValues, ...FIELD_NAME_ALLOWLIST]);
    const unknown = citedLowerIdentifiers.filter((token) => !known.has(token));
    expect(unknown).toEqual([]);
  });

  test('todo código SCREAMING_SNAKE_CASE citado existe no catálogo de erros, é constante exportada de definitions.ts, ou é um dos avisos/negativos documentados', () => {
    const known = new Set([
      ...errorCodeCatalog,
      ...exportedConstantNames,
      ...DELIBERATE_NON_ERROR_CODES,
    ]);
    const unknown = citedScreamingSnakeTokens.filter((token) => !known.has(token));
    expect(unknown).toEqual([]);
  });

  test('todo camelCase citado é função declarada em src/ ou campo de schema conhecido', () => {
    const known = new Set([...declaredFunctionNames, ...FIELD_NAME_ALLOWLIST]);
    const unknown = citedCamelCaseTokens.filter((token) => !known.has(token));
    expect(unknown).toEqual([]);
  });

  test('UNKNOWN_VOCABULARY não pertence ao catálogo de ErrorCode e é usado como código de aviso em event-tools.ts', () => {
    expect(errorCodeCatalog).not.toContain('UNKNOWN_VOCABULARY');
    const eventTools = fs.readFileSync(path.join(repoRoot, 'src/event-tools.ts'), 'utf8');
    expect(eventTools).toMatch(/code:\s*'UNKNOWN_VOCABULARY'/);
  });

  // A skill afirma que `TYPE_NOT_FIXED` não existe. Sem esta asserção ele só passaria pela
  // allow-list: alguém poderia acrescentar o código ao catálogo e a afirmação da skill viraria
  // mentira sem nada acusar.
  test('TYPE_NOT_FIXED continua ausente do código, como a skill afirma', () => {
    expect(errorCodeCatalog).not.toContain('TYPE_NOT_FIXED');
    expect(exportedConstantNames).not.toContain('TYPE_NOT_FIXED');
  });
});
