import { describe, it, expect, beforeAll } from '@jest/globals';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { xor } from 'es-toolkit';
import { parseCatalog } from '../scripts/flow/critic-catalog.ts';
import { EXIT } from '../scripts/flow/critic-run.ts';
import { buildRules } from '../scripts/flow/critic-tools.ts';
import { parsePremises, scanPremises, type ScannedPremise } from '../scripts/flow/sync.ts';
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

// ---- fluxo do hexlog: o que o agente lê não ensina a se esquivar da checagem ----

// A regra de seleção da checagem mora só na skill dela; o que o CLAUDE.md importa não a cita.
const SELECTION_TERMS =
  /amostr|estrato|sorteio|sprt|semente|\bsampling\b|\bstrat(um|a)\b|\bseed\b/i;
const AUDIT_TERMS = /auditor|auditoria|\baudit/i;
const FLOW_DOC = 'docs/directives/fluxo-hexlog.md';
const FLOW_SKILLS = ['flow-run', 'flow-gaps', 'flow-audit', 'flow-owner-seat'];
// A cadeira do dono não conhece quem a ocupa nem o que ele registra.
const OWNER_SEAT_FORBIDDEN_TERMS = /\b(ask|autonomous|critic|answeredBy|simulated|SendMessage)\b/;
const OWNER_SEAT_DOC = 'docs/directives/cadeira-do-dono.md';
const OWNER_SEAT_BULLET_MAX_CHARS = 400;
const DIRECTIVES_DOC_CITATION = /docs\/directives\/[\w.-]+\.md/g;

const skillPath = (name: string): string => path.join(repoRoot, '.claude/skills', name, 'SKILL.md');

const flowDoc = (): string => fs.readFileSync(path.join(repoRoot, FLOW_DOC), 'utf8');
const skill = (name: string): string => fs.readFileSync(skillPath(name), 'utf8');

const catalog = parseCatalog(fs.readFileSync(path.join(repoRoot, OWNER_SEAT_DOC), 'utf8'));

/** Nomes citados na forma "ação `x`" ou "action `x`": a única forma que a trava fraca enxerga. */
const citedActionsIn = (text: string): string[] =>
  [...text.matchAll(/\b(?:ação|action) `([^`]+)`/g)].map(([, name = '']) => name);

/** Valores de cada literal `Nature: a|b|c` do texto. */
const natureLiteralsIn = (text: string): string[][] =>
  [...text.matchAll(/Nature: ((?:[a-z-]+\|)+[a-z-]+)/g)].map(([, values = '']) =>
    values.split('|'),
  );

/** Literais cujo conjunto de valores difere das naturezas do catálogo. */
const naturesDifferingFrom = (literals: string[][], natures: string[]): string[][] =>
  literals.filter((values) => xor(values, natures).length > 0);

/** Corpo de um `## <título>` até o próximo `## `. */
const sectionBodyOf = (text: string, title: string): string =>
  new RegExp(`^## ${title}$([\\s\\S]*?)(?=^## |(?![\\s\\S]))`, 'm').exec(text)?.[1] ?? '';

// Geração vigente ou futura; `directives-2` segue citado como corte de trabalhos antigos.
const currentGeneration = /directives-[4-9]/;

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

// O doc e a skill `flow-run` dizem a mesma frase: um caso em cada arquivo, a frase num lugar só.
const CREATE_PROCESS_FORBIDDEN = '`create_process` de `directives-N`';

describe('citedActionsIn', () => {
  it('should read only the form "action `x`" (or its Portuguese twin)', () => {
    const text = 'a ação `jury` e a action `web`, mas `local` solta e ações `x`';

    expect(citedActionsIn(text)).toEqual(['jury', 'web']);
  });
});

describe('naturesDifferingFrom', () => {
  const natures = ['repo-fact', 'external-fact', 'choice'];

  it('should flag a literal that drops or adds a nature', () => {
    const literals = natureLiteralsIn(
      'Nature: repo-fact|choice e Nature: repo-fact|external-fact|choice|guess',
    );

    expect(naturesDifferingFrom(literals, natures)).toHaveLength(2);
  });

  it('should accept a literal with the catalog natures in any order', () => {
    const literals = natureLiteralsIn('Nature: choice|repo-fact|external-fact');

    expect(naturesDifferingFrom(literals, natures)).toEqual([]);
  });
});

