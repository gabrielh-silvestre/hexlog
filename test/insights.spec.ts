import { afterAll, beforeAll, describe, expect, test } from '@jest/globals';
import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { spawnSync } from 'node:child_process';
import { type Environment, createEnvironment, registerCore } from './helpers.ts';

const repoRoot = path.resolve(__dirname, '..');
const AGENT = 'agent-test';
const MINUTE = 60_000;
const START = Date.parse('2026-01-01T00:00:00.000Z');

let xdgHome: string;
const extraDirs: string[] = [];

function runInsights(xdg: string, ...args: string[]) {
  const result = spawnSync(process.execPath, ['scripts/insights.ts', ...args], {
    cwd: repoRoot,
    encoding: 'utf8',
    env: { ...process.env, XDG_DATA_HOME: xdg },
  });
  return { code: result.status, out: result.stdout, err: result.stderr };
}

function snapshot(dir: string): Record<string, string> {
  const entries = fs.readdirSync(dir, { recursive: true, withFileTypes: true });
  return Object.fromEntries(
    entries
      .filter((entry) => entry.isFile())
      .map((entry) => {
        const file = path.join(entry.parentPath, entry.name);
        const hash = createHash('sha256').update(fs.readFileSync(file)).digest('hex');
        return [file, `${hash}:${fs.statSync(file).mtimeMs}`];
      }),
  );
}

function copyToXdg(source: string): string {
  const xdg = fs.mkdtempSync(path.join(os.tmpdir(), 'hexlog-xdg-'));
  fs.cpSync(source, path.join(xdg, 'hexlog'), { recursive: true });
  extraDirs.push(xdg);
  return xdg;
}

async function register(
  environment: Environment,
  project: string,
  process: string,
  minute: number,
  data: object,
) {
  environment.setClock(new Date(START + minute * MINUTE));
  await environment.call('register', {
    project,
    process,
    id: `${project}:${process}:milestone`,
    agent: AGENT,
    data: { milestoneType: 'approved', target: 'hex:target:u1', ...data },
  });
}

async function evaluateGate(
  environment: Environment,
  process: string,
  minute: number,
  target: string,
) {
  environment.setClock(new Date(START + minute * MINUTE));
  await environment.call('evaluate_gate', {
    project: 'alpha',
    process,
    gate: 'no-orphans',
    agent: AGENT,
    target,
  });
}

// alpha/run-1: 6 eventos (gate pass + gate fail); alpha/run-2: vazio; beta/run-3: 1 evento.
beforeAll(async () => {
  const environment = await createEnvironment();
  for (const project of ['alpha', 'beta']) await registerCore(environment, project);
  for (const [project, process] of [
    ['alpha', 'run-1'],
    ['alpha', 'run-2'],
    ['beta', 'run-3'],
  ]) {
    await environment.call('create_process', { project, process });
  }
  await register(environment, 'alpha', 'run-1', 0, {});
  await register(environment, 'alpha', 'run-1', 1, {});
  await register(environment, 'alpha', 'run-1', 11, {});
  await evaluateGate(environment, 'run-1', 71, 'hex:target:u1');
  await register(environment, 'alpha', 'run-1', 191, {
    target: 'hex:target:u2',
    dueAt: '2026-01-01T00:00:00.000Z',
  });
  await evaluateGate(environment, 'run-1', 192, 'hex:target:u2');
  await register(environment, 'beta', 'run-3', 5, {});
  xdgHome = copyToXdg(environment.dir);
  await environment.close();
});

afterAll(() => {
  for (const dir of [xdgHome, ...extraDirs]) fs.rmSync(dir, { recursive: true, force: true });
});

