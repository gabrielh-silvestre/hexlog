import type { Telemetry } from '../../ports.ts';
import { within } from './within.ts';

/** O mínimo de `process` que o encerramento usa; os testes injetam um falso. */
export type ShutdownProcess = {
  stdin: {
    readableEnded: boolean;
    destroyed: boolean;
    on(event: 'end' | 'close', listener: () => void): unknown;
  };
  on(event: 'SIGTERM' | 'SIGINT', listener: () => void): unknown;
  once(event: 'beforeExit', listener: () => void): unknown;
  exit(code?: number): unknown;
};

export type ShutdownBinding = {
  telemetry: Telemetry;
  proc: ShutdownProcess;
  closeTransport: () => Promise<void>;
};

type Budget = { closeMs: number; shutdownMs: number };

// EOF do stdin: sem pressa de cliente conhecida, o envio final tem até 1.750 ms (ADR 0015, item 8).
const EOF_BUDGET: Budget = { closeMs: 250, shutdownMs: 1_500 };
// Sinal: o Claude Code (2.1.318) manda SIGINT, SIGTERM 100 ms depois e SIGKILL aos 500 ms; 350 ms
// deixam o envio final terminar antes do SIGKILL.
const SIGNAL_BUDGET: Budget = { closeMs: 100, shutdownMs: 250 };

/**
 * Liga o encerramento do processo ao EOF do stdin, a `beforeExit`, `SIGTERM` e `SIGINT`. Uma só
 * promessa fecha o transporte e depois a telemetria; o primeiro gatilho escolhe o orçamento
 * (EOF: 250 ms + 1.500 ms; sinal: 100 ms + 250 ms) e cada etapa é limitada por conta própria.
 * `proc.exit` é o único caminho garantido, porque timers de retry e sockets do exporter seguram o
 * laço de eventos: ele roda mesmo que uma etapa lance ou rejeite.
 * Um sinal com o encerramento já pendente só espera essa mesma promessa e então sai com o código
 * do sinal (o do primeiro sinal, mesmo que o EOF tenha decidido o orçamento): sair na hora perderia
 * o envio final, porque o segundo sinal chega 100 ms depois do primeiro. Se o EOF decidiu o
 * orçamento de 1.750 ms, o SIGKILL do cliente aos 500 ms corta essa espera; é limite aceito.
 */
export function bindShutdown({ telemetry, proc, closeTransport }: ShutdownBinding): void {
  let pending: Promise<void> | undefined;
  let exited = false;
  let signalCode: number | undefined;

  const exit = (): void => {
    if (exited) return;
    exited = true;
    proc.exit(signalCode);
  };
  const shutdown = ({ closeMs, shutdownMs }: Budget): Promise<void> =>
    (pending ??= within(Promise.resolve().then(closeTransport), closeMs).then(() =>
      within(
        Promise.resolve().then(() => telemetry.shutdown(shutdownMs)),
        shutdownMs,
      ),
    ));
  const exitAfterShutdown = (budget: Budget): void =>
    void shutdown(budget)
      .catch(() => undefined)
      .then(exit);

  const onEnd = (): void => exitAfterShutdown(EOF_BUDGET);
  const onSignal = (code: number) => (): void => {
    signalCode ??= code;
    exitAfterShutdown(SIGNAL_BUDGET);
  };

  proc.stdin.on('end', onEnd);
  proc.stdin.on('close', onEnd);
  proc.once('beforeExit', onEnd);
  proc.on('SIGTERM', onSignal(143));
  proc.on('SIGINT', onSignal(130));
  if (proc.stdin.readableEnded || proc.stdin.destroyed) onEnd();
}
