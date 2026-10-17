import * as fs from 'node:fs';
import * as path from 'node:path';
import { afterEach, describe, expect, it, jest } from '@jest/globals';
import MiniSearch from 'minisearch';
import { compose, composeReader } from '../src/compose.ts';
import { processPaths } from '../src/adapters/fs/data-format.ts';
import type { Logger } from '../src/shared/logger.ts';
import { captureError, createTempDir } from './helpers.ts';
import { AUTHOR, NOTE, NOW, PROJECT, note } from './commands/register-fakes.ts';

/** `cwd` e `dataDir` distintos; o `dataDir` fica dentro do `cwd` para provar que o `attach` o recusa (D-15). */
function composed(logger: Logger = () => undefined) {
  const cwd = createTempDir('compose');
  const dataDir = path.join(cwd, 'data');
  fs.mkdirSync(dataDir);
  return { cwd, dataDir, ...compose({ dataDir, cwd, clock: () => NOW, logger }) };
}

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
    const { services } = composed();
    services.definition.defineType({ project: PROJECT, name: 'note', schema: NOTE });
    services.process.createProcess({ project: PROJECT, process: 'run-1' });
    await services.process.register({
      project: PROJECT,
      process: 'run-1',
      author: AUTHOR,
      key: 'k1',
      records: [note('webhook')],
    });
    const input = { project: PROJECT, process: 'run-1', text: 'webhook' };

    services.query.queryRecords(input);
    services.query.queryRecords(input);

    expect(addAll).toHaveBeenCalledTimes(1);
  });

  it('should write a single log line for createProcess followed by register', async () => {
    const { services, dataDir } = composed();
    services.definition.defineType({ project: PROJECT, name: 'note', schema: NOTE });
    services.process.createProcess({ project: PROJECT, process: 'run-1' });
    const input = {
      project: PROJECT,
      process: 'run-1',
      author: AUTHOR,
      key: 'k1',
      records: [note()],
    };
    const logFile = processPaths(dataDir, { project: PROJECT, process: 'run-1' }).log;

    const first = await services.process.register(input);

    const lines = fs.readFileSync(logFile, 'utf8').trimEnd().split('\n');

    expect(first.replayed).toBe(false);
    expect(lines).toHaveLength(1);
  });

  it('should return replayed and leave the log unchanged when register repeats the same key', async () => {
    const { services, dataDir } = composed();
    services.definition.defineType({ project: PROJECT, name: 'note', schema: NOTE });
    services.process.createProcess({ project: PROJECT, process: 'run-1' });
    const input = {
      project: PROJECT,
      process: 'run-1',
      author: AUTHOR,
      key: 'k1',
      records: [note()],
    };
    const logFile = processPaths(dataDir, { project: PROJECT, process: 'run-1' }).log;
    const first = await services.process.register(input);
    const lines = fs.readFileSync(logFile, 'utf8').trimEnd().split('\n');

    const again = await services.process.register(input);

    expect(again).toMatchObject({ replayed: true, records: first.records });
    expect(fs.readFileSync(logFile, 'utf8').trimEnd().split('\n')).toEqual(lines);
  });

  it('should emit batch-replayed through the composed logger on the second register with the same key', async () => {
    const logger = jest.fn<Logger>();
    const { services } = composed(logger);
    services.definition.defineType({ project: PROJECT, name: 'note', schema: NOTE });
    services.process.createProcess({ project: PROJECT, process: 'run-1' });
    const input = {
      project: PROJECT,
      process: 'run-1',
      author: AUTHOR,
      key: 'k1',
      records: [note()],
    };
    const replayed = expect.objectContaining({ event: 'batch-replayed', key: 'k1' });
    await services.process.register(input);

    expect(logger).not.toHaveBeenCalledWith(replayed);

    await services.process.register(input);

    expect(logger).toHaveBeenCalledWith(replayed);
  });

  it('should report no legacy data when the dataDir is empty', () => {
    const { isLegacy } = composed();

    expect(isLegacy()).toBe(false);
  });

  it('should report legacy data when the dataDir has a 0.x layout', () => {
    const { isLegacy, dataDir } = composed();
    fs.mkdirSync(path.join(dataDir, 'meu-projeto'));

    expect(isLegacy()).toBe(true);
  });
});

describe('composeReader', () => {
  const REF = { project: PROJECT, process: 'run-1' };

  async function seeded() {
    const { services, cwd, dataDir } = composed();
    services.definition.defineType({ project: PROJECT, name: 'note', schema: NOTE });
    services.process.createProcess(REF);
    const { records } = await services.process.register({
      ...REF,
      author: AUTHOR,
      key: 'k1',
      records: [note()],
    });
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

  it('should read through each reader method what compose wrote', async () => {
    const { reader, records } = await seeded();

    expect(reader.listProjects()).toEqual([PROJECT]);
    expect(reader.list(PROJECT)).toEqual(['run-1']);
    expect(reader.loadProcess(REF).records.map(({ id }) => id)).toEqual(
      records.map(({ id }) => id),
    );
    expect(reader.query.queryRecords(REF).records.map(({ id }) => id)).toEqual(
      records.map(({ id }) => id),
    );
  });

  it('should list a process with an unreadable process.json that the query list refuses', async () => {
    const { reader, dataDir } = await seeded();
    fs.writeFileSync(processPaths(dataDir, REF).manifest, '{');

    expect(reader.list(PROJECT)).toEqual(['run-1']);
    expect(captureError(() => reader.query.list({ project: PROJECT }))).toMatchObject({
      code: 'PROCESS_CORRUPTED',
    });
  });
});