describe('linksWithOffsetFrom', () => {
  it('should report positions comparable with manualMarkerOffsetFrom on the same text', () => {
    const content = '[a](x.md)\n## Manual Notes\n[b](y.md#s)';
    const marker = manualMarkerOffsetFrom(content);

    expect(linksWithOffsetFrom(content).map((link) => [link.target, link.index > marker])).toEqual([
      ['x.md', false],
      ['y.md', true],
    ]);
  });
});

describe('relativeLinkTargetsFrom', () => {
  it('should ignore URLs, bare anchors and fenced blocks, and strip the anchor from the target', () => {
    const content = [
      '[a](docs/a.md#secao) [b](https://x.dev/b.md) [c](#topo) [d](../d.md)',
      '```',
      '[e](nao-existe.md)',
      '```',
    ].join('\n');

    expect(relativeLinkTargetsFrom(content)).toEqual(['docs/a.md', '../d.md']);
  });
});

describe('atImportsFrom', () => {
  it('should read only a `@path` alone on its line', () => {
    expect(atImportsFrom('@AGENTS.md\ntexto @fora.md\n@docs/x.md')).toEqual([
      'AGENTS.md',
      'docs/x.md',
    ]);
  });
});

describe('headingCitationsFrom', () => {
  it('should split the citation into path and title', () => {
    expect(headingCitationsFrom('veja `docs/AGENTS.md#Common Patterns` e `src/a.ts#f`')).toEqual([
      { file: 'docs/AGENTS.md', title: 'Common Patterns' },
    ]);
  });
});

describe('headingTitlesFrom', () => {
  it('should read the heading text', () => {
    expect(headingTitlesFrom('# Um\n### Common Patterns \n```\n# fora\n```')).toEqual([
      'Um',
      'Common Patterns',
    ]);
  });
});

