import { describe, test, expect } from '@jest/globals';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { RESERVED_PROCESS_NAMES } from '../src/domain/ids.ts';
import { at } from './helpers.ts';

const repoRoot = path.resolve(__dirname, '..');
const srcDir = path.join(repoRoot, 'src');

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
  return [...stripFencedCodeBlocks(content).matchAll(/`([^`]+)`/g)].map((m) => at(m, 1));
}

const SCREAMING_SNAKE_CASE = /^[A-Z][A-Z0-9_]*$/;
// snake/kebab minúsculo: nomes de tool (`register_vocabulary`) e valores reservados com hífen (`no-orphans`).
const LOWER_IDENTIFIER = /^[a-z][a-z0-9_-]*$/;
// Exige ao menos uma maiúscula depois da primeira letra: `^[a-z][a-zA-Z0-9]*$` sozinho também casaria
// com token minúsculo puro (`register`, `list`), que não é camelCase e não deve entrar nesta checagem.
const CAMEL_CASE_IDENTIFIER = /^[a-z][a-z0-9]*[A-Z][a-zA-Z0-9]*$/;

/** Nomes entre aspas do 1º argumento de cada `server.registerTool(` em `content`. */
function toolNamesFrom(content: string): string[] {
  return [...content.matchAll(/server\.registerTool\(\s*['"]([^'"]+)['"]/g)].map((m) => at(m, 1));
}

/** Nomes SCREAMING_SNAKE_CASE de `export const NOME` em `content`. */
function exportedConstantNamesFrom(content: string): string[] {
  return [...content.matchAll(/export const ([A-Za-z][A-Za-z0-9_]*)/g)]
    .map((m) => at(m, 1))
    .filter((name) => SCREAMING_SNAKE_CASE.test(name));
}

/** Códigos do union literal `export type ErrorCode = 'A' | 'B' | ...;` em `content` (ADR 0009 item 7). */
function errorCodeCatalogFrom(content: string): string[] {
  const start = content.indexOf('export type ErrorCode =');
  const unionBlock = content.slice(start, content.indexOf(';', start));
  return [...unionBlock.matchAll(/'([A-Z_]+)'/g)].map((m) => at(m, 1));
}

/** Nomes de declarações de função (`export function X`, `async function X`, `function X`) em `content`. */
function functionNamesFrom(content: string): string[] {
  return [...content.matchAll(/(?:^|\s)function ([A-Za-z][A-Za-z0-9]*)/g)].map((m) => at(m, 1));
}

/** Caminho relativo a `src/` (zero ou mais diretórios), `.ts`, `#` e o símbolo. */
const SYMBOL_CITATION_FORMAT = /^(?:[a-z0-9-]+\/)*[A-Za-z0-9_.-]+\.ts#[A-Za-z_][A-Za-z0-9_]*$/;

/** Citações `[diretório/]arquivo.ts#símbolo` entre crase simples em `content`, fora de blocos cercados. */
function fileSymbolCitationsFrom(content: string): string[] {
  return extractInlineBackticks(content).filter((token) => SYMBOL_CITATION_FORMAT.test(token));
}

const DECLARATION_KEYWORDS =
  '(?:export\\s+)?(?:async\\s+)?(?:function|const|let|type|class|interface)';

/**
 * Corpo da declaração ancorada de `symbol` em `content`: da linha da declaração até a anterior à próxima
 * declaração ancorada (ou o fim do arquivo). Ancorar no início da linha rejeita comentário e variável
 * local indentada. Devolve `undefined` se a declaração não existe.
 */
function declarationBodyFrom(content: string, symbol: string): string | undefined {
  const start = new RegExp(`^${DECLARATION_KEYWORDS}\\s+${symbol}\\b`, 'm').exec(content);
  if (start === null) return undefined;
  const rest = content.slice(start.index + start[0].length);
  const next = new RegExp(`^${DECLARATION_KEYWORDS}\\s+\\w+`, 'm').exec(rest);
  return content.slice(start.index, start.index + start[0].length + (next?.index ?? rest.length));
}

/** Citação `arquivo:N` de código em `.md` (todas as extensões citadas hoje, incl. `.py` de repositórios externos); exclui nomes de produto com `.js` em prosa. */
const LINE_NUMBER_CITATION =
  /(?<![\w./-])(?!(?:Node|Next|Nuxt|Vue|Deno)\.js:)[\w./-]+\.(?:ts|mjs|json|js|yml|md|py):\d+/;

/** Citação de linha em prosa ("linha 12", "linhas ~141"). */
const LINE_PROSE_CITATION = /\blinhas?\s+~?\d+/i;

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

  test('fileSymbolCitationsFrom pega só crases no formato arquivo.ts#símbolo, ignorando outras crases', () => {
    const content =
      '`definitions.ts#createProcess` e `events.ts#Name`, mas não `register_type` nem `AGENTS.md`';
    expect(fileSymbolCitationsFrom(content)).toEqual([
      'definitions.ts#createProcess',
      'events.ts#Name',
    ]);
  });

  test('fileSymbolCitationsFrom aceita diretórios relativos a src/ e recusa maiúscula, ../ e raiz absoluta', () => {
    const content =
      '`mcp/tools/register.ts#register` e `a/b-2/c.ts#Sym`, mas não `Mcp/x.ts#y`, `../x.ts#y` nem `/x.ts#y`';
    expect(fileSymbolCitationsFrom(content)).toEqual([
      'mcp/tools/register.ts#register',
      'a/b-2/c.ts#Sym',
    ]);
  });

  test('tsFilesUnder desce em subpastas e devolve caminhos relativos', () => {
    const files = tsFilesUnder(path.join(repoRoot, 'test'));
    expect(files).toContain('skill-coherence.spec.ts');
    expect(files.some((file) => file.startsWith('fixtures/'))).toBe(true);
  });

  test('declarationBodyFrom acha a declaração ancorada e vai até a próxima, rejeitando comentário e indentada', () => {
    const content = [
      '// function alvo() fantasma',
      'export async function alvo(): void {',
      '  const alvo = 1;',
      '  throw new Error(CODIGO);',
      '}',
      'export const OUTRA = 1;',
    ].join('\n');
    const body = declarationBodyFrom(content, 'alvo');
    expect(body).toContain('CODIGO');
    expect(body).not.toContain('OUTRA');
    expect(declarationBodyFrom(content, 'fantasma')).toBeUndefined();
    expect(declarationBodyFrom('  const alvo = 1;', 'alvo')).toBeUndefined();
  });

  // literais montados por concatenação: o grep de aceite não pode achar citação neste arquivo
  test('LINE_NUMBER_CITATION casa arquivo:N e arquivo:N-M em qualquer extensão citada', () => {
    for (const citation of [
      'a.ts' + ':12',
      'a.ts' + ':1-3',
      'package.json' + ':7',
      'eslint.config.js' + ':12',
      'ci.yml' + ':3',
      'AGENTS.md' + ':39',
      'server.py' + ':87-98',
    ]) {
      expect(LINE_NUMBER_CITATION.test(`veja \`${citation}\` aqui`)).toBe(true);
    }
  });

  test('LINE_PROSE_CITATION casa "linha N" e "linhas ~N" e ignora "linha" sem número', () => {
    for (const text of ['linhas 141–192 de x', 'na linha 12', 'Linhas ~40']) {
      expect(LINE_PROSE_CITATION.test(text)).toBe(true);
    }
    for (const text of ['da linha da declaração', 'uma linha só', 'linhagem 3']) {
      expect(LINE_PROSE_CITATION.test(text)).toBe(false);
    }
  });

  test('LINE_NUMBER_CITATION não casa target hexlog, arquivo#símbolo nem nome de produto com .js', () => {
    for (const text of ['hex:target:x', 'a.ts#sym', 'Node.js' + ':24', 'Next.js' + ':3000']) {
      expect(LINE_NUMBER_CITATION.test(text)).toBe(false);
    }
  });
});

