// Hook PreToolUse para a tool Bash: impede que o agente contorne as tools MCP
// do hexlog lendo o diretório de dados por fora (cat, grep, jq etc). Nunca
// executa nada, só tokeniza o comando recebido.
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { matchesGlob } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse as shellQuoteParse, type ParseEntry } from 'shell-quote';
import { isNil, isString } from 'es-toolkit';
import { dataDir } from '../src/directory.ts';

// Segmento com `**` ou uma chave `{a/b,c}` com barra dentro: o `path.matchesGlob`
// não expande `**` até a profundidade de D, e o truncamento por `sep` corta a
// chave no meio (R-6, Critic iter2-1) — por isso o prefixo literal decide.
const SLASH_KEY_REGEX = /\{[^}]*\/[^}]*\}/;
const GLOB_CHARS_REGEX = /[*?[{]/;
// `~` no início do token ou logo após `=` (`--opt=~/x`); shell-quote não expande til.
const TILDE_REGEX = /(^|=)~(?=\/|$)/g;

const denialMessage = (d: string): string =>
  `hexlog: ${d} is only accessible through the hexlog MCP tools (list, state, events, chain).`;

interface RawInput {
  tool_name?: unknown;
  tool_input?: { command?: unknown };
  cwd?: unknown;
}

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

/** Índice do primeiro segmento com caractere de glob, ou -1 se nenhum. */
function firstGlobIndex(segments: string[]): number {
  return segments.findIndex((segment) => GLOB_CHARS_REGEX.test(segment));
}

/** Só os tokens texto e os padrões `{op: 'glob', pattern}` interessam à checagem. */
function tokensAsStrings(tokens: ParseEntry[]): string[] {
  const strings: string[] = [];
  for (const token of tokens) {
    if (isString(token)) {
      strings.push(token);
    } else if ('op' in token && token.op === 'glob') {
      strings.push(token.pattern);
    }
  }
  return strings;
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

/** Um token isolado alcança `D` (por igualdade, prefixo ou glob compatível)? */
function tokenReachesDirectory(
  rawToken: string,
  cwd: string,
  dataDir: string,
  home: string,
): boolean {
  const token = expandTilde(rawToken, home);
  if (token.includes(dataDir)) return true;

  const sep = path.sep;
  const resolvedPath = path.resolve(cwd, token);
  if (resolvedPath === dataDir || resolvedPath.startsWith(dataDir + sep)) return true;

  const hasSlashKey = SLASH_KEY_REGEX.test(token);
  if (token.includes('**') || hasSlashKey) {
    const segments = resolvedPath.split(sep);
    const globIndex = firstGlobIndex(segments);
    const prefix = globIndex === -1 ? resolvedPath : segments.slice(0, globIndex).join(sep);
    return (
      prefix === dataDir || dataDir.startsWith(prefix + sep) || prefix.startsWith(dataDir + sep)
    );
  }

  if (GLOB_CHARS_REGEX.test(token)) {
    const dirDepth = dataDir.split(sep).length;
    const truncated = resolvedPath.split(sep).slice(0, dirDepth).join(sep);
    return matchesGlob(dataDir, truncated);
  }

  return false;
}

/** Decisão pura do guard: sem I/O, testável isolada do processo real. */
function decide(
  input: unknown,
  env: NodeJS.ProcessEnv,
  defaultCwd: string,
): { deny: boolean; reason?: string } {
  const command = extractCommand(input);
  if (isNil(command)) return { deny: false };

  const dataDirPath = dataDir(env);
  const home = os.homedir();
  const cwd = extractCwd(input) ?? defaultCwd;

  const tokens = tryTokenize(command, home, env);
  const reachedByTokens = isNil(tokens)
    ? false
    : tokensAsStrings(tokens).some((token) => tokenReachesDirectory(token, cwd, dataDirPath, home));

  // Rede de segurança (§4.14): também decide sozinha quando o
  // parse lança, e cobre o comando citando D fora de qualquer token isolado.
  const deny = reachedByTokens || command.includes(dataDirPath);
  return deny ? { deny: true, reason: denialMessage(dataDirPath) } : { deny: false };
}

/** `import.meta.main` não sobrevive ao bundle do esbuild: compara o caminho do entrypoint. */
function isExecutedDirectly(): boolean {
  try {
    return path.resolve(process.argv[1] ?? '') === fileURLToPath(import.meta.url);
  } catch {
    return false;
  }
}

function run(): void {
  const stdinInput = fs.readFileSync(0, 'utf8');
  const input: unknown = JSON.parse(stdinInput);
  const { deny, reason } = decide(input, process.env, process.cwd());
  if (deny) {
    process.stderr.write(reason ?? '');
    process.exitCode = 2;
  }
}

if (isExecutedDirectly()) {
  try {
    run();
  } catch {
    // R-1: falha aberto — Node ausente, JSON inválido ou qualquer erro
    // interno nunca deve bloquear o Bash tool.
    process.exitCode = 0;
  }
}
