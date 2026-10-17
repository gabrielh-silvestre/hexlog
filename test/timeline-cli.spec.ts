import { beforeAll, describe, expect, it } from '@jest/globals';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { blobFile, processPaths } from '../src/adapters/fs/data-format.ts';
import { sha256hex } from '../src/domain/chain.ts';
import { compose } from '../src/compose.ts';
import { escapeControls } from '../scripts/escape-controls.ts';
import { AUTHOR, DOC, NOW, PROJECT } from './commands/register-fakes.ts';
import { at, copyToXdg, createTempDir, snapshot } from './helpers.ts';

const repoRoot = path.resolve(__dirname, '..');
const legacyFixture = path.join(__dirname, 'fixtures', 'legacy-0x');
const TARGET = 'plan.f6';
const REVOKE_TARGET = 'revoke.case';

// texto grande (> 200 KB), com acentos, emoji, CRLF, BOM e NUL: tem que sair byte-idêntico
const BIG_TEXT = `\uFEFF${'Decisão — ação 😀\r\nlinha com NUL \u0000 no meio\n'.repeat(5_000)}`;
const SMALL_TEXT = 'relatório curto';

function runTimeline(xdg: string, ...args: string[]) {
  const result = spawnSync(process.execPath, ['scripts/timeline.ts', ...args], {
    cwd: repoRoot,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
    env: { ...process.env, XDG_DATA_HOME: xdg },
  });
  return { code: result.status, out: result.stdout, err: result.stderr };
}

type JsonRecord = {
  kind: string;
  target: string;
  id: string;
  in: { kind: string; from: string }[];
  attachmentText?: Record<string, string>;
};

const jsonRecords = (out: string): JsonRecord[] =>
  out
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line) as JsonRecord);