// ---- catálogo real, extraído do código (nunca copiado à mão) — global ao projeto, não por skill ----

/** TB5: a 1.0 expõe exatamente 11 tools. */
const EXPECTED_TOOL_COUNT = 11;

/** TM4: 35 códigos da transição menos os 8 legados e os 2 sem uso (`INVALID_ID`, `UNKNOWN_ID`). */
const EXPECTED_ERROR_CODE_COUNT = 25;

const toolsDir = path.join(srcDir, 'mcp/tools');

const registeredTools = tsFilesUnder(toolsDir).flatMap((file) =>
  toolNamesFrom(fs.readFileSync(path.join(toolsDir, file), 'utf8')),
);

// Constantes exportadas do domínio e do kernel MCP: as skills citam as de `domain/` e de `mcp/kernel.ts`.
const exportedConstantNames = [
  ...tsFilesUnder(path.join(srcDir, 'domain')).map((file) => path.join(srcDir, 'domain', file)),
  path.join(srcDir, 'mcp/kernel.ts'),
].flatMap((file) => exportedConstantNamesFrom(fs.readFileSync(file, 'utf8')));

const errorCodeCatalog = errorCodeCatalogFrom(
  fs.readFileSync(path.join(srcDir, 'errors.ts'), 'utf8'),
);

