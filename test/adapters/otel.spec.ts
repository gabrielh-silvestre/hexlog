import { execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';
import { SpanStatusCode, type Attributes, type Meter, type Tracer } from '@opentelemetry/api';
import { ExportResultCode, type ExportResult } from '@opentelemetry/core';
import {
  MeterProvider,
  type MetricData,
  type PushMetricExporter,
  type ResourceMetrics,
} from '@opentelemetry/sdk-metrics';
import { TracerProvider, type ReadableSpan, type SpanExporter } from '@opentelemetry/sdk-trace';
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  jest,
} from '@jest/globals';
import { isUndefined } from 'es-toolkit';
import { z } from 'zod';
import { processPaths } from '../../src/adapters/fs/data-format.ts';
import { MAX_LOG_BYTES } from '../../src/adapters/fs/process-store.ts';
import {
  createOtelTelemetry,
  type OtelTelemetry,
  type OtelTelemetryOptions,
} from '../../src/adapters/telemetry/otel.ts';
import { processTooLarge } from '../../src/errors.ts';
import { execute, type ToolDeps } from '../../src/mcp/kernel.ts';
import type { LogRecord } from '../../src/shared/logger.ts';
import type { OtelSenderArgs } from '../fixtures/fixture-args.ts';
import { at } from '../helpers.ts';
import {
  createEnvironment,
  NOTE_SCHEMA,
  PROJECT,
  registerNote,
  TOOL_NAMES,
  type Environment,
} from '../mcp/environment.ts';
import { delay, listen, type OtlpBody, type Receiver } from '../otlp-receiver.ts';

const execFileAsync = promisify(execFile);

type Mode = 'ok' | 'fail' | 'silent';

/** Exporters do próprio teste: guardam o que recebem e respondem conforme o `mode`. */
function createCapture(initial: Mode = 'ok') {
  const capture = {
    mode: initial,
    spans: [] as ReadableSpan[],
    metrics: [] as ResourceMetrics[],
    late: [] as ((result: ExportResult) => void)[],
  };
  const respond = (done: (result: ExportResult) => void): void => {
    if (capture.mode === 'silent') capture.late.push(done);
    else {
      done({ code: capture.mode === 'ok' ? ExportResultCode.SUCCESS : ExportResultCode.FAILED });
    }
  };
  const spanExporter: SpanExporter = {
    export: (batch, done) => {
      capture.spans.push(...batch);
      respond(done);
    },
    shutdown: () => Promise.resolve(),
  };
  const metricExporter: PushMetricExporter = {
    export: (batch, done) => {
      capture.metrics.push(batch);
      respond(done);
    },
    forceFlush: () => Promise.resolve(),
    shutdown: () => Promise.resolve(),
  };
  return { capture, spanExporter, metricExporter };
}

/** Resolve `'timeout'` depois de `ms`, sem segurar o processo de teste vivo (o timer é `unref`). */
const timeoutAfter = (ms: number): Promise<'timeout'> =>
  new Promise((resolve) => {
    AbortSignal.timeout(ms).addEventListener('abort', () => resolve('timeout'));
  });

const SETTINGS = { endpoint: 'http://127.0.0.1:9', headers: {} };
const opened: OtelTelemetry[] = [];

function openTelemetry(overrides: Partial<OtelTelemetryOptions> = {}) {
  const logs: LogRecord[] = [];
  const { capture, spanExporter, metricExporter } = createCapture();
  const telemetry = createOtelTelemetry({
    settings: SETTINGS,
    logger: (record) => logs.push(record),
    probe: () => Promise.resolve(true),
    spanExporter,
    metricExporter,
    batchDelayMs: 60_000,
    metricIntervalMs: 60_000,
    exportTimeoutMs: 200,
    drainTimeoutMs: 50,
    ...overrides,
  });
  opened.push(telemetry);

  expect(telemetry.enabled).toBe(true);

  return { telemetry, capture, logs };
}

const metricsNamed = (metrics: ResourceMetrics[], name: string): MetricData[] =>
  metrics.flatMap(({ scopeMetrics }) =>
    scopeMetrics.flatMap(({ metrics: data }) => data.filter((m) => m.descriptor.name === name)),
  );

/** Pontos do último envio de uma métrica. */
type Point = { attributes: Attributes; value: unknown };
const pointsOf = (metric: MetricData): Point[] => metric.dataPoints;
const lastPoints = (metrics: ResourceMetrics[], name: string): Point[] => {
  const sent = metricsNamed(metrics, name);
  return pointsOf(at(sent, sent.length - 1));
};

