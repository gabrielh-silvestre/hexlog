import fs from 'node:fs';
import { describe, expect, test } from '@jest/globals';
import { blobFile, processPaths } from '../../src/adapters/fs/data-format.ts';
import type { Hash } from '../../src/domain/ids.ts';
import type { BatchItem } from '../../src/domain/record.ts';
import { note } from '../commands/register-fakes.ts';
import { captureError } from '../helpers.ts';
import { PROJECT, querySetup } from './query-setup.ts';

function verifySetup() {
  const setup = querySetup();
  setup.createProcess('run-1');
  const verify = (process = 'run-1') => setup.queries.verifyChain({ project: PROJECT, process });
  const logFile = () => processPaths(setup.dataDir, { project: PROJECT, process: 'run-1' }).log;
  const blobOf = (hash: Hash) => blobFile(setup.dataDir, PROJECT, hash);
  const stored = (text: string): Hash => setup.attachments.putText(PROJECT, text).hash;
  const doc = (data: BatchItem['data']): BatchItem => ({
    type: 'doc',
    target: 'run.doc',
    data,
  });
  return { ...setup, verify, logFile, blobOf, stored, doc };
}

describe('verifyChain: cadeia do processo', () => {
  test('processo íntegro dá ok, a contagem e a cabeça, sem quebra nem linha reparada', async () => {
    const { registerOne, verify } = verifySetup();
    await registerOne('run-1', note('a'));
    await registerOne('run-1', note('b'), 1);

    expect(verify()).toMatchObject({
      ok: true,
      totalRecords: 2,
      head: expect.stringMatching(/^[0-9a-f]{64}$/),
      breaks: [],
      totalBreaks: 0,
      repairedLines: [],
    });
  });

  test('processo sem registro dá ok com cabeça vazia', () => {
    expect(verifySetup().verify()).toMatchObject({ ok: true, totalRecords: 0, head: '' });
  });

  test('diagnostica sem gravar: o log fica byte a byte igual, também com quebra', async () => {
    const { registerOne, verify, logFile, tamper } = verifySetup();
    await registerOne('run-1', note('a'));
    await registerOne('run-1', note('b'), 1);
    tamper('run-1');
    const before = fs.readFileSync(logFile());

    verify();

    expect(fs.readFileSync(logFile()).equals(before)).toBe(true);
  });

  test('linha adulterada não lança: vira ok false com a quebra na linha seguinte', async () => {
    const { registerOne, verify, tamper } = verifySetup();
    await registerOne('run-1', note('a'));
    await registerOne('run-1', note('b'), 1);
    tamper('run-1');

    const result = verify();

    expect(result.ok).toBe(false);
    expect(result.totalBreaks).toBeGreaterThan(0);
    expect(result.breaks[0]).toMatchObject({ index: 1 });
  });

  test('linha rasgada seguida de linha válida é reparada: aparece em repairedLines e não quebra', async () => {
    const { registerOne, verify, logFile } = verifySetup();
    await registerOne('run-1', note('a'));
    fs.appendFileSync(logFile(), '{"links":[{\n');
    await registerOne('run-1', note('b'), 1);

    expect(verify()).toMatchObject({ ok: true, totalRecords: 2, repairedLines: [1] });
  });

  test('processo inexistente é PROCESS_NOT_FOUND', () => {
    expect(captureError(() => verifySetup().verify('ghost')).code).toBe('PROCESS_NOT_FOUND');
  });
});

describe('verifyChain: anexos citados (D-16)', () => {
  test('anexo íntegro não quebra', async () => {
    const { registerOne, doc, stored, verify } = verifySetup();
    await registerOne('run-1', doc({ body: stored('texto') }));

    expect(verify()).toMatchObject({ ok: true, breaks: [] });
  });

  test('anexo ausente vira quebra attachment-missing e anexo corrompido, attachment-corrupted', async () => {
    const { registerOne, doc, stored, blobOf, verify } = verifySetup();
    const gone = stored('sumiu');
    const bad = stored('adulterado');
    const record = await registerOne('run-1', doc({ body: gone, files: [bad] }));
    fs.rmSync(blobOf(gone));
    fs.writeFileSync(blobOf(bad), 'outro conteúdo');

    const result = verify();

    expect(result.ok).toBe(false);
    expect(result.totalBreaks).toBe(2);
    expect(result.breaks).toEqual([
      { id: record, hash: gone, reason: 'attachment-missing' },
      { id: record, hash: bad, reason: 'attachment-corrupted' },
    ]);
  });

  test('quebra da cadeia e anexo ausente somam no mesmo diagnóstico', async () => {
    const { registerOne, doc, stored, blobOf, verify, tamper } = verifySetup();
    const gone = stored('sumiu');
    await registerOne('run-1', doc({ body: gone }));
    await registerOne('run-1', note('a'), 1);
    await registerOne('run-1', note('b'), 2);
    fs.rmSync(blobOf(gone));
    tamper('run-1');

    const result = verify();

    expect(result.breaks.map((entry) => entry.reason)).toEqual(
      expect.arrayContaining(['hash-mismatch', 'attachment-missing']),
    );
    expect(result.totalBreaks).toBe(result.breaks.length);
  });
});
