import type { CallProbe, Telemetry } from '../../ports.ts';

const noopProbe: CallProbe = { end: () => undefined };

/** Telemetria desligada: repassa `run` direto e não registra nada. */
export const noopTelemetry: Telemetry = {
  enabled: false,
  trace: (_tool, run) => run(noopProbe),
  recordLoad: () => undefined,
  degraded: () => undefined,
  shutdown: () => Promise.resolve(),
};
