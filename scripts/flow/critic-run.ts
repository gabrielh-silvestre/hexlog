// Borda de I/O do runner do critic da cadeira do dono: mailbox em `os.tmpdir()`, lock por pergunta,
// processo filho em stream com timeout por inatividade, retry e contadores. Uma execução da CLI do
// critic por pergunta (`claude -p --resume`, `agy -p --conversation`), sem processo permanente.
// Só builtins do Node e sem `import.meta`, para o jest carregá-lo; o `critic.ts` liga o argv.
// Tempos, backoff, teto de texto e o leitor de `/proc` entram por parâmetro: os specs injetam
// valores pequenos, a CLI usa `DEFAULT_TIMING`.
import { spawn, spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { StringDecoder } from 'node:string_decoder';
import { escapeControls } from '../escape-controls.ts';
import {
  buildCommand,
  buildPrompt,
  classifyFailure,
  EMPTY_TURN,
  foldTurn,
  PROMPT_MAX_BYTES,
  QUESTION_MAX_BYTES,
  truncateText,
  type Command,
  type Tool,
  type Turn,
  type TurnOutcome,
} from './critic-tools.ts';

export const EXIT = {
  ok: 0,
  usage: 1,
  missingMailbox: 2,
  unavailable: 3,
  credential: 4,
  failed: 5,
  busy: 6,
  timeout: 7,
  sighup: 129,
  sigint: 130,
  sigterm: 143,
} as const;

export type Reply = { exitCode: number; message: string };

const reply = (exitCode: number, message: string): Reply => ({ exitCode, message });

type Timing = {
  /** Sem byte em stdout nem stderr por este tempo, o turno estoura. */
  idleMs: number;
  /** Teto absoluto do turno, mesmo falando. */
  capMs: number;
  /** Pausa antes de cada retentativa de falha transitória; o tamanho da lista dá as tentativas. */
  backoffMs: number[];
  /** Teto do texto da resposta final; acima dele o texto é truncado. */
  maxTextBytes: number;
};

const DEFAULT_TIMING: Timing = {
  idleMs: 300_000,
  capMs: 1_800_000,
  backoffMs: [5_000, 20_000],
  maxTextBytes: 1_048_576,
};

/** Perguntas seguidas que terminam em falha transitória esgotada até a sessão virar `broken`. */
const MAX_FAILURES = 3;
const MAILBOX_PREFIX = 'hexlog-critic-';
const SLUG = /^[a-z0-9][a-z0-9-]{0,62}$/;
const CHECK_TIMEOUT_MS = 30_000;
const STDERR_TAIL_BYTES = 4096;
const DETAIL_CHARS = 300;

/**
 * Estado da sessão em `session.json`. `sessionId` só existe depois que a sessão nasceu no lado da
 * ferramenta (`TurnState.established`); `confirmed` é o primeiro turno que respondeu: até lá o
 * prompt leva as regras do critic.
 */
type Session = {
  tool: Tool;
  cwd: string;
  sessionId: string | null;
  confirmed: boolean;
  failures: number;
  broken: boolean;
};

const sessionFile = (mailbox: string) => path.join(mailbox, 'session.json');

function writeAtomic(file: string, data: string, mode: number): void {
  const staged = `${file}.${randomUUID()}.tmp`;
  fs.writeFileSync(staged, data, { mode });
  fs.renameSync(staged, file);
}

const writeSession = (mailbox: string, session: Session): void =>
  writeAtomic(sessionFile(mailbox), `${JSON.stringify(session, null, 2)}\n`, 0o600);

const readSession = (mailbox: string): Session =>
  JSON.parse(fs.readFileSync(sessionFile(mailbox), 'utf8')) as Session;

/** `starttime` (campo 22 de `/proc/<pid>/stat`), ou `undefined` sem `/proc` ou sem o pid. */
export function procStartTime(pid: number): number | undefined {
  try {
    const stat = fs.readFileSync(`/proc/${pid}/stat`, 'utf8');
    // `comm` pode ter espaço e parêntese: os campos contam a partir do último `)`
    const value = Number(stat.slice(stat.lastIndexOf(')') + 2).split(' ')[19]);
    return Number.isFinite(value) ? value : undefined;
  } catch {
    return undefined;
  }
}

type ReadStartTime = (pid: number) => number | undefined;

type Holder = { pid: number; startTime: number | null; token: string };

function readHolder(lock: string): Holder | undefined {
  try {
    return JSON.parse(fs.readFileSync(lock, 'utf8')) as Holder;
  } catch {
    return undefined;
  }
}

/** Pid morto ou `startTime` diferente (pid reaproveitado); dono vivo nunca. */
function isOrphan(lock: string, readStartTime: ReadStartTime): boolean {
  const holder = readHolder(lock);
  if (holder === undefined) return true;
  try {
    process.kill(holder.pid, 0);
  } catch (error) {
    // `EPERM`: o pid existe, é de outro usuário
    if ((error as NodeJS.ErrnoException).code !== 'EPERM') return true;
  }
  return (readStartTime(holder.pid) ?? null) !== holder.startTime;
}

/**
 * Cria `ask.lock` por `link` exclusivo de um arquivo já completo (nunca há lock meio escrito).
 * Devolve quem solta o lock, ou `undefined` quando o dono está vivo. `ponytail:` dois que roubam o
 * mesmo órfão ao mesmo tempo podem se atropelar; o `ask` roda um por vez pela skill, melhorar com
 * rename do órfão para nome único se isso mudar.
 */
function acquireLock(mailbox: string, readStartTime: ReadStartTime): (() => void) | undefined {
  const lock = path.join(mailbox, 'ask.lock');
  const token = randomUUID();
  const staged = `${lock}.${token}.tmp`;
  const holder: Holder = { pid: process.pid, startTime: readStartTime(process.pid) ?? null, token };
  fs.writeFileSync(staged, JSON.stringify(holder), { mode: 0o600 });
  const release = () => {
    if (readHolder(lock)?.token === token) fs.rmSync(lock, { force: true });
  };
  try {
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        fs.linkSync(staged, lock);
        return release;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      }
      if (attempt === 0) {
        if (!isOrphan(lock, readStartTime)) return undefined;
        fs.rmSync(lock, { force: true });
      }
    }
    return undefined;
  } finally {
    fs.rmSync(staged, { force: true });
  }
}

