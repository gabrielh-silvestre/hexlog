import { describe, test, expect } from '@jest/globals';
import * as fs from 'node:fs';
import * as path from 'node:path';
import {
  RESERVED_PROCESS_NAMES,
  RESERVED_TYPE_NAMES,
  BUILTIN_GATE_NAMES,
} from '../src/definitions.ts';
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

/** Códigos do union literal `export type ErrorCode = 'A' | 'B' | ...;` em `content` (§4.13). */
function errorCodeCatalogFrom(content: string): string[] {
  const start = content.indexOf('export type ErrorCode =');
  const unionBlock = content.slice(start, content.indexOf(';', start));
  return [...unionBlock.matchAll(/'([A-Z_]+)'/g)].map((m) => at(m, 1));
}

/** Nomes de declarações de função (`export function X`, `async function X`, `function X`) em `content`. */
function functionNamesFrom(content: string): string[] {
  return [...content.matchAll(/(?:^|\s)function ([A-Za-z][A-Za-z0-9]*)/g)].map((m) => at(m, 1));
}

const SYMBOL_CITATION_FORMAT = /^[A-Za-z0-9_.-]+\.ts#[A-Za-z_][A-Za-z0-9_]*$/;

/** Citações `arquivo.ts#símbolo` entre crase simples em `content`, fora de blocos cercados. */
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

/** Citação `arquivo:N` de código em `.md` (todas as extensões citadas hoje); exclui nomes de produto com `.js` em prosa. */
const LINE_NUMBER_CITATION =
  /(?<![\w./-])(?!(?:Node|Next|Nuxt|Vue|Deno)\.js:)[\w./-]+\.(?:ts|mjs|json|js|yml|md):\d+/;

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
    ]) {
      expect(LINE_NUMBER_CITATION.test(`veja \`${citation}\` aqui`)).toBe(true);
    }
  });

  test('LINE_NUMBER_CITATION não casa target hexlog, arquivo#símbolo nem nome de produto com .js', () => {
    for (const text of ['hex:target:x', 'a.ts#sym', 'Node.js' + ':24', 'Next.js' + ':3000']) {
      expect(LINE_NUMBER_CITATION.test(text)).toBe(false);
    }
  });
});

// ---- catálogo real, extraído do código (nunca copiado à mão) — global ao projeto, não por skill ----

const registeredTools = ['src/definition-tools.ts', 'src/event-tools.ts'].flatMap((relativeFile) =>
  toolNamesFrom(fs.readFileSync(path.join(repoRoot, relativeFile), 'utf8')),
);

const exportedConstantNames = exportedConstantNamesFrom(
  fs.readFileSync(path.join(repoRoot, 'src/definitions.ts'), 'utf8'),
);

