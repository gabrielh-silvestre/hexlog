import { describe, expect, it } from '@jest/globals';
import { readTelemetrySettings } from '../../src/adapters/telemetry/settings.ts';

describe('readTelemetrySettings', () => {
  it.each([
    ['absent', {}],
    ['empty', { HEXLOG_OTEL_ENDPOINT: '' }],
    ['blank', { HEXLOG_OTEL_ENDPOINT: '   ' }],
    ['set only through the standard variable', { OTEL_EXPORTER_OTLP_ENDPOINT: 'http://x:4318' }],
  ])('should return undefined when the endpoint is %s', (_case, env) => {
    expect(readTelemetrySettings(env)).toBeUndefined();
  });

  it('should return the trimmed endpoint with no headers when HEXLOG_OTEL_HEADERS is absent', () => {
    const env = { HEXLOG_OTEL_ENDPOINT: '  http://localhost:4318/api/default  ' };

    expect(readTelemetrySettings(env)).toEqual({
      endpoint: 'http://localhost:4318/api/default',
      headers: {},
    });
  });

  it('should split each header pair at the first equals sign and percent-decode it', () => {
    const env = {
      HEXLOG_OTEL_ENDPOINT: 'http://localhost:4318',
      HEXLOG_OTEL_HEADERS: 'Authorization=Basic%20YWJj==,x-org=a%2Cb',
    };

    expect(readTelemetrySettings(env)?.headers).toEqual({
      Authorization: 'Basic YWJj==',
      'x-org': 'a,b',
    });
  });

  it('should ignore malformed pairs and keep the valid ones', () => {
    const env = {
      HEXLOG_OTEL_ENDPOINT: 'http://localhost:4318',
      HEXLOG_OTEL_HEADERS: 'noequals,=novalue-key,bad=%E0%A4%A,,good=1',
    };

    expect(readTelemetrySettings(env)?.headers).toEqual({ good: '1' });
  });

  it.each([
    ['a name with a space', 'bad name=1,good=1'],
    ['a name with a colon', 'a:b=1,good=1'],
    ['a value with a CR', 'bad=a%0Db,good=1'],
    ['a value with a LF', 'bad=a%0Ab,good=1'],
    ['a value with a NUL', 'bad=a%00b,good=1'],
  ])('should drop the pair with %s', (_case, headers) => {
    const env = { HEXLOG_OTEL_ENDPOINT: 'http://localhost:4318', HEXLOG_OTEL_HEADERS: headers };

    expect(readTelemetrySettings(env)?.headers).toEqual({ good: '1' });
  });

  it('should keep a __proto__ header as an own property without touching the prototype', () => {
    const env = {
      HEXLOG_OTEL_ENDPOINT: 'http://localhost:4318',
      HEXLOG_OTEL_HEADERS: '__proto__=x',
    };

    const headers = readTelemetrySettings(env)?.headers ?? {};

    expect(Object.keys(headers)).toEqual(['__proto__']);
    expect(Object.getPrototypeOf(headers)).toBe(Object.prototype);
  });
});
