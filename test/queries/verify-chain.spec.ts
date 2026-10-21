import fs from 'node:fs';
import { describe, expect, test } from '@jest/globals';
import { omit } from 'es-toolkit';
import { blobFile, processPaths } from '../../src/adapters/fs/data-format.ts';
import type { Hash } from '../../src/domain/ids.ts';
import type { BatchItem } from '../../src/domain/record.ts';
import { MAX_BREAKS } from '../../src/shared/loader.ts';
import { note } from '../commands/register-fakes.ts';
import { captureError } from '../helpers.ts';
import { PROJECT, querySetup } from './query-setup.ts';

function verifySetup() {
  const setup = querySetup();
  setup.createProcess('run-1');
  const verify = (process = 'run-1') => setup.queries.verifyChain({ project: PROJECT, process });
  const verifyAgainst = (expectedHead: Hash) =>
    setup.queries.verifyChain({ project: PROJECT, process: 'run-1', expectedHead });
  const logFile = () => setup.logPath('run-1');
  const blobOf = (hash: Hash) => blobFile(setup.dataDir, PROJECT, hash);
  const stored = (text: string): Hash => setup.attachments.putText(PROJECT, text).hash;
  const doc = (data: BatchItem['data']): BatchItem => ({
    type: 'doc',
    target: 'run.doc',
    data,
  });
  return { ...setup, verify, verifyAgainst, logFile, blobOf, stored, doc };
}

