import { beforeAll, describe, expect, it } from '@jest/globals';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { processPaths } from '../src/adapters/fs/data-format.ts';
import { compose } from '../src/compose.ts';
import { AUTHOR, NOTE, NOW, PROJECT, note } from './commands/register-fakes.ts';
import { writeRecordsCorpus } from './fixtures/records-corpus.ts';
import { at, copyToXdg, createTempDir, snapshot } from './helpers.ts';

const repoRoot = path.resolve(__dirname, '..');
const legacyFixture = path.join(__dirname, 'fixtures', 'legacy-0x');
const PROCESS = 'run-1';
const REF = { project: PROJECT, process: PROCESS };

let xdgHome: string;
let ids: string[];

function runExport(xdg: string, ...args: string[]) {
  const result = spawnSync(process.execPath, ['scripts/export.ts', ...args], {
    cwd: repoRoot,
    encoding: 'utf8',
    env: { ...process.env, XDG_DATA_HOME: xdg },
  });
  return { code: result.status, out: result.stdout, err: result.stderr };
}

// alpha/run-1: três registros; o terceiro supersede o primeiro.
const seedProcess = async () => {
  const xdg = createTempDir('xdg');
  const dataDir = path.join(xdg, 'hexlog');
  fs.mkdirSync(dataDir);
  const { services } = compose({ dataDir, cwd: xdg, clock: () => NOW, logger: () => undefined });
  services.definition.defineType({ project: PROJECT, name: 'note', schema: NOTE });
  services.process.createProcess(REF);
  const register = async (key: string, item: ReturnType<typeof note>) => {
    const { records } = await services.process.register({
      ...REF,
      author: AUTHOR,
      key,
      records: [item],
    });
    return at(records, 0).id;
  };
  const first = await register('k1', note('um'));
  const second = await register('k2', note('dois'));
  const third = await register(
    'k3',
    note('três', { relations: [{ to: first, kind: 'supersedes' }] }),
  );
  ids = [first, second, third];
  xdgHome = xdg;
};

describe('scripts/export.ts', () => {
  // `jest/require-top-level-describe` barra hook fora de describe.
  beforeAll(seedProcess);

  it('should print one JSON line per record in log order, including the non-current one', () => {
    const { code, out } = runExport(xdgHome, `${PROJECT}/${PROCESS}`);
    const lines = out
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line) as { id: string; in: { kind: string; from: string }[] });

    expect(lines.map(({ id }) => id)).toEqual(ids);
    expect(at(lines, 0).in).toEqual([
      expect.objectContaining({ kind: 'supersedes', from: at(ids, 2) }),
    ]);
    expect(code).toBe(0);
  });

  it('should export a process with more records than a page whole, in a single call', () => {
    const xdg = createTempDir('xdg');
    const corpus = writeRecordsCorpus(path.join(xdg, 'hexlog'), { recordsPerProcess: 120 });
    const { project, process: processName } = at(corpus.refs, 0);

    const { code, out } = runExport(xdg, `${project}/${processName}`);

    const exported = out
      .trim()
      .split('\n')
      .map((line) => (JSON.parse(line) as { id: string }).id);

    expect(exported).toEqual(corpus.records.map(({ id }) => id));
    expect(code).toBe(0);
  });

  it('should project only the requested keys on each line with --fields', () => {
    const { code, out } = runExport(xdgHome, `${PROJECT}/${PROCESS}`, '--fields', 'id,type');
    const lines = out
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line) as Record<string, unknown>);

    expect(lines).toHaveLength(3);

    for (const line of lines) expect(Object.keys(line).sort()).toEqual(['id', 'type']);

    expect(code).toBe(0);
  });

  it('should fail with a clear message and a non-zero code for an unknown --fields field', () => {
    const { code, err } = runExport(xdgHome, `${PROJECT}/${PROCESS}`, '--fields', 'id,bogus');

    expect(err).toContain('invalid field(s): bogus');
    expect(code).toBe(1);
  });

  it('should fail with the usage instead of exporting everything when --fields has no value', () => {
    const { code, out, err } = runExport(xdgHome, `${PROJECT}/${PROCESS}`, '--fields');

    expect(err).toContain('export failed: usage:');
    expect(out).toBe('');
    expect(code).toBe(1);
  });

  it.each([
    ['without arguments', []],
    ['without a slash', [PROJECT]],
    ['with an invalid name', ['A/b']],
    ['with three parts', ['a/b/c']],
    ['with an unknown flag', [`${PROJECT}/${PROCESS}`, '--bogus']],
    ['with an extra argument', [`${PROJECT}/${PROCESS}`, 'extra']],
  ])('should exit 1 with the usage on stderr when called %s', (_name, args) => {
    const { code, err } = runExport(xdgHome, ...args);

    expect(err).toContain('export failed: usage:');
    expect(code).toBe(1);
  });

  it('should fail with PROCESS_NOT_FOUND and exit 1 for a missing process', () => {
    const { code, err } = runExport(xdgHome, `${PROJECT}/ghost`);

    expect(err).toContain('export failed: PROCESS_NOT_FOUND:');
    expect(code).toBe(1);
  });

  it('should detect a tampered chain and exit 2 without exporting anything', () => {
    const xdg = copyToXdg(path.join(xdgHome, 'hexlog'));
    const { log } = processPaths(path.join(xdg, 'hexlog'), REF);
    fs.writeFileSync(log, fs.readFileSync(log, 'utf8').replace('"um"', '"trocado"'));

    const { code, out, err } = runExport(xdg, `${PROJECT}/${PROCESS}`);

    expect(err).toContain(`export failed: PROCESS_CORRUPTED: process chain is broken (${PROCESS}:`);
    expect(out).toBe('');
    expect(code).toBe(2);
  });

  it('should exit 2 with PROCESS_CORRUPTED and export nothing for a truncated process.json', () => {
    const xdg = copyToXdg(path.join(xdgHome, 'hexlog'));
    const { manifest } = processPaths(path.join(xdg, 'hexlog'), REF);
    fs.writeFileSync(manifest, fs.readFileSync(manifest, 'utf8').slice(0, 20));

    const { code, out, err } = runExport(xdg, `${PROJECT}/${PROCESS}`);

    expect(err).toContain('export failed: PROCESS_CORRUPTED:');
    expect(out).toBe('');
    expect(code).toBe(2);
  });

  it('should exit 2 with the LEGACY_DATA message over a <D> with 0.x data', () => {
    const xdg = createTempDir('xdg');
    fs.cpSync(legacyFixture, path.join(xdg, 'hexlog'), { recursive: true });

    const { code, out, err } = runExport(xdg, `${PROJECT}/${PROCESS}`);

    expect(err).toContain('export failed: LEGACY_DATA:');
    expect(err).toContain('legacy 0.x data found; archive it first');
    expect(out).toBe('');
    expect(code).toBe(2);
  });

  it('should leave the hash and mtime of everything under <D> unchanged', () => {
    const before = snapshot(path.join(xdgHome, 'hexlog'));

    runExport(xdgHome, `${PROJECT}/${PROCESS}`);

    expect(snapshot(path.join(xdgHome, 'hexlog'))).toEqual(before);
  });
});
