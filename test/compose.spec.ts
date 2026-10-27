import * as fs from 'node:fs';
import * as path from 'node:path';
import { afterEach, describe, expect, it, jest } from '@jest/globals';
import MiniSearch from 'minisearch';
import { compose, composeReader } from '../src/compose.ts';
import { processPaths } from '../src/adapters/fs/data-format.ts';
import type { Logger } from '../src/shared/logger.ts';
import { captureError, createTempDir } from './helpers.ts';
import { AUTHOR, NOTE, NOW, PROJECT, note } from './commands/register-fakes.ts';

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