/** Caminhos `.ts` sob `dir`, relativos a ele, em qualquer profundidade. */
function tsFilesUnder(dir: string): string[] {
  return fs
    .readdirSync(dir, { recursive: true, encoding: 'utf8' })
    .filter((file) => file.endsWith('.ts'));
}

const declaredFunctionNames = tsFilesUnder(srcDir).flatMap((file) =>
  functionNamesFrom(fs.readFileSync(path.join(srcDir, file), 'utf8')),
);

const reservedNameValues: readonly string[] = RESERVED_PROCESS_NAMES;

/**
 * Campos de entrada/saída, relações, valores de enum e exemplos citados em crase nas skills que coincidem em
 * forma com nome de tool ou de valor reservado, mas não são nenhum dos dois — allowlist explícita em vez de
 * afrouxar o regex de identificador. Global ao projeto, não por skill.
 */
const FIELD_NAME_ALLOWLIST = new Set([
  'type',
  'as',
  'target',
  'data',
  'id',
  'supersedes',
  'revokes',
  'pinned',
  'stale',
  'process',
  'breaking',
  'enum',
  'required',
  'format',
  'from',
  'to',
  'kind',
  'approved',
  'occurred',
  'path',
  'details',
  'project',
  'result',
  'run',
  'holder-unreadable',
  'gate',
  'agent',
  'key',
  'where',
  'text',
  'ids',
  'in',
  'out',
  'marker',
  'hash',
  'offset',
  'next',
  'cursor',
  'author',
  'alias',
  'current',
  'supports',
  'replayed',
  'code',
  'self-relation',
  'type-mismatch',
  'cross-process-currency',
  'contradicts',
  'supports-and-contradicts',
  'supersedes-and-revokes',
  'unknown-relation-name',
  'kind-mismatch',
  'endpoint-type',
  'stale-destination',
  'missing',
  'destination-corrupted',
  'complements',
  'answers',
  'reopens',
  'scope',
  'no_open_contradiction',
  'entered',
  'left',
  'reason',
  'lock-busy',
  'lock-lost',
  'broken-chain',
  'unreadable-manifest',
  'outside-allowed-root',
  'inside-data-dir',
  'bad-extension',
  'not-regular',
  'not-found',
  'too-big',
  'bad-args',
  'invalid-utf8',
  'ok',
  'corrupted',
  'unmarked-attachment',
  'diff',
  'plan',
  'review',
  'no_pending',
  'deviation',
  'document',
  'report',
  'verdict',
  'evidence',
  'unsupported',
  'contradictions',
  'unresolved',
  'summary',
  'trigger',
  'other',
  'status',
  'worked-around',
  'name',
  'accept',
  'approves',
  'accept-with-reservations',
  'lead',
  'orchestrator',
  'revise',
  'reject',
  'rejects',
  'escalated',
  'plan-ready',
  'attempts',
  'executor',
  'user',
  'verification-failure',
  'resolved',
  'plan-deviation',
  'scope-cut',
  'reviewer-reject',
  'blocked-dependency',
  'agent-failure',
  'user-stop',
  'settles',
  'limit',
  'includeNonCurrent',
  'readOnlyHint',
  'targetPrefix',
  'targetIdPattern',
  'changesSince',
  'attachmentStatus',
  'staleOut',
  'staleIn',
  'derivesFrom',
  'attachmentBreaks',
  'isRevision',
  'decidedBy',
  'editedSkills',
]);

