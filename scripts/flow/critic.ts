// Critic da cadeira do dono, uma execução por pergunta: `node scripts/flow/critic.ts <verbo> ...`.
// Quem chama é a skill `flow-run`.
//
//   start <slug> [--cwd <dir>] [--tool claude|agy]   cria a mailbox e imprime o caminho
//   rules <dir>/critic-rules.txt [--cwd <dir>] [--tool claude|agy] grava as regras do critic no Herdr
//                                                    (`0600`); outro nome de arquivo é recusado
//   ask <mailbox>                                    responde a `q-<n>.txt` e imprime `a-<n>.txt`
//   close <mailbox>                                  remove a mailbox (idempotente)
//
// `--tool` vence `HEXLOG_CRITIC_CLI`; sem nenhum dos dois o critic é o Claude. `--cwd` é o worktree
// em que o critic roda (padrão: o diretório atual) e de onde se lê o doc do catálogo de ações.
// Saídas em `critic-run.ts#EXIT`; o que a skill faz com cada uma, em `flow-run`, seção 6.
// A mensagem de sucesso vai ao stdout e a de falha ao stderr. Só age como CLI: importar o módulo não
// roda nada (guard `import.meta.main`, como o `mark.ts`). Usa `parseArgs` direto, e não o
// `cli-error.ts#parseCliArgs`, para não puxar o `compose` e ficar só com builtins.
import * as path from 'node:path';
import { parseArgs } from 'node:util';
import {
  askQuestion,
  catalogPathOf,
  closeMailbox,
  EXIT,
  startSession,
  writeRules,
  type Reply,
} from './critic-run.ts';
import { resolveTool, type Tool } from './critic-tools.ts';

const USAGE =
  'usage: node scripts/flow/critic.ts start <slug> [--cwd <dir>] [--tool claude|agy] | rules <dir>/critic-rules.txt [--cwd <dir>] [--tool claude|agy] | ask <mailbox> | close <mailbox>';

const usage = (message: string): Reply => ({ exitCode: EXIT.usage, message });

async function run(argv: string[], env: NodeJS.ProcessEnv, cwd: string): Promise<Reply> {
  let parsed;
  try {
    parsed = parseArgs({
      args: argv,
      options: { tool: { type: 'string' }, cwd: { type: 'string' } },
      allowPositionals: true,
      strict: true,
    });
  } catch {
    return usage(USAGE);
  }
  const { values, positionals } = parsed;
  const [verb, target, ...extra] = positionals;
  const startOnly = values.tool !== undefined || values.cwd !== undefined;
  if (target === undefined || extra.length > 0) return usage(USAGE);
  const worktree = path.resolve(cwd, values.cwd ?? '');
  if (verb === 'start' || verb === 'rules') {
    let tool: Tool;
    try {
      tool = resolveTool({ flag: values.tool, env: env.HEXLOG_CRITIC_CLI });
    } catch (error) {
      return usage(error instanceof Error ? error.message : String(error));
    }
    return verb === 'start'
      ? startSession({ tool, slug: target, cwd: worktree })
      : writeRules({ tool, file: path.resolve(cwd, target), catalogPath: catalogPathOf(worktree) });
  }
  if (startOnly) return usage(USAGE);
  if (verb === 'ask') return askQuestion(target);
  if (verb === 'close') return closeMailbox(target);
  return usage(USAGE);
}

async function main(): Promise<void> {
  let result: Reply;
  try {
    result = await run(process.argv.slice(2), process.env, process.cwd());
  } catch (error) {
    result = {
      exitCode: EXIT.failed,
      message: `critic: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
  const stream = result.exitCode === EXIT.ok ? process.stdout : process.stderr;
  stream.write(`${result.message}\n`);
  process.exitCode = result.exitCode;
}

// eslint-disable-next-line n/no-unsupported-features/node-builtins -- engine >=24.18.1 já suporta import.meta.main, plugin n ainda marca como experimental
if (import.meta.main) void main();
