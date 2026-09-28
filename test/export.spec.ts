import { afterAll, beforeAll, describe, expect, test } from '@jest/globals';
import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { spawnSync } from 'node:child_process';
import { at, createEnvironment, registerCore } from './helpers.ts';

const repoRoot = path.resolve(__dirname, '..');
const AGENT = 'agent-test';

let xdgHome: string;
const extraDirs: string[] = [];

function runExport(xdg: string, ...args: string[]) {
  const result = spawnSync(process.execPath, ['scripts/export.ts', ...args], {
    cwd: repoRoot,
    encoding: 'utf8',
    env: { ...process.env, XDG_DATA_HOME: xdg },
  });
  return { code: result.status, out: result.stdout, err: result.stderr };
}

function copyToXdg(source: string): string {
  const xdg = fs.mkdtempSync(path.join(os.tmpdir(), 'hexlog-xdg-'));
  fs.cpSync(source, path.join(xdg, 'hexlog'), { recursive: true });
  extraDirs.push(xdg);
  return xdg;
}

function eventsFilePath(xdg: string): string {
  return path.join(xdg, 'hexlog', 'alpha', 'run-1', 'events.jsonl');
}

// alpha/run-1: 2 marcos.
beforeAll(async () => {
  const environment = await createEnvironment();
  await registerCore(environment, 'alpha');
  await environment.call('create_process', { project: 'alpha', process: 'run-1' });
  for (const target of ['hex:target:u1', 'hex:target:u2']) {
    await environment.call('register', {
      project: 'alpha',
      process: 'run-1',
      id: 'alpha:run-1:milestone',
      agent: AGENT,
      data: { milestoneType: 'approved', target },
    });
  }
  xdgHome = copyToXdg(environment.dir);
  await environment.close();
});

afterAll(() => {
  for (const dir of [xdgHome, ...extraDirs]) fs.rmSync(dir, { recursive: true, force: true });
});

describe('sem --fields', () => {
  test('a saída é idêntica às linhas do arquivo, na ordem física', () => {
    const fileLines = fs.readFileSync(eventsFilePath(xdgHome), 'utf8').split('\n').slice(0, -1);
    const { code, out } = runExport(xdgHome, 'alpha/run-1');
    expect(out.trim().split('\n')).toEqual(fileLines);
    expect(code).toBe(0);
  });
});

describe('--fields', () => {
  test('projeta só as chaves pedidas, em cada linha', () => {
    const { code, out } = runExport(xdgHome, 'alpha/run-1', '--fields', 'id,type');
    const lines: Record<string, unknown>[] = out
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line) as Record<string, unknown>);
    expect(lines).toHaveLength(2);
    for (const line of lines) expect(Object.keys(line).sort()).toEqual(['id', 'type']);
    expect(code).toBe(0);
  });

  test('campo desconhecido falha com mensagem clara e código diferente de zero', () => {
    const { code, err } = runExport(xdgHome, 'alpha/run-1', '--fields', 'id,bogus');
    expect(err).toContain('invalid field(s): bogus');
    expect(code).not.toBe(0);
  });
});

describe('processo inexistente', () => {
  test('falha com mensagem clara no stderr e código diferente de zero', () => {
    const { code, err } = runExport(xdgHome, 'alpha/ghost');
    expect(err).toContain('export failed:');
    expect(code).not.toBe(0);
  });
});

describe('linha inválida', () => {
  test('é omitida sem quebrar o comando', () => {
    const xdg = copyToXdg(path.join(xdgHome, 'hexlog'));
    const eventsFile = eventsFilePath(xdg);
    const lines = fs.readFileSync(eventsFile, 'utf8').split('\n').slice(0, -1);
    lines[0] = at(lines, 0).slice(0, -1); // remove o '}' final, quebra o parse JSON
    fs.writeFileSync(eventsFile, `${lines.join('\n')}\n`);

    const { code, out } = runExport(xdg, 'alpha/run-1');

    expect(out.trim().split('\n')).toHaveLength(1);
    expect(code).toBe(0);
  });
});

describe('read-only', () => {
  test('hash e mtime do arquivo de eventos ficam iguais depois da execução', () => {
    const eventsFile = eventsFilePath(xdgHome);
    const snapshot = () =>
      `${createHash('sha256').update(fs.readFileSync(eventsFile)).digest('hex')}:${fs.statSync(eventsFile).mtimeMs}`;
    const before = snapshot();
    runExport(xdgHome, 'alpha/run-1');
    expect(snapshot()).toEqual(before);
  });
});
