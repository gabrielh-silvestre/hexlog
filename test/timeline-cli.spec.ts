import { beforeAll, describe, expect, it } from '@jest/globals';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { blobFile, processPaths } from '../src/adapters/fs/data-format.ts';
import { escapeControls } from '../scripts/escape-controls.ts';
import { AUTHOR, DOC, NOW, PROJECT, composeIn } from './commands/fakes.ts';
import { at, copyToXdg, createDataHome, jsonLines, snapshot } from './helpers.ts';

const repoRoot = path.resolve(__dirname, '..');
const legacyFixture = path.join(__dirname, 'fixtures', 'legacy-0x');
const CLI_TIMEOUT = 15_000;
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

/** `runTimeline` de um caso que tem de sair com 0: qualquer outro status lança com o stderr. */
function runTimelineOk(xdg: string, ...args: string[]) {
  const result = runTimeline(xdg, ...args);
  if (result.code !== 0) throw new Error(`timeline exited ${result.code}: ${result.err}`);
  return result;
}

type JsonRecord = {
  kind: string;
  target: string;
  id: string;
  in: { kind: string; from: string }[];
  attachmentText?: Record<string, string>;
};

type Services = ReturnType<typeof composeIn>;

/** `<D>` temporário com o tipo `doc` e os `processes` criados. */
function seedDoc(processes: string[], clock?: () => Date) {
  const home = createDataHome();
  const services = composeIn(home, clock);
  services.definition.defineType({ project: PROJECT, name: 'doc', schema: DOC });
  for (const process of processes) services.process.createProcess({ project: PROJECT, process });
  return { xdg: home.xdg, services };
}

