import { AsyncLocalStorage } from 'node:async_hooks';
import { SpanStatusCode, type Attributes, type Span } from '@opentelemetry/api';
import { ExportResultCode, type ExportResult } from '@opentelemetry/core';
import {
  AggregationTemporalityPreference,
  OTLPMetricExporter,
} from '@opentelemetry/exporter-metrics-otlp-http';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http';
import { resourceFromAttributes } from '@opentelemetry/resources';
import {
  MeterProvider,
  PeriodicExportingMetricReader,
  type PushMetricExporter,
} from '@opentelemetry/sdk-metrics';
import { BatchSpanProcessor, TracerProvider, type SpanExporter } from '@opentelemetry/sdk-trace';
import { isNil, isUndefined, uniq } from 'es-toolkit';
import type { CallProbe, LoadReport, Telemetry } from '../../ports.ts';
import type { Logger } from '../../shared/logger.ts';
import { VERSION } from '../../version.ts';
import { noopTelemetry } from './noop.ts';
import type { TelemetrySettings } from './settings.ts';
import { within } from './within.ts';

export type OtelTelemetryOptions = {
  settings: TelemetrySettings;
  logger: Logger;
  /** `true` quando o endpoint responde (qualquer resposta HTTP serve); `false` quando não. */
  probe?: () => Promise<boolean>;
  spanExporter?: SpanExporter;
  metricExporter?: PushMetricExporter;
  batchDelayMs?: number;
  metricIntervalMs?: number;
  exportTimeoutMs?: number;
  drainTimeoutMs?: number;
};

/** `flush` só existe no objeto de retorno, para os testes; a porta `Telemetry` não o expõe. */
export type OtelTelemetry = Telemetry & { flush(): Promise<void> };

const DETAIL_CODES_CAP = 20;
const PROBE_TIMEOUT_MS = 1_000;
const DURATION_BUCKETS_MS = [1, 5, 10, 25, 50, 100, 250, 500, 1_000, 2_500, 5_000];

type Load = { ref: LoadReport['ref']; bytes?: number; lines?: number };

/** Estado de uma chamada de tool: o que cada processo reportou e qual deles foi escrito. */
type CallState = { loads: Map<string, Load>; target?: string };

type SendState = { lastExport?: 'ok' | 'failed'; probeFailed: boolean };

/**
 * Roda `build` sem as variáveis `OTEL_*` no `process.env` real, que é o que o SDK lê: headers,
 * compressão, timeout e temporalidade de ambiente não podem desviar a configuração explícita.
 */
function scrubOtelEnv<T>(build: () => T): T {
  const removed: [string, string][] = [];
  for (const [key, value] of Object.entries(process.env)) {
    if (!key.startsWith('OTEL_') || isUndefined(value)) continue;
    removed.push([key, value]);
    delete process.env[key];
  }
  try {
    return build();
  } finally {
    for (const [key, value] of removed) process.env[key] = value;
  }
}

/**
 * Dá a cada envio um prazo próprio: o `timeoutMillis` do exporter não cobre a fase de conexão. Grava
 * o resultado em `lastExport`, chama `done` uma vez e ignora o resultado que chegar depois.
 */
function sendWithDeadline(
  send: (done: (result: ExportResult) => void) => void,
  done: (result: ExportResult) => void,
  state: SendState,
  timeoutMs: number,
): void {
  let settled = false;
  const settle = (result: ExportResult): void => {
    if (settled) return;
    settled = true;
    clearTimeout(timer);
    state.lastExport = result.code === ExportResultCode.SUCCESS ? 'ok' : 'failed';
    done(result);
  };
  const timer = setTimeout(() => settle({ code: ExportResultCode.FAILED }), timeoutMs);
  timer.unref();
  try {
    send(settle);
  } catch {
    settle({ code: ExportResultCode.FAILED });
  }
}

const watchSpanExporter = (
  inner: SpanExporter,
  state: SendState,
  timeoutMs: number,
): SpanExporter => ({
  export: (spans, done) =>
    sendWithDeadline((settle) => inner.export(spans, settle), done, state, timeoutMs),
  shutdown: () => inner.shutdown(),
  forceFlush: () => inner.forceFlush?.() ?? Promise.resolve(),
});

const watchMetricExporter = (
  inner: PushMetricExporter,
  state: SendState,
  timeoutMs: number,
): PushMetricExporter => ({
  export: (metrics, done) =>
    sendWithDeadline((settle) => inner.export(metrics, settle), done, state, timeoutMs),
  forceFlush: () => inner.forceFlush(),
  shutdown: () => inner.shutdown(),
  // O leitor periódico lê temporalidade e agregação do exporter.
  selectAggregationTemporality: inner.selectAggregationTemporality?.bind(inner),
  selectAggregation: inner.selectAggregation?.bind(inner),
});