describe('createOtelTelemetry', () => {
  afterEach(async () => {
    jest.restoreAllMocks();
    await Promise.all(opened.map((telemetry) => telemetry.shutdown(1_000)));
    opened.length = 0;
  });

  describe('with a span per call', () => {
    it('should end the span once with ms, code and detail codes, ignoring a second end', async () => {
      const { telemetry, capture } = openTelemetry();

      await telemetry.trace('query', (probe) => {
        probe.end({ ms: 42, code: 'INVALID_INPUT', detailCodes: ['reserved-key'] });
        probe.end({ ms: 1, code: 'OTHER' });
        return Promise.resolve();
      });
      await telemetry.flush();

      const span = at(capture.spans, 0);

      expect(capture.spans).toHaveLength(1);
      expect(span.name).toBe('tool query');
      expect(span.attributes).toMatchObject({
        'hexlog.tool': 'query',
        'hexlog.error.code': 'INVALID_INPUT',
        'hexlog.error.detail_codes': ['reserved-key'],
      });

      const duration = at(lastPoints(capture.metrics, 'hexlog.tool.duration'), 0);

      expect(duration.value).toMatchObject({ count: 1, sum: 42 });
    });

    it('should mark an error span without message, exception event or input content', async () => {
      const { telemetry, capture } = openTelemetry();

      await telemetry.trace('register', (probe) => {
        probe.end({ ms: 3, code: 'INVALID_INPUT', detailCodes: ['reserved-key'] });
        return Promise.resolve();
      });
      await telemetry.flush();

      const span = at(capture.spans, 0);

      expect(span.status).toEqual({ code: SpanStatusCode.ERROR });
      expect(span.events).toEqual([]);
    });

    it('should leave a successful span without status or error attributes', async () => {
      const { telemetry, capture } = openTelemetry();

      await telemetry.trace('list', (probe) => {
        probe.end({ ms: 1 });
        return Promise.resolve();
      });
      await telemetry.flush();

      const span = at(capture.spans, 0);

      expect(span.status.code).toBe(SpanStatusCode.UNSET);
      expect(Object.keys(span.attributes).filter((key) => key.includes('error'))).toEqual([]);
    });

    it('should close the span even when run never calls end, and keep the rejection', async () => {
      const { telemetry, capture } = openTelemetry();

      const failing = telemetry.trace('query', () => Promise.reject(new Error('boom')));

      await expect(failing).rejects.toThrow('boom');

      await telemetry.flush();

      expect(capture.spans).toHaveLength(1);
      expect(at(lastPoints(capture.metrics, 'hexlog.tool.calls'), 0).value).toBe(1);
    });

    it('should cut detail codes at 20 distinct and report the 5 omitted', async () => {
      const { telemetry, capture } = openTelemetry();
      const codes = Array.from({ length: 25 }, (_, index) => `code-${index}`);

      await telemetry.trace('register', (probe) => {
        probe.end({ ms: 1, code: 'INVALID_INPUT', detailCodes: [...codes, ...codes] });
        return Promise.resolve();
      });
      await telemetry.flush();

      const attributes = at(capture.spans, 0).attributes;

      expect(attributes['hexlog.error.detail_codes']).toEqual(codes.slice(0, 20));
      expect(attributes['hexlog.error.detail_codes_omitted']).toBe(5);
    });

    it('should not set the omitted count when the distinct codes fit in 20', async () => {
      const { telemetry, capture } = openTelemetry();

      await telemetry.trace('register', (probe) => {
        probe.end({ ms: 1, code: 'X', detailCodes: ['a', 'a', 'b'] });
        return Promise.resolve();
      });
      await telemetry.flush();

      const attributes = at(capture.spans, 0).attributes;

      expect(attributes['hexlog.error.detail_codes']).toEqual(['a', 'b']);
      expect(attributes).not.toHaveProperty('hexlog.error.detail_codes_omitted');
    });
  });

  describe('with loads reported by the store', () => {
    const load = (project: string, process: string) => ({ project, process });

    it('should attribute the target process and its size when other processes were also read', async () => {
      const { telemetry, capture } = openTelemetry();

      await telemetry.trace('register', async (probe) => {
        await Promise.resolve();
        telemetry.recordLoad({ ref: load('p1', 'dest'), role: 'read', bytes: 10, lines: 2 });
        telemetry.recordLoad({ ref: load('p1', 'work'), role: 'target', bytes: 100, lines: 5 });
        probe.end({ ms: 1 });
      });
      await telemetry.flush();

      expect(at(capture.spans, 0).attributes).toMatchObject({
        'hexlog.process.count': 2,
        'hexlog.project': 'p1',
        'hexlog.process': 'work',
        'hexlog.log.lines': 5,
        'hexlog.log.bytes': 100,
      });
    });

    it('should attribute the only process read when there is no target', async () => {
      const { telemetry, capture } = openTelemetry();

      await telemetry.trace('verify_chain', (probe) => {
        telemetry.recordLoad({ ref: load('p1', 'only'), role: 'read', bytes: 7, lines: 3 });
        probe.end({ ms: 1 });
        return Promise.resolve();
      });
      await telemetry.flush();

      expect(at(capture.spans, 0).attributes).toMatchObject({
        'hexlog.process.count': 1,
        'hexlog.process': 'only',
        'hexlog.log.lines': 3,
        'hexlog.log.bytes': 7,
      });
    });

    it('should sum the sizes that were reported and omit the process when two or more were read without a target', async () => {
      const { telemetry, capture } = openTelemetry();

      await telemetry.trace('query', (probe) => {
        telemetry.recordLoad({ ref: load('p1', 'a'), role: 'read', bytes: 10, lines: 2 });
        telemetry.recordLoad({ ref: load('p1', 'b'), role: 'read', bytes: 20, lines: 3 });
        telemetry.recordLoad({ ref: load('p1', 'c'), role: 'read' });
        probe.end({ ms: 1 });
        return Promise.resolve();
      });
      await telemetry.flush();

      const attributes = at(capture.spans, 0).attributes;

      expect(attributes).toMatchObject({
        'hexlog.process.count': 3,
        'hexlog.project': 'p1',
        'hexlog.log.lines': 5,
        'hexlog.log.bytes': 30,
      });
      expect(attributes).not.toHaveProperty('hexlog.process');
    });

    it('should omit project, process and sizes when the processes span projects and none reported a size', async () => {
      const { telemetry, capture } = openTelemetry();

      await telemetry.trace('list', (probe) => {
        telemetry.recordLoad({ ref: load('p1', 'a'), role: 'read' });
        telemetry.recordLoad({ ref: load('p2', 'a'), role: 'read' });
        probe.end({ ms: 1 });
        return Promise.resolve();
      });
      await telemetry.flush();

      const attributes = at(capture.spans, 0).attributes;

      expect(attributes['hexlog.process.count']).toBe(2);

      for (const key of [
        'hexlog.project',
        'hexlog.process',
        'hexlog.log.lines',
        'hexlog.log.bytes',
      ]) {
        expect(attributes).not.toHaveProperty(key);
      }
    });

    it('should merge a repeated report of the same process without erasing known sizes', async () => {
      const { telemetry, capture } = openTelemetry();

      await telemetry.trace('register', (probe) => {
        telemetry.recordLoad({ ref: load('p1', 'work'), role: 'target' });
        telemetry.recordLoad({ ref: load('p1', 'work'), role: 'read', bytes: 9, lines: 4 });
        telemetry.recordLoad({ ref: load('p1', 'work'), role: 'read' });
        probe.end({ ms: 1 });
        return Promise.resolve();
      });
      await telemetry.flush();

      expect(at(capture.spans, 0).attributes).toMatchObject({
        'hexlog.process.count': 1,
        'hexlog.process': 'work',
        'hexlog.log.lines': 4,
        'hexlog.log.bytes': 9,
      });
    });

    it('should report a zero process count and no process when nothing was read', async () => {
      const { telemetry, capture } = openTelemetry();

      await telemetry.trace('register', (probe) => {
        probe.end({ ms: 1, code: 'INVALID_INPUT' });
        return Promise.resolve();
      });
      await telemetry.flush();

      const attributes = at(capture.spans, 0).attributes;

      expect(attributes['hexlog.process.count']).toBe(0);
      expect(attributes).not.toHaveProperty('hexlog.process');
    });

    it('should not attribute a load reported outside any call to a later call', async () => {
      const { telemetry, capture } = openTelemetry();

      telemetry.recordLoad({ ref: load('p1', 'stray'), role: 'target', bytes: 1, lines: 1 });
      await telemetry.trace('list', (probe) => {
        probe.end({ ms: 1 });
        return Promise.resolve();
      });
      await telemetry.flush();

      expect(at(capture.spans, 0).attributes['hexlog.process.count']).toBe(0);
    });

    it('should keep concurrent calls apart', async () => {
      const { telemetry, capture } = openTelemetry();
      const call = (name: string, wait: number) =>
        telemetry.trace('query', async (probe) => {
          await delay(wait);
          telemetry.recordLoad({ ref: load('p1', name), role: 'target', bytes: wait, lines: 1 });
          probe.end({ ms: 1 });
        });

      await Promise.all([call('slow', 30), call('fast', 1)]);
      await telemetry.flush();

      const processes = capture.spans.map((span) => span.attributes['hexlog.process']).sort();

      expect(processes).toEqual(['fast', 'slow']);
    });
  });

  describe('with metrics', () => {
    it('should count one call per trace, by tool', async () => {
      const { telemetry, capture } = openTelemetry();

      for (const tool of ['query', 'query', 'register']) {
        await telemetry.trace(tool, (probe) => {
          probe.end({ ms: 1 });
          return Promise.resolve();
        });
      }
      await telemetry.flush();

      const byTool = Object.fromEntries(
        lastPoints(capture.metrics, 'hexlog.tool.calls').map((point) => [
          String(point.attributes['hexlog.tool']),
          point.value,
        ]),
      );

      expect(byTool).toEqual({ query: 2, register: 1 });
    });

    it('should count errors by tool and code only, with no project or process label', async () => {
      const { telemetry, capture } = openTelemetry();

      await telemetry.trace('register', (probe) => {
        telemetry.recordLoad({ ref: { project: 'secret-p', process: 'secret-q' }, role: 'target' });
        probe.end({ ms: 1, code: 'INVALID_INPUT', detailCodes: ['reserved-key'] });
        return Promise.resolve();
      });
      await telemetry.flush();

      const points = capture.metrics.flatMap(({ scopeMetrics }) =>
        scopeMetrics.flatMap(({ metrics }) => metrics.flatMap(pointsOf)),
      );
      const labels = new Set(points.flatMap((point) => Object.keys(point.attributes)));

      expect([...labels].sort()).toEqual(['hexlog.error.code', 'hexlog.tool']);
      expect(lastPoints(capture.metrics, 'hexlog.tool.errors').map((p) => p.attributes)).toEqual([
        { 'hexlog.tool': 'register', 'hexlog.error.code': 'INVALID_INPUT' },
      ]);
    });

    it('should record the duration in milliseconds with the fixed bucket boundaries', async () => {
      const { telemetry, capture } = openTelemetry();

      await telemetry.trace('query', (probe) => {
        probe.end({ ms: 30 });
        return Promise.resolve();
      });
      await telemetry.flush();

      const duration = at(metricsNamed(capture.metrics, 'hexlog.tool.duration'), 0);

      expect(duration.descriptor.unit).toBe('ms');
      expect(at(pointsOf(duration), 0).value).toMatchObject({
        count: 1,
        sum: 30,
        buckets: { boundaries: [1, 5, 10, 25, 50, 100, 250, 500, 1000, 2500, 5000] },
      });
    });
  });

  describe('with the exported resource', () => {
    const traceOnce = (telemetry: OtelTelemetry) =>
      telemetry.trace('query', (probe) => {
        probe.end({ ms: 1 });
        return Promise.resolve();
      });

    it('should carry service.instance.id on the spans and on the metrics', async () => {
      const { telemetry, capture } = openTelemetry();
      await traceOnce(telemetry);
      await telemetry.flush();

      const spanId = at(capture.spans, 0).resource.attributes['service.instance.id'];
      const metricId = at(capture.metrics, 0).resource.attributes['service.instance.id'];

      expect(spanId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
      expect(metricId).toBe(spanId);
    });

    it('should give each boot its own service.instance.id', async () => {
      const first = openTelemetry();
      const second = openTelemetry();
      await Promise.all([traceOnce(first.telemetry), traceOnce(second.telemetry)]);
      await Promise.all([first.telemetry.flush(), second.telemetry.flush()]);

      const idOf = (capture: ReturnType<typeof createCapture>['capture']) =>
        at(capture.metrics, 0).resource.attributes['service.instance.id'];

      expect(idOf(first.capture)).not.toBe(idOf(second.capture));
    });
  });

  describe('with the call lifecycle', () => {
    it('should call run in the same stack, with no await before it', async () => {
      const { telemetry } = openTelemetry();
      let calledSynchronously = false;

      const pending = telemetry.trace('query', () => {
        calledSynchronously = true;
        return Promise.resolve();
      });

      expect(calledSynchronously).toBe(true);

      await pending;
    });

    it('should return the result of run', async () => {
      const { telemetry } = openTelemetry();

      const result = await telemetry.trace('query', () => Promise.resolve({ ok: true }));

      expect(result).toEqual({ ok: true });
    });

    it('should resolve without waiting for a pending send when the exporters never answer', async () => {
      const { capture, spanExporter, metricExporter } = createCapture('silent');
      const { telemetry } = openTelemetry({
        spanExporter,
        metricExporter,
        exportTimeoutMs: 60_000,
      });
      await telemetry.trace('query', (probe) => {
        probe.end({ ms: 1 });
        return Promise.resolve();
      });
      void telemetry.flush();
      await delay(50);

      const outcome = await Promise.race([
        telemetry.trace('query', () => Promise.resolve('done')),
        timeoutAfter(2_000),
      ]);
      // Libera os envios presos e os do shutdown: o SDK mantém um timer de 60 s por envio pendente.
      capture.mode = 'ok';
      for (const done of capture.late) done({ code: ExportResultCode.SUCCESS });

      expect(capture.late.length).toBeGreaterThan(0);
      expect(outcome).toBe('done');
    });

    it('should neither change the result nor call run twice when the SDK throws', async () => {
      const tracer = {
        startSpan: () => ({
          setAttributes: () => {
            throw new Error('sdk');
          },
          setStatus: () => {
            throw new Error('sdk');
          },
          end: () => {
            throw new Error('sdk');
          },
        }),
      } as unknown as Tracer;
      const meter = {
        createCounter: () => ({
          add: () => {
            throw new Error('sdk');
          },
        }),
        createHistogram: () => ({
          record: () => {
            throw new Error('sdk');
          },
        }),
      } as unknown as Meter;
      jest.spyOn(TracerProvider.prototype, 'getTracer').mockReturnValue(tracer);
      jest.spyOn(MeterProvider.prototype, 'getMeter').mockReturnValue(meter);
      const { telemetry } = openTelemetry();
      const run = jest.fn((probe: { end(outcome: { ms: number; code?: string }): void }) => {
        probe.end({ ms: 1, code: 'X' });
        return Promise.resolve('value');
      });

      const result = await telemetry.trace('query', run);

      expect(result).toBe('value');
      expect(run).toHaveBeenCalledTimes(1);
    });

    it('should call run once and keep its rejection when starting the span throws', async () => {
      const tracer = {
        startSpan: () => {
          throw new Error('sdk');
        },
      } as unknown as Tracer;
      jest.spyOn(TracerProvider.prototype, 'getTracer').mockReturnValue(tracer);
      const { telemetry } = openTelemetry();
      const run = jest.fn(() => Promise.reject(new Error('from run')));

      const failing = telemetry.trace('query', run);

      await expect(failing).rejects.toThrow('from run');
      expect(run).toHaveBeenCalledTimes(1);
    });
  });

  describe('with the send state', () => {
    const traceOnce = (telemetry: OtelTelemetry) =>
      telemetry.trace('query', (probe) => {
        probe.end({ ms: 1 });
        return Promise.resolve();
      });

    it('should report export while the last send failed', async () => {
      const { telemetry, capture } = openTelemetry();
      capture.mode = 'fail';
      await traceOnce(telemetry);

      await telemetry.flush();

      expect(telemetry.degraded()).toBe('export');
    });

    it('should clear export after a successful send', async () => {
      const { telemetry, capture } = openTelemetry();
      capture.mode = 'fail';
      await traceOnce(telemetry);
      await telemetry.flush();
      capture.mode = 'ok';

      expect(telemetry.degraded()).toBe('export');

      await traceOnce(telemetry);
      await telemetry.flush();

      expect(telemetry.degraded()).toBeUndefined();
    });

    it('should report probe when the probe failed and nothing was sent yet', async () => {
      const { telemetry } = openTelemetry({ probe: () => Promise.resolve(false) });

      await delay(10);

      expect(telemetry.degraded()).toBe('probe');
    });

    it('should report nothing while the probe is still pending', async () => {
      const { telemetry } = openTelemetry({ probe: () => new Promise<boolean>(() => undefined) });

      await delay(10);

      expect(telemetry.degraded()).toBeUndefined();
    });

    it('should clear probe after a successful send', async () => {
      const { telemetry } = openTelemetry({ probe: () => Promise.resolve(false) });
      await delay(10);

      expect(telemetry.degraded()).toBe('probe');

      await traceOnce(telemetry);
      await telemetry.flush();

      expect(telemetry.degraded()).toBeUndefined();
    });

    it('should treat a probe that throws as failed', async () => {
      const { telemetry } = openTelemetry({
        probe: () => {
          throw new Error('sync');
        },
      });

      await delay(10);

      expect(telemetry.degraded()).toBe('probe');
    });

    it('should mark the send failed at the deadline when the exporter never answers, and ignore a late result', async () => {
      const { capture, spanExporter, metricExporter } = createCapture('silent');
      const { telemetry } = openTelemetry({ spanExporter, metricExporter, exportTimeoutMs: 100 });
      await traceOnce(telemetry);
      const started = Date.now();

      await telemetry.flush();
      for (const done of capture.late) done({ code: ExportResultCode.SUCCESS });

      expect(Date.now() - started).toBeLessThan(1_000);
      expect(telemetry.degraded()).toBe('export');
    });

    it('should probe the endpoint with a HEAD, an abort signal and no redirect', async () => {
      const fetchSpy = jest
        .spyOn(globalThis, 'fetch')
        .mockResolvedValue(new Response(null, { status: 405 }));

      openTelemetry({ probe: undefined });
      await delay(10);

      expect(fetchSpy).toHaveBeenCalledWith(
        SETTINGS.endpoint,
        expect.objectContaining({
          method: 'HEAD',
          signal: expect.any(AbortSignal),
          redirect: 'manual',
        }),
      );
    });

    it('should count any answer of the endpoint as reachable', async () => {
      jest.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(null, { status: 405 }));

      const { telemetry } = openTelemetry({ probe: undefined });
      await delay(10);

      expect(telemetry.degraded()).toBeUndefined();
    });

    it('should report probe when the default probe cannot reach the endpoint', async () => {
      jest.spyOn(globalThis, 'fetch').mockRejectedValue(new TypeError('fetch failed'));

      const { telemetry } = openTelemetry({ probe: undefined });
      await delay(10);

      expect(telemetry.degraded()).toBe('probe');
    });
  });

  describe('with a failed start', () => {
    it.each([
      'not a url',
      'ftp://host/x',
      'http://user:pass@127.0.0.1:1/',
      'http://user@127.0.0.1:1/',
      'http://127.0.0.1:1/api/default?org=acme',
      'http://127.0.0.1:1/api/default/?org=acme',
      'http://127.0.0.1:1/api/default#frag',
      'http://127.0.0.1:1/?',
      'http://127.0.0.1:1/#',
    ])('should return the noop and log one init failure for the endpoint %s', (endpoint) => {
      const logs: LogRecord[] = [];

      const telemetry = createOtelTelemetry({
        settings: { endpoint, headers: {} },
        logger: (record) => logs.push(record),
      });

      expect(telemetry.enabled).toBe(false);
      expect(logs).toEqual([
        { level: 'warn', event: 'telemetry-init-failed', reason: 'invalid-endpoint' },
      ]);
    });

    it('should return the noop and log only the reason when the SDK fails to start', async () => {
      jest.spyOn(TracerProvider.prototype, 'getTracer').mockImplementation(() => {
        throw new Error('secret-detail');
      });
      const logs: LogRecord[] = [];

      const telemetry = createOtelTelemetry({
        settings: { endpoint: 'http://leaky-host:4318', headers: {} },
        logger: (record) => logs.push(record),
      });

      expect(telemetry.enabled).toBe(false);
      expect(logs).toEqual([
        { level: 'warn', event: 'telemetry-init-failed', reason: 'sdk-init-failed' },
      ]);
      await expect(telemetry.flush()).resolves.toBeUndefined();
      await expect(telemetry.trace('query', () => Promise.resolve(1))).resolves.toBe(1);
    });
  });

  describe('with shutdown', () => {
    it('should send what is pending', async () => {
      const { telemetry, capture } = openTelemetry();
      await telemetry.trace('query', (probe) => {
        probe.end({ ms: 1 });
        return Promise.resolve();
      });

      await telemetry.shutdown(1_000);

      expect(capture.spans).toHaveLength(1);
      expect(capture.metrics.length).toBeGreaterThan(0);
    });

    it('should stop waiting for a call in flight after the drain and still send the finished ones', async () => {
      const { telemetry, capture } = openTelemetry({ drainTimeoutMs: 50 });
      await telemetry.trace('query', (probe) => {
        probe.end({ ms: 1 });
        return Promise.resolve();
      });
      void telemetry.trace('register', () => new Promise<void>(() => undefined));
      const started = Date.now();

      await telemetry.shutdown(5_000);

      expect(Date.now() - started).toBeLessThan(1_000);
      expect(capture.spans.map((span) => span.name)).toContain('tool query');
    });

    it('should return as soon as a call in flight finishes within the drain and send its span', async () => {
      const { telemetry, capture } = openTelemetry({ drainTimeoutMs: 500 });
      void telemetry.trace('register', () => delay(20));
      const started = Date.now();

      await telemetry.shutdown(1_000);

      expect(capture.spans.map((span) => span.name)).toContain('tool register');
      expect(Date.now() - started).toBeLessThan(400);
    });

    it('should not exceed its timeout and not reject when an exporter never shuts down', async () => {
      const stuck: SpanExporter = {
        export: (_spans, done) => done({ code: ExportResultCode.SUCCESS }),
        shutdown: () => new Promise<void>(() => undefined),
      };
      const { telemetry } = openTelemetry({ spanExporter: stuck });
      const started = Date.now();

      await expect(telemetry.shutdown(150)).resolves.toBeUndefined();

      expect(Date.now() - started).toBeLessThan(1_000);
    });

    it('should not reject when an exporter shutdown rejects', async () => {
      const broken: SpanExporter = {
        export: (_spans, done) => done({ code: ExportResultCode.SUCCESS }),
        shutdown: () => Promise.reject(new Error('boom')),
      };
      const { telemetry } = openTelemetry({ spanExporter: broken });

      await expect(telemetry.shutdown(500)).resolves.toBeUndefined();
    });
  });

  describe('with the process streams', () => {
    it('should never call console or write to stdout', async () => {
      const methods = Object.keys(console).filter(
        (key) => typeof console[key as keyof Console] === 'function',
      ) as (keyof Console)[];
      const spies = methods.map((method) =>
        jest.spyOn(console, method as 'log').mockImplementation(() => undefined),
      );
      const stdout = jest.spyOn(process.stdout, 'write').mockImplementation(() => true);
      const { capture, spanExporter, metricExporter } = createCapture('fail');
      const { telemetry } = openTelemetry({
        spanExporter,
        metricExporter,
        probe: () => Promise.resolve(false),
      });
      createOtelTelemetry({ settings: { endpoint: 'nope', headers: {} }, logger: () => undefined });

      await telemetry.trace('query', (probe) => {
        probe.end({ ms: 1, code: 'X' });
        return Promise.resolve();
      });
      await telemetry.flush();
      await telemetry.shutdown(500);

      expect(capture.spans).toHaveLength(1);
      expect(spies.flatMap((spy) => spy.mock.calls)).toEqual([]);
      expect(stdout).not.toHaveBeenCalled();
    });
  });

  describe('with a local receiver and hostile OTEL_* variables', () => {
    const SENDER = path.join(__dirname, '..', 'fixtures', 'otel-sender.ts');
    const HOSTILE_ENV = {
      OTEL_EXPORTER_OTLP_HEADERS: 'x-leak=1',
      OTEL_EXPORTER_OTLP_TRACES_HEADERS: 'x-leak=2',
      OTEL_EXPORTER_OTLP_METRICS_HEADERS: 'x-leak=3',
      OTEL_EXPORTER_OTLP_COMPRESSION: 'gzip',
      OTEL_EXPORTER_OTLP_METRICS_TEMPORALITY_PREFERENCE: 'delta',
    };
    const CALLS = 2;
    let own: Receiver;
    let other: Receiver;
    let outcome: { enabled: boolean; otelEnvAfterBuild: Record<string, string> };

    beforeAll(async () => {
      own = await listen();
      other = await listen();
      const hostile = { ...HOSTILE_ENV, OTEL_EXPORTER_OTLP_ENDPOINT: other.origin };
      const args: OtelSenderArgs = {
        endpoint: `${own.origin}/api/default/`,
        headers: { Authorization: 'Basic abc' },
        calls: CALLS,
      };
      const { stdout } = await execFileAsync(process.execPath, [SENDER, JSON.stringify(args)], {
        env: { ...process.env, ...hostile },
        timeout: 15_000,
      });
      outcome = JSON.parse(stdout) as typeof outcome;
    }, 30_000);

    afterAll(async () => {
      await Promise.all([own.close(), other.close()]);
    });

    it('should enable the telemetry', () => {
      expect(outcome.enabled).toBe(true);
    });

    it('should post traces and metrics to the paths of the own endpoint', () => {
      const posts = new Set(own.hits.map((hit) => `${hit.method} ${hit.url}`));

      expect(posts).toEqual(
        new Set(['POST /api/default/v1/metrics', 'POST /api/default/v1/traces']),
      );
    });

    it('should send the own headers on every post', () => {
      const authorizations = new Set(own.hits.map((hit) => hit.headers.authorization));

      expect(authorizations).toEqual(new Set(['Basic abc']));
    });

    it('should send none of the headers of the OTEL_* variables', () => {
      const leaked = new Set(
        own.hits.map((hit) => Object.keys(hit.headers).some((name) => name.startsWith('x-leak'))),
      );

      expect(leaked).toEqual(new Set([false]));
    });

    it('should send the body uncompressed', () => {
      const encodings = new Set(own.hits.map((hit) => hit.headers['content-encoding']));

      expect(encodings).toEqual(new Set([undefined]));
    });

    it('should send nothing to the endpoint of the OTEL_* variables', () => {
      expect(other.hits).toEqual([]);
    });

    it('should leave the OTEL_* variables of the environment untouched', () => {
      expect(outcome.otelEnvAfterBuild).toEqual({
        ...HOSTILE_ENV,
        OTEL_EXPORTER_OTLP_ENDPOINT: other.origin,
      });
    });

    it('should send cumulative call counts despite the delta preference', () => {
      const sums = own.hits
        .filter((hit) => hit.url?.endsWith('/v1/metrics'))
        .flatMap((hit) => (JSON.parse(hit.body) as OtlpBody).resourceMetrics ?? [])
        .flatMap((resource) => resource.scopeMetrics)
        .flatMap((scope) => scope.metrics)
        .filter((metric) => metric.name === 'hexlog.tool.calls');
      const lastSum = at(sums, sums.length - 1).sum;
      const point = at(lastSum?.dataPoints ?? [], 0);

      expect(lastSum?.aggregationTemporality).toBe(2);
      expect(Number(point.asDouble ?? point.asInt)).toBe(CALLS);
    });
  });
});