describe('scanPremises', () => {
  it('should split slug, a statement containing `: ` and the Ver link, and flag a malformed line', () => {
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

describe('SELECTION_TERMS', () => {
  it('should match the selection terms in Portuguese and English', () => {
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
  });

  it('should ignore common prose', () => {
    for (const text of ['estratégia', 'demonstrar', 'needs']) {
      expect(SELECTION_TERMS.test(text)).toBe(false);
    }
  });
});

describe('README.md, CLAUDE.md, **/AGENTS.md and docs/**/*.md', () => {
  // Sanidade: sem ela a trava passaria lendo uma coleção vazia.
  it('should collect the covered documents and leave docs/pesquisa out', () => {
    const relative = documents.map((file) => path.relative(repoRoot, file));

    expect(relative).toEqual(
      expect.arrayContaining(['README.md', 'CLAUDE.md', 'AGENTS.md', 'docs/AGENTS.md']),
    );
    expect(relative.some((file) => file.startsWith('docs/pesquisa/'))).toBe(false);
  });

  it('should resolve every relative markdown link to an existing file', () => {
    const broken = documents.flatMap((file) =>
      relativeLinkTargetsFrom(fs.readFileSync(file, 'utf8'))
        .filter((target) => !fs.existsSync(path.resolve(path.dirname(file), target)))
        .map((target) => `${path.relative(repoRoot, file)} → ${target}`),
    );

    expect(broken).toEqual([]);
  });

  // O caminho da citação vale a partir da raiz do repositório (`docs/AGENTS.md#...`) ou da pasta do documento.
  it('should point every `path.md#title` citation to an existing file with that title', () => {
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

describe('CLAUDE.md', () => {
  it('should resolve every `@path` to an existing file', () => {
    const imports = claudeMdImports();

    expect(imports.length).toBeGreaterThan(0);
    expect(imports.filter((target) => !fs.existsSync(path.resolve(repoRoot, target)))).toEqual([]);
  });

  it('should import every living doc, with fluxo-hexlog.md first and convencoes.md next', () => {
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

  it('should keep what it imports within 1000 lines in total', () => {
    const total = claudeMdImports().reduce(
      (sum, target) => sum + lineCount(path.join(repoRoot, target)),
      0,
    );

    expect(total).toBeLessThanOrEqual(IMPORTED_MAX_LINES);
  });

  it('should import estrategia.md after fluxo-hexlog.md and convencoes.md', () => {
    const imports = claudeMdImports();
    const position = (target: string): number => imports.indexOf(target);

    expect(position(STRATEGY_DOC)).toBeGreaterThan(position('docs/directives/convencoes.md'));
    expect(position('docs/directives/convencoes.md')).toBeGreaterThan(position(FLOW_DOC));
    expect(position(FLOW_DOC)).toBeGreaterThanOrEqual(0);
  });

  it('should import no doc that matches the selection terms', () => {
    const imported = claudeMdImports();
    const hits = imported.filter((target) =>
      SELECTION_TERMS.test(fs.readFileSync(path.join(repoRoot, target), 'utf8')),
    );

    expect(imported).toContain(FLOW_DOC);
    expect(hits).toEqual([]);
  });
});

describe('docs/directives/*.md', () => {
  // Sanidade: sem ela a trava passaria sem achar doc nenhum.
  it('should find the living docs', () => {
    expect(livingDocs).toEqual(expect.arrayContaining(['convencoes.md', 'fronteiras.md']));
  });

  it('should keep every living doc within 150 lines', () => {
    const tooLong = livingDocs.filter(
      (name) => lineCount(path.join(directivesDir, name)) > LIVING_DOC_MAX_LINES,
    );

    expect(tooLong).toEqual([]);
  });
});

describe('**/AGENTS.md', () => {
  const agentsFiles = documents.filter((file) => path.basename(file) === 'AGENTS.md');

  // Sanidade: sem ela a trava passaria sem achar o `AGENTS.md` de `test/fixtures`.
  it('should collect the AGENTS.md of the root, src and test/fixtures', () => {
    const relative = agentsFiles.map((file) => path.relative(repoRoot, file));

    expect(relative).toEqual(
      expect.arrayContaining(['AGENTS.md', 'src/AGENTS.md', 'test/fixtures/AGENTS.md']),
    );
  });

  it('should have none of the headings the extraction removed', () => {
    const found = agentsFiles.flatMap((file) =>
      headingTitlesFrom(fs.readFileSync(file, 'utf8'))
        .filter((title) => EXTRACTED_HEADINGS.includes(title))
        .map((title) => `${path.relative(repoRoot, file)} → ${title}`),
    );

    expect(found).toEqual([]);
  });

  it('should link to docs/directives/ only after the Manual Notes heading', () => {
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

describe('docs/directives/fluxo-hexlog.md', () => {
  // `directives-4` só prova que o token existe: `directives-2` segue citado como corte de trabalhos
  // antigos, então a prova do processo vigente está em "processo vigente de diretrizes escrito num lugar só".
  it.each([
    'rests-on',
    'fills-gap',
    'directives-4',
    'premise.objective',
    'directives.estrategia.none',
  ])('should cite `%s`', (token) => {
    expect(flowDoc()).toContain(token);
  });

  it('should not mention the audit check either', () => {
    expect(AUDIT_TERMS.test(flowDoc())).toBe(false);
  });

  it('should cite the current generation only in the "Processo das diretrizes vigente" line', () => {
    const lines = flowDoc()
      .split('\n')
      .filter((line) => currentGeneration.test(line));

    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain('Processo das diretrizes vigente:');
    expect(flowDoc()).not.toMatch(/process: directives-\d/);
  });

  it('should name `directives-4` as the current process and `directives-5` as the next generation', () => {
    const line = flowDoc()
      .split('\n')
      .find((candidate) => candidate.includes('Processo das diretrizes vigente:'));

    expect(line).toContain('vigente: `directives-4`');
    expect(line).toContain('vira `directives-5`');
  });

  it('should forbid the agent from `create_process` of `directives-N`', () => {
    expect(flowDoc()).toContain(CREATE_PROCESS_FORBIDDEN);
  });

  it('should not say the timeless premise lives in directives-2', () => {
    expect(flowDoc()).not.toContain('mora em `directives-2`');
  });
});

describe('docs/directives/estrategia.md', () => {
  const strategyPath = path.join(repoRoot, STRATEGY_DOC);
  let content: string;
  let premises: ScannedPremise[];

  beforeAll(() => {
    content = fs.readFileSync(strategyPath, 'utf8');
    ({ premises } = scanPremises(content));
  });

  it('should fit in 150 lines', () => {
    expect(lineCount(strategyPath)).toBeLessThanOrEqual(LIVING_DOC_MAX_LINES);
  });

  it('should have the 6 theme sections and the sentinel one, in that order', () => {
    const themes = headingTitlesFrom(content);

    expect(themes.slice(1)).toEqual([...STRATEGY_THEMES, SENTINEL_THEME]);
  });

  it('should have every premise line matching the format, with a unique slug and a statement of 1 to 255 code points', () => {
    const { malformed } = parsePremises(content);

    expect(malformed).toEqual([]);
  });

  it('should have at least one premise in every theme', () => {
    const empty = STRATEGY_THEMES.filter(
      (theme) => !premises.some((premise) => premise.theme === theme),
    );

    expect(empty).toEqual([]);
  });

  it('should end every premise except the sentinel with a relative `Ver:` link', () => {
    const withoutLink = premises
      .filter((premise) => premise.slug !== SENTINEL_SLUG)
      .filter((premise) => relativeLinkTargetsFrom(premise.ver ?? '').length === 0);

    expect(withoutLink.map((premise) => premise.slug)).toEqual([]);
  });

  it('should have the `none` sentinel, without a `Ver:` link', () => {
    expect(premises.find((premise) => premise.slug === SENTINEL_SLUG)).toMatchObject({
      theme: SENTINEL_THEME,
      ver: undefined,
    });
  });
});

describe('.claude/skills/flow-*/SKILL.md', () => {
  it('should declare a `name` equal to its folder', () => {
    const wrong = FLOW_SKILLS.filter((name) => skillNameFrom(skill(name)) !== name);

    expect(wrong).toEqual([]);
  });

  it('should cite only existing docs/directives/ paths, fluxo-hexlog.md among them', () => {
    const cited = FLOW_SKILLS.flatMap((name) => {
      const content = skill(name);
      return [...content.matchAll(DIRECTIVES_DOC_CITATION)].map(([citation]) => citation);
    });

    expect(cited).toContain(FLOW_DOC);
    expect(cited.filter((citation) => !fs.existsSync(path.join(repoRoot, citation)))).toEqual([]);
  });

  it.each(FLOW_SKILLS)('should cite docs/directives/estrategia.md in %s', (name) => {
    expect(skill(name)).toContain(STRATEGY_DOC);
  });

  it('should keep the owner-seat skill unaware of who occupies the seat', () => {
    expect(skill('flow-owner-seat')).not.toMatch(OWNER_SEAT_FORBIDDEN_TERMS);
  });

  it('should list in every `Nature:` literal exactly the natures of the catalog', () => {
    const literals = FLOW_SKILLS.flatMap((name) => natureLiteralsIn(skill(name)));

    expect(literals.length).toBeGreaterThan(0);
    expect(naturesDifferingFrom(literals, Object.keys(catalog.choice))).toEqual([]);
  });

  it.each(['flow-run', 'flow-gaps'])('should leave `Unavailable:` out of %s', (name) => {
    expect(skill(name)).not.toContain('Unavailable:');
  });

  it.each([
    'Consultar o hexlog ou os docs diretamente não é a ação `local`',
    'Sem `actionUsed` fixado a ação indisponível não degrada',
    'Comum: só quando a evidência local (hexlog, docs, ADRs) não decide. Crítica: exigida.',
  ])('should leave the contract sentence only in the owner-seat doc: %s', (sentence) => {
    expect(FLOW_SKILLS.filter((name) => skill(name).includes(sentence))).toEqual([]);
  });
});

describe('.claude/skills/flow-owner-seat/SKILL.md', () => {
  it('should not carry the numbered list of the context actions', () => {
    expect(skill('flow-owner-seat')).not.toMatch(/^\d+\. \*\*/m);
  });

  it('should point to the action catalog of the owner-seat doc', () => {
    expect(skill('flow-owner-seat')).toContain('## Catálogo de ações');
    expect(skill('flow-owner-seat')).toContain(OWNER_SEAT_DOC);
  });

  it('should keep the nested subagent launch with `TaskStop`', () => {
    expect(skill('flow-owner-seat')).toContain('`TaskStop`');
  });

  it('should cite no action outside the catalog (weak guard: only the form "action `x`")', () => {
    expect(
      citedActionsIn(skill('flow-owner-seat')).filter((name) => !(name in catalog.actions)),
    ).toEqual([]);
  });
});

describe('buildRules', () => {
  it('should cite no action outside the catalog in the base rules (weak guard: only the form "action `x`")', () => {
    const rules = buildRules('');

    expect(citedActionsIn(rules).filter((name) => !(name in catalog.actions))).toEqual([]);
  });
});

describe('docs/directives/cadeira-do-dono.md', () => {
  const ownerSeatDoc = (): string => fs.readFileSync(path.join(repoRoot, OWNER_SEAT_DOC), 'utf8');

  it('should keep every bullet within 400 characters', () => {
    const tooLong = ownerSeatDoc()
      .split('\n')
      .filter((line) => line.startsWith('- ') && line.length > OWNER_SEAT_BULLET_MAX_CHARS);

    expect(tooLong).toEqual([]);
  });

  it('should end the critic only at the end of the work, with no `TaskStop`', () => {
    expect(ownerSeatDoc()).toContain('O `critic` é encerrado só no fim do trabalho');
    expect(ownerSeatDoc()).not.toContain('TaskStop');
  });

  it('should say the simulated occupant does not sit without a pinned `answeredBy`', () => {
    expect(ownerSeatDoc()).toContain('Sem `answeredBy` fixado o ocupante simulado não senta');
  });

  it('should cite the subagent protocol', () => {
    expect(ownerSeatDoc()).toMatch(/protocolo do subagente/i);
  });
});

describe('.claude/skills/flow-run/SKILL.md', () => {
  it('should neither pin the current generation nor point to the process without a generation', () => {
    expect(skill('flow-run')).not.toMatch(currentGeneration);
    expect(skill('flow-run')).not.toMatch(/process: directives\b(?!-)/);
  });

  it('should forbid the agent from `create_process` of `directives-N`', () => {
    expect(skill('flow-run')).toContain(CREATE_PROCESS_FORBIDDEN);
  });

  it('should say the simulated occupant does not sit without a pinned `answeredBy`', () => {
    expect(skill('flow-run')).toContain('Sem `answeredBy` fixado o ocupante simulado não senta');
  });

  it('should detect the occupant by `describe_type` and pick the Herdr or runner transport', () => {
    expect(skill('flow-run')).toContain('`describe_type` com `process`');
    expect(skill('flow-run')).toContain('`HERDR_ENV`');
    expect(skill('flow-run')).toContain('critic.ts start');
  });

  it('should run the durable critic, read the neutral skill and close the tool list', () => {
    const run = skill('flow-run');

    expect(run).toContain('## 6. Cadeira do dono');
    expect(run).toContain('`Read` de `.claude/skills/flow-owner-seat/SKILL.md`');
    expect(run).toContain('`query`, `describe_type`, `register`, `attach`, `read_attachment`');
    expect(run).toContain('SendMessage');
    expect(run).toContain('critic.ts ask');
    expect(run).toContain('critic.ts close');
    expect(run).toContain('critic.md');
    expect(run).toContain(OWNER_SEAT_DOC);
  });

  it('should cite the subagent protocol', () => {
    expect(skill('flow-run')).toMatch(/protocolo do subagente/i);
  });

  it('should cite no action outside the catalog in section 6 (weak guard: only the form "action `x`")', () => {
    const section = sectionBodyOf(skill('flow-run'), '6\\. Cadeira do dono');

    expect(citedActionsIn(section).length).toBeGreaterThan(0);
    expect(citedActionsIn(section).filter((name) => !(name in catalog.actions))).toEqual([]);
  });

  it('should write the gap literal with the class and the catalog natures', () => {
    const [literal] = natureLiteralsIn(skill('flow-run'));

    expect(skill('flow-run')).toContain('`Class: common|critical[; rule: <target>]; Nature: ');
    expect(literal).toEqual(Object.keys(catalog.choice));
  });

  it('should generate the rules file for the Herdr critic and point the Claude one to it in one line', () => {
    const run = skill('flow-run');

    expect(run).toContain('node scripts/flow/critic.ts rules --tool <claude|agy> --cwd <worktree>');
    expect(run).not.toContain('.ignore/flow/<slug>/critic-rules.txt');
    expect(run).toContain(
      '--append-system-prompt "Antes de qualquer resposta, leia com Read o arquivo <caminho do arquivo de regras>, que traz suas regras e o catálogo de ações, e releia-o se o contexto for compactado."',
    );
  });

  it('should prefix every agy prompt with the rules file instead of the old constant', () => {
    expect(skill('flow-run')).toContain('começa pelo conteúdo do arquivo de regras');
    expect(skill('flow-run')).not.toContain('CRITIC_RULES');
  });

  it('should have the critic look up the pending simulated premise with `actionUsed`', () => {
    expect(skill('flow-run')).toContain('`fields: ["statement","answeredBy","actionUsed"]`');
  });

  it('should show the degradation mark at the approval, with the expectation computed by the main session', () => {
    const approval = /^5\. `evaluate_gate` de `gaps`.*$/m.exec(
      sectionBodyOf(skill('flow-run'), '5\\. Pré-PR'),
    )?.[0];

    expect(approval).toContain('`fields: ["statement","answeredBy","actionUsed"]`');
    expect(approval).toContain('com o `Class` e o `Nature` do literal que você mesmo escreveu');
    expect(approval).toContain('"degradada: esperada X, usada Y"');
    expect(approval).toContain('o esperado nunca vem do cabeçalho do `attach`');
  });

  describe('with the runner transport section', () => {
    const runnerSection = (): string =>
      /^### Transporte runner$([\s\S]*?)(?=^#{2,3} |(?![\s\S]))/m.exec(skill('flow-run'))?.[1] ??
      '';

    it.each(Object.values(EXIT))('should cite the exit code %i', (code) => {
      expect(runnerSection()).toMatch(new RegExp(`(?<!\\d)${code}(?!\\d)`));
    });

    it.each([
      ['the question size cap', '100000'],
      ['the tool of critic.md on returning to start', '--tool <ferramenta do critic.md>'],
      ['the tool variable', 'HEXLOG_CRITIC_CLI'],
      ['the unreadable catalog exit', '"unreadable catalog"'],
    ])('should cite %s', (_what, fragment) => {
      expect(runnerSection()).toContain(fragment);
    });
  });
});

describe('.claude/skills/flow-gaps/SKILL.md', () => {
  it('should keep the human seat and say approval does not hold against a timeless premise', () => {
    const gaps = skill('flow-gaps');

    expect(gaps).toContain('O assento aqui é sempre humano');
    expect(gaps).toContain('Aprovar não vale para contradição com premissa atemporal');
  });

  it('should follow the action catalog when the owner asks for context', () => {
    expect(skill('flow-gaps')).toContain('siga o catálogo de ações do mesmo doc');
    expect(skill('flow-gaps')).not.toContain('ações de contexto da skill');
  });

  it('should present the `Nature:` of the gap with its context', () => {
    expect(skill('flow-gaps')).toContain('com o `Nature:` da lacuna');
  });
});

describe('.claude/skills/flow-audit/SKILL.md', () => {
  it('should cover the current generation and the earlier ones without pinning the number', () => {
    expect(skill('flow-audit')).toContain('o processo de diretrizes vigente');
    expect(skill('flow-audit')).toContain('as gerações anteriores');
    expect(skill('flow-audit')).not.toMatch(/directives-\d/);
  });
});

describe('docs/directives/adr-0010-camada-sobre-omc.md', () => {
  it('should end with the block of amendments that starts at 2026-10-06', () => {
    const adr = fs.readFileSync(path.join(directivesDir, 'adr-0010-camada-sobre-omc.md'), 'utf8');

    expect(lastBlockOf(adr)).toMatch(/^- \*\*2026-10-06/);
  });

  it('should keep the 2026-10-16 amendment in the last block', () => {
    const adr = fs.readFileSync(path.join(directivesDir, 'adr-0010-camada-sobre-omc.md'), 'utf8');

    expect(lastBlockOf(adr)).toContain('\n- **2026-10-16');
  });
});

describe('docs/directives/adr-0011-camada-estrategica.md', () => {
  it.each(['Context', 'Decision', 'Consequences'])('should have the "%s" section', (title) => {
    const adr = fs.readFileSync(path.join(directivesDir, 'adr-0011-camada-estrategica.md'), 'utf8');

    expect(headingTitlesFrom(adr)).toContain(title);
  });

  it('should end with the 2026-10-16 amendment', () => {
    const adr = fs.readFileSync(path.join(directivesDir, 'adr-0011-camada-estrategica.md'), 'utf8');

    expect(lastBlockOf(adr)).toMatch(/^- \*\*2026-10-16/);
  });
});

describe('docs/directives/adr-0012-cadeira-do-dono.md', () => {
  it.each(['Context', 'Decision', 'Emendas aos ADRs 0010 e 0011', 'Consequences'])(
    'should have the "%s" section',
    (title) => {
      const adr = fs.readFileSync(path.join(directivesDir, 'adr-0012-cadeira-do-dono.md'), 'utf8');

      expect(headingTitlesFrom(adr)).toContain(title);
    },
  );
});
