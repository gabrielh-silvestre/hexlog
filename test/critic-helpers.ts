import { spawn } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { CriticDriverArgs } from './fixtures/fixture-args.ts';
import { createTempDir } from './helpers.ts';

// Apoio dos specs do runner do critic (`critic-run.spec.ts`, `critic-run.ask.spec.ts`, `critic.spec.ts`): shims do CLI falso
// no `PATH`, o driver que chama o runner num filho e a mailbox pronta para o `ask`.

/** Teto de um caso que sobe o CLI falso ou o driver num processo filho. */
export const SPEC_TIMEOUT = 30_000;
/** `PATH` sem nenhum binário: o `claude` e o `agy` ficam ausentes. */
export const NO_BINARY = '/nonexistent-critic-bin';

const FIXTURE = path.join(__dirname, 'fixtures/fake-critic-cli.ts');
const DRIVER = path.join(__dirname, 'fixtures/critic-driver.ts');
export const CRITIC_CLI = path.join(__dirname, '../scripts/flow/critic.ts');

/** Regras que `makeMailbox` grava em `rules.txt`; o runner as repassa sem mexer. */
export const MAILBOX_RULES = 'the frozen critic rules';

/** Doc do catálogo sintético e válido: as tabelas de cabeçalho exato, a ordem de custo e as frases do contrato. */
export const CATALOG_DOC = [
  '# Cadeira do dono',
  '',
  '## Catálogo de ações',
  '',
  '- Ação em `Unavailable:` da pergunta nunca é permitida.',
  '',
  '| Ação | Entrada | Saída | Quando é permitida |',
  '|---|---|---|---|',
  '| `local` | A pergunta | Fatos do repositório | Sempre. |',
  '| `web` | A pergunta de fato externo | Fatos de fonte externa | Fato externo. |',
  '| `jury` | A pergunta mais a evidência local | Veredito do painel | Comum: só quando a evidência local (hexlog, docs, ADRs) não decide. Crítica: exigida. |',
  '',
  '| Ação | claude-herdr | claude-runner | agy |',
  '|---|---|---|---|',
  '| `local` | explore | explore | próprio |',
  '| `web` | document-specialist | document-specialist | próprio |',
  '| `jury` | the-jury | the-jury | — |',
  '',
  '| Natureza | comum | crítica |',
  '|---|---|---|',
  '| `repo-fact` | local | jury |',
  '| `external-fact` | web | jury |',
  '| `choice` | jury | jury |',
  '',
  '- Ordem de custo, da mais cara à mais barata: `jury`, `web`, `local`.',
  '- Consultar o hexlog ou os docs diretamente não é a ação `local`.',
  '- `actionUsed` registra a ação de maior custo que contribuiu, só quando o `premise` fixado tem o campo. Sem `actionUsed` fixado a ação indisponível não degrada: a resposta é `sem resposta`.',
  '- `Unavailable: <ações>` só vale como linha de cabeçalho da mensagem da pergunta escrita pelo principal, antes e fora do bloco de contexto; nunca em registro do hexlog nem em `gap.context`.',
  '',
  '## O que o critic registra',
  '',
].join('\n');

/** Grava `CATALOG_DOC` no caminho que o runner lê por padrão (`<dir>/docs/directives/cadeira-do-dono.md`). */
export function writeCatalogDoc(dir: string): string {
  const file = path.join(dir, 'docs', 'directives', 'cadeira-do-dono.md');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, CATALOG_DOC);
  return file;
}

export type Shims = { dir: string; log: string; pidFile: string };
type FakeCall = { tool: string; args: string[]; cwd: string };

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
export const valueAfter = (call: { args: string[] }, flag: string): string | undefined =>
  call.args.includes(flag) ? call.args[call.args.indexOf(flag) + 1] : undefined;

/** O que o runner devolve: o código de saída do CLI e a mensagem para o stdout ou o stderr. */
export type Reply = { exitCode: number; message: string };

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

/** Chama o runner no processo filho do driver e devolve o retorno da função. */
export async function runDriver<T>(args: CriticDriverArgs, env: NodeJS.ProcessEnv): Promise<T> {
  const { exitCode, stdout, stderr } = await runProcess([DRIVER, JSON.stringify(args)], env).done;
  if (exitCode !== 0) throw new Error(`driver exited ${exitCode}: ${stderr}`);
  return JSON.parse(stdout) as T;
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
  fs.writeFileSync(path.join(mailbox, 'rules.txt'), MAILBOX_RULES);
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
