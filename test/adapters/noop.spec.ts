import { describe, expect, it } from '@jest/globals';
import { noopTelemetry } from '../../src/adapters/telemetry/noop.ts';

describe('noopTelemetry', () => {
  it('should be disabled and never report degradation', () => {
    expect(noopTelemetry.enabled).toBe(false);
    expect(noopTelemetry.degraded()).toBeUndefined();
  });

  it('should pass the result of run through, calling it once', async () => {
    let calls = 0;

    const result = await noopTelemetry.trace('query', () => {
      calls += 1;
      return Promise.resolve('value');
    });

    expect(result).toBe('value');
    expect(calls).toBe(1);
  });

  it('should propagate the rejection of run', async () => {
    const failing = noopTelemetry.trace('query', () => Promise.reject(new Error('boom')));

    await expect(failing).rejects.toThrow('boom');
  });

  it('should accept a probe end, a load report and a shutdown without effect', async () => {
    const ended = noopTelemetry.trace('query', (probe) => {
      probe.end({ ms: 1, code: 'X', detailCodes: ['a'] });
      return Promise.resolve();
    });

    await expect(ended).resolves.toBeUndefined();
    expect(() =>
      noopTelemetry.recordLoad({ ref: { project: 'p', process: 'q' }, role: 'read' }),
    ).not.toThrow();
    await expect(noopTelemetry.shutdown(10)).resolves.toBeUndefined();
  });
});
