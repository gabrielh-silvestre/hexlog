// Tokenizador de comando shell que acha `gh pr create` e `gh pr ready` em posição de comando. Puro:
// sem I/O e sem dependência. O `.ts` é a autoridade do casamento; o `if` do settings só poupa o spawn.

/** Invocação de `gh pr <kind>`; `args` são as demais palavras do comando, já sem aspas. */
export type PrCommand = { kind: 'create' | 'ready'; args: string[] };

export type PrMatch = {
  commands: PrCommand[];
  /** Aspa sem par que o tokenizador não fechou e que ainda casa `gh ... pr create|ready` solto. */
  unclosedMatch: boolean;
};

type ScanState = { commands: string[][]; unterminated: boolean };

const LOOSE_PR = /\bgh\b[\s\S]*\bpr\s+(create|ready)\b/;
const ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=/;
const SHELL_C_FLAG = /^-[a-zA-Z]*c[a-zA-Z]*$/;
const SHELLS = new Set(['sh', 'bash', 'zsh']);
// Palavras que deixam a seguinte em posição de comando, sem argumento próprio.
const KEYWORD_PREFIXES = new Set(['!', '{', 'then', 'do', 'else', 'elif', 'if', 'while', 'until']);
// Prefixos que aceitam opções (`-x`) antes do comando de verdade.
const WRAPPER_PREFIXES = new Set(['command', 'env', 'exec', 'sudo', 'time', 'nohup', 'xargs']);

/**
 * Varre `src` a partir de `pos` e acumula os comandos simples em `state`. Com `inSubshell`, para
 * no `)` que fecha o `$(` e devolve a posição seguinte; senão, consome até o fim.
 * ponytail: corpo de heredoc sem aspas no delimitador expande `$(...)` no shell e aqui é só dado.
 */
function scanList(src: string, pos: number, inSubshell: boolean, state: ScanState): number {
  let words: string[] = [];
  let word: string | null = null;
  let heredocs: { delimiter: string; stripTabs: boolean }[] = [];
  let i = pos;

  const endWord = (): void => {
    if (word === null) return;
    words.push(word);
    word = null;
  };
  const endCommand = (): void => {
    endWord();
    if (words.length > 0) state.commands.push(words);
    words = [];
  };
  const append = (text: string): void => {
    word = (word ?? '') + text;
  };

  // Lê `$(`...`)` ou crases a partir de `i` e devolve a posição depois do fechamento.
  const scanSubstitution = (at: number): number => {
    if (src[at] === '`') {
      const end = src.indexOf('`', at + 1);
      if (end < 0) {
        state.unterminated = true;
        return src.length;
      }
      scanList(src.slice(at + 1, end), 0, false, state);
      return end + 1;
    }
    return scanList(src, at + 2, true, state);
  };

  const scanDoubleQuoted = (at: number): number => {
    let j = at + 1;
    while (j < src.length) {
      const c = src[j];
      if (c === '"') return j + 1;
      if (c === '\\') {
        append(src[j + 1] ?? '');
        j += 2;
      } else if (c === '`' || (c === '$' && src[j + 1] === '(')) {
        j = scanSubstitution(j);
      } else {
        append(c ?? '');
        j += 1;
      }
    }
    state.unterminated = true;
    return j;
  };

  const readHeredocDelimiter = (at: number): number => {
    let j = at + 2;
    const stripTabs = src[j] === '-';
    if (stripTabs) j += 1;
    while (src[j] === ' ' || src[j] === '\t') j += 1;
    let delimiter = '';
    while (j < src.length && !/[\s;&|()<>]/.test(src[j] ?? '')) {
      if (src[j] !== "'" && src[j] !== '"' && src[j] !== '\\') delimiter += src[j];
      j += 1;
    }
    heredocs.push({ delimiter, stripTabs });
    return j;
  };

  // Pula os corpos de heredoc pendentes, que começam em `at` (logo após a quebra de linha).
  const skipHeredocBodies = (at: number): number => {
    let j = at;
    for (const { delimiter, stripTabs } of heredocs) {
      while (j < src.length) {
        const end = src.indexOf('\n', j);
        const line = src.slice(j, end < 0 ? src.length : end);
        j = end < 0 ? src.length : end + 1;
        if ((stripTabs ? line.replace(/^\t+/, '') : line) === delimiter) break;
      }
    }
    heredocs = [];
    return j;
  };

  while (i < src.length) {
    const c = src[i] ?? '';
    if (c === '\\') {
      if (src[i + 1] !== '\n') append(src[i + 1] ?? '');
      i += 2;
    } else if (c === "'") {
      const end = src.indexOf("'", i + 1);
      if (end < 0) {
        state.unterminated = true;
        return src.length;
      }
      append(src.slice(i + 1, end));
      i = end + 1;
    } else if (c === '"') {
      word ??= '';
      i = scanDoubleQuoted(i);
    } else if (c === '`' || (c === '$' && src[i + 1] === '(')) {
      append('$');
      i = scanSubstitution(i);
    } else if (c === '<' && src[i + 1] === '<' && src[i + 2] !== '<') {
      endWord();
      i = readHeredocDelimiter(i);
    } else if (c === '\n') {
      endCommand();
      i = skipHeredocBodies(i + 1);
    } else if (c === ')' && inSubshell) {
      endCommand();
      return i + 1;
    } else if (c === '#' && word === null) {
      const end = src.indexOf('\n', i);
      i = end < 0 ? src.length : end;
    } else if (/[;&|()]/.test(c)) {
      endCommand();
      i += 1;
    } else if (/\s/.test(c)) {
      endWord();
      i += 1;
    } else {
      append(c);
      i += 1;
    }
  }
  if (inSubshell) state.unterminated = true;
  endCommand();
  return i;
}

