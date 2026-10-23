// CLI falso do critic: faz o papel de `claude` e de `agy` nos specs do runner (`critic-run.spec.ts`,
// `critic.spec.ts`). Roda como processo filho, nunca importado pelo jest. O spec monta dois shims
// `claude` e `agy` num diretório no início do `PATH` que fazem `exec node <este arquivo> <tool> "$@"`.
//
// argv: `<tool> <args da CLI real...>` com `tool` em `claude | agy`. Reconhece os comandos que o
// runner chama: `claude auth status`, `agy models`, `agy mcp list` e o turno (`-p`).
//
// env:
//   FAKE_CRITIC_LOG         arquivo JSONL em que cada chamada acrescenta `{tool, args, cwd}` (obrigatório)
//   FAKE_CRITIC_MODE        comportamento do turno (padrão `reply`):
//     reply                 eventos no formato real da ferramenta e resposta final, exit 0
//     slow                  igual a `reply`, com `FAKE_CRITIC_GAP_MS` entre os eventos (4 intervalos)
//     silent                emite o início e cala para sempre (estoura a inatividade)
//     grandchild            como `silent`, com um neto vivo no mesmo grupo (pid em `FAKE_CRITIC_PID_FILE`)
//     detached-grandchild   como `grandchild`, mas o neto sai do grupo (`setsid`) e herda o stdout
//     credential            resultado `is_error` de credencial, exit 1
//     error                 resultado `is_error` que não é de credencial, exit 1 (texto em `FAKE_CRITIC_ERROR`)
//     init-then-fail        emite o `init` e sai 1 sem resultado, com erro em stderr
//     init-then-fail-once   o 1º turno do log é `init-then-fail`, os seguintes `reply`
//     fail-once             o 1º turno do log sai 1 sem nenhum evento, os seguintes `reply`
//     no-id                 `agy` com resultado de sucesso sem id de conversa
//     huge-line             `reply` com uma linha de 300 KB antes do resultado
//     mcp-down              `reply` do Claude cujo `init` declara o `hexlog` como `failed`, exit 0
//     exit-after-answer     `reply` que sai 1 depois do resultado íntegro
//   FAKE_CRITIC_REPLY       texto da resposta final (padrão `fake critic answer`)
//   FAKE_CRITIC_ERROR       texto do modo `error` (padrão `API Error: overloaded`)
//   FAKE_CRITIC_GAP_MS      pausa do modo `slow` (padrão 100)
//   FAKE_CRITIC_PID_FILE    onde os modos `grandchild` e `detached-grandchild` gravam o pid do neto
//   FAKE_CRITIC_AGY_ID      id de conversa que o `agy` entrega no primeiro turno
//   FAKE_CRITIC_LOGGED_OUT  `1` faz `claude auth status` e `agy models` saírem 1
//   FAKE_CRITIC_NO_AGY_MCP  `1` faz `agy mcp list` sair 0 sem listar o `hexlog`
import { spawn } from 'node:child_process';
import * as fs from 'node:fs';

type Call = { tool: string; args: string[]; cwd: string };
type Dialect = {
  begin: () => void;
  init: () => void;
  progress: () => void;
  answer: (text: string) => void;
  failure: (text: string) => void;
};

const [tool = '', ...args] = process.argv.slice(2);
const { env } = process;
const logFile = env.FAKE_CRITIC_LOG ?? '';
const reply = env.FAKE_CRITIC_REPLY ?? 'fake critic answer';
const CREDENTIAL_TEXT = {
  claude: 'Not logged in · Please run /login',
  agy: 'authentication failed or timed out',
} as const;

const mcpServers = [
  { name: 'hexlog', status: env.FAKE_CRITIC_MODE === 'mcp-down' ? 'failed' : 'connected' },
];

const isTurn = (call: Call): boolean => call.args.includes('-p');
const valueAfter = (flag: string): string | undefined =>
  args.includes(flag) ? args[args.indexOf(flag) + 1] : undefined;
const out = (event: unknown): void => void process.stdout.write(`${JSON.stringify(event)}\n`);
const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

const previous: Call[] = fs.existsSync(logFile)
  ? fs
      .readFileSync(logFile, 'utf8')
      .split('\n')
      .filter((line) => line !== '')
      .map((line) => JSON.parse(line) as Call)
  : [];
fs.appendFileSync(logFile, `${JSON.stringify({ tool, args, cwd: process.cwd() })}\n`);

function claudeDialect(id: string): Dialect {
  return {
    begin: () => {
      out({
        type: 'system',
        subtype: 'hook_started',
        hook_name: 'SessionStart:startup',
        session_id: id,
      });
      process.stdout.write('global hook noise that is not json\n');
    },
    init: () =>
      out({
        type: 'system',
        subtype: 'init',
        session_id: id,
        model: 'opus',
        mcp_servers: mcpServers,
      }),
    progress: () => out({ type: 'assistant', session_id: id, message: { role: 'assistant' } }),
    answer: (text) =>
      out({ type: 'result', subtype: 'success', is_error: false, result: text, session_id: id }),
    failure: (text) => {
      out({
        type: 'system',
        subtype: 'init',
        session_id: id,
        model: 'opus',
        mcp_servers: mcpServers,
      });
      out({ type: 'result', subtype: 'success', is_error: true, result: text, session_id: id });
    },
  };
}

