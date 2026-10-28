// CLI do fluxo autônomo guiado por diretrizes (modo `slug`). Só builtins do Node, para rodar na
// abertura do trabalho, inclusive em worktree sem `node_modules`. Chamado pela skill `flow-run`; o
// algoritmo do slug mora em `marker.ts`. O sync das diretrizes é o `sync-cli.ts`.
import { slugOf } from './marker.ts';

function run(mode: string | undefined, arg: string | undefined): void {
  if (mode === 'slug') return void process.stdout.write(`${slugOf(arg ?? '')}\n`);
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
