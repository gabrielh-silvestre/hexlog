import { describe, test, expect, beforeAll } from '@jest/globals';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { parsePremises, scanPremises, type ScannedPremise } from '../.claude/hooks/flow-sync.ts';
import { at } from './helpers.ts';

const repoRoot = path.resolve(__dirname, '..');
const pesquisaDir = path.join(repoRoot, 'docs/pesquisa');
const directivesDir = path.join(repoRoot, 'docs/directives');

// Tetos de contexto: o que o `CLAUDE.md` importa chega a toda sessão e a todo subagente.
const LIVING_DOC_MAX_LINES = 150;
const IMPORTED_MAX_LINES = 1000;

// Títulos que a extração tirou dos `AGENTS.md`: a regra mora nos docs vivos de `docs/directives/`.
const EXTRACTED_HEADINGS = [
  'Fronteiras',
  'Working In This Directory',
  'Testing Requirements',
  'Common Patterns',
];

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

/** Alvo (sem âncora) e posição de cada `[texto](alvo)` em `content`, já sem blocos cercados. */
function linksWithOffsetFrom(content: string): { target: string; index: number }[] {
  return [...stripFencedCodeBlocks(content).matchAll(/\]\(([^)\s]+)\)/g)].map((m) => ({
    target: at(m, 1).split('#')[0] ?? '',
    index: m.index,
  }));
}

/** Posição do título `## Manual Notes` em `content` sem blocos cercados, ou -1 sem o título. */
function manualMarkerOffsetFrom(content: string): number {
  return stripFencedCodeBlocks(content).indexOf('## Manual Notes');
}

