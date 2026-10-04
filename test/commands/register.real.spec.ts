import * as fs from 'node:fs';
import { afterEach, describe, expect, jest, test } from '@jest/globals';
import { processPaths } from '../../src/adapters/fs/data-format.ts';
import { MAX_LOG_BYTES } from '../../src/adapters/fs/process-store.ts';
import { compose } from '../../src/compose.ts';
import type { BatchItem } from '../../src/domain/record.ts';
import { at, createTempDir, rejectionOf, scriptWrites } from '../helpers.ts';
import { AUTHOR, DOC, NOTE, NOW, PROJECT, note, refusal } from './register-fakes.ts';

afterEach(() => {
  jest.restoreAllMocks();
});

/** Os serviços da composição real, num diretório de dados temporário. */
function realSetup() {
  const dataDir = createTempDir('register-real');
  const { services, loadProcess } = compose({
    dataDir,
    cwd: dataDir,
    clock: () => NOW,
    logger: () => undefined,
  });
  services.definition.defineType({ project: PROJECT, name: 'note', schema: NOTE });
  services.definition.defineType({ project: PROJECT, name: 'doc', schema: DOC });
  services.definition.defineRelation({ project: PROJECT, name: 'approves', kind: 'supports' });
  const register = (process: string, records: BatchItem[], key?: string) =>
    services.process.register({
      project: PROJECT,
      process,
      author: AUTHOR,
      records,
      ...(key === undefined ? {} : { key }),
    });
  const logOf = (process: string) => processPaths(dataDir, { project: PROJECT, process }).log;
  const verified = (process: string) => loadProcess({ project: PROJECT, process });
  return { dataDir, services, register, logOf, verified };
}

describe('register sobre os adaptadores reais', () => {
  test('grava uma linha verificável, com relação a outro processo e anexo reais', async () => {
    const { services, register, verified } = realSetup();
    services.process.createProcess({ project: PROJECT, process: 'run-1' });
    services.process.createProcess({ project: PROJECT, process: 'run-2' });
    const { hash } = services.attachment.attach({ project: PROJECT, text: 'conteúdo do anexo' });
    const target = await register('run-2', [note('destino')]);

    const result = await register('run-1', [
      { type: 'doc', target: 'run.doc', data: { body: hash } },
      note('apoio', { relations: [{ to: at(target.records, 0).id, as: 'approves' }] }),
    ]);

    const { chain, records } = verified('run-1');
    expect(chain).toMatchObject({ ok: true, totalRecords: 2 });
    expect(records.map(({ id }) => id)).toEqual(result.records.map(({ id }) => id));
    expect(records[1]?.relations).toEqual([
      { kind: 'supports', to: at(target.records, 0).id, as: 'approves' },
    ]);
  });

  test('PROCESS_TOO_LARGE na leitura: log acima do teto recusa o lote', async () => {
    const { services, register, logOf } = realSetup();
    services.process.createProcess({ project: PROJECT, process: 'run-1' });
    fs.truncateSync(logOf('run-1'), MAX_LOG_BYTES + 1);

    const error = await refusal(register('run-1', [note()]));

    expect(error).toMatchObject({ code: 'PROCESS_TOO_LARGE', details: [{ code: 'too-large' }] });
  });

  test('PROCESS_TOO_LARGE no veto do lote: o log fica como estava e o lote com violação dá a violação', async () => {
    const { services, register, logOf } = realSetup();
    services.process.createProcess({ project: PROJECT, process: 'run-1' });
    fs.truncateSync(logOf('run-1'), MAX_LOG_BYTES - 10);
    const sizeBefore = fs.statSync(logOf('run-1')).size;

    const tooLarge = await refusal(register('run-1', [note()]));
    const violation = await refusal(
      register('run-1', [
        note('a', {
          relations: [{ to: 'run-1:00000000-0000-7000-8000-000000000999', kind: 'supports' }],
        }),
      ]),
    );

    expect(tooLarge.code).toBe('PROCESS_TOO_LARGE');
    expect(violation.code).toBe('RELATION_NOT_FOUND');
    expect(fs.statSync(logOf('run-1')).size).toBe(sizeBefore);
  });

  test('chave: sobre cauda rasgada o reenvio da mesma key grava, não é replayed nem broken-chain', async () => {
    const { services, register, logOf, verified } = realSetup();
    services.process.createProcess({ project: PROJECT, process: 'run-1' });
    await register('run-1', [note('a')], 'k0');
    await register('run-1', [note('b')], 'k1');
    const [lineA, lineB] = fs.readFileSync(logOf('run-1'), 'utf8').split('\n');
    fs.writeFileSync(logOf('run-1'), `${lineA}\n${lineB?.slice(0, 60)}`);

    const chainOf = () => verified('run-1').chain;

    const resent = await register('run-1', [note('b')], 'k1');
    expect(resent.replayed).toBe(false);
    expect(chainOf()).toMatchObject({ ok: true, totalRecords: 2, repairedLines: [1] });

    const next = await register('run-1', [note('c')], 'k2');
    expect(next.replayed).toBe(false);
    expect(chainOf()).toMatchObject({ ok: true, totalRecords: 3, repairedLines: [1] });
  });

  test('P9: escrita curta e ENOSPC dão IO_ERROR sem caminho, o reenvio com a mesma key grava e a cadeia fecha', async () => {
    const { dataDir, services, register, verified } = realSetup();
    services.process.createProcess({ project: PROJECT, process: 'run-1' });
    const batch = [note('a'), note('b'), note('c')];
    scriptWrites([100, 'enospc'], dataDir);

    const error = await rejectionOf(register('run-1', batch, 'k'), dataDir);
    const resent = await register('run-1', batch, 'k');

    expect(error).toMatchObject({
      code: 'IO_ERROR',
      details: [{ path: '', code: 'enospc', message: 'I/O failure' }],
    });
    expect(resent.replayed).toBe(false);
    expect(verified('run-1').chain).toMatchObject({ ok: true, totalRecords: 3 });
  });

  test('P9 incerto: tudo menos o \\n e ENOSPC dão IO_ERROR, o lote já é visível e o reenvio devolve replayed com os mesmos ids', async () => {
    const { dataDir, services, register, verified } = realSetup();
    services.process.createProcess({ project: PROJECT, process: 'run-1' });
    const batch = [note('a'), note('b'), note('c')];
    scriptWrites([-1, 'enospc'], dataDir);

    const error = await rejectionOf(register('run-1', batch, 'k'), dataDir);
    const visible = verified('run-1');
    const resent = await register('run-1', batch, 'k');

    expect(error).toMatchObject({ code: 'IO_ERROR', details: [{ code: 'enospc' }] });
    expect(visible.chain).toMatchObject({ ok: true, totalRecords: 3 });
    expect(resent.replayed).toBe(true);
    expect(resent.records.map(({ id }) => id)).toEqual(visible.records.map(({ id }) => id));
  });
});