type TurnRun = TurnOutcome & { aborted: boolean; stderrTail: string };

/**
 * Roda um turno: processo `detached` (grupo próprio), stdin em `/dev/null`, stdout lido linha a
 * linha sem acumular o stream, e só a resposta final guardada. Qualquer byte em stdout ou stderr
 * zera o relógio de inatividade; inatividade, teto absoluto e `signal` matam o grupo inteiro.
 */
export function runTurn(
  command: Command,
  { cwd, tool, timing, signal }: { cwd: string; tool: Tool; timing: Timing; signal: AbortSignal },
): Promise<TurnRun> {
  return new Promise((resolve) => {
    let turn = EMPTY_TURN;
    let timedOut = false;
    let aborted = false;
    let settled = false;
    let stderrTail = '';
    let pending = '';
    let discarding = false;
    const decoder = new StringDecoder('utf8');
    // `\uXXXX` infla o texto em até 6x; linha acima disso não cabe na resposta e é descartada
    const lineCap = timing.maxTextBytes * 6 + 65_536;

    const child = spawn(command.bin, command.args, {
      cwd,
      detached: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const killGroup = () => {
      // o `close` só chega com os pipes fechados: neto fora do grupo (`setsid`) que herdou o stdout os seguraria
      child.stdout.destroy();
      child.stderr.destroy();
      if (child.pid === undefined) return;
      try {
        process.kill(-child.pid, 'SIGKILL');
      } catch {
        // o grupo já acabou
      }
    };
    const idle = setTimeout(() => {
      timedOut = true;
      killGroup();
    }, timing.idleMs);
    const cap = setTimeout(() => {
      timedOut = true;
      killGroup();
    }, timing.capMs);
    const onAbort = () => {
      aborted = true;
      killGroup();
    };
    signal.addEventListener('abort', onAbort, { once: true });

    const settle = (exitCode: number | null, spawnError?: string) => {
      if (settled) return;
      settled = true;
      clearTimeout(idle);
      clearTimeout(cap);
      signal.removeEventListener('abort', onAbort);
      if (!discarding) turn = foldTurn(tool, turn, pending + decoder.end());
      resolve({ exitCode, timedOut, spawnError, turn, aborted, stderrTail });
    };

    child.stdout.on('data', (chunk: Buffer) => {
      idle.refresh();
      let text = decoder.write(chunk);
      if (discarding) {
        const newline = text.indexOf('\n');
        if (newline < 0) return;
        text = text.slice(newline + 1);
        discarding = false;
      }
      const lines = (pending + text).split('\n');
      pending = lines.pop() ?? '';
      for (const line of lines) turn = foldTurn(tool, turn, line);
      if (pending.length > lineCap) {
        pending = '';
        discarding = true;
      }
    });
    child.stderr.on('data', (chunk: Buffer) => {
      idle.refresh();
      stderrTail = (stderrTail + chunk.toString()).slice(-STDERR_TAIL_BYTES);
    });
    child.on('error', (error: NodeJS.ErrnoException) => settle(null, error.code ?? error.message));
    child.on('close', (code) => settle(code));
  });
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    signal.addEventListener(
      'abort',
      () => {
        clearTimeout(timer);
        resolve();
      },
      { once: true },
    );
  });
}

