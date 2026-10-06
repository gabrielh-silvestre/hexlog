import { describe, test, expect } from '@jest/globals';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { at } from './helpers.ts';

const repoRoot = path.resolve(__dirname, '..');
const pesquisaDir = path.join(repoRoot, 'docs/pesquisa');

// Pastas de ponto (`.git`, `.omc`, `.ignore`, `.gitnexus`...) também ficam de fora.
const IGNORED_DIR_NAMES = new Set(['node_modules', 'graphify-out']);

function isIgnoredDir(name: string): boolean {
  return IGNORED_DIR_NAMES.has(name) || name.startsWith('.') || name.startsWith('brag-output');
}

/** Todo `.md` sob `dir`, sem entrar em pasta ignorada nem em `docs/pesquisa/` (congelada). */
function markdownFilesUnder(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      return isIgnoredDir(entry.name) || full === pesquisaDir ? [] : markdownFilesUnder(full);
    }
    return entry.name.endsWith('.md') ? [full] : [];
  });
}

/** Documentos cobertos: `README.md`, `CLAUDE.md`, todo `AGENTS.md` e tudo de `docs/`. */
function isCoveredDocument(file: string): boolean {
  const relative = path.relative(repoRoot, file);
  return (
    relative === 'README.md' ||
    relative === 'CLAUDE.md' ||
    path.basename(file) === 'AGENTS.md' ||
    relative.startsWith('docs/')
  );
}

const documents = markdownFilesUnder(repoRoot).filter(isCoveredDocument);

// ---- extração (puras: recebem `content`, não leem arquivo) ----

/** Remove blocos de código cercados (```): exemplos de sintaxe não são links nem citações reais. */
function stripFencedCodeBlocks(content: string): string {
  return content.replace(/```[\s\S]*?```/g, '');
}

/** Alvos de `[texto](alvo)` que apontam para o repositório: sem esquema (`https:`) e sem âncora pura (`#x`). */
function relativeLinkTargetsFrom(content: string): string[] {
  return [...stripFencedCodeBlocks(content).matchAll(/\]\(([^)\s]+)\)/g)]
    .map((m) => at(m, 1))
    .filter((target) => !/^[a-z][a-z0-9+.-]*:/i.test(target) && !target.startsWith('#'))
    .map((target) => target.split('#')[0] ?? '');
}

/** Caminhos de `@caminho` (import do `CLAUDE.md`) no início de linha. */
function atImportsFrom(content: string): string[] {
  return [...stripFencedCodeBlocks(content).matchAll(/^@(\S+)$/gm)].map((m) => at(m, 1));
}

/** Citações `` `caminho.md#título` `` entre crase simples, já separadas em caminho e título. */
function headingCitationsFrom(content: string): { file: string; title: string }[] {
  return [...stripFencedCodeBlocks(content).matchAll(/`([^`\s#]+\.md)#([^`]+)`/g)].map((m) => ({
    file: at(m, 1),
    title: at(m, 2),
  }));
}

/** Títulos (texto depois do `#`) de todos os cabeçalhos de `content`, fora de blocos cercados. */
function headingTitlesFrom(content: string): string[] {
  return [...stripFencedCodeBlocks(content).matchAll(/^#{1,6}\s+(.+?)\s*$/gm)].map((m) => at(m, 1));
}

describe('extração de links e citações (unitário, sobre string literal)', () => {
  test('relativeLinkTargetsFrom ignora URL, âncora pura e bloco cercado, e tira a âncora do alvo', () => {
    const content = [
      '[a](docs/a.md#secao) [b](https://x.dev/b.md) [c](#topo) [d](../d.md)',
      '```',
      '[e](nao-existe.md)',
      '```',
    ].join('\n');
    expect(relativeLinkTargetsFrom(content)).toEqual(['docs/a.md', '../d.md']);
  });

  test('atImportsFrom lê só `@caminho` sozinho na linha', () => {
    expect(atImportsFrom('@AGENTS.md\ntexto @fora.md\n@docs/x.md')).toEqual([
      'AGENTS.md',
      'docs/x.md',
    ]);
  });

  test('headingCitationsFrom separa caminho e título, e headingTitlesFrom lê o texto do cabeçalho', () => {
    expect(headingCitationsFrom('veja `docs/AGENTS.md#Common Patterns` e `src/a.ts#f`')).toEqual([
      { file: 'docs/AGENTS.md', title: 'Common Patterns' },
    ]);
    expect(headingTitlesFrom('# Um\n### Common Patterns \n```\n# fora\n```')).toEqual([
      'Um',
      'Common Patterns',
    ]);
  });
});

// ---- links e citações dos documentos reais ----

describe('documentos do repositório', () => {
  test('a coleta não está vazia (sanity: a trava não passa por não ler nada)', () => {
    const relative = documents.map((file) => path.relative(repoRoot, file));
    expect(relative).toEqual(
      expect.arrayContaining(['README.md', 'CLAUDE.md', 'AGENTS.md', 'docs/AGENTS.md']),
    );
    expect(relative.some((file) => file.startsWith('docs/pesquisa/'))).toBe(false);
  });

  test('todo link markdown relativo resolve para arquivo existente', () => {
    const broken = documents.flatMap((file) =>
      relativeLinkTargetsFrom(fs.readFileSync(file, 'utf8'))
        .filter((target) => !fs.existsSync(path.resolve(path.dirname(file), target)))
        .map((target) => `${path.relative(repoRoot, file)} → ${target}`),
    );
    expect(broken).toEqual([]);
  });

  test('todo `@caminho` do CLAUDE.md existe', () => {
    const claudeMd = path.join(repoRoot, 'CLAUDE.md');
    const imports = atImportsFrom(fs.readFileSync(claudeMd, 'utf8'));
    expect(imports.length).toBeGreaterThan(0);
    expect(imports.filter((target) => !fs.existsSync(path.resolve(repoRoot, target)))).toEqual([]);
  });

  // O caminho da citação vale a partir da raiz do repositório (`docs/AGENTS.md#...`) ou da pasta do documento.
  test('toda citação `caminho.md#título` aponta para arquivo existente com esse título', () => {
    const broken = documents.flatMap((file) =>
      headingCitationsFrom(fs.readFileSync(file, 'utf8')).flatMap(({ file: cited, title }) => {
        const target = [repoRoot, path.dirname(file)]
          .map((base) => path.resolve(base, cited))
          .find((candidate) => fs.existsSync(candidate));
        const titles =
          target === undefined ? [] : headingTitlesFrom(fs.readFileSync(target, 'utf8'));
        return titles.includes(title)
          ? []
          : [`${path.relative(repoRoot, file)} → ${cited}#${title}`];
      }),
    );
    expect(broken).toEqual([]);
  });
});
