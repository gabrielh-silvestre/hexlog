import { isNotNil } from 'es-toolkit';
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

const SHUTDOWN_TIMEOUT_MS = 1_500;
const CLOSE_TIMEOUT_MS = 250;

/**
 * Liga o encerramento do processo ao EOF do stdin, a `beforeExit`, `SIGTERM` e `SIGINT`. Uma só
 * promessa fecha o transporte (até 250 ms) e depois a telemetria (até 1.500 ms); cada etapa é
 * limitada por conta própria e `proc.exit` é o único caminho garantido, porque timers de retry e
 * sockets do exporter seguram o laço de eventos: ele roda mesmo que uma etapa lance ou rejeite.
 * Um sinal com o encerramento já pendente sai na hora.
 */
export function bindShutdown({ telemetry, proc, closeTransport }: ShutdownBinding): void {
  let pending: Promise<void> | undefined;
  let exited = false;

  const exit = (code?: number): void => {
    if (exited) return;
    exited = true;
    proc.exit(code);
  };
  const shutdown = (): Promise<void> =>
    (pending ??= within(Promise.resolve().then(closeTransport), CLOSE_TIMEOUT_MS).then(() =>
      within(
        Promise.resolve().then(() => telemetry.shutdown(SHUTDOWN_TIMEOUT_MS)),
        SHUTDOWN_TIMEOUT_MS,
      ),
    ));
  const exitAfterShutdown = (code?: number): void =>
    void shutdown()
      .catch(() => undefined)
      .then(() => exit(code));

  const onEnd = (): void => exitAfterShutdown();
  const onSignal = (code: number) => (): void => {
    if (isNotNil(pending)) exit(code);
    else exitAfterShutdown(code);
  };

  proc.stdin.on('end', onEnd);
  proc.stdin.on('close', onEnd);
  proc.once('beforeExit', onEnd);
  proc.on('SIGTERM', onSignal(143));
  proc.on('SIGINT', onSignal(130));
  if (proc.stdin.readableEnded || proc.stdin.destroyed) onEnd();
}
