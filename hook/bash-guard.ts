// Hook PreToolUse para a tool Bash: impede que o agente contorne as tools MCP
// do hexlog lendo o diretório de dados por fora (cat, grep, jq etc). Nunca
// executa nada, só tokeniza o comando recebido.
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse as shellQuoteParse, type ParseEntry } from 'shell-quote';
import { isNil, isString, sumBy, take, takeWhile } from 'es-toolkit';
import { dataDir } from '../src/directory.ts';

const GLOB_CHARS_REGEX = /[*?[{]/;
// Grupo de chave sem chave aninhada: o `path.matchesGlob` expande o produto das chaves e das
// faixas (`{1..9999999}`, `{a,b,c,d}`×7 passam de 10 s), então acima de MAX_BRACE_EXPANSION
// alternativas, ou com faixa, o grupo vira `*` antes do casamento. Abaixo, a chave expande de verdade.
const BRACE_GROUP_REGEX = /\{[^{}]*\}/g;
const MAX_BRACE_EXPANSION = 32;
const STAR_RUN_REGEX = /\*{2,}/g;
// Tetos de um token com caractere de glob, aplicados antes de qualquer varredura do token: sem
// eles, um `[`×4096 leva segundos e o hook morre no timeout de 10 s, liberando o comando. Texto
// sem glob não é limitado. Falso positivo aceito: um token legítimo acima do teto também é negado.
const MAX_GLOB_TOKEN_LENGTH = 4096;
const MAX_BRACES = 8;
const MAX_BRACKETS = 64;
// Orçamento por comando: o teto acima vale por token, e centenas de tokens abaixo dele ainda
// somam o tempo do timeout. A soma dos tamanhos dos tokens com glob também é limitada.
const MAX_GLOB_TOTAL_LENGTH = 16384;
// O custo da tokenização é linear no comando: acima do teto ele estoura o timeout do hook, que
// libera o comando. Falso positivo aceito: um comando legítimo acima do teto também é negado.
const MAX_COMMAND_LENGTH = 1_048_576;
const COMPOUND_OPERATORS = new Set(['&&', '||', ';', '|', '&', '|&']);
const MAX_MATCHED_LENGTH = 200;
// Controle e formatação (U+202E, U+200B), separadores de linha e de parágrafo (U+2028, U+2029).
const CONTROL_CHARS_REGEX = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu;
// `~` no início do token ou logo após `=` (`--opt=~/x`); shell-quote não expande til.
const TILDE_REGEX = /(^|=)~(?=\/|$)/g;

// Caracteres de controle do trecho viram `?` para não chegarem ao terminal pelo stderr.
const matchedSuffix = (matched?: string): string =>
  isNil(matched)
    ? ''
    : ` Matched: ${matched.replace(CONTROL_CHARS_REGEX, '?').slice(0, MAX_MATCHED_LENGTH)}`;

const denialMessage = (d: string, matched?: string): string =>
  `hexlog: ${d} is only accessible through the hexlog MCP tools (list, query, verify_chain, read_attachment, evaluate_gate, describe_type).` +
  matchedSuffix(matched);

// Negação por comando que o hook não consegue decidir: não cita `D` a quem não o citou.
const undecidableMessage = (matched?: string): string =>
  'hexlog: the command was denied because it could not be checked against the hexlog data directory (it does not parse, it is longer than the safety limit, or its glob tokens exceed the safety limits). Simplify it.' +
  matchedSuffix(matched);

type RawInput = {
  tool_name?: unknown;
  tool_input?: { command?: unknown };
  cwd?: unknown;
};

function asRawInput(input: unknown): RawInput | undefined {
  return !isNil(input) && typeof input === 'object' ? input : undefined;
}

function extractCommand(input: unknown): string | undefined {
  const rawInput = asRawInput(input);
  if (isNil(rawInput) || rawInput.tool_name !== 'Bash') return undefined;
  const command = rawInput.tool_input?.command;
  return isString(command) ? command : undefined;
}

function extractCwd(input: unknown): string | undefined {
  const cwd = asRawInput(input)?.cwd;
  return isString(cwd) ? cwd : undefined;
}

function expandTilde(token: string, home: string): string {
  return token.replace(TILDE_REGEX, `$1${home}`);
}

/**
 * Só os tokens texto e os padrões `{op: 'glob', pattern}` interessam à checagem, agrupados
 * por segmento: os operadores de comando composto (`&&`, `||`, `;`, `|`) abrem um segmento novo.
 */
function splitSegments(tokens: ParseEntry[]): string[][] {
  let current: string[] = [];
  const segments = [current];
  for (const token of tokens) {
    if (isString(token)) {
      current.push(token);
    } else if ('op' in token && token.op === 'glob') {
      current.push(token.pattern);
    } else if ('op' in token && COMPOUND_OPERATORS.has(token.op)) {
      current = [];
      segments.push(current);
    }
  }
  return segments;
}

function tryTokenize(
  command: string,
  home: string,
  env: NodeJS.ProcessEnv,
): ParseEntry[] | undefined {
  if (command.length > MAX_COMMAND_LENGTH) return undefined;
  try {
    return shellQuoteParse(command, { HOME: home, XDG_DATA_HOME: env.XDG_DATA_HOME ?? '' });
  } catch {
    return undefined;
  }
}

function countOf(token: string, char: string): number {
  return token.split(char).length - 1;
}

/** Token com glob acima dos tetos: recusado sem rodar nenhuma regex sobre ele. */
function exceedsGlobLimits(token: string): boolean {
  return (
    GLOB_CHARS_REGEX.test(token) &&
    (token.length > MAX_GLOB_TOKEN_LENGTH ||
      countOf(token, '{') > MAX_BRACES ||
      countOf(token, '[') > MAX_BRACKETS)
  );
}

/** Orçamento por comando: a soma dos tokens com glob passou do teto? */
function exceedsGlobBudget(tokens: string[]): boolean {
  return (
    sumBy(
      tokens.filter((token) => GLOB_CHARS_REGEX.test(token)),
      (token) => token.length,
    ) > MAX_GLOB_TOTAL_LENGTH
  );
}

/** Chave `{a/b,c}`: há barra entre um `{` e o primeiro `}` seguinte. Varredura linear, sem regex. */
function hasSlashInBraces(token: string): boolean {
  for (let open = token.indexOf('{'); open !== -1; open = token.indexOf('{', open + 1)) {
    const close = token.indexOf('}', open);
    if (close === -1) return false;
    const slash = token.indexOf('/', open);
    if (slash !== -1 && slash < close) return true;
  }
  return false;
}

/** Limite superior das alternativas que o `path.matchesGlob` expandiria; faixa `..` é ilimitada. */
function braceAlternatives(pattern: string): number {
  let alternatives = 1;
  let current = pattern;
  let previous: string;
  do {
    previous = current;
    current = previous.replace(BRACE_GROUP_REGEX, (group) => {
      alternatives *= group.includes('..') ? Infinity : countOf(group, ',') + 1;
      return 'x';
    });
  } while (current !== previous);
  return alternatives;
}

/**
 * Cada grupo de chave vira `*`, um superconjunto das alternativas e das faixas, exceto no nome
 * oculto: o `*` não casa um segmento que começa com `.`, então o grupo que abre um segmento
 * cujo nome em `D` começa com `.` vira `.*`. A escolha é por segmento, sem testar variantes.
 */
function collapseBraceGroups(pattern: string, dataSegments: string[]): string {
  return pattern
    .split(path.sep)
    .map((segment, index) => {
      const hidden = dataSegments[index]?.startsWith('.') === true;
      let current = segment;
      let previous: string;
      do {
        previous = current;
        current = previous.replace(BRACE_GROUP_REGEX, (_group, offset: number) =>
          hidden && offset === 0 ? '.*' : '*',
        );
      } while (current !== previous);
      return current;
    })
    .join(path.sep)
    .replace(STAR_RUN_REGEX, '*');
}

/** Um token já expandido por til alcança `D` (por igualdade, prefixo ou glob compatível)? */
function tokenReachesDirectory(token: string, cwd: string, dataDir: string): boolean {
  const sep = path.sep;
  const resolvedPath = path.resolve(cwd, token);
  if (resolvedPath === dataDir || resolvedPath.startsWith(dataDir + sep)) return true;

  // Segmento com `**` ou uma chave `{a/b,c}` com barra dentro: o `path.matchesGlob` não expande
  // `**` até a profundidade de D, e o truncamento por `sep` corta a chave no meio (R-6,
  // Critic iter2-1) — por isso o prefixo literal decide.
  if (token.includes('**') || hasSlashInBraces(token)) {
    // prefixo literal: os segmentos até o primeiro com caractere de glob (todos, se nenhum)
    const prefix = takeWhile(
      resolvedPath.split(sep),
      (segment) => !GLOB_CHARS_REGEX.test(segment),
    ).join(sep);
    return (
      prefix === dataDir || dataDir.startsWith(prefix + sep) || prefix.startsWith(dataDir + sep)
    );
  }

  if (GLOB_CHARS_REGEX.test(token)) {
    const dataSegments = dataDir.split(sep);
    const truncated = take(resolvedPath.split(sep), dataSegments.length).join(sep);
    return path.matchesGlob(
      dataDir,
      braceAlternatives(truncated) <= MAX_BRACE_EXPANSION
        ? truncated
        : collapseBraceGroups(truncated, dataSegments),
    );
  }

  return false;
}

type TokenClass = 'reaches' | 'undecidable' | 'clear';

/** Token acima dos tetos ou cujo casamento lança é `undecidable` (nega, sem citar `D`). */
function classifyToken(rawToken: string, cwd: string, dataDir: string, home: string): TokenClass {
  try {
    const token = expandTilde(rawToken, home);
    if (token.includes(dataDir)) return 'reaches';
    if (exceedsGlobLimits(token)) return 'undecidable';
    return tokenReachesDirectory(token, cwd, dataDir) ? 'reaches' : 'clear';
  } catch {
    return 'undecidable';
  }
}

/** O primeiro token que bloqueia o comando; `token` falta quando o orçamento do comando estourou. */
function findBlockingToken(
  tokens: string[],
  cwd: string,
  dataDir: string,
  home: string,
): { token?: string; tokenClass: Exclude<TokenClass, 'clear'> } | undefined {
  if (exceedsGlobBudget(tokens)) return { tokenClass: 'undecidable' };
  for (const token of tokens) {
    const tokenClass = classifyToken(token, cwd, dataDir, home);
    if (tokenClass !== 'clear') return { token, tokenClass };
  }
  return undefined;
}

/** Em comando composto, o segmento que casou (`cat <D>/x`); comando simples não cita trecho. */
function matchedSegment(
  segments: string[][] | undefined,
  isMatch: (token: string) => boolean,
): string | undefined {
  if (isNil(segments) || segments.length < 2) return undefined;
  return segments.find((segment) => segment.some(isMatch))?.join(' ');
}

/** Decisão pura do guard: sem I/O, testável isolada do processo real. */
function decide(
  input: unknown,
  env: NodeJS.ProcessEnv,
  defaultCwd: string,
): { deny: false } | { deny: true; reason: string } {
  const command = extractCommand(input);
  if (isNil(command)) return { deny: false };

  const dataDirPath = dataDir(env);
  const home = os.homedir();
  const cwd = extractCwd(input) ?? defaultCwd;

  const denied = (reason: string) => ({ deny: true as const, reason });
  const segmentsOf = (): string[][] | undefined => {
    const tokens = tryTokenize(command, home, env);
    return isNil(tokens) ? undefined : splitSegments(tokens);
  };

  // A menção literal decide antes de qualquer tokenização: o resto pode lançar ou demorar.
  if (command.includes(dataDirPath)) {
    return denied(
      denialMessage(
        dataDirPath,
        matchedSegment(segmentsOf(), (token) => token.includes(dataDirPath)),
      ),
    );
  }

  // Parse que lança (`${}`) ou comando acima de MAX_COMMAND_LENGTH: nega em vez de liberar, mesmo
  // que o shell aceite o comando (heredoc de delimitador citado com `${}` no corpo é falso positivo aceito).
  const segments = segmentsOf();
  if (isNil(segments)) return denied(undecidableMessage());

  const blocking = findBlockingToken(segments.flat(), cwd, dataDirPath, home);
  if (isNil(blocking)) return { deny: false };
  const matched = matchedSegment(segments, (token) => token === blocking.token);
  return denied(
    blocking.tokenClass === 'reaches'
      ? denialMessage(dataDirPath, matched)
      : undecidableMessage(matched),
  );
}

/** `import.meta.main` não sobrevive ao bundle do esbuild: compara o caminho do entrypoint. */
function isExecutedDirectly(): boolean {
  try {
    return fs.realpathSync(process.argv[1] ?? '') === fileURLToPath(import.meta.url);
  } catch {
    return false;
  }
}

function run(): void {
  const stdinInput = fs.readFileSync(0, 'utf8');
  const input: unknown = JSON.parse(stdinInput);
  const decision = decide(input, process.env, process.cwd());
  if (decision.deny) {
    process.stderr.write(decision.reason);
    process.exitCode = 2;
  }
}

if (isExecutedDirectly()) {
  try {
    run();
  } catch {
    // R-1: falha aberto só para entrada que não é um comando Bash (stdin vazio, JSON
    // inválido, `tool_name` diferente de `Bash`) ou Node ausente. Comando que a checagem
    // não consegue decidir é negado em `decide` e nunca chega aqui.
  }
}