const sum = (values: (number | undefined)[]): number | undefined => {
  const reported = values.filter((value) => !isUndefined(value));
  return reported.length === 0 ? undefined : reported.reduce((total, value) => total + value, 0);
};

/** Processo, projeto e tamanho do log da chamada, conforme o que a camada de disco reportou. */
function loadAttributes(call: CallState): Attributes {
  const loads = [...call.loads.values()];
  const attributes: Attributes = { 'hexlog.process.count': loads.length };
  const target = isUndefined(call.target) ? undefined : call.loads.get(call.target);
  const single = target ?? (loads.length === 1 ? loads[0] : undefined);

  if (!isUndefined(single)) {
    attributes['hexlog.project'] = single.ref.project;
    attributes['hexlog.process'] = single.ref.process;
  } else {
    const projects = uniq(loads.map(({ ref }) => ref.project));
    if (projects.length === 1 && !isUndefined(projects[0])) {
      attributes['hexlog.project'] = projects[0];
    }
  }
  const lines = single ? single.lines : sum(loads.map((load) => load.lines));
  const bytes = single ? single.bytes : sum(loads.map((load) => load.bytes));
  if (!isUndefined(lines)) attributes['hexlog.log.lines'] = lines;
  if (!isUndefined(bytes)) attributes['hexlog.log.bytes'] = bytes;
  return attributes;
}

function errorAttributes(outcome: Parameters<CallProbe['end']>[0]): Attributes {
  const attributes: Attributes = {};
  if (!isUndefined(outcome.code)) attributes['hexlog.error.code'] = outcome.code;
  const codes = uniq(outcome.detailCodes ?? []);
  if (codes.length > 0) attributes['hexlog.error.detail_codes'] = codes.slice(0, DETAIL_CODES_CAP);
  if (codes.length > DETAIL_CODES_CAP) {
    attributes['hexlog.error.detail_codes_omitted'] = codes.length - DETAIL_CODES_CAP;
  }
  return attributes;
}

/**
 * Telemetria por OTLP/HTTP JSON: um span e três métricas por chamada de tool. Falha de construção
 * ou endpoint inválido devolve `noopTelemetry` com um único aviso `telemetry-init-failed`, sem a
 * mensagem da exceção nem o endpoint. Nenhum acesso ao SDK pode mudar o resultado de `run`.
 */
