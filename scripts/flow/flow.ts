// CLI do fluxo autônomo guiado por diretrizes (modos `slug` e `sync-plan`). Só builtins do Node,
// para rodar na abertura do trabalho, inclusive em worktree sem `node_modules`. Chamado pela skill
// `flow-run`; o algoritmo do slug mora em `marker.ts` e o planejador de sync em `sync.ts`.
import * as fs from 'node:fs';
import * as path from 'node:path';
import { slugOf } from './marker.ts';
import {
  STRATEGY_DOC,
  invalidDocPath,
  parsePremises,
  planSync,
  sha256,
  type SyncInput,
} from './sync.ts';

const REPO_ROOT = path.resolve(import.meta.dirname, '../..');

/**
 * Para `estrategia`, o CLI lê o documento e entrega hash e premissas ao planejador, no lugar do
 * que veio no stdin; premissa inválida lança. O documento apagado (`extracted: null`) passa direto,
 * e o `path` inválido também, sem ler nada: o `planSync` responde `invalid-path`.
 * O `input.path` relativo vale a partir da raiz do repositório, não do cwd de quem roda o CLI.
 */
function withStrategyPremises(input: SyncInput): SyncInput {
  if (input.docSlug !== STRATEGY_DOC || input.extracted === null || invalidDocPath(input)) {
    return input;
  }
  const bytes = fs.readFileSync(path.resolve(REPO_ROOT, input.path));
  const { rules, malformed } = parsePremises(bytes.toString('utf8'));
  if (malformed.length > 0) {
    throw new Error(`${input.path} has invalid premises:\n- ${malformed.join('\n- ')}`);
  }
  return { ...input, hash: sha256(bytes), extracted: rules };
}

function run(mode: string | undefined, arg: string | undefined): void {
  if (mode === 'slug') return void process.stdout.write(`${slugOf(arg ?? '')}\n`);
  if (mode === 'sync-plan') {
    const input = JSON.parse(fs.readFileSync(0, 'utf8')) as SyncInput;
    return void process.stdout.write(JSON.stringify(planSync(withStrategyPremises(input))));
  }
  throw new Error(`unknown mode "${mode ?? ''}"`);
}

/** `slug` recusa com exit 1 (quem chama é a skill); o resto sai com 2. */
function main(): void {
  const [, , mode, arg] = process.argv;
  try {
    run(mode, arg);
  } catch (error) {
    process.stderr.write(
      `hexlog flow: ${error instanceof Error ? error.message : String(error)}\n`,
    );
    process.exitCode = mode === 'slug' ? 1 : 2;
  }
}

main();