/**
 * Substrings esperadas no corpo da declaração de cada `arquivo.ts#símbolo` citado — mapa explícito em vez
 * de inferir a partir de outras crases da mesma linha. A substring prova o vínculo símbolo ↔ código de erro
 * ou mensagem: mover o `throw` para outra função quebra o teste, de propósito. `installation.ts#installArtifact`
 * espera a chamada de `verifyPreparedArtifact` para provar que a checagem ocorre dentro da instalação.
 */
const HEXLOG_CITATION_EXPECTATIONS: Record<string, string[]> = {
  'commands/process.ts#assertSomethingRegistered': ['TYPE_NOT_FOUND'],
  'domain/ids.ts#Name': ['Name'],
  'commands/definition.ts#targetVersion': ['BREAKING_CHANGE'],
  'domain/ids.ts#RESERVED_PROCESS_NAMES': ['RESERVED_PROCESS_NAMES'],
  'commands/definition.ts#typeRule': ['INVALID_SCHEMA'],
  'commands/register/static.ts#pinnedSchema': ['TYPE_NOT_PINNED'],
  'commands/register/static.ts#checkData': ['checkData'],
  'queries/query-service.ts#gateNotFound': ['GATE_NOT_FOUND'],
  'installation.ts#verifyPreparedArtifact': ['verifyPreparedArtifact'],
  'installation.ts#installArtifact': ['verifyPreparedArtifact'],
};

const HEXLOG_SETUP_CITATION_EXPECTATIONS: Record<string, string[]> = {
  'commands/process.ts#assertSomethingRegistered': ['TYPE_NOT_FOUND'],
  'domain/ids.ts#RESERVED_PROCESS_NAMES': ['RESERVED_PROCESS_NAMES'],
  'commands/definition.ts#typeRule': ['INVALID_SCHEMA'],
  'commands/definition.ts#targetVersion': ['BREAKING_CHANGE'],
};

const HEXLOG_FLOW_CITATION_EXPECTATIONS: Record<string, string[]> = {
  'commands/register/state.ts#assertSameBatch': ['IDEMPOTENCY_CONFLICT'],
  'commands/register/errors.ts#ruleRefusal': ['FORK_REJECTED'],
  'adapters/fs/lock.ts#lockTimeout': ['LOCK_TIMEOUT'],
  'commands/register/attachments.ts#checkAttachments': ['unmarked-attachment'],
};

const FLOW_MAP_SCHEMA_CITATION_EXPECTATIONS: Record<string, string[]> = {
  'domain/ids.ts#Name': ['Name'],
  'domain/ids.ts#Target': ['Target'],
};

const TARGET_FORMAT_CITATION_EXPECTATIONS: Record<string, string[]> = {
  'domain/ids.ts#Target': ['Target'],
  'domain/gate.ts#matchesTargetPrefix': ['target'],
};

const AUDIT_TYPES_CITATION_EXPECTATIONS: Record<string, string[]> = {
  'domain/definitions.ts#attachmentFields': ['attachmentFields'],
  'domain/gate.ts#evaluateGate': ['evaluateGate'],
};

type SkillCase = {
  name: string;
  skillPath: string;
  citationExpectations: Record<string, string[]>;
};