/** Comandos que provam o login sem gastar cota. */
const LOGIN_CHECK: Record<Tool, string[]> = { claude: ['auth', 'status'], agy: ['models'] };

type Login = 'ok' | 'missing' | 'logged-out';

function loginState(tool: Tool): Login {
  const result = spawnSync(tool, LOGIN_CHECK[tool], { stdio: 'ignore', timeout: CHECK_TIMEOUT_MS });
  if (result.error !== undefined) return 'missing';
  return result.status === 0 ? 'ok' : 'logged-out';
}

/**
 * Entrada `hexlog` de `~/.claude.json` só com `type`, `command` e `args` (um `env` com segredo não
 * vai para `/tmp`), ou `undefined` quando falta ou o arquivo não lê.
 */
function hexlogServer(claudeJsonPath: string): object | undefined {
  try {
    const parsed = JSON.parse(fs.readFileSync(claudeJsonPath, 'utf8')) as {
      mcpServers?: { hexlog?: unknown };
    };
    const server = parsed.mcpServers?.hexlog;
    if (typeof server !== 'object' || server === null) return undefined;
    const { type, command, args } = server as Record<string, unknown>;
    return { type, command, args };
  } catch {
    return undefined;
  }
}

function agyListsHexlog(): boolean {
  const result = spawnSync('agy', ['mcp', 'list'], { encoding: 'utf8', timeout: CHECK_TIMEOUT_MS });
  return result.status === 0 && result.stdout.includes('hexlog');
}

export type StartOptions = {
  tool: Tool;
  slug: string;
  /** Worktree em que o critic roda. */
  cwd: string;
  tmpdir?: string;
  claudeJsonPath?: string;
};

/** Pré-condição que falta para o critic subir, ou `undefined` com tudo no lugar. */
function missingPrecondition(tool: Tool, server: object | undefined): string | undefined {
  const login = loginState(tool);
  if (login === 'missing') return `${tool} is not available on the PATH`;
  if (login === 'logged-out') return `${tool} is not logged in`;
  if (server === undefined) return 'hexlog server not registered in ~/.claude.json';
  if (tool === 'agy' && !agyListsHexlog()) return 'hexlog server not registered in agy';
  return undefined;
}

/**
 * Confere as pré-condições e cria a mailbox `hexlog-critic-<slug>-XXXXXX` (modo `0700`, config MCP
 * `0600` só com o `hexlog`). Sai 3, sem criar nada, se algo falta; a mensagem de sucesso é o
 * caminho da mailbox. Não varre mailboxes velhas.
 */
export function startSession({
  tool,
  slug,
  cwd,
  tmpdir = os.tmpdir(),
  claudeJsonPath = path.join(os.homedir(), '.claude.json'),
}: StartOptions): Reply {
  if (!SLUG.test(slug)) return reply(EXIT.usage, `invalid slug "${slug}"`);
  if (!fs.statSync(cwd, { throwIfNoEntry: false })?.isDirectory()) {
    return reply(EXIT.usage, `cwd is not a directory: ${cwd}`);
  }
  const server = hexlogServer(claudeJsonPath);
  const problem = missingPrecondition(tool, server);
  if (problem !== undefined) return reply(EXIT.unavailable, problem);

  const mailbox = fs.mkdtempSync(path.join(tmpdir, `${MAILBOX_PREFIX}${slug}-`));
  try {
    writeAtomic(
      path.join(mailbox, 'mcp.json'),
      JSON.stringify({ mcpServers: { hexlog: server } }),
      0o600,
    );
    writeSession(mailbox, {
      tool,
      cwd,
      sessionId: null,
      confirmed: false,
      failures: 0,
      broken: false,
    });
  } catch (error) {
    fs.rmSync(mailbox, { recursive: true, force: true });
    throw error;
  }
  return reply(EXIT.ok, mailbox);
}