describe('link and citation extraction (unit, over a string literal)', () => {
  test('linksWithOffsetFrom and manualMarkerOffsetFrom measure the position in the same text', () => {
    const content = '[a](x.md)\n## Manual Notes\n[b](y.md#s)';
    const marker = manualMarkerOffsetFrom(content);
    expect(linksWithOffsetFrom(content).map((link) => [link.target, link.index > marker])).toEqual([
      ['x.md', false],
      ['y.md', true],
    ]);
  });

  test('relativeLinkTargetsFrom ignores URLs, bare anchors and fenced blocks, and strips the anchor from the target', () => {
    const content = [
      '[a](docs/a.md#secao) [b](https://x.dev/b.md) [c](#topo) [d](../d.md)',
      '```',
      '[e](nao-existe.md)',
      '```',
    ].join('\n');
    expect(relativeLinkTargetsFrom(content)).toEqual(['docs/a.md', '../d.md']);
  });

  test('atImportsFrom reads only a `@path` alone on its line', () => {
    expect(atImportsFrom('@AGENTS.md\ntexto @fora.md\n@docs/x.md')).toEqual([
      'AGENTS.md',
      'docs/x.md',
    ]);
  });

  test('headingCitationsFrom splits path and title, and headingTitlesFrom reads the heading text', () => {
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

describe('repository documents', () => {
  test('the collection is not empty (sanity: the lock does not pass by reading nothing)', () => {
    const relative = documents.map((file) => path.relative(repoRoot, file));
    expect(relative).toEqual(
      expect.arrayContaining(['README.md', 'CLAUDE.md', 'AGENTS.md', 'docs/AGENTS.md']),
    );
    expect(relative.some((file) => file.startsWith('docs/pesquisa/'))).toBe(false);
  });

  test('every relative markdown link resolves to an existing file', () => {
    const broken = documents.flatMap((file) =>
      relativeLinkTargetsFrom(fs.readFileSync(file, 'utf8'))
        .filter((target) => !fs.existsSync(path.resolve(path.dirname(file), target)))
        .map((target) => `${path.relative(repoRoot, file)} → ${target}`),
    );
    expect(broken).toEqual([]);
  });

  test('every `@path` in CLAUDE.md exists', () => {
    const claudeMd = path.join(repoRoot, 'CLAUDE.md');
    const imports = atImportsFrom(fs.readFileSync(claudeMd, 'utf8'));
    expect(imports.length).toBeGreaterThan(0);
    expect(imports.filter((target) => !fs.existsSync(path.resolve(repoRoot, target)))).toEqual([]);
  });

  // O caminho da citação vale a partir da raiz do repositório (`docs/AGENTS.md#...`) ou da pasta do documento.
  test('every `path.md#title` citation points to an existing file with that title', () => {
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

// ---- docs vivos e extração das regras dos AGENTS.md ----

const claudeMdPath = path.join(repoRoot, 'CLAUDE.md');

const claudeMdImports = (): string[] => atImportsFrom(fs.readFileSync(claudeMdPath, 'utf8'));

/** Docs vivos: o que sobra em `docs/directives/` sem o `AGENTS.md` (só navegação) e sem os ADRs. */
const livingDocs = fs
  .readdirSync(directivesDir)
  .filter((name) => name.endsWith('.md') && name !== 'AGENTS.md' && !name.startsWith('adr-'));

function lineCount(file: string): number {
  return fs.readFileSync(file, 'utf8').split('\n').length - 1;
}

describe('living docs in docs/directives', () => {
  test('the collection is not empty (sanity: the lock does not pass by finding no doc)', () => {
    expect(livingDocs).toEqual(expect.arrayContaining(['convencoes.md', 'fronteiras.md']));
  });

  test('every living doc is imported by CLAUDE.md, with fluxo-hexlog.md first and convencoes.md next', () => {
    const importedLivingDocs = claudeMdImports().filter((target) =>
      livingDocs.includes(path.basename(target)),
    );
    expect(importedLivingDocs).toEqual(
      expect.arrayContaining(livingDocs.map((name) => `docs/directives/${name}`)),
    );
    expect(importedLivingDocs.slice(0, 2)).toEqual([
      'docs/directives/fluxo-hexlog.md',
      'docs/directives/convencoes.md',
    ]);
  });

  test('every living doc fits in 150 lines and what CLAUDE.md imports fits in 1000 in total', () => {
    const tooLong = livingDocs.filter(
      (name) => lineCount(path.join(directivesDir, name)) > LIVING_DOC_MAX_LINES,
    );
    expect(tooLong).toEqual([]);

    const total = claudeMdImports().reduce(
      (sum, target) => sum + lineCount(path.join(repoRoot, target)),
      0,
    );
    expect(total).toBeLessThanOrEqual(IMPORTED_MAX_LINES);
  });
});

describe('AGENTS.md after the rules extraction', () => {
  const agentsFiles = documents.filter((file) => path.basename(file) === 'AGENTS.md');

  test('the collection includes the AGENTS.md of test/fixtures (sanity)', () => {
    const relative = agentsFiles.map((file) => path.relative(repoRoot, file));
    expect(relative).toEqual(
      expect.arrayContaining(['AGENTS.md', 'src/AGENTS.md', 'test/fixtures/AGENTS.md']),
    );
  });

  test('no AGENTS.md has the headings the extraction removed', () => {
    const found = agentsFiles.flatMap((file) =>
      headingTitlesFrom(fs.readFileSync(file, 'utf8'))
        .filter((title) => EXTRACTED_HEADINGS.includes(title))
        .map((title) => `${path.relative(repoRoot, file)} → ${title}`),
    );
    expect(found).toEqual([]);
  });

  test('the link to docs/directives/ comes after the Manual Notes heading', () => {
    const misplaced = agentsFiles
      .filter((file) => path.dirname(file) !== directivesDir)
      .flatMap((file) => {
        const content = fs.readFileSync(file, 'utf8');
        const marker = manualMarkerOffsetFrom(content);
        return linksWithOffsetFrom(content)
          .filter(({ target }) =>
            path.resolve(path.dirname(file), target).startsWith(`${directivesDir}${path.sep}`),
          )
          .filter(({ index }) => marker === -1 || index < marker)
          .map(({ target }) => `${path.relative(repoRoot, file)} → ${target}`);
      });
    expect(misplaced).toEqual([]);
  });
});

// ---- fluxo do hexlog: o que o agente lê não ensina a se esquivar da checagem ----

// A regra de seleção da checagem mora só na skill dela; o que o CLAUDE.md importa não a cita.
const SELECTION_TERMS =
  /amostr|estrato|sorteio|sprt|semente|\bsampling\b|\bstrat(um|a)\b|\bseed\b/i;
const AUDIT_TERMS = /auditor|auditoria|\baudit/i;
const FLOW_DOC = 'docs/directives/fluxo-hexlog.md';
const FLOW_SKILLS = ['flow-run', 'flow-gaps', 'flow-audit'];
const DIRECTIVES_DOC_CITATION = /docs\/directives\/[\w.-]+\.md/g;

const skillPath = (name: string): string => path.join(repoRoot, '.claude/skills', name, 'SKILL.md');

/** Nome declarado no frontmatter de um `SKILL.md`, ou `undefined` sem `name:`. */
function skillNameFrom(content: string): string | undefined {
  return /^name:\s*(\S+)$/m.exec(content)?.[1];
}

/** Último bloco do texto: o que vem depois da última linha em branco. */
function lastBlockOf(content: string): string {
  return (
    content
      .trim()
      .split(/\n\s*\n/)
      .at(-1) ?? ''
  );
}

describe('audit selection terms kept out of what the agent reads', () => {
  test('the terms regex matches in Portuguese and English and ignores common prose (unit)', () => {
    for (const text of [
      'amostragem',
      'Estrato alto',
      'sorteio',
      'SPRT',
      'semente',
      'seed',
      'strata',
    ]) {
      expect(SELECTION_TERMS.test(text)).toBe(true);
    }
    for (const text of ['estratégia', 'demonstrar', 'needs']) {
      expect(SELECTION_TERMS.test(text)).toBe(false);
    }
  });

  test('no doc imported by CLAUDE.md matches the selection terms', () => {
    const imported = claudeMdImports();
    expect(imported).toContain(FLOW_DOC);
    const hits = imported.filter((target) =>
      SELECTION_TERMS.test(fs.readFileSync(path.join(repoRoot, target), 'utf8')),
    );
    expect(hits).toEqual([]);
  });

  test('fluxo-hexlog.md does not mention the audit check either', () => {
    expect(AUDIT_TERMS.test(fs.readFileSync(path.join(repoRoot, FLOW_DOC), 'utf8'))).toBe(false);
  });
});

// ---- estratégia: premissas atemporais em formato determinístico ----

const STRATEGY_DOC = 'docs/directives/estrategia.md';
const STRATEGY_THEMES = [
  'Stack',
  'Integridade de dados',
  'Contrato público',
  'Segurança e riscos aceitos',
  'Escopo e processo',
  'Propósito e modos de uso',
];
const SENTINEL_THEME = 'Nenhuma premissa se aplica';
const SENTINEL_SLUG = 'none';
describe('premise extraction (unit, over a string literal)', () => {
  test('scanPremises splits slug, a statement containing `: ` and the Ver link, and flags a malformed line', () => {
    const content = [
      '## Tema',
      '- `a-b`: Regra: com dois pontos. Ver: [x.md](x.md).',
      '- `none`: Sem premissa.',
      '- sem crase: linha ruim',
    ].join('\n');
    expect(scanPremises(content)).toEqual({
      premises: [
        {
          theme: 'Tema',
          slug: 'a-b',
          statement: 'Regra: com dois pontos.',
          ver: '[x.md](x.md).',
        },
        { theme: 'Tema', slug: 'none', statement: 'Sem premissa.', ver: undefined },
      ],
      malformed: ['- sem crase: linha ruim'],
    });
  });
});

describe('estrategia.md', () => {
  const strategyPath = path.join(repoRoot, STRATEGY_DOC);

  test('is imported by CLAUDE.md after fluxo-hexlog.md and convencoes.md', () => {
    const imports = claudeMdImports();
    const position = (target: string): number => imports.indexOf(target);
    expect(position(STRATEGY_DOC)).toBeGreaterThan(position('docs/directives/convencoes.md'));
    expect(position('docs/directives/convencoes.md')).toBeGreaterThan(position(FLOW_DOC));
    expect(position(FLOW_DOC)).toBeGreaterThanOrEqual(0);
  });

  test('fits in 150 lines', () => {
    expect(lineCount(strategyPath)).toBeLessThanOrEqual(LIVING_DOC_MAX_LINES);
  });
});

describe('estrategia.md premises', () => {
  let content: string;
  let premises: ScannedPremise[];
  let malformed: string[];

  beforeAll(() => {
    content = fs.readFileSync(path.join(repoRoot, STRATEGY_DOC), 'utf8');
    ({ premises } = scanPremises(content));
    ({ malformed } = parsePremises(content));
  });

  test('has the 6 theme sections and the sentinel one, in that order', () => {
    const themes = headingTitlesFrom(content);
    expect(themes.slice(1)).toEqual([...STRATEGY_THEMES, SENTINEL_THEME]);
  });

  test('every premise line matches the format, with a unique slug and a statement of 1 to 255 code points', () => {
    expect(malformed).toEqual([]);
  });

  test('every theme has at least one premise', () => {
    const empty = STRATEGY_THEMES.filter(
      (theme) => !premises.some((premise) => premise.theme === theme),
    );
    expect(empty).toEqual([]);
  });

  test('every premise except the sentinel ends with a relative `Ver:` link', () => {
    const withoutLink = premises
      .filter((premise) => premise.slug !== SENTINEL_SLUG)
      .filter((premise) => relativeLinkTargetsFrom(premise.ver ?? '').length === 0);
    expect(withoutLink.map((premise) => premise.slug)).toEqual([]);
  });

  test('the `none` sentinel exists, without a `Ver:` link', () => {
    expect(premises.find((premise) => premise.slug === SENTINEL_SLUG)).toMatchObject({
      theme: SENTINEL_THEME,
      ver: undefined,
    });
  });
});

describe('fluxo-hexlog.md with the strategic layer', () => {
  // `directives-3` só prova que o token existe: `directives-2` segue citado como corte de trabalhos
  // antigos, então a prova do processo vigente está em "processo vigente de diretrizes escrito num lugar só".
  test.each([
    'rests-on',
    'fills-gap',
    'directives-3',
    'premise.objective',
    'directives.estrategia.none',
  ])('cites `%s`', (token) => {
    expect(fs.readFileSync(path.join(repoRoot, FLOW_DOC), 'utf8')).toContain(token);
  });
});

describe('current directives process written in a single place', () => {
  const flowDoc = (): string => fs.readFileSync(path.join(repoRoot, FLOW_DOC), 'utf8');
  const skill = (name: string): string => fs.readFileSync(skillPath(name), 'utf8');
  // Geração vigente ou futura; `directives-2` segue citado como corte de trabalhos antigos.
  const currentGeneration = /directives-[3-9]/;

  test('only the "Processo das diretrizes vigente" line of fluxo-hexlog.md cites the current generation', () => {
    const lines = flowDoc()
      .split('\n')
      .filter((line) => currentGeneration.test(line));
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain('Processo das diretrizes vigente:');
    expect(flowDoc()).not.toMatch(/process: directives-\d/);
  });

  test('the current process is `directives-3` and the next generation is `directives-4`', () => {
    const line = flowDoc()
      .split('\n')
      .find((candidate) => candidate.includes('Processo das diretrizes vigente:'));
    expect(line).toContain('vigente: `directives-3`');
    expect(line).toContain('vira `directives-4`');
  });

  test('flow-run neither pins the current generation nor points to the process without a generation', () => {
    expect(skill('flow-run')).not.toMatch(currentGeneration);
    expect(skill('flow-run')).not.toMatch(/process: directives\b(?!-)/);
  });

  test.each([
    ['the doc', (): string => flowDoc()],
    ['the flow-run skill', (): string => skill('flow-run')],
  ])('%s forbids the agent from `create_process` of `directives-N`', (_label, read) => {
    expect(read()).toContain('`create_process` de `directives-N`');
  });

  test('flow-audit covers the current generation and the earlier ones without pinning the number', () => {
    expect(skill('flow-audit')).toContain('o processo de diretrizes vigente');
    expect(skill('flow-audit')).toContain('as gerações anteriores');
    expect(skill('flow-audit')).not.toMatch(/directives-\d/);
  });

  test('the timeless premise does not "mora em `directives-2`"', () => {
    expect(flowDoc()).not.toContain('mora em `directives-2`');
  });
});

describe('local flow skills', () => {
  test('every skill has `name` equal to its folder', () => {
    const wrong = FLOW_SKILLS.filter(
      (name) => skillNameFrom(fs.readFileSync(skillPath(name), 'utf8')) !== name,
    );
    expect(wrong).toEqual([]);
  });

  test('cite only existing docs/directives/ paths, fluxo-hexlog.md among them', () => {
    const cited = FLOW_SKILLS.flatMap((name) => {
      const content = fs.readFileSync(skillPath(name), 'utf8');
      return [...content.matchAll(DIRECTIVES_DOC_CITATION)].map(([citation]) => citation);
    });
    expect(cited).toContain(FLOW_DOC);
    expect(cited.filter((citation) => !fs.existsSync(path.join(repoRoot, citation)))).toEqual([]);
  });
});

describe('local skills cite the strategy', () => {
  test.each(FLOW_SKILLS)('%s cites docs/directives/estrategia.md', (name) => {
    expect(fs.readFileSync(skillPath(name), 'utf8')).toContain(STRATEGY_DOC);
  });
});

describe('ADR 0010 after the flow amendment', () => {
  test('the last block of the file is the 2026-10-06 amendment', () => {
    const adr = fs.readFileSync(path.join(directivesDir, 'adr-0010-camada-sobre-omc.md'), 'utf8');
    expect(lastBlockOf(adr)).toMatch(/^- \*\*2026-10-06/);
  });
});

describe('ADR 0011 of the strategic layer', () => {
  test.each(['Context', 'Decision', 'Consequences'])('has the "%s" section', (title) => {
    const adr = fs.readFileSync(path.join(directivesDir, 'adr-0011-camada-estrategica.md'), 'utf8');
    expect(headingTitlesFrom(adr)).toContain(title);
  });
});