describe('filtro posicional', () => {
  test('sem argumento cobre todos os processos; chain ok e forks vazio', () => {
    const { code, out } = runInsights(xdgHome);
    expect(out).toContain('## alpha/run-1');
    expect(out).toContain('## alpha/run-2');
    expect(out).toContain('## beta/run-3');
    expect(out).toContain('- chain: ok');
    expect(out).toContain('- forks: none');
    expect(code).toBe(0);
  });

  test('projeto cobre só os processos daquele projeto', () => {
    const { code, out } = runInsights(xdgHome, 'alpha');
    expect(out).toContain('## alpha/run-1');
    expect(out).toContain('## alpha/run-2');
    expect(out).not.toContain('beta/run-3');
    expect(code).toBe(0);
  });

  test('projeto/processo cobre só aquele processo', () => {
    const { code, out } = runInsights(xdgHome, 'beta/run-3');
    expect(out).toContain('## beta/run-3');
    expect(out).not.toContain('alpha/');
    expect(code).toBe(0);
  });

  test('filtro sem correspondência sai com código diferente de zero', () => {
    const { code, out } = runInsights(xdgHome, 'ghost/none');
    expect(out).toContain("matching 'ghost/none'");
    expect(code).not.toBe(0);
  });

  test('diretório de dados sem processos imprime mensagem e sai com 0', () => {
    const empty = fs.mkdtempSync(path.join(os.tmpdir(), 'hexlog-empty-'));
    extraDirs.push(empty);
    const { code, out } = runInsights(empty);
    expect(out).toContain('No processes found');
    expect(code).toBe(0);
  });
});

describe('integridade', () => {
  test('linha adulterada quebra a cadeia e sai com código diferente de zero', () => {
    const xdg = copyToXdg(path.join(xdgHome, 'hexlog'));
    const eventsFile = path.join(xdg, 'hexlog', 'alpha', 'run-1', 'events.jsonl');
    fs.writeFileSync(
      eventsFile,
      fs.readFileSync(eventsFile, 'utf8').replace('approved', 'apprxved'),
    );
    const { code, out } = runInsights(xdg, 'alpha/run-1');
    expect(out).toContain('- chain: BROKEN');
    expect(code).not.toBe(0);
  });
});

describe('gates e timeline', () => {
  let report = '';
  beforeAll(() => {
    report = runInsights(xdgHome, 'alpha/run-1').out;
  });

  test('conta gates avaliados com pass e fail por nome', () => {
    expect(report).toContain('- gates: 2 evaluated, 1 pass, 1 fail');
    expect(report).toContain('  - no-orphans pass: 1');
    expect(report).toContain('  - no-orphans fail: 1');
  });

  test('processo sem gates informa que nenhum foi avaliado', () => {
    expect(runInsights(xdgHome, 'beta/run-3').out).toContain('- gates: none evaluated');
  });

  test('timeline traz primeiro/último evento, duração, eventos por dia e marcos por tipo', () => {
    expect(report).toContain('- first event: 2026-01-01T00:00:00.000Z');
    expect(report).toContain('- last event: 2026-01-01T03:12:00.000Z');
    expect(report).toContain('- total duration: 3.2 h');
    expect(report).toContain('  - 2026-01-01: 6');
    expect(report).toContain('  - approved: 4');
    expect(report).toContain('  - gate: 2');
  });

  test('lista os 3 maiores intervalos entre eventos consecutivos', () => {
    const gaps = report.split('\n').filter((line) => line.includes('between seq'));
    expect(gaps).toEqual([
      '  - 2.0 h between seq 3 and 4',
      '  - 1.0 h between seq 2 and 3',
      '  - 10.0 min between seq 1 and 2',
    ]);
  });

  test('log vazio informa que não há eventos', () => {
    expect(runInsights(xdgHome, 'alpha/run-2').out).toContain('- timeline: no events');
  });
});

describe('read-only', () => {
  test('hash e mtime dos arquivos em <dataDir> ficam iguais depois da execução', () => {
    const dataDir = path.join(xdgHome, 'hexlog');
    const before = snapshot(dataDir);
    runInsights(xdgHome);
    expect(snapshot(dataDir)).toEqual(before);
  });
});

describe('process.json corrompido', () => {
  test('falha com mensagem clara no stderr, sem stack trace', () => {
    const xdg = fs.mkdtempSync(path.join(os.tmpdir(), 'hexlog-xdg-'));
    extraDirs.push(xdg);
    const processDir = path.join(xdg, 'hexlog', 'alpha', 'broken');
    fs.mkdirSync(processDir, { recursive: true });
    fs.writeFileSync(path.join(processDir, 'process.json'), '{bad');

    const { code, err } = runInsights(xdg);

    expect(code).toBe(1);
    expect(err).toContain('insights failed: IO_ERROR');
    expect(err).not.toMatch(/^\s+at /m);
  });
});
