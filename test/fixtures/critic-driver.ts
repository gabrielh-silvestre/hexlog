// Chama uma função do runner do critic (`scripts/flow/critic-run.ts`) num processo próprio e imprime
// o retorno em JSON. Existe porque o jest não altera o `PATH` real do processo: só um filho com o
// `PATH` do spec acha os shims do CLI falso (`fake-critic-cli.ts`). Roda como processo filho, nunca
// importado pelo jest.
//
// argv: um argumento JSON (`CriticDriverArgs`). `runTurn` devolve também `elapsedMs`.
import { askQuestion, closeMailbox, runTurn, startSession } from '../../scripts/flow/critic-run.ts';
import type { CriticDriverArgs } from './fixture-args.ts';

async function run(args: CriticDriverArgs): Promise<unknown> {
  switch (args.call) {
    case 'runTurn': {
      const started = Date.now();
      const turn = await runTurn(args.command, {
        cwd: args.cwd,
        tool: args.tool,
        timing: args.timing,
        signal: new AbortController().signal,
      });
      return { ...turn, elapsedMs: Date.now() - started };
    }
    case 'startSession':
      return startSession(args.options);
    case 'askQuestion': {
      const { startTimes } = args;
      return askQuestion(args.mailbox, {
        timing: args.timing,
        ...(startTimes === undefined ? {} : { readStartTime: (pid: number) => startTimes[pid] }),
      });
    }
    case 'closeMailbox':
      return closeMailbox(args.mailbox);
  }
}

const args = JSON.parse(process.argv[2] ?? '') as CriticDriverArgs;
void run(args).then((result) => process.stdout.write(`${JSON.stringify(result)}\n`));
