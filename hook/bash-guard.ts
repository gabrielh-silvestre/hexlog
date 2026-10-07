// Hook PreToolUse para a tool Bash: impede que o agente contorne as tools MCP
// do hexlog lendo o diretório de dados por fora (cat, grep, jq etc). Nunca
// executa nada, só tokeniza o comando recebido.
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse as shellQuoteParse, type ParseEntry } from 'shell-quote';
import { isNil, isString, take, takeWhile } from 'es-toolkit';
import { dataDir } from '../src/directory.ts';

// Segmento com `**` ou uma chave `{a/b,c}` com barra dentro: o `path.matchesGlob`
// não expande `**` até a profundidade de D, e o truncamento por `sep` corta a
// chave no meio (R-6, Critic iter2-1) — por isso o prefixo literal decide.
const SLASH_KEY_REGEX = /\{[^}]*\/[^}]*\}/;
const GLOB_CHARS_REGEX = /[*?[{]/;
// Tetos de um token com caractere de glob, aplicados antes da `SLASH_KEY_REGEX`: sem eles, um
// `[`×4096 leva 17 s na regex e o hook morre no timeout de 10 s, liberando o comando. Texto sem
// glob não é limitado. Falso positivo aceito: um token legítimo acima do teto também é negado.
const MAX_GLOB_TOKEN_LENGTH = 4096;
const MAX_BRACES = 8;
const MAX_BRACKETS = 64;
const COMPOUND_OPERATORS = new Set(['&&', '||', ';', '|']);
const MAX_MATCHED_LENGTH = 200;
// `~` no início do token ou logo após `=` (`--opt=~/x`); shell-quote não expande til.
const TILDE_REGEX = /(^|=)~(?=\/|$)/g;

const denialMessage = (d: string, matched?: string): string =>
  `hexlog: ${d} is only accessible through the hexlog MCP tools (list, query, verify_chain, read_attachment, evaluate_gate, describe_type).` +
  (isNil(matched) ? '' : ` Matched: ${matched.slice(0, MAX_MATCHED_LENGTH)}`);

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

/** Um token isolado alcança `D` (por igualdade, prefixo ou glob compatível)? */
function tokenReachesDirectory(
  rawToken: string,
  cwd: string,
  dataDir: string,
  home: string,
): boolean {
  const token = expandTilde(rawToken, home);
  if (token.includes(dataDir)) return true;
  if (exceedsGlobLimits(token)) return true;

  const sep = path.sep;
  const resolvedPath = path.resolve(cwd, token);
  if (resolvedPath === dataDir || resolvedPath.startsWith(dataDir + sep)) return true;

  const hasSlashKey = SLASH_KEY_REGEX.test(token);
  if (token.includes('**') || hasSlashKey) {
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
    const dirDepth = dataDir.split(sep).length;
    const truncated = take(resolvedPath.split(sep), dirDepth).join(sep);
    return path.matchesGlob(dataDir, truncated);
  }

  return false;
}

/** O primeiro token que alcança `D`; um token que lança também conta como alcance (nega). */
function findReachingToken(
  tokens: string[],
  cwd: string,
  dataDir: string,
  home: string,
): string | undefined {
  return tokens.find((token) => {
    try {
      return tokenReachesDirectory(token, cwd, dataDir, home);
    } catch {
      return true;
    }
  });
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

  const denied = (segments: string[][] | undefined, isMatch: (token: string) => boolean) => ({
    deny: true as const,
    reason: denialMessage(dataDirPath, matchedSegment(segments, isMatch)),
  });
  const segmentsOf = (): string[][] | undefined => {
    const tokens = tryTokenize(command, home, env);
    return isNil(tokens) ? undefined : splitSegments(tokens);
  };

  // A menção literal decide antes de qualquer tokenização: o resto pode lançar ou demorar.
  if (command.includes(dataDirPath)) {
    return denied(segmentsOf(), (token) => token.includes(dataDirPath));
  }

  // Parse que lança (`${}`): o shell também recusa o comando, então nega em vez de liberar.
  const segments = segmentsOf();
  if (isNil(segments)) return denied(undefined, () => false);

  const reaching = findReachingToken(segments.flat(), cwd, dataDirPath, home);
  return isNil(reaching) ? { deny: false } : denied(segments, (token) => token === reaching);
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
