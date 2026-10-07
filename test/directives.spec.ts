import { describe, test, expect, beforeAll } from '@jest/globals';
import * as fs from 'node:fs';
import * as path from 'node:path';
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

/** Posição do marcador `<!-- MANUAL` em `content` sem blocos cercados, ou -1 sem marcador. */
function manualMarkerOffsetFrom(content: string): number {
  return stripFencedCodeBlocks(content).indexOf('<!-- MANUAL');
}

describe('extração de links e citações (unitário, sobre string literal)', () => {
  test('linksWithOffsetFrom e manualMarkerOffsetFrom medem a posição no mesmo texto', () => {
    const content = '[a](x.md)\n<!-- MANUAL -->\n[b](y.md#s)';
    const marker = manualMarkerOffsetFrom(content);
    expect(linksWithOffsetFrom(content).map((link) => [link.target, link.index > marker])).toEqual([
      ['x.md', false],
      ['y.md', true],
    ]);
  });

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

describe('docs vivos de docs/directives', () => {
  test('a coleta não está vazia (sanity: a trava não passa por não achar doc)', () => {
    expect(livingDocs).toEqual(expect.arrayContaining(['convencoes.md', 'fronteiras.md']));
  });

  test('cada doc vivo é importado pelo CLAUDE.md, com fluxo-hexlog.md primeiro e convencoes.md em seguida', () => {
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

  test('cada doc vivo cabe em 150 linhas e o que o CLAUDE.md importa em 1000 no total', () => {
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

describe('AGENTS.md depois da extração das regras', () => {
  const agentsFiles = documents.filter((file) => path.basename(file) === 'AGENTS.md');

  test('a coleta inclui o AGENTS.md de test/fixtures (sanity)', () => {
    const relative = agentsFiles.map((file) => path.relative(repoRoot, file));
    expect(relative).toEqual(
      expect.arrayContaining(['AGENTS.md', 'src/AGENTS.md', 'test/fixtures/AGENTS.md']),
    );
  });

  test('nenhum AGENTS.md tem os títulos que a extração removeu', () => {
    const found = agentsFiles.flatMap((file) =>
      headingTitlesFrom(fs.readFileSync(file, 'utf8'))
        .filter((title) => EXTRACTED_HEADINGS.includes(title))
        .map((title) => `${path.relative(repoRoot, file)} → ${title}`),
    );
    expect(found).toEqual([]);
  });

  test('o link para docs/directives/ fica depois do marcador MANUAL', () => {
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

describe('termos de seleção da checagem fora do que o agente lê', () => {
  test('a regex de termos casa em português e em inglês e ignora prosa comum (unitário)', () => {
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

  test('nenhum doc importado no CLAUDE.md casa os termos de seleção', () => {
    const imported = claudeMdImports();
    expect(imported).toContain(FLOW_DOC);
    const hits = imported.filter((target) =>
      SELECTION_TERMS.test(fs.readFileSync(path.join(repoRoot, target), 'utf8')),
    );
    expect(hits).toEqual([]);
  });

  test('fluxo-hexlog.md também não menciona a checagem por auditoria', () => {
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
const STATEMENT_MAX_CHARS = 255;
const PREMISE_LINE = /^- `([a-z0-9-]+)`: (.+)$/;
const VER_SEPARATOR = ' Ver: ';

type Premise = {
  theme: string;
  slug: string;
  statement: string;
  ver: string | undefined;
};

/** Premissas por tema: cada `##` abre um tema e cada linha `- ` dele é uma premissa ou uma linha malformada. */
function premisesFrom(content: string): { premises: Premise[]; malformed: string[] } {
  const premises: Premise[] = [];
  const malformed: string[] = [];
  let theme = '';
  for (const line of stripFencedCodeBlocks(content).split('\n')) {
    const heading = /^##\s+(.+?)\s*$/.exec(line);
    if (heading !== null) {
      theme = at(heading, 1);
      continue;
    }
    if (!line.startsWith('- ')) continue;
    const match = PREMISE_LINE.exec(line);
    if (match === null) {
      malformed.push(line);
      continue;
    }
    const rest = at(match, 2);
    // O statement pode conter `: `; o `Ver:` é sempre o último trecho da linha.
    const verAt = rest.lastIndexOf(VER_SEPARATOR);
    premises.push({
      theme,
      slug: at(match, 1),
      statement: verAt === -1 ? rest : rest.slice(0, verAt),
      ver: verAt === -1 ? undefined : rest.slice(verAt + VER_SEPARATOR.length),
    });
  }
  return { premises, malformed };
}

describe('extração das premissas (unitário, sobre string literal)', () => {
  test('premisesFrom separa slug, statement com `: ` dentro e link Ver, e acusa linha malformada', () => {
    const content = [
      '## Tema',
      '- `a-b`: Regra: com dois pontos. Ver: [x.md](x.md).',
      '- `none`: Sem premissa.',
      '- sem crase: linha ruim',
    ].join('\n');
    expect(premisesFrom(content)).toEqual({
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

  test('é importado pelo CLAUDE.md depois de fluxo-hexlog.md e convencoes.md', () => {
    const imports = claudeMdImports();
    const position = (target: string): number => imports.indexOf(target);
    expect(position(STRATEGY_DOC)).toBeGreaterThan(position('docs/directives/convencoes.md'));
    expect(position('docs/directives/convencoes.md')).toBeGreaterThan(position(FLOW_DOC));
    expect(position(FLOW_DOC)).toBeGreaterThanOrEqual(0);
  });

  test('cabe em 150 linhas', () => {
    expect(lineCount(strategyPath)).toBeLessThanOrEqual(LIVING_DOC_MAX_LINES);
  });
});

describe('premissas de estrategia.md', () => {
  let content: string;
  let premises: Premise[];
  let malformed: string[];

  beforeAll(() => {
    content = fs.readFileSync(path.join(repoRoot, STRATEGY_DOC), 'utf8');
    ({ premises, malformed } = premisesFrom(content));
  });

  test('tem as 6 seções temáticas e a da sentinela, nessa ordem', () => {
    const themes = headingTitlesFrom(content);
    expect(themes.slice(1)).toEqual([...STRATEGY_THEMES, SENTINEL_THEME]);
  });

  test('toda linha de premissa casa o formato `slug`: statement', () => {
    expect(malformed).toEqual([]);
  });

  test('cada tema tem pelo menos uma premissa', () => {
    const empty = STRATEGY_THEMES.filter(
      (theme) => !premises.some((premise) => premise.theme === theme),
    );
    expect(empty).toEqual([]);
  });

  test('os slugs são únicos', () => {
    const slugs = premises.map((premise) => premise.slug);
    expect(slugs.filter((slug, index) => slugs.indexOf(slug) !== index)).toEqual([]);
  });

  test('todo statement tem de 1 a 255 caracteres', () => {
    const outOfRange = premises.filter(
      ({ statement }) => statement.length < 1 || statement.length > STATEMENT_MAX_CHARS,
    );
    expect(outOfRange.map((premise) => premise.slug)).toEqual([]);
  });

  test('toda premissa fora a sentinela termina em um link `Ver:` relativo', () => {
    const withoutLink = premises
      .filter((premise) => premise.slug !== SENTINEL_SLUG)
      .filter((premise) => relativeLinkTargetsFrom(premise.ver ?? '').length === 0);
    expect(withoutLink.map((premise) => premise.slug)).toEqual([]);
  });

  test('a sentinela `none` existe, sem link `Ver:`', () => {
    expect(premises.find((premise) => premise.slug === SENTINEL_SLUG)).toMatchObject({
      theme: SENTINEL_THEME,
      ver: undefined,
    });
  });
});

describe('fluxo-hexlog.md com a camada estratégica', () => {
  test.each([
    'rests-on',
    'fills-gap',
    'directives-2',
    'premise.objective',
    'directives.estrategia.none',
  ])('cita `%s`', (token) => {
    expect(fs.readFileSync(path.join(repoRoot, FLOW_DOC), 'utf8')).toContain(token);
  });
});

describe('skills locais do fluxo', () => {
  test('cada skill tem `name` igual à pasta', () => {
    const wrong = FLOW_SKILLS.filter(
      (name) => skillNameFrom(fs.readFileSync(skillPath(name), 'utf8')) !== name,
    );
    expect(wrong).toEqual([]);
  });

  test('citam só caminhos de docs/directives/ que existem, e fluxo-hexlog.md entre eles', () => {
    const cited = FLOW_SKILLS.flatMap((name) => {
      const content = fs.readFileSync(skillPath(name), 'utf8');
      return [...content.matchAll(DIRECTIVES_DOC_CITATION)].map(([citation]) => citation);
    });
    expect(cited).toContain(FLOW_DOC);
    expect(cited.filter((citation) => !fs.existsSync(path.join(repoRoot, citation)))).toEqual([]);
  });
});

describe('skills locais citam a estratégia', () => {
  test.each(FLOW_SKILLS)('%s cita docs/directives/estrategia.md', (name) => {
    expect(fs.readFileSync(skillPath(name), 'utf8')).toContain(STRATEGY_DOC);
  });
});

describe('ADR 0010 depois da emenda do fluxo', () => {
  test('o último bloco do arquivo é a emenda de 2026-10-06', () => {
    const adr = fs.readFileSync(path.join(directivesDir, 'adr-0010-camada-sobre-omc.md'), 'utf8');
    expect(lastBlockOf(adr)).toMatch(/^- \*\*2026-10-06/);
  });
});

describe('ADR 0011 da camada estratégica', () => {
  test.each(['Context', 'Decision', 'Consequences'])('tem a seção "%s"', (title) => {
    const adr = fs.readFileSync(path.join(directivesDir, 'adr-0011-camada-estrategica.md'), 'utf8');
    expect(headingTitlesFrom(adr)).toContain(title);
  });
});