/** Índice da primeira palavra do comando de verdade, depois de atribuições e prefixos. */
function commandStart(words: string[]): number {
  let i = 0;
  while (i < words.length) {
    const word = words[i] ?? '';
    if (ASSIGNMENT.test(word) || KEYWORD_PREFIXES.has(word)) {
      i += 1;
    } else if (WRAPPER_PREFIXES.has(word)) {
      i += 1;
      while (words[i]?.startsWith('-')) i += 1;
    } else if (word === 'nice') {
      i += words[i + 1] === '-n' ? 3 : 1;
    } else if (word === 'timeout') {
      i += 1;
      while (words[i]?.startsWith('-')) i += words[i] === '-k' || words[i] === '-s' ? 2 : 1;
      i += 1;
    } else {
      break;
    }
  }
  return i;
}

function findPrCommand(afterGh: string[]): PrCommand | undefined {
  for (let i = 0; i + 1 < afterGh.length; i += 1) {
    const kind = afterGh[i + 1];
    if (afterGh[i] === 'pr' && (kind === 'create' || kind === 'ready')) {
      return { kind, args: [...afterGh.slice(0, i), ...afterGh.slice(i + 2)] };
    }
  }
  return undefined;
}

function collect(command: string, state: ScanState): PrCommand[] {
  const scanned: ScanState = { commands: [], unterminated: false };
  scanList(command, 0, false, scanned);
  state.unterminated ||= scanned.unterminated;

  return scanned.commands.flatMap((words) => {
    const start = commandStart(words);
    const name = words[start]?.split('/').pop() ?? '';
    const rest = words.slice(start + 1);
    if (name === 'gh') return findPrCommand(rest) ?? [];
    if (name === 'eval') return collect(rest.join(' '), state);
    if (SHELLS.has(name)) {
      const flag = rest.findIndex((word) => SHELL_C_FLAG.test(word));
      const payload = flag < 0 ? undefined : rest[flag + 1];
      return payload === undefined ? [] : collect(payload, state);
    }
    return [];
  });
}

/** Acha os `gh pr create` e `gh pr ready` em posição de comando de `command`. */
export function findPrCommands(command: string): PrMatch {
  const state: ScanState = { commands: [], unterminated: false };
  const commands = collect(command, state);
  return { commands, unclosedMatch: state.unterminated && LOOSE_PR.test(command) };
}