export function createOtelTelemetry(options: OtelTelemetryOptions): OtelTelemetry {
  const { settings, logger } = options;
  const noop: OtelTelemetry = { ...noopTelemetry, flush: () => Promise.resolve() };
  const initFailed = (reason: 'invalid-endpoint' | 'sdk-init-failed'): OtelTelemetry => {
    logger({ level: 'warn', event: 'telemetry-init-failed', reason });
    return noop;
  };

  try {
    const { protocol, username, password } = new URL(settings.endpoint);
    // Credencial na URL viraria Basic auth no exporter; o probe já a recusa.
    if ((protocol !== 'http:' && protocol !== 'https:') || username !== '' || password !== '') {
      return initFailed('invalid-endpoint');
    }
  } catch {
    return initFailed('invalid-endpoint');
  }

  const exportTimeoutMs = options.exportTimeoutMs ?? 3_000;
  const metricIntervalMs = options.metricIntervalMs ?? 15_000;
  const drainTimeoutMs = options.drainTimeoutMs ?? 500;
  const state: SendState = { probeFailed: false };
  const base = settings.endpoint.replace(/\/+$/, '');

  const build = () => {
    const resource = resourceFromAttributes({
      'service.name': 'hexlog',
      'service.version': VERSION,
    });
    const spanExporter =
      options.spanExporter ??
      new OTLPTraceExporter({
        url: `${base}/v1/traces`,
        headers: { ...settings.headers },
        timeoutMillis: exportTimeoutMs,
      });
    const metricExporter =
      options.metricExporter ??
      new OTLPMetricExporter({
        url: `${base}/v1/metrics`,
        headers: { ...settings.headers },
        timeoutMillis: exportTimeoutMs,
        temporalityPreference: AggregationTemporalityPreference.CUMULATIVE,
      });
    const tracerProvider = new TracerProvider({
      resource,
      spanProcessors: [
        new BatchSpanProcessor({
          exporter: watchSpanExporter(spanExporter, state, exportTimeoutMs),
          scheduledDelayMillis: options.batchDelayMs ?? 5_000,
          maxQueueSize: 2_048,
          exportTimeoutMillis: exportTimeoutMs,
        }),
      ],
    });
    const meterProvider = new MeterProvider({
      resource,
      readers: [
        new PeriodicExportingMetricReader({
          exporter: watchMetricExporter(metricExporter, state, exportTimeoutMs),
          exportIntervalMillis: metricIntervalMs,
          exportTimeoutMillis: Math.min(exportTimeoutMs, metricIntervalMs),
        }),
      ],
    });
    const meter = meterProvider.getMeter('hexlog', VERSION);
    return {
      tracerProvider,
      meterProvider,
      tracer: tracerProvider.getTracer('hexlog', VERSION),
      calls: meter.createCounter('hexlog.tool.calls'),
      errors: meter.createCounter('hexlog.tool.errors'),
      duration: meter.createHistogram('hexlog.tool.duration', {
        unit: 'ms',
        advice: { explicitBucketBoundaries: DURATION_BUCKETS_MS },
      }),
    };
  };

  let sdk: ReturnType<typeof build>;
  try {
    sdk = scrubOtelEnv(build);
  } catch {
    return initFailed('sdk-init-failed');
  }

  const probe =
    options.probe ??
    (() =>
      fetch(settings.endpoint, {
        method: 'HEAD',
        signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
        redirect: 'manual',
      }).then(
        () => true,
        () => false,
      ));
  void Promise.resolve()
    .then(probe)
    .catch(() => false)
    .then((reachable) => {
      state.probeFailed = !reachable;
    });

  const als = new AsyncLocalStorage<CallState>();
  let inFlight = 0;
  let onIdle: (() => void) | undefined;
  const drained = (): Promise<void> =>
    inFlight === 0
      ? Promise.resolve()
      : new Promise<void>((resolve) => {
          onIdle = resolve;
        });

  // O SDK é terceiro: toda falha dele é engolida, para nunca mudar o resultado da tool.
  const guarded = (action: () => void): void => {
    try {
      action();
    } catch {
      // sem efeito: telemetria não pode afetar a chamada
    }
  };

  const finishCall = (
    span: Span | undefined,
    tool: string,
    call: CallState,
    outcome: Parameters<CallProbe['end']>[0],
  ): void => {
    guarded(() => {
      span?.setAttributes({
        'hexlog.tool': tool,
        ...loadAttributes(call),
        ...errorAttributes(outcome),
      });
      if (!isUndefined(outcome.code)) span?.setStatus({ code: SpanStatusCode.ERROR });
      span?.end();
    });
    guarded(() => {
      sdk.calls.add(1, { 'hexlog.tool': tool });
      sdk.duration.record(outcome.ms, { 'hexlog.tool': tool });
      if (!isUndefined(outcome.code)) {
        sdk.errors.add(1, { 'hexlog.tool': tool, 'hexlog.error.code': outcome.code });
      }
    });
  };

  return {
    enabled: true,

    trace: (tool, run) => {
      const call: CallState = { loads: new Map() };
      const start = Date.now();
      let span: Span | undefined;
      guarded(() => {
        span = sdk.tracer.startSpan(`tool ${tool}`);
      });
      let ended = false;
      const callProbe: CallProbe = {
        end: (outcome) => {
          if (ended) return;
          ended = true;
          finishCall(span, tool, call, outcome);
        },
      };

      inFlight += 1;
      // `run` roda na mesma pilha, sem `await` antes: o contexto do `als` precisa alcançar as
      // leituras do store, que reportam por `recordLoad`.
      return als
        .run(call, async () => run(callProbe))
        .finally(() => {
          callProbe.end({ ms: Date.now() - start });
          inFlight -= 1;
          if (inFlight === 0) onIdle?.();
        });
    },

    recordLoad: ({ ref, role, bytes, lines }) => {
      const call = als.getStore();
      if (isUndefined(call)) return;
      const key = `${ref.project}\0${ref.process}`;
      const previous = call.loads.get(key);
      call.loads.set(key, {
        ref,
        bytes: isNil(bytes) ? previous?.bytes : bytes,
        lines: isNil(lines) ? previous?.lines : lines,
      });
      if (role === 'target') call.target = key;
    },

    degraded: () => {
      if (state.lastExport === 'failed') return 'export';
      if (state.probeFailed && isUndefined(state.lastExport)) return 'probe';
      return undefined;
    },

    shutdown: (timeoutMs) =>
      within(
        within(drained(), drainTimeoutMs).then(() =>
          Promise.allSettled([sdk.tracerProvider.shutdown(), sdk.meterProvider.shutdown()]),
        ),
        timeoutMs,
      ),

    flush: () =>
      Promise.allSettled([sdk.tracerProvider.forceFlush(), sdk.meterProvider.forceFlush()]).then(
        () => undefined,
      ),
  };
}
