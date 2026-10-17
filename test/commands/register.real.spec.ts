import * as fs from 'node:fs';
import { afterEach, describe, expect, it, jest } from '@jest/globals';
import { processPaths } from '../../src/adapters/fs/data-format.ts';
import { MAX_LOG_BYTES } from '../../src/adapters/fs/process-store.ts';
import { compose, composeReader } from '../../src/compose.ts';
import type { RecordType } from '../../src/domain/definitions.ts';
import type { BatchItem } from '../../src/domain/record.ts';
import { at, createTempDir, rejectionOf, scriptWrites } from '../helpers.ts';
import { AUTHOR, DOC, NOTE, NOW, PROJECT, note, refusal } from './register-fakes.ts';

/** Os serviços da composição real, num diretório de dados temporário. */
function realSetup() {
  const dataDir = createTempDir('register-real');
  const { services } = compose({
    dataDir,
    cwd: dataDir,
    clock: () => NOW,
    logger: () => undefined,
  });
  const { loadProcess } = composeReader({ dataDir, cwd: dataDir, logger: () => undefined });
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

describe('register', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  describe('with the real adapters', () => {
    it('should write a verifiable line, with a relation to another process and a real attachment', async () => {
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

    it('should refuse a batch with invalid records with the first violation of each one and write nothing', async () => {
      const { services, register, logOf, verified } = realSetup();
      services.process.createProcess({ project: PROJECT, process: 'run-1' });
      const sizeBefore = fs.statSync(logOf('run-1')).size;

      const error = await refusal(
        register('run-1', [
          note('ok'),
          { ...note('a'), data: { text: 5 } },
          { ...note('b'), data: { other: 1 } },
        ]),
      );

      expect(error.code).toBe('INVALID_RECORD');
      expect(error.details).toHaveLength(2);
      expect(error.details[0]).toMatchObject({ path: '/records/1/data/text', code: 'type' });
      expect(error.details[1]!.path).toMatch(/^\/records\/2\/data/);
      expect(fs.statSync(logOf('run-1')).size).toBe(sizeBefore);
      expect(verified('run-1').chain).toMatchObject({ ok: true, totalRecords: 0 });
    });

    it('should cut details at 50 and say what it omitted for a batch with many errors, writing nothing', async () => {
      const { services, register, logOf } = realSetup();
      // `anyOf` de 3 ramos gera 2 details por registro (60 em 30 registros): passa do teto de 50.
      const branch: RecordType = {
        type: 'object',
        properties: { a: { type: 'string' } },
        required: ['a'],
      };
      services.definition.defineType({
        project: PROJECT,
        name: 'pick',
        schema: { type: 'object', anyOf: [branch, branch, branch] },
      });
      services.process.createProcess({ project: PROJECT, process: 'run-1' });
      const sizeBefore = fs.statSync(logOf('run-1')).size;

      const error = await refusal(
        register(
          'run-1',
          Array.from({ length: 30 }, () => ({ type: 'pick', target: 'run.step', data: {} })),
        ),
      );
      const indexes = error.details
        .slice(0, 50)
        .map((detail) => Number(/^\/records\/(\d+)\//.exec(detail.path)?.[1]));

      expect(error.code).toBe('INVALID_RECORD');
      expect(error.details).toHaveLength(51);
      expect(error.details.at(-1)).toEqual({
        path: '',
        code: 'too-many-errors',
        message: '10 more errors omitted',
      });
      expect(indexes).toEqual([...indexes].sort((a, b) => a - b));
      expect(fs.statSync(logOf('run-1')).size).toBe(sizeBefore);
    });

    it('should refuse the batch with PROCESS_TOO_LARGE when the log is above the cap at read', async () => {
      const { services, register, logOf } = realSetup();
      services.process.createProcess({ project: PROJECT, process: 'run-1' });
      fs.truncateSync(logOf('run-1'), MAX_LOG_BYTES + 1);

      const error = await refusal(register('run-1', [note()]));

      expect(error).toMatchObject({ code: 'PROCESS_TOO_LARGE', details: [{ code: 'too-large' }] });
    });

    it('should refuse with PROCESS_TOO_LARGE at the batch veto, leaving the log as it was', async () => {
      const { services, register, logOf } = realSetup();
      services.process.createProcess({ project: PROJECT, process: 'run-1' });
      fs.truncateSync(logOf('run-1'), MAX_LOG_BYTES - 10);
      const sizeBefore = fs.statSync(logOf('run-1')).size;

      const tooLarge = await refusal(register('run-1', [note()]));

      expect(tooLarge.code).toBe('PROCESS_TOO_LARGE');
      expect(fs.statSync(logOf('run-1')).size).toBe(sizeBefore);
    });

    it('should give the violation of a batch with a violation even near the cap, leaving the log as it was', async () => {
      const { services, register, logOf } = realSetup();
      services.process.createProcess({ project: PROJECT, process: 'run-1' });
      fs.truncateSync(logOf('run-1'), MAX_LOG_BYTES - 10);
      const sizeBefore = fs.statSync(logOf('run-1')).size;

      const violation = await refusal(
        register('run-1', [
          note('a', {
            relations: [{ to: 'run-1:00000000-0000-7000-8000-000000000999', kind: 'supports' }],
          }),
        ]),
      );

      expect(violation.code).toBe('RELATION_NOT_FOUND');
      expect(fs.statSync(logOf('run-1')).size).toBe(sizeBefore);
    });

    it('should write the resend of the same key over a torn tail, neither replayed nor broken-chain', async () => {
      const { services, register, logOf, verified } = realSetup();
      services.process.createProcess({ project: PROJECT, process: 'run-1' });
      await register('run-1', [note('a')], 'k0');
      await register('run-1', [note('b')], 'k1');
      const [lineA, lineB] = fs.readFileSync(logOf('run-1'), 'utf8').split('\n');
      fs.writeFileSync(logOf('run-1'), `${lineA}\n${lineB?.slice(0, 60)}`);

      const resent = await register('run-1', [note('b')], 'k1');

      expect(resent.replayed).toBe(false);
      expect(verified('run-1').chain).toMatchObject({
        ok: true,
        totalRecords: 2,
        repairedLines: [1],
      });
    });

    it('should write the next batch with a new key after the resend over a torn tail', async () => {
      const { services, register, logOf, verified } = realSetup();
      services.process.createProcess({ project: PROJECT, process: 'run-1' });
      await register('run-1', [note('a')], 'k0');
      await register('run-1', [note('b')], 'k1');
      const [lineA, lineB] = fs.readFileSync(logOf('run-1'), 'utf8').split('\n');
      fs.writeFileSync(logOf('run-1'), `${lineA}\n${lineB?.slice(0, 60)}`);
      await register('run-1', [note('b')], 'k1');

      const next = await register('run-1', [note('c')], 'k2');

      expect(next.replayed).toBe(false);
      expect(verified('run-1').chain).toMatchObject({
        ok: true,
        totalRecords: 3,
        repairedLines: [1],
      });
    });

    it('should fail with IO_ERROR without the path on a short write and ENOSPC (P9)', async () => {
      const { dataDir, services, register } = realSetup();
      services.process.createProcess({ project: PROJECT, process: 'run-1' });
      const batch = [note('a'), note('b'), note('c')];
      scriptWrites([100, 'enospc'], dataDir);

      const error = await rejectionOf(register('run-1', batch, 'k'), dataDir);

      expect(error).toMatchObject({
        code: 'IO_ERROR',
        details: [{ path: '', code: 'enospc', message: 'I/O failure' }],
      });
    });

    it('should write the resend with the same key after a short write and ENOSPC, closing the chain (P9)', async () => {
      const { dataDir, services, register, verified } = realSetup();
      services.process.createProcess({ project: PROJECT, process: 'run-1' });
      const batch = [note('a'), note('b'), note('c')];
      scriptWrites([100, 'enospc'], dataDir);
      await rejectionOf(register('run-1', batch, 'k'), dataDir);

      const resent = await register('run-1', batch, 'k');

      expect(resent.replayed).toBe(false);
      expect(verified('run-1').chain).toMatchObject({ ok: true, totalRecords: 3 });
    });

    it('should fail with IO_ERROR in the uncertain case where everything but the newline was written, leaving the batch already visible (P9)', async () => {
      const { dataDir, services, register, verified } = realSetup();
      services.process.createProcess({ project: PROJECT, process: 'run-1' });
      const batch = [note('a'), note('b'), note('c')];
      scriptWrites([-1, 'enospc'], dataDir);

      const error = await rejectionOf(register('run-1', batch, 'k'), dataDir);
      const visible = verified('run-1');

      expect(error).toMatchObject({ code: 'IO_ERROR', details: [{ code: 'enospc' }] });
      expect(visible.chain).toMatchObject({ ok: true, totalRecords: 3 });
    });

    it('should return replayed with the same ids on the resend in the uncertain case, since the batch is already visible (P9)', async () => {
      const { dataDir, services, register, verified } = realSetup();
      services.process.createProcess({ project: PROJECT, process: 'run-1' });
      const batch = [note('a'), note('b'), note('c')];
      scriptWrites([-1, 'enospc'], dataDir);
      await rejectionOf(register('run-1', batch, 'k'), dataDir);
      const visible = verified('run-1');

      const resent = await register('run-1', batch, 'k');

      expect(resent.replayed).toBe(true);
      expect(resent.records.map(({ id }) => id)).toEqual(visible.records.map(({ id }) => id));
    });
  });
});
