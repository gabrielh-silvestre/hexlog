import * as fs from 'node:fs';
import * as path from 'node:path';
import { afterEach, describe, expect, it, jest } from '@jest/globals';
import MiniSearch from 'minisearch';
import { noopTelemetry } from '../src/adapters/telemetry/noop.ts';
import { compose, composeReader, composeShutdown, composeTelemetry } from '../src/compose.ts';
import { processPaths } from '../src/adapters/fs/data-format.ts';
import type { Telemetry } from '../src/ports.ts';
import type { Logger } from '../src/shared/logger.ts';
import { captureError, createTempDir } from './helpers.ts';
import { AUTHOR, NOTE, NOW, PROJECT, note } from './commands/fakes.ts';

/** `cwd` e `dataDir` distintos; o `dataDir` fica dentro do `cwd` para provar que o `attach` o recusa. */
function composed(logger: Logger = () => undefined) {
  const cwd = createTempDir('compose');
  const dataDir = path.join(cwd, 'data');
  fs.mkdirSync(dataDir);
  return { cwd, dataDir, ...compose({ dataDir, cwd, clock: () => NOW, logger }) };
}

const REF = { project: PROJECT, process: 'run-1' };
const INPUT = { ...REF, author: AUTHOR, key: 'k1', records: [note()] };

/** `composed()` com o tipo `note` definido e o processo `run-1` criado. */
function composedWithNote(logger?: Logger) {
  const setup = composed(logger);
  setup.services.definition.defineType({ project: PROJECT, name: 'note', schema: NOTE });
  setup.services.process.createProcess(REF);
  return setup;
}

/** As linhas do log de `run-1` sob `dataDir`. */
const logLines = (dataDir: string) =>
  fs.readFileSync(processPaths(dataDir, REF).log, 'utf8').trimEnd().split('\n');

// Cada `addAll` é uma montagem do índice de busca: o sensor de que a composição reaproveita o cache.
const addAll = jest.spyOn(MiniSearch.prototype, 'addAll');

describe('compose', () => {
  afterEach(() => {
    addAll.mockClear();
  });

  it('should wire the write and query services over the real adapters', () => {
    const { services } = composed();

    expect(Object.keys(services).sort()).toEqual(['attachment', 'definition', 'process', 'query']);
  });

  it('should build the search index once for two text queries through the composed query service', async () => {
    const { services } = composedWithNote();
    await services.process.register({ ...INPUT, records: [note('webhook')] });
    const input = { ...REF, text: 'webhook' };

    services.query.queryRecords(input);
    services.query.queryRecords(input);

    expect(addAll).toHaveBeenCalledTimes(1);
  });

  it('should write a single log line for createProcess followed by register', async () => {
    const { services, dataDir } = composedWithNote();

    const first = await services.process.register(INPUT);

    expect(first.replayed).toBe(false);
    expect(logLines(dataDir)).toHaveLength(1);
  });

  it('should return replayed and leave the log unchanged when register repeats the same key', async () => {
    const { services, dataDir } = composedWithNote();
    const first = await services.process.register(INPUT);
    const lines = logLines(dataDir);

    const again = await services.process.register(INPUT);

    expect(again).toMatchObject({ replayed: true, records: first.records });
    expect(logLines(dataDir)).toEqual(lines);
  });

  it('should emit batch-replayed through the composed logger on the second register with the same key', async () => {
    const logger = jest.fn<Logger>();
    const { services } = composedWithNote(logger);
    const replayed = expect.objectContaining({ event: 'batch-replayed', key: 'k1' });
    await services.process.register(INPUT);

    expect(logger).not.toHaveBeenCalledWith(replayed);

    await services.process.register(INPUT);

    expect(logger).toHaveBeenCalledWith(replayed);
  });

  it('should report no legacy data when the dataDir is empty', () => {
    const { isLegacy } = composed();

    expect(isLegacy()).toBe(false);
  });

  it('should report legacy data when the dataDir has a 0.x layout', () => {
    const { isLegacy, dataDir } = composed();
    fs.mkdirSync(path.join(dataDir, 'my-project'));

    expect(isLegacy()).toBe(true);
  });

  describe('with a telemetry', () => {
    const recordLoad = jest.fn<Telemetry['recordLoad']>();
    const telemetryOf = (enabled: boolean): Telemetry => ({
      ...noopTelemetry,
      enabled,
      recordLoad,
    });

    /** Cria o processo e lê o log vazio por uma tool de leitura, sobre a composição com `telemetry`. */
    function createAndRead(telemetry: Telemetry) {
      const cwd = createTempDir('compose');
      const dataDir = path.join(cwd, 'data');
      fs.mkdirSync(dataDir);
      const { services } = compose({
        dataDir,
        cwd,
        clock: () => NOW,
        logger: () => undefined,
        telemetry,
      });
      services.definition.defineType({ project: PROJECT, name: 'note', schema: NOTE });
      services.process.createProcess(REF);
      services.query.queryRecords(REF);
    }

    afterEach(() => {
      recordLoad.mockClear();
    });

    it('should hand the store an onLoad that reaches recordLoad when the telemetry is enabled', () => {
      createAndRead(telemetryOf(true));

      expect(recordLoad.mock.calls).toEqual([
        [{ ref: REF, role: 'target' }],
        [{ ref: REF, role: 'read', bytes: 0, lines: 0 }],
      ]);
    });

    it('should not call recordLoad after a read when the telemetry is disabled', () => {
      createAndRead(telemetryOf(false));

      expect(recordLoad).not.toHaveBeenCalled();
    });
  });
});

