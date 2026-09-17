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
import { dirDados } from '../src/diretorio.ts';

// Segmento com `**` ou uma chave `{a/b,c}` com barra dentro: o `path.matchesGlob`
// não expande `**` até a profundidade de D, e o truncamento por `sep` corta a
// chave no meio (R-6, Critic iter2-1) — por isso o prefixo literal decide.
const REGEX_CHAVE_COM_BARRA = /\{[^}]*\/[^}]*\}/;
const REGEX_CARACTERES_GLOB = /[*?[{]/;
// `~` no início do token ou logo após `=` (`--opt=~/x`); shell-quote não expande til.
const REGEX_TIL = /(^|=)~(?=\/|$)/g;

const mensagemNegacao = (d: string): string =>
  `hexlog: ${d} só é acessível pelas tools MCP do hexlog (listar, estado, eventos, cadeia).`;

interface EntradaBruta {
  tool_name?: unknown;
  tool_input?: { command?: unknown };
  cwd?: unknown;
}

function comoEntradaBruta(input: unknown): EntradaBruta | undefined {
  return !isNil(input) && typeof input === 'object' ? input : undefined;
}

function extrairComando(input: unknown): string | undefined {
  const entrada = comoEntradaBruta(input);
  if (isNil(entrada) || entrada.tool_name !== 'Bash') return undefined;
  const comando = entrada.tool_input?.command;
  return isString(comando) ? comando : undefined;
}

function extrairCwd(input: unknown): string | undefined {
  const cwd = comoEntradaBruta(input)?.cwd;
  return isString(cwd) ? cwd : undefined;
}

function expandirTil(token: string, home: string): string {
  return token.replace(REGEX_TIL, `$1${home}`);
}

/** Índice do primeiro segmento com caractere de glob, ou -1 se nenhum. */
function primeiroIndiceComGlob(segmentos: string[]): number {
  return segmentos.findIndex((segmento) => REGEX_CARACTERES_GLOB.test(segmento));
}

/** Só os tokens texto e os padrões `{op: 'glob', pattern}` interessam à checagem. */
function tokensComoStrings(tokens: ParseEntry[]): string[] {
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

function tentarTokenizar(
  comando: string,
  home: string,
  env: NodeJS.ProcessEnv,
): ParseEntry[] | undefined {
  try {
    return shellQuoteParse(comando, { HOME: home, XDG_DATA_HOME: env.XDG_DATA_HOME ?? '' });
  } catch {
    return undefined;
  }
}

/** Um token isolado alcança `D` (por igualdade, prefixo ou glob compatível)? */
function tokenAlcancaDiretorio(
  tokenBruto: string,
  cwd: string,
  dirDados: string,
  home: string,
): boolean {
  const token = expandirTil(tokenBruto, home);
  if (token.includes(dirDados)) return true;

  const sep = path.sep;
  const caminho = path.resolve(cwd, token);
  if (caminho === dirDados || caminho.startsWith(dirDados + sep)) return true;

  const temChaveComBarra = REGEX_CHAVE_COM_BARRA.test(token);
  if (token.includes('**') || temChaveComBarra) {
    const segmentos = caminho.split(sep);
    const indiceGlob = primeiroIndiceComGlob(segmentos);
    const prefixo = indiceGlob === -1 ? caminho : segmentos.slice(0, indiceGlob).join(sep);
    return (
      prefixo === dirDados ||
      dirDados.startsWith(prefixo + sep) ||
      prefixo.startsWith(dirDados + sep)
    );
  }

  if (REGEX_CARACTERES_GLOB.test(token)) {
    const profundidadeDeD = dirDados.split(sep).length;
    const truncado = caminho.split(sep).slice(0, profundidadeDeD).join(sep);
    return matchesGlob(dirDados, truncado);
  }

  return false;
}

/** Decisão pura do guard: sem I/O, testável isolada do processo real. */
function decidir(
  input: unknown,
  env: NodeJS.ProcessEnv,
  cwdPadrao: string,
): { nega: boolean; motivo?: string } {
  const comando = extrairComando(input);
  if (isNil(comando)) return { nega: false };

  const dados = dirDados(env);
  const home = os.homedir();
  const cwd = extrairCwd(input) ?? cwdPadrao;

  const tokens = tentarTokenizar(comando, home, env);
  const alcancaPelosTokens = isNil(tokens)
    ? false
    : tokensComoStrings(tokens).some((token) => tokenAlcancaDiretorio(token, cwd, dados, home));

  // Rede de segurança (§4.14): também decide sozinha quando o
  // parse lança, e cobre o comando citando D fora de qualquer token isolado.
  const nega = alcancaPelosTokens || comando.includes(dados);
  return nega ? { nega: true, motivo: mensagemNegacao(dados) } : { nega: false };
}

/** `import.meta.main` não sobrevive ao bundle do esbuild: compara o caminho do entrypoint. */
function executadoDiretamente(): boolean {
  try {
    return path.resolve(process.argv[1] ?? '') === fileURLToPath(import.meta.url);
  } catch {
    return false;
  }
}

function rodar(): void {
  const entradaStdin = fs.readFileSync(0, 'utf8');
  const input: unknown = JSON.parse(entradaStdin);
  const { nega, motivo } = decidir(input, process.env, process.cwd());
  if (nega) {
    process.stderr.write(motivo ?? '');
    process.exitCode = 2;
  }
}

if (executadoDiretamente()) {
  try {
    rodar();
  } catch {
    // R-1: falha aberto — Node ausente, JSON inválido ou qualquer erro
    // interno nunca deve bloquear o Bash tool.
    process.exitCode = 0;
  }
}
