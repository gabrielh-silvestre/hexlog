import { spawn } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { CriticDriverArgs } from './fixtures/fixture-args.ts';
import { createTempDir } from './helpers.ts';

// Apoio dos specs do runner do critic (`critic-run.spec.ts`, `critic.spec.ts`): shims do CLI falso
// no `PATH`, o driver que chama o runner num filho e a mailbox pronta para o `ask`.

const FIXTURE = path.join(__dirname, 'fixtures/fake-critic-cli.ts');
const DRIVER = path.join(__dirname, 'fixtures/critic-driver.ts');
export const CRITIC_CLI = path.join(__dirname, '../scripts/flow/critic.ts');

export type Shims = { dir: string; log: string; pidFile: string };
export type FakeCall = { tool: string; args: string[]; cwd: string };

/** Shims `claude` e `agy` que rodam o CLI falso. Só dentro de hook ou teste (`createTempDir`). */
export function installShims(): Shims {
  const dir = createTempDir('critic-bin');
  for (const tool of ['claude', 'agy']) {
    fs.writeFileSync(
      path.join(dir, tool),
      `#!/bin/sh\nexec "${process.execPath}" "${FIXTURE}" ${tool} "$@"\n`,
      { mode: 0o755 },
    );
  }
  return { dir, log: path.join(dir, 'calls.jsonl'), pidFile: path.join(dir, 'grandchild.pid') };
}

/**
 * Ambiente do filho: `PATH` só com os shims (o `node` entra por caminho absoluto) e `HOME` temporário,
 * nunca o real. `extra` configura o CLI falso e sobrescreve o padrão; valor `undefined` remove a chave.
 */
export function criticEnv(
  shims: Shims,
  extra: Record<string, string | undefined> = {},
): NodeJS.ProcessEnv {
  return {
    PATH: shims.dir,
    HOME: shims.dir,
    FAKE_CRITIC_LOG: shims.log,
    FAKE_CRITIC_PID_FILE: shims.pidFile,
    ...extra,
  };
}

/** Chamadas que o CLI falso registrou, em ordem. */
function readCalls(shims: Shims): FakeCall[] {
  if (!fs.existsSync(shims.log)) return [];
  return fs
    .readFileSync(shims.log, 'utf8')
    .split('\n')
    .filter((line) => line !== '')
    .map((line) => JSON.parse(line) as FakeCall);
}

/** Só os turnos (`-p`), sem as checagens de login e de MCP. */
export const readTurns = (shims: Shims): FakeCall[] =>
  readCalls(shims).filter((call) => call.args.includes('-p'));

/** Valor que segue `flag` no argv da chamada. */
export const valueAfter = (call: FakeCall, flag: string): string | undefined =>
  call.args.includes(flag) ? call.args[call.args.indexOf(flag) + 1] : undefined;

/** Chama o runner no processo filho do driver e devolve o retorno da função. */
export function runDriver<T>(args: CriticDriverArgs, env: NodeJS.ProcessEnv): Promise<T> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [DRIVER, JSON.stringify(args)], { env });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk: Buffer) => void (stdout += chunk.toString()));
    child.stderr.on('data', (chunk: Buffer) => void (stderr += chunk.toString()));
    child.on('close', (code) => {
      if (code === 0) resolve(JSON.parse(stdout) as T);
      else reject(new Error(`driver exited ${code}: ${stderr}`));
    });
  });
}

export type Run = { exitCode: number | null; stdout: string; stderr: string };

/** Sobe um processo e espera o fim; o filho é devolvido para quem precisa sinalizá-lo no meio. */
export function runProcess(
  args: string[],
  env: NodeJS.ProcessEnv,
  cwd?: string,
): { child: ReturnType<typeof spawn>; done: Promise<Run> } {
  const child = spawn(process.execPath, args, { env, cwd });
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (chunk: Buffer) => void (stdout += chunk.toString()));
  child.stderr.on('data', (chunk: Buffer) => void (stderr += chunk.toString()));
  const done = new Promise<Run>((resolve) => {
    child.on('close', (exitCode) => resolve({ exitCode, stdout, stderr }));
  });
  return { child, done };
}

/** Espera `condition` ficar verdadeira; falha com `what` se passar de `timeoutMs`. */
export async function waitFor(
  what: string,
  condition: () => boolean,
  timeoutMs = 10_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

/** Vivo e não zumbi: um filho morto que ninguém colheu ainda responde a `kill(pid, 0)`. */
export function isRunning(pid: number): boolean {
  try {
    const stat = fs.readFileSync(`/proc/${pid}/stat`, 'utf8');
    return stat.slice(stat.lastIndexOf(')') + 2, stat.lastIndexOf(')') + 3) !== 'Z';
  } catch {
    return false;
  }
}

export type MailboxOptions = {
  tool?: 'claude' | 'agy';
  /** Texto de `q-1.txt`, `q-2.txt`, ... */
  questions?: string[];
  /** Campos de `session.json` que trocam o estado inicial. */
  session?: Record<string, unknown>;
};

/** Mailbox no estado que `startSession` deixa, mais as perguntas; devolve também o `cwd` da sessão. */
export function makeMailbox({
  tool = 'claude',
  questions = ['the first question'],
  session = {},
}: MailboxOptions = {}): { mailbox: string; cwd: string } {
  const cwd = fs.realpathSync(createTempDir('critic-cwd'));
  // `closeMailbox` só apaga pasta com o prefixo `hexlog-critic-`, que o `createTempDir` já dá
  const mailbox = createTempDir('critic-box');
  fs.writeFileSync(
    path.join(mailbox, 'mcp.json'),
    JSON.stringify({ mcpServers: { hexlog: { command: 'node' } } }),
  );
  const state = { tool, cwd, sessionId: null, confirmed: false, failures: 0, broken: false };
  fs.writeFileSync(path.join(mailbox, 'session.json'), JSON.stringify({ ...state, ...session }));
  questions.forEach((text, index) =>
    fs.writeFileSync(path.join(mailbox, `q-${index + 1}.txt`), text),
  );
  return { mailbox, cwd };
}

export const readSession = (mailbox: string): Record<string, unknown> =>
  JSON.parse(fs.readFileSync(path.join(mailbox, 'session.json'), 'utf8')) as Record<
    string,
    unknown
  >;

export const readAnswer = (mailbox: string, n: number): string =>
  fs.readFileSync(path.join(mailbox, `a-${n}.txt`), 'utf8');

/** `~/.claude.json` mínimo com o servidor `hexlog` e outro que não pode ir para a mailbox. */
export function writeClaudeJson(dir: string): string {
  const file = path.join(dir, '.claude.json');
  fs.writeFileSync(
    file,
    JSON.stringify({
      mcpServers: {
        hexlog: { command: 'node', args: ['server.mjs'], env: { HEXLOG_X: '1' } },
        other: { command: 'other' },
      },
    }),
  );
  return file;
}