/** Maior `n` entre os `q-<n>.txt` da mailbox. */
function latestQuestion(mailbox: string): number | undefined {
  const numbers = fs
    .readdirSync(mailbox)
    .map((name) => /^q-(\d+)\.txt$/.exec(name)?.[1])
    .filter((digits) => digits !== undefined)
    .map(Number);
  return numbers.length === 0 ? undefined : Math.max(...numbers);
}

function turnFor(session: Session, mailbox: string, prompt: string): Turn {
  const known = session.sessionId;
  return {
    prompt,
    mcpConfigPath: path.join(mailbox, 'mcp.json'),
    resume: known !== null,
    // o Claude precisa do id antes de falar; o `agy` só o recebe depois do primeiro evento
    sessionId: known ?? (session.tool === 'claude' ? randomUUID() : undefined),
  };
}

/** Grava o id da sessão assim que ela existe no lado da ferramenta, mesmo com o turno falho. */
function rememberSession(mailbox: string, session: Session, run: TurnRun): Session {
  const { sessionId, established } = run.turn;
  if (session.sessionId !== null || !established || sessionId === undefined) return session;
  const next = { ...session, sessionId };
  writeSession(mailbox, next);
  return next;
}

function describeRun(run: TurnRun): string {
  const answer = run.turn.final?.text ?? '';
  const detail = [answer, run.stderrTail.trim()].find((text) => text !== '');
  // o texto vem do stream e do stderr da ferramenta e chega ao terminal do dono
  return escapeControls(detail ?? `exit ${run.exitCode}`).slice(0, DETAIL_CHARS);
}

const interrupted = (signal: AbortSignal): Reply =>
  reply(Number(signal.reason), 'interrupted by a signal');

type Attempts = {
  mailbox: string;
  n: number;
  prompt: string;
  timing: Timing;
  signal: AbortSignal;
};

/** Grava `a-<n>.txt` (texto truncado) e a sessão confirmada; a mensagem de sucesso é o caminho. */
function recordAnswer({ mailbox, n, timing }: Attempts, session: Session, run: TurnRun): Reply {
  const answer = path.join(mailbox, `a-${n}.txt`);
  writeAtomic(answer, truncateText(run.turn.final?.text ?? '', timing.maxTextBytes), 0o600);
  writeSession(mailbox, { ...session, confirmed: true, failures: 0 });
  return reply(EXIT.ok, answer);
}

async function runAttempts(input: Attempts, initial: Session): Promise<Reply> {
  const { mailbox, prompt, timing, signal } = input;
  let session = initial;
  let detail = '';
  const attempts = timing.backoffMs.length + 1;
  for (let attempt = 0; attempt < attempts; attempt++) {
    if (signal.aborted) return interrupted(signal);
    const run = await runTurn(buildCommand(session.tool, turnFor(session, mailbox, prompt)), {
      cwd: session.cwd,
      tool: session.tool,
      timing,
      signal,
    });
    session = rememberSession(mailbox, session, run);
    if (run.aborted) return interrupted(signal);
    if (run.spawnError === 'ENOENT') {
      return reply(EXIT.unavailable, `${session.tool} is not available on the PATH`);
    }
    detail = describeRun(run);
    const failure = classifyFailure(session.tool, run);
    if (failure === undefined) return recordAnswer(input, session, run);
    if (failure === 'credential') return reply(EXIT.credential, `credential failure: ${detail}`);
    if (failure === 'timeout') return reply(EXIT.timeout, `turn timed out: ${detail}`);
    const pause = timing.backoffMs[attempt];
    if (pause !== undefined) await sleep(pause, signal);
  }
  const failures = session.failures + 1;
  const broken = failures >= MAX_FAILURES;
  writeSession(mailbox, { ...session, failures, broken });
  const suffix = broken ? '; the session is now broken' : '';
  return reply(EXIT.failed, `turn failed after ${attempts} attempts: ${detail}${suffix}`);
}

/** Lê a pergunta pendente e monta o prompt; devolve a recusa quando algo passa dos tetos de argv. */
function pendingPrompt(
  mailbox: string,
  session: Session,
  n: number,
): { prompt: string } | { refusal: Reply } {
  const current = fs.readFileSync(path.join(mailbox, `q-${n}.txt`), 'utf8');
  // com a sessão confirmada o prompt é só a pergunta atual: `q-1` não entra
  const first =
    n === 1 || session.confirmed ? current : fs.readFileSync(path.join(mailbox, 'q-1.txt'), 'utf8');
  if (Math.max(Buffer.byteLength(first), Buffer.byteLength(current)) > QUESTION_MAX_BYTES) {
    return {
      refusal: reply(EXIT.usage, `question is over ${QUESTION_MAX_BYTES} bytes (argv limit)`),
    };
  }
  const prompt = buildPrompt({ confirmed: session.confirmed, n, first, current });
  if (Buffer.byteLength(prompt) > PROMPT_MAX_BYTES) {
    return { refusal: reply(EXIT.usage, `prompt is over ${PROMPT_MAX_BYTES} bytes (argv limit)`) };
  }
  return { prompt };
}