describe('verifyChain: process chain', () => {
  test('intact process gives ok, the count and the head, with no break or repaired line', async () => {
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

  test('process with no records gives ok, totalRecords 0 and the process anchor as head', () => {
    expect(verifySetup().verify()).toMatchObject({
      ok: true,
      totalRecords: 0,
      head: expect.stringMatching(/^[0-9a-f]{64}$/),
    });
  });

  test('diagnoses without writing: the log stays byte for byte identical, also with a break', async () => {
    const { registerOne, verify, logFile, tamper } = verifySetup();
    await registerOne('run-1', note('a'));
    await registerOne('run-1', note('b'), 1);
    tamper('run-1');
    const before = fs.readFileSync(logFile());

    verify();

    expect(fs.readFileSync(logFile()).equals(before)).toBe(true);
  });

  test('tampered line does not throw: becomes ok false with the break on the next line', async () => {
    const { registerOne, verify, tamper } = verifySetup();
    await registerOne('run-1', note('a'));
    await registerOne('run-1', note('b'), 1);
    tamper('run-1');

    const result = verify();

    expect(result.ok).toBe(false);
    expect(result.totalBreaks).toBeGreaterThan(0);
    expect(result.breaks[0]).toMatchObject({ index: 1 });
  });

  test('torn line followed by a valid line is repaired: shows up in repairedLines and does not break', async () => {
    const { registerOne, verify, logFile } = verifySetup();
    await registerOne('run-1', note('a'));
    fs.appendFileSync(logFile(), '{"links":[{\n');
    await registerOne('run-1', note('b'), 1);

    expect(verify()).toMatchObject({ ok: true, totalRecords: 2, repairedLines: [1] });
  });

  test('unknown process is PROCESS_NOT_FOUND', () => {
    expect(captureError(() => verifySetup().verify('ghost')).code).toBe('PROCESS_NOT_FOUND');
  });
});

describe('verifyChain: lineageInheritance in the anchor', () => {
  const withoutFlag = (dataDir: string) => {
    const file = processPaths(dataDir, { project: PROJECT, process: 'run-1' }).manifest;
    const manifest = JSON.parse(fs.readFileSync(file, 'utf8')) as Record<string, unknown>;
    fs.writeFileSync(file, JSON.stringify(omit(manifest, ['lineageInheritance'])));
  };

  test('removing the flag from a new process manifest breaks the chain', async () => {
    const { dataDir, registerOne, verify } = verifySetup();
    await registerOne('run-1', note('a'));
    expect(verify().ok).toBe(true);

    withoutFlag(dataDir);

    expect(verify().ok).toBe(false);
  });

  test('a manifest without the flag keeps verifying', async () => {
    const { dataDir, registerOne, verify } = verifySetup();
    withoutFlag(dataDir);
    await registerOne('run-1', note('a'));

    expect(verify()).toMatchObject({ ok: true, totalRecords: 1 });
  });
});

describe('verifyChain: expectedHead as an anchor against truncation', () => {
  /** Reescreve o log sem as últimas `count` linhas, como quem apaga a cauda. */
  function dropLastLines(file: string, count: number) {
    const lines = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean);
    fs.writeFileSync(
      file,
      lines
        .slice(0, -count)
        .map((line) => `${line}\n`)
        .join(''),
    );
  }

  test('the head of the last link passes, and so does that of an earlier link after the log grows', async () => {
    const { registerOne, verify, verifyAgainst } = verifySetup();
    await registerOne('run-1', note('a'));
    const early = verify().head;
    await registerOne('run-1', note('b'), 1);
    const late = verify().head;

    expect(verifyAgainst(late)).toMatchObject({ ok: true, breaks: [], totalBreaks: 0 });
    expect(verifyAgainst(early)).toMatchObject({ ok: true, breaks: [], totalBreaks: 0 });
  });

  test('only link deleted: the earlier head becomes head-not-found with totalRecords 0', async () => {
    const { registerOne, verify, verifyAgainst, logFile } = verifySetup();
    await registerOne('run-1', note('a'));
    const before = verify().head;
    dropLastLines(logFile(), 1);

    expect(verifyAgainst(before)).toMatchObject({
      ok: false,
      totalRecords: 0,
      breaks: [{ index: 0, reason: 'head-not-found' }],
    });
  });

  test('tail deleted: without expectedHead it stays ok, with the earlier head it becomes head-not-found', async () => {
    const { registerOne, verify, verifyAgainst, logFile } = verifySetup();
    await registerOne('run-1', note('a'));
    await registerOne('run-1', note('b'), 1);
    const before = verify().head;
    dropLastLines(logFile(), 1);

    expect(verify()).toMatchObject({ ok: true, totalRecords: 1 });
    expect(verifyAgainst(before)).toMatchObject({
      ok: false,
      totalRecords: 1,
      breaks: [{ index: 1, reason: 'head-not-found' }],
      totalBreaks: 1,
    });
  });

  test('the break comes after the chain breaks and respects the breaks cap', async () => {
    const { registerOne, verifyAgainst, logFile } = verifySetup();
    await registerOne('run-1', note('a'));
    fs.appendFileSync(logFile(), '{}\n'.repeat(MAX_BREAKS + 1));

    const result = verifyAgainst('0'.repeat(64));

    expect(result.ok).toBe(false);
    expect(result.breaks).toHaveLength(MAX_BREAKS);
    expect(result.breaks.map(({ reason }) => reason)).not.toContain('head-not-found');
    expect(result.totalBreaks).toBe(MAX_BREAKS + 2);
  });
});

describe('verifyChain: cited attachments (D-16)', () => {
  test('intact attachment does not break', async () => {
    const { registerOne, doc, stored, verify } = verifySetup();
    await registerOne('run-1', doc({ body: stored('texto') }));

    expect(verify()).toMatchObject({
      ok: true,
      breaks: [],
      totalBreaks: 0,
      attachmentBreaks: [],
      totalAttachmentBreaks: 0,
    });
  });

  test('missing attachment becomes an attachment-missing break and corrupted attachment, attachment-corrupted', async () => {
    const { registerOne, doc, stored, blobOf, verify } = verifySetup();
    const gone = stored('sumiu');
    const bad = stored('adulterado');
    const record = await registerOne('run-1', doc({ body: gone, files: [bad] }));
    fs.rmSync(blobOf(gone));
    fs.writeFileSync(blobOf(bad), 'outro conteúdo');

    const result = verify();

    expect(result.ok).toBe(false);
    expect(result).toMatchObject({ breaks: [], totalBreaks: 0, totalAttachmentBreaks: 2 });
    expect(result.attachmentBreaks).toEqual([
      { id: record, hash: gone, reason: 'attachment-missing' },
      { id: record, hash: bad, reason: 'attachment-corrupted' },
    ]);
  });

  test('chain break and missing attachment come out in separate lists, each with its own total', async () => {
    const { registerOne, doc, stored, blobOf, verify, tamper } = verifySetup();
    const gone = stored('sumiu');
    const record = await registerOne('run-1', doc({ body: gone }));
    await registerOne('run-1', note('a'), 1);
    await registerOne('run-1', note('b'), 2);
    fs.rmSync(blobOf(gone));
    tamper('run-1');

    const result = verify();

    expect(result.ok).toBe(false);
    expect(result.breaks.map((entry) => entry.reason)).toContain('hash-mismatch');
    expect(result.totalBreaks).toBe(result.breaks.length);
    expect(result.attachmentBreaks).toEqual([
      { id: record, hash: gone, reason: 'attachment-missing' },
    ]);
    expect(result.totalAttachmentBreaks).toBe(1);
  });

  test('with the chain already at the breaks cap, the attachment break still shows up in its list', async () => {
    const { registerOne, doc, stored, blobOf, verify, logFile } = verifySetup();
    const gone = stored('sumiu');
    await registerOne('run-1', doc({ body: gone }));
    fs.rmSync(blobOf(gone));
    // Cada linha com JSON válido e sem `links` é uma quebra `invalid-line`.
    fs.appendFileSync(logFile(), '{}\n'.repeat(MAX_BREAKS + 1));

    const result = verify();

    expect(result.breaks).toHaveLength(MAX_BREAKS);
    expect(result.totalBreaks).toBe(MAX_BREAKS + 1);
    expect(result.attachmentBreaks).toHaveLength(1);
    expect(result.totalAttachmentBreaks).toBe(1);
  });

  test('more attachment breaks than the cap are cut at the cap, with the right total', async () => {
    const { registerOne, doc, stored, blobOf, verify } = verifySetup();
    const hashes = Array.from({ length: MAX_BREAKS + 1 }, (_, n) => stored(`anexo ${n}`));
    await registerOne('run-1', doc({ files: hashes }));
    for (const hash of hashes) fs.rmSync(blobOf(hash));

    const result = verify();

    expect(result.ok).toBe(false);
    expect(result.attachmentBreaks).toHaveLength(MAX_BREAKS);
    expect(result.totalAttachmentBreaks).toBe(MAX_BREAKS + 1);
  });
});