const skillCases: SkillCase[] = [
  {
    name: 'hexlog',
    skillPath: path.join(repoRoot, 'skills/hexlog/SKILL.md'),
    citationExpectations: HEXLOG_CITATION_EXPECTATIONS,
  },
  {
    name: 'hexlog-setup',
    skillPath: path.join(repoRoot, 'skills/hexlog-setup/SKILL.md'),
    citationExpectations: HEXLOG_SETUP_CITATION_EXPECTATIONS,
  },
  {
    name: 'hexlog-flow',
    skillPath: path.join(repoRoot, 'skills/hexlog-flow/SKILL.md'),
    citationExpectations: HEXLOG_FLOW_CITATION_EXPECTATIONS,
  },
  {
    name: 'hexlog-flow/references/audit-types',
    skillPath: path.join(repoRoot, 'skills/hexlog-flow/references/audit-types.md'),
    citationExpectations: AUDIT_TYPES_CITATION_EXPECTATIONS,
  },
];

// `references/*.md` só entram na checagem de citação arquivo.ts#símbolo: citam campos do schema
// (`phases`, `process`) em crases, que a checagem de identificadores leria como tool inexistente.
const referenceCases: SkillCase[] = [
  {
    name: 'hexlog-setup/references/flow-map-schema',
    skillPath: path.join(repoRoot, 'skills/hexlog-setup/references/flow-map-schema.md'),
    citationExpectations: FLOW_MAP_SCHEMA_CITATION_EXPECTATIONS,
  },
  {
    name: 'hexlog-flow/references/target-format',
    skillPath: path.join(repoRoot, 'skills/hexlog-flow/references/target-format.md'),
    citationExpectations: TARGET_FORMAT_CITATION_EXPECTATIONS,
  },
];

/** Tokens citados numa skill, já classificados por formato — computado uma vez por caso. */
function tokensCitedBy(skillPath: string) {
  const skillContent = fs.readFileSync(skillPath, 'utf8');
  const backtickTokens = extractInlineBackticks(skillContent);
  return {
    citedFileCitations: fileSymbolCitationsFrom(skillContent),
    citedScreamingSnakeTokens: [
      ...new Set(backtickTokens.filter((t) => SCREAMING_SNAKE_CASE.test(t))),
    ],
    citedLowerIdentifiers: [...new Set(backtickTokens.filter((t) => LOWER_IDENTIFIER.test(t)))],
    citedCamelCaseTokens: [...new Set(backtickTokens.filter((t) => CAMEL_CASE_IDENTIFIER.test(t)))],
  };
}

describe.each(skillCases)('coerência SKILL.md × código ($name)', ({ skillPath }) => {
  const { citedScreamingSnakeTokens, citedLowerIdentifiers, citedCamelCaseTokens } =
    tokensCitedBy(skillPath);

  test('a extração não está vazia (sanity: se a skill mudar de forma, isso quebra antes das checagens abaixo)', () => {
    expect(registeredTools.length).toBeGreaterThan(0);
    expect(citedScreamingSnakeTokens.length).toBeGreaterThan(0);
    expect(citedLowerIdentifiers.length).toBeGreaterThan(0);
    expect(errorCodeCatalog.length).toBeGreaterThan(0);
    expect(citedCamelCaseTokens.length).toBeGreaterThan(0);
  });

  test('toda tool citada na skill está de fato registrada (src/mcp/tools/)', () => {
    const known = new Set([...registeredTools, ...reservedNameValues, ...FIELD_NAME_ALLOWLIST]);
    const unknown = citedLowerIdentifiers.filter((token) => !known.has(token));
    expect(unknown).toEqual([]);
  });

  test('todo código SCREAMING_SNAKE_CASE citado existe no catálogo de erros ou é constante exportada de src/domain/ ou de mcp/kernel.ts', () => {
    const known = new Set([...errorCodeCatalog, ...exportedConstantNames]);
    const unknown = citedScreamingSnakeTokens.filter((token) => !known.has(token));
    expect(unknown).toEqual([]);
  });

  test('todo camelCase citado é função declarada em src/ ou campo de schema conhecido', () => {
    const known = new Set([...declaredFunctionNames, ...FIELD_NAME_ALLOWLIST]);
    const unknown = citedCamelCaseTokens.filter((token) => !known.has(token));
    expect(unknown).toEqual([]);
  });
});

