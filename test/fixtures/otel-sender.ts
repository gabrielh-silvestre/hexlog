// Processo filho do adaptador de telemetria real: `otel-sender.ts <json>`, com o argumento JSON de
// `fixture-args.ts#OtelSenderArgs`. Faz `calls` chamadas de tool, envia a cada uma e imprime
// `{"enabled", "otelEnvAfterBuild"}`. Existe porque o exporter OTLP/HTTP carrega o módulo de rede
// por `import()` dinâmico, que o jest (CJS, sem `--experimental-vm-modules`) recusa; o ambiente
// `OTEL_*` hostil vem do `env` do pai.
import { isUndefined } from 'es-toolkit';
import { createOtelTelemetry } from '../../src/adapters/telemetry/otel.ts';
import type { OtelSenderArgs } from './fixture-args.ts';

const [, , argsJson] = process.argv;
if (isUndefined(argsJson)) throw new Error('usage: otel-sender.ts <json>');
const args = JSON.parse(argsJson) as OtelSenderArgs;

const telemetry = createOtelTelemetry({
  settings: { endpoint: args.endpoint, headers: args.headers },
  logger: () => undefined,
  probe: () => Promise.resolve(true),
  exportTimeoutMs: 2_000,
  metricIntervalMs: 60_000,
  batchDelayMs: 60_000,
});
const otelEnvAfterBuild = Object.fromEntries(
  Object.entries(process.env).filter(([key]) => key.startsWith('OTEL_')),
);

for (let call = 0; call < args.calls; call += 1) {
  await telemetry.trace('query', (probe) => {
    probe.end({ ms: 1 });
    return Promise.resolve();
  });
  await telemetry.flush();
}
await telemetry.shutdown(1_000);
console.log(JSON.stringify({ enabled: telemetry.enabled, otelEnvAfterBuild }));