describe('execute', () => {
  const environments: Environment[] = [];
  const hostile = (): unknown => JSON.parse('{"__proto__":1}');
  const hostileData = (): unknown => JSON.parse('{"text":"x","__proto__":1}');
  const SECRET_PROJECT = 'sentinel-project-q7x';
  const SECRET_PROCESS = 'sentinel-process-q7x';
  const SECRETS = new RegExp(`${SECRET_PROJECT}|${SECRET_PROCESS}`);
  const DETAIL_MESSAGE = 'must not use the key __proto__';
  let environment: Environment;
  let telemetry: OtelTelemetry;
  let capture: ReturnType<typeof createCapture>['capture'];
  let adapterLogs: LogRecord[];

  async function start(overrides: Partial<OtelTelemetryOptions> = {}) {
    ({
      telemetry,
      capture,
      logs: adapterLogs,
    } = openTelemetry({
      batchDelayMs: 50,
      metricIntervalMs: 50,
      exportTimeoutMs: 200,
      ...overrides,
    }));
    environment = await createEnvironment({ telemetry });
    environments.push(environment);
    await environment.ok('define_type', { project: PROJECT, name: 'note', schema: NOTE_SCHEMA });
    await environment.ok('create_process', { project: PROJECT, process: 'run-a' });
    await environment.ok('create_process', { project: PROJECT, process: 'run-b' });
  }

  const logOf = (process: string) =>
    processPaths(environment.dataDir, { project: PROJECT, process }).log;
  const sizeOf = (process: string) => ({
    bytes: fs.statSync(logOf(process)).size,
    lines: fs.readFileSync(logOf(process), 'utf8').split('\n').length - 1,
  });

  /** Último span exportado da tool, depois de enviar o que está em fila. */
  async function spanOf(tool: string) {
    await telemetry.flush();
    const span = capture.spans.findLast(
      (candidate) => candidate.attributes['hexlog.tool'] === tool,
    );
    if (isUndefined(span)) throw new Error(`no ${tool} span was exported`);
    return span;
  }

  const attributeNames = (span: ReadableSpan) => Object.keys(span.attributes);

  const hostileRegister = (project: string, process: string) =>
    environment.fail(
      'register',
      {
        project,
        process,
        agent: 'executor',
        records: [{ type: 'note', target: 'run.step', data: hostileData() }],
      },
      'INVALID_INPUT',
    );

  const allMetricAttributes = () =>
    capture.metrics.flatMap(({ scopeMetrics }) =>
      scopeMetrics.flatMap(({ metrics }) =>
        metrics.flatMap((metric) => pointsOf(metric).map(({ attributes }) => attributes)),
      ),
    );

  beforeEach(async () => {
    await start();
  });

  afterEach(async () => {
    await Promise.all(opened.map((open) => open.shutdown(1_000)));
    opened.length = 0;
    await Promise.all(environments.map((open) => open.close()));
    environments.length = 0;
  });

  describe('with the span attributes', () => {
    it('should attribute a plain register to the target with the log as it was before the batch', async () => {
      await registerNote(environment, { process: 'run-a' });
      const before = sizeOf('run-a');

      await registerNote(environment, { process: 'run-a' });

      expect((await spanOf('register')).attributes).toMatchObject({
        'hexlog.project': PROJECT,
        'hexlog.process': 'run-a',
        'hexlog.process.count': 1,
        'hexlog.log.lines': before.lines,
        'hexlog.log.bytes': before.bytes,
      });
    });

    it('should count two processes and keep the origin as the target when a register anchors in another process', async () => {
      const { records } = await registerNote(environment, { process: 'run-b' });
      await registerNote(environment, { process: 'run-a' });
      const before = sizeOf('run-a');

      await registerNote(environment, {
        process: 'run-a',
        relations: [{ kind: 'derivesFrom', to: records[0]?.id }],
      });

      expect((await spanOf('register')).attributes).toMatchObject({
        'hexlog.process': 'run-a',
        'hexlog.process.count': 2,
        'hexlog.log.lines': before.lines,
        'hexlog.log.bytes': before.bytes,
      });
    });

    it('should count no process when a nested __proto__ is refused before the write', async () => {
      await hostileRegister(PROJECT, 'run-a');

      const span = await spanOf('register');

      expect(span.attributes).toMatchObject({ 'hexlog.process.count': 0 });
      expect(attributeNames(span)).not.toContain('hexlog.process');
    });

    it('should not add a process when query rereads it by changesSince', async () => {
      await registerNote(environment, { process: 'run-a' });
      const { marker } = await environment.ok<{ marker: Record<string, string | null> }>('query', {
        project: PROJECT,
        process: 'run-a',
      });

      await environment.ok('query', { project: PROJECT, process: 'run-a', changesSince: marker });

      expect((await spanOf('query')).attributes).toMatchObject({
        'hexlog.process': 'run-a',
        'hexlog.process.count': 1,
        'hexlog.log.lines': sizeOf('run-a').lines,
        'hexlog.log.bytes': sizeOf('run-a').bytes,
      });
    });

    it('should leave the process out and sum the sizes when a project query reads two processes', async () => {
      await registerNote(environment, { process: 'run-a' });
      await registerNote(environment, { process: 'run-b' });
      await registerNote(environment, { process: 'run-b' });

      await environment.ok('query', { project: PROJECT, scope: 'project' });

      const span = await spanOf('query');

      expect(span.attributes).toMatchObject({
        'hexlog.project': PROJECT,
        'hexlog.process.count': 2,
        'hexlog.log.lines': sizeOf('run-a').lines + sizeOf('run-b').lines,
        'hexlog.log.bytes': sizeOf('run-a').bytes + sizeOf('run-b').bytes,
      });
      expect(attributeNames(span)).not.toContain('hexlog.process');
    });

    it('should attribute verify_chain to the process it read, with the newlines and the stat size', async () => {
      await registerNote(environment, { process: 'run-a' });
      await registerNote(environment, { process: 'run-a' });

      await environment.ok('verify_chain', { project: PROJECT, process: 'run-a' });

      expect((await spanOf('verify_chain')).attributes).toMatchObject({
        'hexlog.process': 'run-a',
        'hexlog.process.count': 1,
        'hexlog.log.lines': sizeOf('run-a').lines,
        'hexlog.log.bytes': sizeOf('run-a').bytes,
      });
    });

    it('should count every process of list without a process and report no process or size', async () => {
      await environment.ok('list', { project: PROJECT });

      const span = await spanOf('list');

      expect(span.attributes).toMatchObject({ 'hexlog.process.count': 2 });
      expect(attributeNames(span).filter((name) => /^hexlog\.(process|log\.)/.test(name))).toEqual([
        'hexlog.process.count',
      ]);
    });

    it('should attribute create_process to the created process without a size', async () => {
      await environment.ok('create_process', { project: PROJECT, process: 'run-c' });

      const span = await spanOf('create_process');

      expect(span.attributes).toMatchObject({
        'hexlog.process': 'run-c',
        'hexlog.process.count': 1,
      });
      expect(attributeNames(span).filter((name) => name.startsWith('hexlog.log.'))).toEqual([]);
    });

    it('should attribute describe_type with a process to that process without a size', async () => {
      await environment.ok('describe_type', { project: PROJECT, process: 'run-a', type: 'note' });

      const span = await spanOf('describe_type');

      expect(span.attributes).toMatchObject({
        'hexlog.process': 'run-a',
        'hexlog.process.count': 1,
      });
      expect(attributeNames(span).filter((name) => name.startsWith('hexlog.log.'))).toEqual([]);
    });
  });

  describe('with the metrics', () => {
    const labelsOf = (name: string) =>
      lastPoints(capture.metrics, name).map(({ attributes }) => Object.keys(attributes).sort());

    it('should add up the calls by tool', async () => {
      await environment.ok('list', { project: PROJECT });
      await environment.ok('list', { project: PROJECT });
      await environment.ok('list', { project: PROJECT });
      await environment.ok('query', { project: PROJECT, process: 'run-a' });
      await telemetry.flush();

      const byTool = Object.fromEntries(
        lastPoints(capture.metrics, 'hexlog.tool.calls').map(({ attributes, value }) => [
          String(attributes['hexlog.tool']),
          value,
        ]),
      );

      expect(byTool).toEqual({ define_type: 1, create_process: 2, list: 3, query: 1 });
    });

    it('should label the calls only by tool', async () => {
      await telemetry.flush();

      expect(new Set(labelsOf('hexlog.tool.calls').flat())).toEqual(new Set(['hexlog.tool']));
    });

    it('should label the duration only by tool', async () => {
      await telemetry.flush();

      expect(new Set(labelsOf('hexlog.tool.duration').flat())).toEqual(new Set(['hexlog.tool']));
    });

    it('should label the errors by tool and error code only', async () => {
      await hostileRegister(PROJECT, 'run-a');
      await telemetry.flush();

      expect(labelsOf('hexlog.tool.errors')).toEqual([['hexlog.error.code', 'hexlog.tool']]);
    });

    it('should count one error with the tool and the code of the refusal', async () => {
      await hostileRegister(PROJECT, 'run-a');
      await telemetry.flush();

      const [point] = lastPoints(capture.metrics, 'hexlog.tool.errors');

      expect(point).toMatchObject({
        attributes: { 'hexlog.tool': 'register', 'hexlog.error.code': 'INVALID_INPUT' },
        value: 1,
      });
    });
  });

  describe('with a refused call', () => {
    it.each(TOOL_NAMES)(
      'should record INVALID_INPUT and reserved-key on the span of %s',
      async (tool) => {
        const body = await environment.fail(tool, { x: hostile() }, 'INVALID_INPUT');

        expect(body.details).toContainEqual(expect.objectContaining({ code: 'reserved-key' }));

        const span = await spanOf(tool);

        expect(span.attributes).toMatchObject({
          'hexlog.error.code': 'INVALID_INPUT',
          'hexlog.error.detail_codes': expect.arrayContaining(['reserved-key']) as unknown,
        });
      },
    );

    it('should mark the span as an error without a message or events', async () => {
      await hostileRegister(PROJECT, 'run-a');

      const span = await spanOf('register');

      expect(span.status).toEqual({ code: SpanStatusCode.ERROR });
      expect(span.events).toEqual([]);
    });
  });

  describe('with a handler that refuses a batch past the cap after reading the log', () => {
    it('should attribute the target, its size and PROCESS_TOO_LARGE to the span', async () => {
      const deps: ToolDeps = {
        services: {} as ToolDeps['services'],
        isLegacy: () => false,
        logger: () => undefined,
        telemetry,
      };
      const call = { name: 'register', schema: z.strictObject({}), args: {}, ctx: { mcpReq: {} } };
      const bytes = MAX_LOG_BYTES - 10;

      await execute(deps, call, () => {
        telemetry.recordLoad({
          ref: { project: PROJECT, process: 'run-a' },
          role: 'target',
          bytes,
          lines: 3,
        });
        throw processTooLarge('run-a', MAX_LOG_BYTES, true);
      });

      expect((await spanOf('register')).attributes).toMatchObject({
        'hexlog.project': PROJECT,
        'hexlog.process': 'run-a',
        'hexlog.process.count': 1,
        'hexlog.log.bytes': bytes,
        'hexlog.log.lines': 3,
        'hexlog.error.code': 'PROCESS_TOO_LARGE',
      });
    });
  });

  describe('with the project and process named by sentinels', () => {
    const spanPayload = () =>
      JSON.stringify(
        capture.spans.map(({ name, attributes, events, status, links }) => ({
          name,
          attributes,
          events,
          status,
          links,
        })),
      );

    beforeEach(async () => {
      await environment.ok('define_type', {
        project: SECRET_PROJECT,
        name: 'note',
        schema: NOTE_SCHEMA,
      });
      await environment.ok('create_process', { project: SECRET_PROJECT, process: SECRET_PROCESS });
      await environment.ok('register', {
        project: SECRET_PROJECT,
        process: SECRET_PROCESS,
        agent: 'executor',
        records: [{ type: 'note', target: 'run.step', data: { text: 'x' } }],
      });
      await environment.ok('query', { project: SECRET_PROJECT, process: SECRET_PROCESS });
      await hostileRegister(SECRET_PROJECT, SECRET_PROCESS);
      await telemetry.flush();
    });

    it('should keep them out of the tool, tool-over-cap and telemetry logs', () => {
      const logged = [...environment.logs, ...adapterLogs].filter(
        ({ event }) =>
          event === 'tool' || event === 'tool-over-cap' || event.startsWith('telemetry-'),
      );

      expect(logged.some(({ event }) => event === 'tool')).toBe(true);
      expect(JSON.stringify(logged)).not.toMatch(SECRETS);
    });

    it('should keep them out of every metric attribute', () => {
      const attributes = allMetricAttributes();

      expect(attributes.length).toBeGreaterThan(0);
      expect(JSON.stringify(attributes)).not.toMatch(SECRETS);
    });

    it('should carry them on the span of the call', () => {
      const payload = spanPayload();

      expect(capture.spans.length).toBeGreaterThan(0);
      expect(payload).toContain(SECRET_PROJECT);
      expect(payload).toContain(SECRET_PROCESS);
    });

    it('should keep the message of the error details out of spans and metrics', () => {
      expect(spanPayload()).not.toContain(DETAIL_MESSAGE);
      expect(JSON.stringify(allMetricAttributes())).not.toContain(DETAIL_MESSAGE);
    });
  });

  describe('with exporters that never answer', () => {
    it('should resolve a call without waiting for a pending send', async () => {
      const silent = createCapture('silent');
      await start({
        spanExporter: silent.spanExporter,
        metricExporter: silent.metricExporter,
        exportTimeoutMs: 60_000,
      });
      void telemetry.flush();
      await delay(50);

      const outcome = await Promise.race([
        environment.ok('list', { project: PROJECT }).then(() => 'done'),
        timeoutAfter(2_000),
      ]);
      // Libera os envios presos e os do shutdown: o SDK mantém um timer de 60 s por envio pendente.
      silent.capture.mode = 'ok';
      for (const done of silent.capture.late) done({ code: ExportResultCode.SUCCESS });

      expect(silent.capture.late.length).toBeGreaterThan(0);
      expect(outcome).toBe('done');
    });
  });
});