describe('catálogo real extraído do código', () => {
  test(`src/mcp/tools/ registra exatamente ${EXPECTED_TOOL_COUNT} tools, sem repetição (TB5)`, () => {
    expect(registeredTools).toHaveLength(EXPECTED_TOOL_COUNT);
    expect(new Set(registeredTools).size).toBe(EXPECTED_TOOL_COUNT);
  });

  test(`src/errors.ts declara exatamente ${EXPECTED_ERROR_CODE_COUNT} códigos de erro (TM4)`, () => {
    expect(errorCodeCatalog).toHaveLength(EXPECTED_ERROR_CODE_COUNT);
    expect(new Set(errorCodeCatalog).size).toBe(EXPECTED_ERROR_CODE_COUNT);
  });
});

describe.each([...skillCases, ...referenceCases])(
  'citações arquivo.ts#símbolo na skill × código real em src/ ($name)',
  ({ skillPath, citationExpectations }) => {
    const { citedFileCitations } = tokensCitedBy(skillPath);

    test('a extração de citações não está vazia (sanity)', () => {
      expect(citedFileCitations.length).toBeGreaterThan(0);
    });

    test('toda citação da skill tem uma expectativa mapeada, e toda expectativa mapeada ainda é citada (nenhuma citação nova ou removida passa despercebida)', () => {
      expect(new Set(citedFileCitations)).toEqual(new Set(Object.keys(citationExpectations)));
    });

    test('cada citação aponta pra um arquivo de src/ cuja declaração do símbolo contém as substrings esperadas', () => {
      for (const citation of citedFileCitations) {
        const [file = '', symbol = ''] = citation.split('#');
        const filePath = path.join(srcDir, file);
        expect(fs.existsSync(filePath)).toBe(true);
        const body = declarationBodyFrom(fs.readFileSync(filePath, 'utf8'), symbol);
        expect(body).toBeDefined();
        for (const substring of citationExpectations[citation] ?? []) {
          expect(body).toContain(substring);
        }
      }
    });
  },
);

// ---- trava: documentação nunca cita linha de arquivo (arquivo + símbolo) ----

function markdownFilesUnder(dir: string): string[] {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return markdownFilesUnder(full);
    return entry.name.endsWith('.md') ? [full] : [];
  });
}

/** Todo `AGENTS.md` do repositório, sem entrar em node_modules nem em pastas de ponto (`.git`, `.omc`...). */
function agentsFilesUnder(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      return entry.name === 'node_modules' || entry.name.startsWith('.')
        ? []
        : agentsFilesUnder(full);
    }
    return entry.name === 'AGENTS.md' ? [full] : [];
  });
}

describe('documentação não cita número de linha', () => {
  test('nenhum .md de skills/, docs/, friction-mining, README.md ou AGENTS.md casa arquivo:N nem "linha N"', () => {
    const files = [
      ...markdownFilesUnder(path.join(repoRoot, 'skills')),
      ...markdownFilesUnder(path.join(repoRoot, 'docs')),
      ...markdownFilesUnder(path.join(repoRoot, '.claude/skills/friction-mining')),
      path.join(repoRoot, 'README.md'),
      ...agentsFilesUnder(repoRoot),
    ];
    const hits = files.flatMap((file) =>
      fs
        .readFileSync(file, 'utf8')
        .split('\n')
        .flatMap((line, index) => {
          const match = LINE_NUMBER_CITATION.exec(line) ?? LINE_PROSE_CITATION.exec(line);
          return match === null
            ? []
            : [`${path.relative(repoRoot, file)}:${index + 1} → ${match[0]}`];
        }),
    );
    expect(hits).toEqual([]);
  });
});
