import * as fs from 'node:fs';
import { describe, expect, test } from '@jest/globals';
import { createAttachmentStore } from '../../src/adapters/fs/attachment-store.ts';
import { createDefinitionStore } from '../../src/adapters/fs/definition-store.ts';
import { processPaths } from '../../src/adapters/fs/data-format.ts';
import { createProcessStore, MAX_LOG_BYTES } from '../../src/adapters/fs/process-store.ts';
import { createValidator } from '../../src/adapters/validator.ts';
import { createProcessService } from '../../src/commands/process.ts';
import type { BatchItem } from '../../src/domain/record.ts';
import { verifyProcess } from '../../src/shared/loader.ts';
import { at, createTempDir } from '../helpers.ts';
import { AUTHOR, DOC, NOTE, NOW, PROJECT, createUuids, note, refusal } from './register-fakes.ts';

/** Os serviços sobre os adaptadores de disco de verdade, num diretório de dados temporário. */
function realSetup() {
  const dataDir = createTempDir('register-real');
  const store = createProcessStore({ dataDir, log: () => undefined });
  const definitions = createDefinitionStore({ dataDir });
  const attachments = createAttachmentStore({ dataDir, cwd: dataDir });
  const service = createProcessService({
    store,
    definitions,
    attachments,
    validator: createValidator(),
    clock: () => NOW,
    newUuid: createUuids(),
  });
  definitions.write(PROJECT, 'types', 'note', '1.0', NOTE);
  definitions.write(PROJECT, 'types', 'doc', '1.0', DOC);
  definitions.write(PROJECT, 'relations', 'approves', '1.0', {
    name: 'approves',
    kind: 'supports',
  });
  const register = (process: string, records: BatchItem[], key?: string) =>
    service.register({
      project: PROJECT,
      process,
      author: AUTHOR,
      records,
      ...(key === undefined ? {} : { key }),
    });
  const logOf = (process: string) => processPaths(dataDir, { project: PROJECT, process }).log;
  return { service, store, attachments, register, logOf };
}

describe('register sobre os adaptadores reais', () => {
  test('grava uma linha verificável, com relação a outro processo e anexo reais', async () => {
    const { service, store, attachments, register } = realSetup();
    service.createProcess({ project: PROJECT, process: 'run-1' });
    service.createProcess({ project: PROJECT, process: 'run-2' });
    const { hash } = attachments.putText(PROJECT, 'conteúdo do anexo');
    const target = await register('run-2', [note('destino')]);

    const result = await register('run-1', [
      { type: 'doc', target: 'run.doc', data: { body: hash } },
      note('apoio', { relations: [{ to: at(target.records, 0).id, as: 'approves' }] }),
    ]);

    const verified = verifyProcess(store.read({ project: PROJECT, process: 'run-1' }));
    expect(verified.chain).toMatchObject({ ok: true, totalRecords: 2 });
    expect(verified.records.map(({ id }) => id)).toEqual(result.records.map(({ id }) => id));
    expect(verified.records[1]?.relations).toEqual([
      { kind: 'supports', to: at(target.records, 0).id, as: 'approves' },
    ]);
  });

  test('chave: o replay devolve o lote sem mudar os bytes do log', async () => {
    const { service, register, logOf } = realSetup();
    service.createProcess({ project: PROJECT, process: 'run-1' });
    const original = await register('run-1', [note('a')], 'k');
    const before = fs.readFileSync(logOf('run-1'), 'utf8');

    const again = await register('run-1', [note('a')], 'k');

    expect(again).toEqual({ ...original, replayed: true });
    expect(fs.readFileSync(logOf('run-1'), 'utf8')).toBe(before);
  });

  test('PROCESS_TOO_LARGE na leitura: log acima do teto recusa o lote', async () => {
    const { service, register, logOf } = realSetup();
    service.createProcess({ project: PROJECT, process: 'run-1' });
    fs.truncateSync(logOf('run-1'), MAX_LOG_BYTES + 1);

    const error = await refusal(register('run-1', [note()]));

    expect(error).toMatchObject({ code: 'PROCESS_TOO_LARGE', details: [{ code: 'too-large' }] });
  });

  test('PROCESS_TOO_LARGE no veto do lote: o log fica como estava e o lote com violação dá a violação', async () => {
    const { service, register, logOf } = realSetup();
    service.createProcess({ project: PROJECT, process: 'run-1' });
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
});