async function answerPending(
  mailbox: string,
  session: Session,
  timing: Timing,
  signal: AbortSignal,
): Promise<Reply> {
  if (session.broken) return reply(EXIT.failed, 'the session is broken: replace the critic');
  const n = latestQuestion(mailbox);
  if (n === undefined) return reply(EXIT.usage, 'no q-<n>.txt question in the mailbox');
  const answer = path.join(mailbox, `a-${n}.txt`);
  if (fs.existsSync(answer)) return reply(EXIT.ok, answer);
  const built = pendingPrompt(mailbox, session, n);
  if ('refusal' in built) return built.refusal;
  if (!fs.statSync(session.cwd, { throwIfNoEntry: false })?.isDirectory()) {
    return reply(EXIT.unavailable, `the session cwd is gone: ${session.cwd}`);
  }
  // `agy -p` sem login espera 60 s pela OAuth em vez de falhar: confere antes de rodar
  const login = session.tool === 'agy' ? loginState('agy') : 'ok';
  if (login === 'missing') return reply(EXIT.unavailable, 'agy is not available on the PATH');
  if (login === 'logged-out') return reply(EXIT.credential, 'agy is not logged in');
  return runAttempts({ mailbox, n, prompt: built.prompt, timing, signal }, session);
}

export type AskOptions = {
  timing?: Partial<Timing>;
  readStartTime?: ReadStartTime;
};

const SIGNAL_EXIT = { SIGHUP: EXIT.sighup, SIGINT: EXIT.sigint, SIGTERM: EXIT.sigterm } as const;

/**
 * Responde à pergunta mais recente da mailbox (`q-<n>.txt` para `a-<n>.txt`). Um `ask` por vez
 * (`ask.lock`); SIGHUP, SIGINT e SIGTERM matam o grupo do filho e soltam o lock, e a mailbox fica.
 * A mensagem de sucesso é o caminho da resposta.
 */
export async function askQuestion(
  given: string,
  { timing, readStartTime = procStartTime }: AskOptions = {},
): Promise<Reply> {
  // o `mcp.json` e a saída são lidos de outro `cwd`: o caminho relativo quebraria os dois
  const mailbox = path.resolve(given);
  if (!fs.existsSync(sessionFile(mailbox))) {
    return reply(EXIT.missingMailbox, `mailbox not found: ${mailbox}`);
  }
  const controller = new AbortController();
  const handlers = (Object.keys(SIGNAL_EXIT) as (keyof typeof SIGNAL_EXIT)[]).map((name) => {
    const handler = () => controller.abort(SIGNAL_EXIT[name]);
    process.on(name, handler);
    return { name, handler };
  });
  let release: (() => void) | undefined;
  try {
    release = acquireLock(mailbox, readStartTime);
    if (release === undefined) return reply(EXIT.busy, 'another ask is running in this mailbox');
    return await answerPending(
      mailbox,
      readSession(mailbox),
      { ...DEFAULT_TIMING, ...timing },
      controller.signal,
    );
  } finally {
    release?.();
    handlers.forEach(({ name, handler }) => process.off(name, handler));
  }
}

/**
 * Remove a mailbox; idempotente. Só apaga pasta com o prefixo da mailbox, direto em `os.tmpdir()` e
 * com `session.json` dentro, nunca um caminho qualquer; pasta ausente sai 0.
 */
export function closeMailbox(given: string): Reply {
  const mailbox = path.resolve(given);
  const direct = path.dirname(mailbox) === path.resolve(os.tmpdir());
  if (!direct || !path.basename(mailbox).startsWith(MAILBOX_PREFIX)) {
    return reply(EXIT.usage, `not a critic mailbox: ${given}`);
  }
  if (fs.existsSync(mailbox) && !fs.existsSync(sessionFile(mailbox))) {
    return reply(EXIT.usage, `not a critic mailbox (no session.json): ${given}`);
  }
  fs.rmSync(mailbox, { recursive: true, force: true });
  return reply(EXIT.ok, given);
}
