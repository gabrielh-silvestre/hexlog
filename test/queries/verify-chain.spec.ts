import fs from 'node:fs';
import { describe, expect, it } from '@jest/globals';
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

describe('QueryService.verifyChain', () => {
  it('should give ok, the count and the head, with no break or repaired line, for an intact process', async () => {
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

  it('should give ok, totalRecords 0 and the process anchor as head for a process with no records', () => {
    const { verify } = verifySetup();

    expect(verify()).toMatchObject({
      ok: true,
      totalRecords: 0,
      head: expect.stringMatching(/^[0-9a-f]{64}$/),
    });
  });

  it('should diagnose without writing: the log stays byte for byte identical, also with a break', async () => {
    const { registerOne, verify, logFile, tamper } = verifySetup();
    await registerOne('run-1', note('a'));
    await registerOne('run-1', note('b'), 1);
    tamper('run-1');
    const before = fs.readFileSync(logFile());

    verify();

    expect(fs.readFileSync(logFile()).equals(before)).toBe(true);
  });

  it('should not throw on a tampered line: it becomes ok false with the break on the next line', async () => {
    const { registerOne, verify, tamper } = verifySetup();
    await registerOne('run-1', note('a'));
    await registerOne('run-1', note('b'), 1);
    tamper('run-1');

    const result = verify();

    expect(result.ok).toBe(false);
    expect(result.totalBreaks).toBeGreaterThan(0);
    expect(result.breaks[0]).toMatchObject({ index: 1 });
  });

  it('should repair a torn line followed by a valid line: it shows up in repairedLines and does not break', async () => {
    const { registerOne, verify, logFile } = verifySetup();
    await registerOne('run-1', note('a'));
    fs.appendFileSync(logFile(), '{"links":[{\n');
    await registerOne('run-1', note('b'), 1);

    expect(verify()).toMatchObject({ ok: true, totalRecords: 2, repairedLines: [1] });
  });

  it('should refuse an unknown process with PROCESS_NOT_FOUND', () => {
    const { verify } = verifySetup();

    expect(captureError(() => verify('ghost')).code).toBe('PROCESS_NOT_FOUND');
  });

  describe('with the lineageInheritance flag in the anchor', () => {
    const withoutFlag = (dataDir: string) => {
      const file = processPaths(dataDir, { project: PROJECT, process: 'run-1' }).manifest;
      const manifest = JSON.parse(fs.readFileSync(file, 'utf8')) as Record<string, unknown>;
      fs.writeFileSync(file, JSON.stringify(omit(manifest, ['lineageInheritance'])));
    };

    it('should verify a new process manifest that carries the flag', async () => {
      const { registerOne, verify } = verifySetup();
      await registerOne('run-1', note('a'));

      expect(verify().ok).toBe(true);
    });

    it('should break the chain when the flag is removed from a new process manifest', async () => {
      const { dataDir, registerOne, verify } = verifySetup();
      await registerOne('run-1', note('a'));
      verify();
      withoutFlag(dataDir);

      expect(verify().ok).toBe(false);
    });

    it('should keep verifying a manifest without the flag', async () => {
      const { dataDir, registerOne, verify } = verifySetup();
      withoutFlag(dataDir);
      await registerOne('run-1', note('a'));

      expect(verify()).toMatchObject({ ok: true, totalRecords: 1 });
    });
  });

  describe('with expectedHead as an anchor against truncation', () => {
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

    it('should accept the head of any link, the last one or an earlier one after the log grows', async () => {
      const { registerOne, verify, verifyAgainst } = verifySetup();
      await registerOne('run-1', note('a'));
      const early = verify().head;
      await registerOne('run-1', note('b'), 1);
      const late = verify().head;

      expect(verifyAgainst(late)).toMatchObject({ ok: true, breaks: [], totalBreaks: 0 });
      expect(verifyAgainst(early)).toMatchObject({ ok: true, breaks: [], totalBreaks: 0 });
    });

    it('should turn the earlier head into head-not-found with totalRecords 0 when the only link is deleted', async () => {
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

    it('should turn the earlier head into head-not-found when the tail is deleted, while it stays ok without expectedHead', async () => {
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

    it('should put the head-not-found break after the chain breaks and respect the breaks cap', async () => {
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

  describe('with cited attachments', () => {
    it('should not break on an intact attachment', async () => {
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

    it('should turn a missing attachment into attachment-missing and a corrupted one into attachment-corrupted', async () => {
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

    it('should list a chain break and a missing attachment separately, each with its own total', async () => {
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

    it('should still show the attachment break in its list when the chain is already at the breaks cap', async () => {
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

    it('should cut more attachment breaks than the cap at the cap, with the right total', async () => {
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
});