/** Grava um registro `doc` e devolve o id. */
async function registerDoc(
  services: Services,
  process: string,
  key: string,
  data: Record<string, string>,
  options: {
    target?: string;
    relations?: { to: string; kind: 'supersedes' | 'revokes' }[];
    author?: typeof AUTHOR;
  } = {},
) {
  const { target = TARGET, relations = [], author = AUTHOR } = options;
  const { records } = await services.process.register({
    project: PROJECT,
    process,
    author,
    key,
    records: [{ type: 'doc', target, data, relations }],
  });
  return at(records, 0).id;
}

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
    let now = NOW;
    const { xdg, services } = seedDoc(['first', 'second'], () => now);
    hashes = {
      big: services.attachment.attach({ project: PROJECT, text: BIG_TEXT }).hash,
      small: services.attachment.attach({ project: PROJECT, text: SMALL_TEXT }).hash,
    };
    let seq = 0;
    const register = (
      process: string,
      target: string,
      data: Record<string, string>,
      relations: { to: string; kind: 'supersedes' | 'revokes' }[] = [],
    ) => {
      now = new Date(NOW.getTime() + (seq += 1) * 1000);
      return registerDoc(services, process, `k${seq}`, data, { target, relations });
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

  describe('with --full --raw', () => {
    let result: ReturnType<typeof runTimeline>;

    beforeAll(() => {
      result = runTimelineOk(xdgHome, PROJECT, TARGET, '--full', '--raw');
    }, CLI_TIMEOUT);

    it('should print the attachment text contiguous and identical between the delimiters (≥ 200 KB)', () => {
      const header = `----- attachment ${hashes.big} (${Buffer.byteLength(BIG_TEXT, 'utf8')} bytes) -----\n`;

      expect(BIG_TEXT.length).toBeGreaterThan(200_000);

      const start = result.out.indexOf(header);
      const body = result.out.slice(
        start + header.length,
        result.out.indexOf('\n----- end -----', start),
      );

      expect(start).toBeGreaterThan(-1);
      expect(body).toBe(BIG_TEXT);
    });

    it('should print the text of every attachment of the target, not only the first', () => {
      expect(result.out).toContain(`----- attachment ${hashes.small} (`);
    });
  });

  describe('with only the project and the target', () => {
    let result: ReturnType<typeof runTimeline>;

    beforeAll(() => {
      result = runTimelineOk(xdgHome, PROJECT, TARGET);
    }, CLI_TIMEOUT);

    it('should print the attachment hash and status, but not the text, without --full', () => {
      expect(result.out).not.toContain('-----');
      expect(result.out).toContain(`attachment: ${hashes.big} (ok)`);
    });

    it('should list the records of both processes at project scope, and not the ones of other targets', () => {
      expect(result.out).toContain(`target ${TARGET}: 4 records`);

      for (const id of [ids.first, ids.second, ids.other, ids.superseder]) {
        expect(result.out).toContain(id);
      }

      expect(result.out).not.toContain(ids.unrelated);
    });

    it('should mark the non-current record as [superseded by <id>]', () => {
      expect(result.out).toContain(`[superseded by ${ids.superseder}]`);
      expect(result.out).toContain(`out: supersedes -> ${ids.first}`);
    });
  });

  describe('with terminal control characters in the record and its attachment', () => {
    // ESC, OSC 0, BEL, CSI C1, CR, RLO bidi, DEL; TAB e LF passam
    const HOSTILE = 'a\u001b]0;x\u0007b\u009bc\rd\u202ee\u007ff\tg\nh';
    let hash: string;
    let escaped: ReturnType<typeof runTimeline>;
    let raw: ReturnType<typeof runTimeline>;
    let json: ReturnType<typeof runTimeline>;

    beforeAll(async () => {
      const { xdg, services } = seedDoc(['evil']);
      hash = services.attachment.attach({ project: PROJECT, text: HOSTILE }).hash;
      await registerDoc(services, 'evil', 'evil', { note: HOSTILE, body: hash });
      escaped = runTimelineOk(xdg, PROJECT, TARGET, '--full');
      raw = runTimelineOk(xdg, PROJECT, TARGET, '--full', '--raw');
      json = runTimelineOk(xdg, PROJECT, TARGET, '--full', '--json');
    }, CLI_TIMEOUT);

    it('should print the text with control characters replaced by a visible \\uXXXX, and TAB and LF intact, without --raw', () => {
      expect(escaped.out).toContain('a\\u001b]0;x\\u0007b\\u009bc\\u000dd\\u202ee\\u007ff\tg\nh');
      expect(escapeControls(escaped.out)).toBe(escaped.out);
    });

    it('should print the exact bytes, control characters included, with --raw', () => {
      expect(raw.out).toContain(
        `----- attachment ${hash} (${Buffer.byteLength(HOSTILE, 'utf8')} bytes) -----\n${HOSTILE}\n`,
      );
    });

    it('should escape the 0x80-0x9f control and bidi characters that JSON.stringify leaves raw with --json', () => {
      expect(escapeControls(json.out)).toBe(json.out);
      expect(json.out).toContain('\\u009b');
    });

    it('should let JSON.parse return the original attachment text with --json', () => {
      expect(at(jsonLines<JsonRecord>(json.out), 0).attachmentText).toEqual({ [hash]: HOSTILE });
    });
  });

  it(
    'should mark a revoked record as [revoked by <id>]',
    () => {
      const { out } = runTimelineOk(xdgHome, PROJECT, REVOKE_TARGET);

      expect(out).toContain(`[revoked by ${ids.revoker}]`);
    },
    CLI_TIMEOUT,
  );

  it(
    'should print one section per target when given more than one',
    () => {
      const { out } = runTimelineOk(xdgHome, PROJECT, TARGET, 'other.thing');

      expect(out).toContain(`target ${TARGET}: 4 records`);
      expect(out).toContain('target other.thing: 1 records');
    },
    CLI_TIMEOUT,
  );

  it(
    'should escape an agent with a line break and ESC in the header, without forging a line or terminal control',
    async () => {
      const agent = 'evil\n  target: ok.fake\u001b[31mRED';
      const { xdg, services } = seedDoc(['evil']);
      await registerDoc(services, 'evil', 'evil', { note: 'x' }, { author: { ...AUTHOR, agent } });

      const { out } = runTimelineOk(xdg, PROJECT, TARGET);

      expect(out).toContain(JSON.stringify(agent));
      expect(out).not.toContain('\u001b');
      expect(out.split('\n').filter((line) => line.startsWith('  target:'))).toEqual([
        `  target: ${TARGET}`,
      ]);
    },
    CLI_TIMEOUT,
  );

  it(
    'should print every record at project scope in a single call when they exceed a page of 50',
    async () => {
      const { xdg, services } = seedDoc(['many']);
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
      const expectedIds = [
        ...(await registerBatch('a')).records,
        ...(await registerBatch('b')).records,
      ].map(({ id }) => id);

      const { out } = runTimelineOk(xdg, PROJECT, TARGET, '--json');

      expect(jsonLines<JsonRecord>(out).map(({ id }) => id)).toEqual(expectedIds);
    },
    CLI_TIMEOUT,
  );

  describe('with --full --json', () => {
    let lines: JsonRecord[];

    beforeAll(() => {
      lines = jsonLines<JsonRecord>(
        runTimelineOk(xdgHome, PROJECT, TARGET, '--full', '--json').out,
      );
    }, CLI_TIMEOUT);

    it('should print one record per line, ordered by (at, process, seq)', () => {
      expect(lines.map((line) => line.kind)).toEqual(['record', 'record', 'record', 'record']);
      expect(lines.map((line) => line.id)).toEqual([
        ids.first,
        ids.second,
        ids.other,
        ids.superseder,
      ]);
    });

    it('should carry the query and the incoming edges on each line', () => {
      expect(at(lines, 0)).toMatchObject({
        query: TARGET,
        in: [{ kind: 'supersedes', from: ids.superseder }],
      });
    });

    it('should carry the attachmentText equal to the original', () => {
      expect(at(lines, 0).attachmentText).toEqual({ [hashes.big]: BIG_TEXT });
      expect(at(lines, 1).attachmentText).toEqual({ [hashes.small]: SMALL_TEXT });
    });
  });

  it(
    'should omit attachmentText but keep the attachment status without --full, with --json',
    () => {
      const { out } = runTimelineOk(xdgHome, PROJECT, TARGET, '--json');
      const entry = at(jsonLines<JsonRecord>(out), 0);

      expect(entry).not.toHaveProperty('attachmentText');
      expect(entry).toMatchObject({ attachmentStatus: { [hashes.big]: 'ok' } });
    },
    CLI_TIMEOUT,
  );

  it(
    'should leave the data dir tree (hash and mtime) unchanged after running',
    () => {
      const before = snapshot(path.join(xdgHome, 'hexlog'));

      runTimeline(xdgHome, PROJECT, TARGET, '--full');
      runTimeline(xdgHome, PROJECT, TARGET, '--json');

      expect(snapshot(path.join(xdgHome, 'hexlog'))).toEqual(before);
    },
    CLI_TIMEOUT,
  );

  it(
    'should exit 2 with corrupted in the output and a warning on stderr for a tampered blob',
    () => {
      const xdg = copyToXdg(path.join(xdgHome, 'hexlog'));
      fs.writeFileSync(blobFile(path.join(xdg, 'hexlog'), PROJECT, hashes.small), 'adulterado');

      const { code, out, err } = runTimeline(xdg, PROJECT, TARGET, '--full');

      expect(code).toBe(2);
      expect(out).toContain(`attachment: ${hashes.small} (corrupted)`);
      expect(err).toContain('warning ATTACHMENT_CORRUPTED');
    },
    CLI_TIMEOUT,
  );

  it(
    'should exit 2 with missing in the output for a removed blob',
    () => {
      const xdg = copyToXdg(path.join(xdgHome, 'hexlog'));
      fs.rmSync(blobFile(path.join(xdg, 'hexlog'), PROJECT, hashes.small));

      const { code, out } = runTimeline(xdg, PROJECT, TARGET, '--json');

      expect(code).toBe(2);
      expect(out).toContain('"missing"');
    },
    CLI_TIMEOUT,
  );

  it.each([
    {
      name: 'a tampered chain',
      tamper: (dataDir: string) => {
        const { log } = processPaths(dataDir, { project: PROJECT, process: 'first' });
        fs.writeFileSync(log, fs.readFileSync(log, 'utf8').replace('"grande"', '"trocado"'));
      },
      message: 'timeline failed: PROCESS_CORRUPTED: process chain is broken (first:',
    },
    {
      name: 'a truncated process.json',
      tamper: (dataDir: string) => {
        const { manifest } = processPaths(dataDir, { project: PROJECT, process: 'second' });
        fs.writeFileSync(manifest, fs.readFileSync(manifest, 'utf8').slice(0, 20));
      },
      message: 'timeline failed: PROCESS_CORRUPTED:',
    },
  ])(
    'should exit 2 with PROCESS_CORRUPTED and no output for $name',
    ({ tamper, message }) => {
      const xdg = copyToXdg(path.join(xdgHome, 'hexlog'));
      tamper(path.join(xdg, 'hexlog'));

      const { code, out, err } = runTimeline(xdg, PROJECT, TARGET);

      expect(err).toContain(message);
      expect(out).toBe('');
      expect(code).toBe(2);
    },
    CLI_TIMEOUT,
  );

  it(
    'should exit 2 with the LEGACY_DATA message over a <D> with 0.x data',
    () => {
      const xdg = copyToXdg(legacyFixture);

      const { code, out, err } = runTimeline(xdg, PROJECT, TARGET);

      expect(err).toContain('timeline failed: LEGACY_DATA:');
      expect(err).toContain('legacy 0.x data found; archive it first');
      expect(out).toBe('');
      expect(code).toBe(2);
    },
    CLI_TIMEOUT,
  );

  it.each([
    { name: 'without arguments', args: [] },
    { name: 'without a target', args: [PROJECT] },
    { name: 'with an unknown flag', args: [PROJECT, TARGET, '--bogus'] },
  ])(
    'should exit 1 with the usage on stderr when called $name',
    ({ args }) => {
      const { code, err } = runTimeline(xdgHome, ...args);

      expect(err).toContain('timeline failed: usage:');
      expect(code).toBe(1);
    },
    CLI_TIMEOUT,
  );

  it(
    'should exit 1 with PROJECT_NOT_FOUND for a missing project',
    () => {
      const { code, err } = runTimeline(xdgHome, 'ghost', TARGET);

      expect(err.trim()).toBe('timeline failed: PROJECT_NOT_FOUND: project not found');
      expect(code).toBe(1);
    },
    CLI_TIMEOUT,
  );

  it.each(['../x', 'A', 'a/b'])(
    'should exit 1 with INVALID_INPUT for the project name %j',
    (project) => {
      const { code, err } = runTimeline(xdgHome, project, TARGET);

      expect(err).toContain('timeline failed: INVALID_INPUT:');
      expect(code).toBe(1);
    },
    CLI_TIMEOUT,
  );

  it(
    'should exit 1 with INVALID_INPUT for a target out of the format',
    () => {
      const { code, err } = runTimeline(xdgHome, PROJECT, 'Plano.F6');

      expect(err).toContain('timeline failed: INVALID_INPUT:');
      expect(code).toBe(1);
    },
    CLI_TIMEOUT,
  );
});