describe('composeReader', () => {
  async function seeded() {
    const { services, cwd, dataDir } = composedWithNote();
    const { records } = await services.process.register(INPUT);
    return { reader: composeReader({ cwd, dataDir, logger: () => undefined }), dataDir, records };
  }

  it('should expose only the read side', async () => {
    const { reader } = await seeded();

    expect(Object.keys(reader).sort()).toEqual([
      'isLegacy',
      'list',
      'listProjects',
      'loadProcess',
      'query',
    ]);
  });

  const idsOf = (items: readonly { id: string }[]) => items.map(({ id }) => id);

  it.each([
    [
      'listProjects',
      (reader: ReturnType<typeof composeReader>) => reader.listProjects(),
      () => [PROJECT],
    ],
    ['list', (reader: ReturnType<typeof composeReader>) => reader.list(PROJECT), () => ['run-1']],
    [
      'loadProcess',
      (reader: ReturnType<typeof composeReader>) => idsOf(reader.loadProcess(REF).records),
      idsOf,
    ],
    [
      'query.queryRecords',
      (reader: ReturnType<typeof composeReader>) => idsOf(reader.query.queryRecords(REF).records),
      idsOf,
    ],
  ])('should read through %s what compose wrote', async (_name, read, expected) => {
    const { reader, records } = await seeded();

    expect(read(reader)).toEqual(expected(records));
  });

  it('should reject a telemetry option at the type level', () => {
    const options = { cwd: '', dataDir: '', logger: () => undefined };

    // @ts-expect-error o lado de leitura não leva telemetria
    expect(() => composeReader({ ...options, telemetry: noopTelemetry })).not.toThrow();
  });

  it('should list a process with an unreadable process.json', async () => {
    const { reader, dataDir } = await seeded();
    fs.writeFileSync(processPaths(dataDir, REF).manifest, '{');

    expect(reader.list(PROJECT)).toEqual(['run-1']);
  });

  it('should refuse the query list with PROCESS_CORRUPTED for an unreadable process.json', async () => {
    const { reader, dataDir } = await seeded();
    fs.writeFileSync(processPaths(dataDir, REF).manifest, '{');

    expect(captureError(() => reader.query.list({ project: PROJECT }))).toMatchObject({
      code: 'PROCESS_CORRUPTED',
    });
  });
});

describe('composeTelemetry', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  it.each([
    { scenario: 'no key', env: {} },
    { scenario: 'an empty key', env: { HEXLOG_OTEL_ENDPOINT: '' } },
    { scenario: 'a blank key', env: { HEXLOG_OTEL_ENDPOINT: '   ' } },
    {
      scenario: 'only the standard OTLP variables',
      env: {
        OTEL_EXPORTER_OTLP_ENDPOINT: 'http://127.0.0.1:1',
        OTEL_EXPORTER_OTLP_HEADERS: 'authorization=x',
      },
    },
  ])('should return noopTelemetry without calling fetch for $scenario', ({ env }) => {
    const fetch = jest.spyOn(globalThis, 'fetch');

    const telemetry = composeTelemetry(env, () => undefined);

    expect(telemetry).toBe(noopTelemetry);
    expect(telemetry.enabled).toBe(false);
    expect(fetch).not.toHaveBeenCalled();
  });

  it('should return an enabled telemetry when the key is set', async () => {
    jest.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(null, { status: 404 }));

    const telemetry = composeTelemetry(
      { HEXLOG_OTEL_ENDPOINT: 'http://127.0.0.1:1' },
      () => undefined,
    );

    expect(telemetry.enabled).toBe(true);

    await telemetry.shutdown(500);
  });
});

describe('composeShutdown', () => {
  function fakeProcess() {
    return {
      stdin: { readableEnded: false, destroyed: false, on: jest.fn() },
      on: jest.fn(),
      once: jest.fn(),
      exit: jest.fn(),
    };
  }

  it('should not install any handler when the telemetry is disabled', () => {
    const proc = fakeProcess();

    composeShutdown({
      telemetry: noopTelemetry,
      proc,
      closeTransport: () => Promise.resolve(),
    });

    expect(proc.on).not.toHaveBeenCalled();
    expect(proc.once).not.toHaveBeenCalled();
    expect(proc.stdin.on).not.toHaveBeenCalled();
  });

  it('should bind the process events when the telemetry is enabled', () => {
    const proc = fakeProcess();

    composeShutdown({
      telemetry: { ...noopTelemetry, enabled: true },
      proc,
      closeTransport: () => Promise.resolve(),
    });

    expect(proc.on).toHaveBeenCalledWith('SIGTERM', expect.any(Function));
    expect(proc.stdin.on).toHaveBeenCalledWith('end', expect.any(Function));
  });
});
