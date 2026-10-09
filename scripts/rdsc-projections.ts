// Snapshot read-only de um processo em JSONL (`meta`, `record`, `gate`, `changes`, `end`), lido pelo
// `composeReader`. A lógica mora em `rdsc-projections-run.ts`; este arquivo só liga o I/O. Nada é
// escrito no stdout antes de o snapshot fechar: em qualquer falha o stdout fica vazio.
// Uso: node scripts/rdsc-projections.ts <project> <process> [--gate <name>]... [--gate-per-target <gate>:<regex>]... [--since <marker-json>]
import { isUndefined } from 'es-toolkit';
import { formatCliError, openReadOnly } from './cli-error.ts';
import { parseRdscArgs, run, USAGE } from './rdsc-projections-run.ts';

function main(argv: string[]): number {
  const args = parseRdscArgs(argv);
  if (isUndefined(args)) {
    console.error(`rdsc-projections failed: ${USAGE}`);
    return 1;
  }
  try {
    const lines: string[] = [];
    run(openReadOnly(), args, (line) => lines.push(line));
    process.stdout.write(lines.join(''));
    return 0;
  } catch (error) {
    const { text, exitCode } = formatCliError('rdsc-projections', error);
    console.error(text);
    return exitCode;
  }
}

process.exitCode = main(process.argv.slice(2));
