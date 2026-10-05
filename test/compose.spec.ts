import * as fs from 'node:fs';
import * as path from 'node:path';
import { afterEach, describe, expect, jest, test } from '@jest/globals';
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

afterEach(() => {
  addAll.mockClear();
});

describe('compose', () => {
  test('monta os serviços de escrita e de consulta sobre os adaptadores reais', () => {
    const { services } = composed();

    expect(Object.keys(services).sort()).toEqual(['attachment', 'definition', 'process', 'query']);
  });

  test('duas consultas com text pelo query da composição indexam uma vez só', async () => {
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

  test('createProcess e register gravam uma linha e a mesma key devolve replayed', async () => {
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

    expect(first.replayed).toBe(false);
    expect(lines).toHaveLength(1);
    expect(again).toMatchObject({ replayed: true, records: first.records });
    expect(fs.readFileSync(logFile, 'utf8').trimEnd().split('\n')).toEqual(lines);
  });

  test('o segundo register com a mesma key emite batch-replayed pelo logger da composição', async () => {
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

  test('isLegacy é falso com o dataDir vazio e verdadeiro com layout 0.x', () => {
    const { isLegacy, dataDir } = composed();
    expect(isLegacy()).toBe(false);

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

  test('só expõe o lado de leitura, sobre o que compose gravou', async () => {
    const { reader, records } = await seeded();

    expect(Object.keys(reader).sort()).toEqual([
      'isLegacy',
      'list',
      'listProjects',
      'loadProcess',
      'query',
    ]);
    expect(reader.listProjects()).toEqual([PROJECT]);
    expect(reader.list(PROJECT)).toEqual(['run-1']);
    expect(reader.loadProcess(REF).records.map(({ id }) => id)).toEqual(
      records.map(({ id }) => id),
    );
    expect(reader.query.queryRecords(REF).records.map(({ id }) => id)).toEqual(
      records.map(({ id }) => id),
    );
  });

  test('list enumera o processo com process.json ilegível, que o list da consulta recusa', async () => {
    const { reader, dataDir } = await seeded();
    fs.writeFileSync(processPaths(dataDir, REF).manifest, '{');

    expect(reader.list(PROJECT)).toEqual(['run-1']);
    expect(captureError(() => reader.query.list({ project: PROJECT }))).toMatchObject({
      code: 'PROCESS_CORRUPTED',
    });
  });
});