const errorCodeCatalog = errorCodeCatalogFrom(
  fs.readFileSync(path.join(repoRoot, 'src/errors.ts'), 'utf8'),
);

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
 * SCREAMING_SNAKE_CASE citados nas skills que não pertencem ao catálogo de `ErrorCode` por desenho, não
 * por erro de digitação:
 * - `UNKNOWN_VOCABULARY`: código de **aviso** (campo `result` do Veredito, vocabulário aberto), não um
 *   `ErrorCode` — a skill `hexlog` documenta essa distinção de propósito (ver teste dedicado abaixo).
 * - `TYPE_NOT_FIXED`: citado de propósito como contraste ("não `TYPE_NOT_FIXED`, esse código não
 *   existe") — a skill afirma que ele NÃO existe; exigi-lo no catálogo inverteria a checagem.
 * - `STALE_DEFINITIONS`: código de **aviso** de `create_process` (P3), quando o processo já existe
 *   com um snapshot de definições diferente do candidato desta chamada — não um `ErrorCode`.
 */
const DELIBERATE_NON_ERROR_CODES = new Set([
  'UNKNOWN_VOCABULARY',
  'TYPE_NOT_FIXED',
  'STALE_DEFINITIONS',
]);

/**
 * Palavras de domínio (campo/valor de exemplo) citadas nas skills em crase que coincidem em forma
 * (lowercase, sem hífen) com nome de tool ou de valor reservado, mas não são nenhum dos dois — allow-
 * list explícita em vez de afrouxar o regex de identificador. Global ao projeto (as skills compartilham
 * o mesmo vocabulário de campos de entrada/saída do servidor), não por skill.
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
  // `builtinGates` em definition-tools.ts, `versions` (bloco de versionamento,
  // leva 8) em definition-tools.ts/definitions.ts.
  'milestoneType',
  'builtinGates',
  'versions',
  // P1-P5: campos de saída/entrada citados na skill hexlog, não tools nem valores reservados.
  // `owners`/`allowed` (details de VOCABULARY_VIOLATED, P2), `supersedes`/`active`
  // (Verdict/state, contexto do `no-forks`, P1), `targets` (state, P4), `trace`
  // (Milestone, P5).
  'owners',
  'allowed',
  'supersedes',
  'active',
  'targets',
  'trace',
  // #33: `warnings`/`event` (saída de state) e `since` (entrada de state), citados no aviso cumulativo.
  'warnings',
  'since',
  'event',
  // `sections`/`conflicts` (campos de `state`) e `targetPrefix` (campo novo de `state`/`events`),
  // não funções nem tools.
  'sections',
  'conflicts',
  'targetPrefix',
  // hexlog-setup/hexlog-flow: `target` (singular, campo de entrada de register/evaluate_gate/
  // events/chain), `editedSkills` e `targetIdPattern` (campos do frontmatter FlowMap,
  // ver skills/hexlog-setup/references/flow-map-schema.md).
  'target',
  'editedSkills',
  'targetIdPattern',
]);

/**
 * Substrings esperadas no corpo da declaração de cada `arquivo.ts#símbolo` citado — mapa explícito em vez
 * de inferir a partir de outras crases da mesma linha. A substring prova o vínculo símbolo ↔ código de erro
 * ou mensagem: mover o `throw` para outra função quebra o teste, de propósito. `installation.ts#installArtifact`
 * espera a chamada de `verifyPreparedArtifact` para provar que a checagem ocorre dentro da instalação.
 */
const HEXLOG_CITATION_EXPECTATIONS: Record<string, string[]> = {
  'definitions.ts#buildSnapshot': ['VOCABULARY_MISSING'],
  'definitions.ts#createProcess': ['createProcess'],
  'definitions.ts#RESERVED_PROCESS_NAMES': ['RESERVED_PROCESS_NAMES'],
  'definitions.ts#RESERVED_TYPE_NAMES': ['RESERVED_TYPE_NAMES'],
  'definitions.ts#BUILTIN_GATE_NAMES': ['BUILTIN_GATE_NAMES'],
  'event-tools.ts#registerEvent': ['TYPE_NOT_PINNED', 'RESERVED_FIELD'],
  'event-tools.ts#ensureVocabulary': ['VOCABULARY_VIOLATED'],
  'event-tools.ts#unknownResultWarning': ['UNKNOWN_VOCABULARY'],
  'event-tools.ts#evaluateGate': ['duplicate {name, target} in batch', 'gates batch exceeds'],
  'events.ts#TargetPrefix': ['TargetPrefix'],
  'definition-tools.ts#reservedTypeMessage': ['built-in domain kind'],
  'installation.ts#verifyPreparedArtifact': ['verifyPreparedArtifact'],
  'installation.ts#installArtifact': ['verifyPreparedArtifact'],
};

const HEXLOG_SETUP_CITATION_EXPECTATIONS: Record<string, string[]> = {
  'definitions.ts#buildSnapshot': ['VOCABULARY_MISSING'],
  'definitions.ts#RESERVED_PROCESS_NAMES': ['RESERVED_PROCESS_NAMES'],
  'definitions.ts#RESERVED_TYPE_NAMES': ['RESERVED_TYPE_NAMES'],
  'definitions.ts#BUILTIN_GATE_NAMES': ['BUILTIN_GATE_NAMES'],
  'definitions.ts#writeVersionExclusive': ['BREAKING_CHANGE'],
};

const HEXLOG_FLOW_CITATION_EXPECTATIONS: Record<string, string[]> = {
  'event-tools.ts#registerEvent': ['TYPE_NOT_PINNED', 'RESERVED_FIELD'],
  'event-tools.ts#ensureVocabulary': ['VOCABULARY_VIOLATED'],
  'event-tools.ts#unknownResultWarning': ['UNKNOWN_VOCABULARY'],
  'event-tools.ts#retryWithFullId': ['CONFLICTING_ID'],
  'event-tools.ts#resolveGate': ['INVALID_EVALUATION'],
  'events.ts#Target': ['Target'],
};

const FLOW_MAP_SCHEMA_CITATION_EXPECTATIONS: Record<string, string[]> = {
  'events.ts#Name': ['Name'],
  'events.ts#Target': ['Target'],
};

const TARGET_FORMAT_CITATION_EXPECTATIONS: Record<string, string[]> = {
  'events.ts#Target': ['Target'],
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
});

describe('fatos de código globais que a skill hexlog cita (não dependem de qual skill citou)', () => {
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
  test('nenhum .md de skills/, docs/, friction-mining, README.md ou AGENTS.md casa arquivo:N', () => {
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
          const match = LINE_NUMBER_CITATION.exec(line);
          return match === null
            ? []
            : [`${path.relative(repoRoot, file)}:${index + 1} → ${match[0]}`];
        }),
    );
    expect(hits).toEqual([]);
  });
});
