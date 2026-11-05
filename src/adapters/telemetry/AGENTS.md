# telemetry

**Parent context:** `../AGENTS.md`
**Generated:** 2026-11-05 · **Updated:** 2026-11-05

## Purpose

Telemetria opcional por OTLP/HTTP, ligada só por `HEXLOG_OTEL_ENDPOINT`. Implementa a porta `Telemetry` de `src/ports.ts` e é o único lugar de `src/` que importa `@opentelemetry/*`; só `compose.ts` importa esta pasta. Sem a chave o servidor usa `noopTelemetry` e nenhum handler de processo é instalado. O guia de uso está em `docs/telemetria.md`.

## Key Files

| File | Description |
|------|-------------|
| `settings.ts` | `readTelemetrySettings(env)`: pura; lê só `HEXLOG_OTEL_ENDPOINT` e `HEXLOG_OTEL_HEADERS` (pares `k=v` por vírgula, percent-decodificados; par com nome que não é token HTTP ou valor com CR, LF ou NUL é descartado) e devolve `undefined` com o endpoint ausente ou vazio |
| `otel.ts` | `createOtelTelemetry({ settings, logger, ... })`: span por chamada de tool e as métricas `hexlog.tool.calls`, `hexlog.tool.errors` e `hexlog.tool.duration`; exporters com `url`, `headers` e temporalidade explícitos sob o scrub de `OTEL_*`; processo e tamanho do log por `AsyncLocalStorage` e `recordLoad`. Endpoint que não é `http:` nem `https:`, ou que traz usuário ou senha, ou SDK que falha ao subir, devolve o `noopTelemetry` com um só aviso `telemetry-init-failed` e o `reason` `invalid-endpoint` ou `sdk-init-failed`. As opções além de `settings` e `logger` existem para os testes: `probe`, `spanExporter`, `metricExporter`, `batchDelayMs` (5.000), `metricIntervalMs` (15.000), `exportTimeoutMs` (3.000, prazo de cada envio, que cobre também a conexão) e `drainTimeoutMs` (500). O probe é um `HEAD` no boot, com prazo de 1.000 ms e sem seguir redirect, e qualquer resposta HTTP conta como alcançável; `degraded()` devolve `export` quando o último envio falhou, `probe` quando o probe falhou e nada foi enviado, e `undefined` nos demais casos. `shutdown(timeoutMs)` espera as chamadas em voo até o drain, fecha os dois provedores (é o envio final) e nunca passa de `timeoutMs`; `flush()` só existe no retorno (`OtelTelemetry`), para os testes, e não na porta |
| `noop.ts` | `noopTelemetry`: `enabled: false`, passa o `run` direto, `degraded` que devolve `undefined` e `shutdown` que resolve |
| `shutdown.ts` | `bindShutdown`: encerramento do processo no EOF do stdin, em `beforeExit`, `SIGTERM` e `SIGINT`, com o transporte fechado em 250 ms e o `shutdown` da telemetria em 1.500 ms; helper de ciclo de vida que não implementa porta |
| `within.ts` | `within(work, ms)`: espera `work` por no máximo `ms`, nunca rejeita e limpa o timer; usado pelo `shutdown` de `otel.ts` e pelas duas etapas de `bindShutdown` |

## Dependencies

### Internal

- `../../ports.ts`: `Telemetry`, `CallProbe` e `LoadReport`
- `../../shared/logger.ts`: o aviso `telemetry-init-failed` e os demais logs
- `../../version.ts`: `VERSION` no recurso `service.version`

### External

- `@opentelemetry/api`, `@opentelemetry/sdk-trace`, `@opentelemetry/sdk-metrics`, `@opentelemetry/resources`, `@opentelemetry/core`, `@opentelemetry/exporter-trace-otlp-http` e `@opentelemetry/exporter-metrics-otlp-http`: só `otel.ts`

## Manual Notes

## Diretrizes

- [fronteiras.md](../../../docs/directives/fronteiras.md): regra de capacidades transversais, `@opentelemetry/*` restrito a esta pasta e `adapters/` sem `commands/`, `queries/` nem `mcp/`
- [invariantes.md](../../../docs/directives/invariantes.md): superfícies de privacidade da telemetria (`telemetry-surfaces`)
- [adr-0015-telemetria-opentelemetry.md](../../../docs/directives/adr-0015-telemetria-opentelemetry.md): a decisão e os limites aceitos