describe('scripts/timeline.ts', () => {
  let xdgHome: string;
  let ids: {
    first: string;
    second: string;
    other: string;
    superseder: string;
    unrelated: string;
    revoker: string;
  };
  let hashes: { big: string; small: string };

  // alpha: dois processos sob o mesmo target; o 3º registro de `first` supersede o 1º.
  beforeAll(async () => {
    const xdg = createTempDir('xdg');
    const dataDir = path.join(xdg, 'hexlog');
    fs.mkdirSync(dataDir);
    let now = NOW;
    const { services } = compose({ dataDir, cwd: xdg, clock: () => now, logger: () => undefined });
    services.definition.defineType({ project: PROJECT, name: 'doc', schema: DOC });
    services.process.createProcess({ project: PROJECT, process: 'first' });
    services.process.createProcess({ project: PROJECT, process: 'second' });

    hashes = {
      big: services.attachment.attach({ project: PROJECT, text: BIG_TEXT }).hash,
      small: services.attachment.attach({ project: PROJECT, text: SMALL_TEXT }).hash,
    };
    let seq = 0;
    const register = async (
      process: string,
      target: string,
      data: Record<string, string>,
      relations: { to: string; kind: 'supersedes' | 'revokes' }[] = [],
    ) => {
      now = new Date(NOW.getTime() + (seq += 1) * 1000);
      const { records } = await services.process.register({
        project: PROJECT,
        process,
        author: AUTHOR,
        key: `k${seq}`,
        records: [{ type: 'doc', target, data, relations }],
      });
      return at(records, 0).id;
    };
    const first = await register('first', TARGET, { note: 'grande', body: hashes.big });
    const second = await register('first', TARGET, { note: 'pequeno', body: hashes.small });
    const other = await register('second', `${TARGET}.sub`, { note: 'outro processo' });
    const superseder = await register('first', TARGET, { note: 'novo' }, [
      { to: first, kind: 'supersedes' },
    ]);
    const unrelated = await register('second', 'other.thing', { note: 'fora do target' });

    const revoked = await register('second', REVOKE_TARGET, { note: 'revogado' });
    const revoker = await register('second', REVOKE_TARGET, { note: 'revogador' }, [
      { to: revoked, kind: 'revokes' },
    ]);

    ids = { first, second, other, superseder, unrelated, revoker };
    xdgHome = xdg;
  });

  it('should print the attachment text contiguous and identical between the delimiters with --full --raw (≥ 200 KB)', () => {
    expect(BIG_TEXT.length).toBeGreaterThan(200_000);

    const header = `----- attachment ${hashes.big} (${Buffer.byteLength(BIG_TEXT, 'utf8')} bytes) -----\n`;

    const { code, out } = runTimeline(xdgHome, PROJECT, TARGET, '--full', '--raw');
    const start = out.indexOf(header);
    const body = out.slice(start + header.length, out.indexOf('\n----- end -----', start));

    expect(start).toBeGreaterThan(-1);
    expect(body).toBe(BIG_TEXT);
    expect(sha256hex(body)).toBe(hashes.big);
    expect(out).toContain(`----- attachment ${hashes.small} (`);
    expect(code).toBe(0);
  });

  describe('with only the project and the target', () => {
    let result: ReturnType<typeof runTimeline>;

    beforeAll(() => {
      result = runTimeline(xdgHome, PROJECT, TARGET);
    }, 15_000);

    it('should print the attachment hash and status, but not the text, without --full', () => {
      expect(result.out).not.toContain('-----');
      expect(result.out).toContain(`attachment: ${hashes.big} (ok)`);
      expect(result.code).toBe(0);
    });

    it('should list the records of both processes at project scope, marking the non-current one as [superseded by <id>]', () => {
      expect(result.out).toContain(`target ${TARGET}: 4 records`);

      for (const id of [ids.first, ids.second, ids.other, ids.superseder]) {
        expect(result.out).toContain(id);
      }

      expect(result.out).not.toContain(ids.unrelated);
      expect(result.out).toContain(`[superseded by ${ids.superseder}]`);
      expect(result.out).toContain(`out: supersedes -> ${ids.first}`);
      expect(result.code).toBe(0);
    });
  });

  describe('with terminal control characters in the record and its attachment', () => {
    // ESC, OSC 0, BEL, CSI C1, CR, RLO bidi, DEL; TAB e LF passam
    const HOSTILE = 'a\u001b]0;x\u0007b\u009bc\rd\u202ee\u007ff\tg\nh';
    let xdg: string;
    let hash: string;

    beforeAll(async () => {
      xdg = createTempDir('xdg');
      const dataDir = path.join(xdg, 'hexlog');
      fs.mkdirSync(dataDir);
      const { services } = compose({
        dataDir,
        cwd: xdg,
        clock: () => NOW,
        logger: () => undefined,
      });
      services.definition.defineType({ project: PROJECT, name: 'doc', schema: DOC });
      services.process.createProcess({ project: PROJECT, process: 'evil' });
      hash = services.attachment.attach({ project: PROJECT, text: HOSTILE }).hash;
      await services.process.register({
        project: PROJECT,
        process: 'evil',
        author: AUTHOR,
        key: 'evil',
        records: [
          { type: 'doc', target: TARGET, data: { note: HOSTILE, body: hash }, relations: [] },
        ],
      });
    });

    it('should print the text with control characters replaced by a visible \\uXXXX, and TAB and LF intact, without --raw', () => {
      const { code, out } = runTimeline(xdg, PROJECT, TARGET, '--full');

      expect(out).toContain('a\\u001b]0;x\\u0007b\\u009bc\\u000dd\\u202ee\\u007ff\tg\nh');
      expect(escapeControls(out)).toBe(out);
      expect(code).toBe(0);
    });

    it('should print the exact bytes, control characters included, with --raw', () => {
      const { code, out } = runTimeline(xdg, PROJECT, TARGET, '--full', '--raw');

      expect(out).toContain(
        `----- attachment ${hash} (${Buffer.byteLength(HOSTILE, 'utf8')} bytes) -----\n${HOSTILE}\n`,
      );
      expect(code).toBe(0);
    });

    it('should escape the 0x80-0x9f control and bidi characters that JSON.stringify leaves raw with --json, and JSON.parse should return the original', () => {
      const { code, out } = runTimeline(xdg, PROJECT, TARGET, '--full', '--json');

      expect(escapeControls(out)).toBe(out);
      expect(out).toContain('\\u009b');
      expect(at(jsonRecords(out), 0).attachmentText).toEqual({ [hash]: HOSTILE });
      expect(code).toBe(0);
    });
  });

  it('should mark a revoked record as [revoked by <id>]', () => {
    const { code, out } = runTimeline(xdgHome, PROJECT, REVOKE_TARGET);

    expect(out).toContain(`[revoked by ${ids.revoker}]`);
    expect(code).toBe(0);
  });

  it('should print one section per target when given more than one', () => {
    const { code, out } = runTimeline(xdgHome, PROJECT, TARGET, 'other.thing');

    expect(out).toContain(`target ${TARGET}: 4 records`);
    expect(out).toContain('target other.thing: 1 records');
    expect(code).toBe(0);
  });

  it('should escape an agent with a line break and ESC in the header, without forging a line or terminal control', async () => {
    const xdg = createTempDir('xdg');
    const dataDir = path.join(xdg, 'hexlog');
    fs.mkdirSync(dataDir);
    const { services } = compose({ dataDir, cwd: xdg, clock: () => NOW, logger: () => undefined });
    services.definition.defineType({ project: PROJECT, name: 'doc', schema: DOC });
    services.process.createProcess({ project: PROJECT, process: 'evil' });
    const agent = 'evil\n  target: ok.fake\u001b[31mRED';
    await services.process.register({
      project: PROJECT,
      process: 'evil',
      author: { ...AUTHOR, agent },
      key: 'evil',
      records: [{ type: 'doc', target: TARGET, data: { note: 'x' }, relations: [] }],
    });

    const { code, out } = runTimeline(xdg, PROJECT, TARGET);

    expect(out).toContain(JSON.stringify(agent));
    expect(out).not.toContain('\u001b');
    expect(out.split('\n').filter((line) => line.startsWith('  target:'))).toEqual([
      `  target: ${TARGET}`,
    ]);
    expect(code).toBe(0);
  });

  it('should print every record at project scope in a single call when they exceed a page of 50', async () => {
    const xdg = createTempDir('xdg');
    const dataDir = path.join(xdg, 'hexlog');
    fs.mkdirSync(dataDir);
    const { services } = compose({ dataDir, cwd: xdg, clock: () => NOW, logger: () => undefined });
    services.definition.defineType({ project: PROJECT, name: 'doc', schema: DOC });
    services.process.createProcess({ project: PROJECT, process: 'many' });
    const registerBatch = (key: string) =>
      services.process.register({
        project: PROJECT,
        process: 'many',
        author: AUTHOR,
        key,
        records: Array.from({ length: 30 }, (_, index) => ({
          type: 'doc',
          target: TARGET,
          data: { note: `registro ${key} ${index}` },
          relations: [],
        })),
      });
    const ids = [...(await registerBatch('a')).records, ...(await registerBatch('b')).records].map(
      ({ id }) => id,
    );

    const { code, out } = runTimeline(xdg, PROJECT, TARGET, '--json');

    expect(jsonRecords(out).map(({ id }) => id)).toEqual(ids);
    expect(code).toBe(0);
  });

  it('should print one record per line, ordered by (at, process, seq), with attachmentText equal to the original, with --full --json', () => {
    const { code, out } = runTimeline(xdgHome, PROJECT, TARGET, '--full', '--json');
    const lines = jsonRecords(out);

    expect(lines.map((line) => line.kind)).toEqual(['record', 'record', 'record', 'record']);
    expect(lines.map((line) => line.id)).toEqual([
      ids.first,
      ids.second,
      ids.other,
      ids.superseder,
    ]);
    expect(at(lines, 0)).toMatchObject({
      query: TARGET,
      in: [{ kind: 'supersedes', from: ids.superseder }],
    });
    expect(at(lines, 0).attachmentText).toEqual({ [hashes.big]: BIG_TEXT });
    expect(at(lines, 1).attachmentText).toEqual({ [hashes.small]: SMALL_TEXT });
    expect(code).toBe(0);
  });

  it('should omit attachmentText but keep the attachment status without --full, with --json', () => {
    const { out } = runTimeline(xdgHome, PROJECT, TARGET, '--json');
    const entry = at(jsonRecords(out), 0);

    expect(entry).not.toHaveProperty('attachmentText');
    expect(entry).toMatchObject({ attachmentStatus: { [hashes.big]: 'ok' } });
  });

  it('should leave the data dir tree (hash and mtime) unchanged after running', () => {
    const before = snapshot(path.join(xdgHome, 'hexlog'));

    runTimeline(xdgHome, PROJECT, TARGET, '--full');
    runTimeline(xdgHome, PROJECT, TARGET, '--json');

    expect(snapshot(path.join(xdgHome, 'hexlog'))).toEqual(before);
  });

  it('should exit 2 with corrupted in the output and a warning on stderr for a tampered blob', () => {
    const xdg = copyToXdg(path.join(xdgHome, 'hexlog'));
    fs.writeFileSync(blobFile(path.join(xdg, 'hexlog'), PROJECT, hashes.small), 'adulterado');

    const { code, out, err } = runTimeline(xdg, PROJECT, TARGET, '--full');

    expect(code).toBe(2);
    expect(out).toContain(`attachment: ${hashes.small} (corrupted)`);
    expect(err).toContain('warning ATTACHMENT_CORRUPTED');
  });

  it('should exit 2 with missing in the output for a removed blob', () => {
    const xdg = copyToXdg(path.join(xdgHome, 'hexlog'));
    fs.rmSync(blobFile(path.join(xdg, 'hexlog'), PROJECT, hashes.small));

    const { code, out } = runTimeline(xdg, PROJECT, TARGET, '--json');

    expect(code).toBe(2);
    expect(out).toContain('"missing"');
  });

  it('should exit 2 with PROCESS_CORRUPTED naming the process, and no output, for a tampered chain', () => {
    const xdg = copyToXdg(path.join(xdgHome, 'hexlog'));
    const { log } = processPaths(path.join(xdg, 'hexlog'), { project: PROJECT, process: 'first' });
    fs.writeFileSync(log, fs.readFileSync(log, 'utf8').replace('"grande"', '"trocado"'));

    const { code, out, err } = runTimeline(xdg, PROJECT, TARGET);

    expect(err).toContain('timeline failed: PROCESS_CORRUPTED: process chain is broken (first:');
    expect(out).toBe('');
    expect(code).toBe(2);
  });

  it('should exit 2 with PROCESS_CORRUPTED for a truncated process.json', () => {
    const xdg = copyToXdg(path.join(xdgHome, 'hexlog'));
    const { manifest } = processPaths(path.join(xdg, 'hexlog'), {
      project: PROJECT,
      process: 'second',
    });
    fs.writeFileSync(manifest, fs.readFileSync(manifest, 'utf8').slice(0, 20));

    const { code, out, err } = runTimeline(xdg, PROJECT, TARGET);

    expect(err).toContain('timeline failed: PROCESS_CORRUPTED:');
    expect(out).toBe('');
    expect(code).toBe(2);
  });

  it('should exit 2 with the LEGACY_DATA message over a <D> with 0.x data', () => {
    const xdg = createTempDir('xdg');
    fs.cpSync(legacyFixture, path.join(xdg, 'hexlog'), { recursive: true });

    const { code, out, err } = runTimeline(xdg, PROJECT, TARGET);

    expect(err).toContain('timeline failed: LEGACY_DATA:');
    expect(err).toContain('legacy 0.x data found; archive it first');
    expect(out).toBe('');
    expect(code).toBe(2);
  });

  it.each([
    { name: 'without arguments', args: [] },
    { name: 'without a target', args: [PROJECT] },
    { name: 'with an unknown flag', args: [PROJECT, TARGET, '--bogus'] },
  ])('should exit 1 with the usage on stderr when called $name', ({ args }) => {
    const { code, err } = runTimeline(xdgHome, ...args);

    expect(err).toContain('timeline failed: usage:');
    expect(code).toBe(1);
  });

  it('should exit 1 with PROJECT_NOT_FOUND for a missing project', () => {
    const { code, err } = runTimeline(xdgHome, 'ghost', TARGET);

    expect(err.trim()).toBe('timeline failed: PROJECT_NOT_FOUND: project not found');
    expect(code).toBe(1);
  });

  it.each(['../x', 'A', 'a/b'])(
    'should exit 1 with INVALID_INPUT for the project name %j',
    (project) => {
      const { code, err } = runTimeline(xdgHome, project, TARGET);

      expect(err).toContain('timeline failed: INVALID_INPUT:');
      expect(code).toBe(1);
    },
  );

  it('should exit 1 with INVALID_INPUT for a target out of the format', () => {
    const { code, err } = runTimeline(xdgHome, PROJECT, 'Plano.F6');

    expect(err).toContain('timeline failed: INVALID_INPUT:');
    expect(code).toBe(1);
  });
});