function agyDialect(id: string): Dialect {
  const step = { conversation_id: id, step_index: 1, step_type: 'agent_response' };
  return {
    begin: () => undefined,
    init: () => out({ event: 'init', conversation_id: id, init: { model: 'gemini-4-argon-high' } }),
    progress: () =>
      out({
        event: 'step_update',
        step_update: { ...step, state: 'ACTIVE', text_delta: 'working' },
      }),
    answer: (text) =>
      out({ event: 'result', result: { conversation_id: id, status: 'SUCCESS', response: text } }),
    // o `agy` com falha não emite `init` nem entrega id de conversa
    failure: (text) =>
      out({
        event: 'result',
        result: { conversation_id: '', status: 'ERROR', response: '', error: text },
      }),
  };
}

const hang = (): Promise<never> => {
  setInterval(() => undefined, 1000);
  return new Promise<never>(() => undefined);
};

function resolveMode(attempt: number): string {
  const mode = env.FAKE_CRITIC_MODE ?? 'reply';
  if (mode === 'init-then-fail-once') return attempt === 0 ? 'init-then-fail' : 'reply';
  if (mode === 'fail-once') return attempt === 0 ? 'fail' : 'reply';
  return mode;
}

async function turn(): Promise<void> {
  const claude = tool === 'claude';
  const sessionId = claude
    ? (valueAfter('--session-id') ?? valueAfter('--resume') ?? '')
    : (valueAfter('--conversation') ??
      env.FAKE_CRITIC_AGY_ID ??
      'a9f1c2d3-0000-4000-8000-000000000001');
  const earlier = previous.filter(isTurn);
  // o Claude real recusa um `--session-id` que já existe
  if (claude && args.includes('--session-id')) {
    const reused = earlier.some((call) =>
      call.args.join('\0').includes(`--session-id\0${sessionId}`),
    );
    if (reused) {
      process.stderr.write(`Error: Session ID ${sessionId} is already in use.\n`);
      process.exitCode = 1;
      return;
    }
  }
  const dialect = claude ? claudeDialect(sessionId) : agyDialect(sessionId);
  const mode = resolveMode(earlier.length);
  const gap = Number(env.FAKE_CRITIC_GAP_MS ?? 100);

  if (mode === 'fail') {
    process.stderr.write('connection reset by peer\n');
    process.exitCode = 1;
  } else if (mode === 'credential' || mode === 'error') {
    dialect.failure(
      mode === 'credential'
        ? CREDENTIAL_TEXT[claude ? 'claude' : 'agy']
        : (env.FAKE_CRITIC_ERROR ?? 'API Error: overloaded'),
    );
    process.exitCode = 1;
  } else if (mode === 'init-then-fail') {
    dialect.begin();
    dialect.init();
    process.stderr.write('connection reset by peer\n');
    process.exitCode = 1;
  } else if (mode === 'no-id' && !claude) {
    out({ event: 'result', result: { status: 'SUCCESS', response: reply } });
  } else if (mode === 'silent' || mode === 'grandchild' || mode === 'detached-grandchild') {
    if (mode !== 'silent') {
      const detached = mode === 'detached-grandchild';
      const grandchild = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
        detached,
        stdio: ['ignore', detached ? 'inherit' : 'ignore', 'ignore'],
      });
      fs.writeFileSync(env.FAKE_CRITIC_PID_FILE ?? '', String(grandchild.pid));
    }
    dialect.begin();
    dialect.init();
    await hang();
  } else {
    dialect.begin();
    dialect.init();
    if (mode === 'huge-line') out({ type: 'user', blob: 'x'.repeat(300_000) });
    for (let i = 0; mode === 'slow' && i < 4; i++) {
      await sleep(gap);
      dialect.progress();
    }
    dialect.answer(reply);
    if (mode === 'exit-after-answer') process.exitCode = 1;
  }
}

const loggedOut = env.FAKE_CRITIC_LOGGED_OUT === '1';

if (tool === 'claude' && args[0] === 'auth') {
  process.stdout.write(`${JSON.stringify({ loggedIn: !loggedOut })}\n`);
  process.exitCode = loggedOut ? 1 : 0;
} else if (tool === 'agy' && args[0] === 'models') {
  process.stdout.write(
    loggedOut
      ? 'Error: Please sign in to view available models.\n'
      : 'gemini-4-argon-high\tGemini 4 Argon (High)\n',
  );
  process.exitCode = loggedOut ? 1 : 0;
} else if (tool === 'agy' && args[0] === 'mcp') {
  if (env.FAKE_CRITIC_NO_AGY_MCP !== '1')
    process.stdout.write('hexlog stdio enabled node server.mjs\n');
} else {
  void turn();
}
