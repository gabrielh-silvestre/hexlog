import { afterAll, beforeAll, describe, expect, test } from '@jest/globals';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { sha256hex } from '../src/chain.ts';
import { at, createEnvironment, registerCore, type Environment } from './helpers.ts';

const repoRoot = path.resolve(__dirname, '..');
const PROJECT = 'alpha';
const AGENT = 'agent-test';
const TARGET = 'hex:target:plano';

const REPORT_SCHEMA = {
  type: 'object',
  properties: {
    note: { type: 'string' },
    target: { type: 'string', pattern: '^hex:target:[^\\s:]+$' },
    attachment: { type: 'string', pattern: '^[0-9a-f]{64}$' },
    supersedes: { type: 'array', items: { type: 'string' } },
  },
  required: ['note', 'target'],
  additionalProperties: false,
};

// texto grande (> 200 KB), com acentos, emoji, CRLF, BOM e NUL: tem que sair byte-idêntico
const BIG_TEXT = `\uFEFF${'Decisão — ação 😀\r\nlinha com NUL \u0000 no meio\n'.repeat(5_000)}`;
const SMALL_TEXT = 'relatório curto';

let xdgHome: string;
const extraDirs: string[] = [];
let ids: { first: string; second: string; other: string; superseder: string };
let hashes: { big: string; small: string };

function runTimeline(xdg: string, ...args: string[]) {
  const result = spawnSync(process.execPath, ['scripts/timeline.ts', ...args], {
    cwd: repoRoot,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
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

/** `caminho → sha256:mtimeMs` de todo arquivo sob `root`, para provar que nada foi escrito. */
function snapshot(root: string): Record<string, string> {
  const entries: [string, string][] = [];
  const walk = (dir: string) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else {
        const hash = createHash('sha256').update(fs.readFileSync(full)).digest('hex');
        entries.push([path.relative(root, full), `${hash}:${fs.statSync(full).mtimeMs}`]);
      }
    }
  };
  walk(root);
  return Object.fromEntries(entries);
}

async function put(environment: Environment, text: string): Promise<string> {
  const result = await environment.call('attachment', { project: PROJECT, text });
  return (result.structuredContent as { hash: string }).hash;
}

async function report(
  environment: Environment,
  processName: string,
  data: Record<string, unknown>,
): Promise<string> {
  const result = await environment.call('register', {
    project: PROJECT,
    process: processName,
    type: 'report',
    agent: AGENT,
    data: { target: TARGET, ...data },
  });
  return (result.structuredContent as { id: string }).id;
}

// alpha: dois processos no mesmo target; o 3º evento do `first` supersede o 1º.
beforeAll(async () => {
  const environment = await createEnvironment();
  await registerCore(environment, PROJECT);
  await environment.call('register_type', {
    project: PROJECT,
    name: 'report',
    schema: REPORT_SCHEMA,
  });
  await environment.call('create_process', { project: PROJECT, process: 'first' });
  await environment.call('create_process', { project: PROJECT, process: 'second' });

  hashes = { big: await put(environment, BIG_TEXT), small: await put(environment, SMALL_TEXT) };
  environment.setClock(new Date('2026-01-01T00:00:01.000Z'));
  const first = await report(environment, 'first', { note: 'grande', attachment: hashes.big });
  environment.setClock(new Date('2026-01-01T00:00:02.000Z'));
  const second = await report(environment, 'first', { note: 'pequeno', attachment: hashes.small });
  environment.setClock(new Date('2026-01-01T00:00:03.000Z'));
  const other = await report(environment, 'second', { note: 'outro processo' });
  environment.setClock(new Date('2026-01-01T00:00:04.000Z'));
  const superseder = await report(environment, 'first', { note: 'novo', supersedes: [first] });

  ids = { first, second, other, superseder };
  xdgHome = copyToXdg(environment.dir);
  await environment.close();
});

afterAll(() => {
  for (const dir of [xdgHome, ...extraDirs]) fs.rmSync(dir, { recursive: true, force: true });
});

describe('--full', () => {
  test('imprime o texto contíguo e idêntico entre os delimitadores (≥ 200 KB)', () => {
    expect(BIG_TEXT.length).toBeGreaterThan(200_000);
    const { code, out } = runTimeline(xdgHome, PROJECT, TARGET, '--full');

    const header = `----- attachment ${hashes.big} (${Buffer.byteLength(BIG_TEXT, 'utf8')} bytes) -----\n`;
    const start = out.indexOf(header);
    expect(start).toBeGreaterThan(-1);
    const body = out.slice(start + header.length, out.indexOf('\n----- end -----', start));

    expect(body).toBe(BIG_TEXT);
    expect(sha256hex(body)).toBe(hashes.big);
    expect(out).toContain(`----- attachment ${hashes.small} (`);
    expect(code).toBe(0);
  });

  test('sem --full o texto não sai, mas o hash e o status do anexo sim', () => {
    const { code, out } = runTimeline(xdgHome, PROJECT, TARGET);
    expect(out).not.toContain('-----');
    expect(out).toContain(`attachment: ${hashes.big} (ok)`);
    expect(code).toBe(0);
  });
});

describe('texto legível', () => {
  test('cabeçalho por processo com chain ok e marca [superado por <id>]', () => {
    const { code, out } = runTimeline(xdgHome, PROJECT, TARGET);

    expect(out).toContain('process first: chain ok (3 lines)');
    expect(out).toContain('process second: chain ok (1 lines)');
    expect(out).toContain(`[superado por ${ids.superseder}]`);
    expect(out).toContain(`supersedes: ${ids.first}`);
    expect(code).toBe(0);
  });
});

describe('--json', () => {
  test('toda linha é JSON: chain por processo, depois entry, com attachment.text === original', () => {
    const { code, out } = runTimeline(xdgHome, PROJECT, TARGET, '--full', '--json');
    const lines = out
      .trim()
      .split('\n')
      .map(
        (line) => JSON.parse(line) as Record<string, unknown> & { attachment?: { text?: string } },
      );

    expect(lines.map((line) => line.kind)).toEqual([
      'chain',
      'chain',
      'entry',
      'entry',
      'entry',
      'entry',
    ]);
    expect(Object.keys(at(lines, 0)).sort()).toEqual(
      ['breaks', 'kind', 'ok', 'process', 'totalBreaks', 'totalLines'].sort(),
    );
    expect(at(lines, 0)).toMatchObject({
      process: 'first',
      ok: true,
      totalLines: 3,
      totalBreaks: 0,
    });

    const entries = lines.filter((line) => line.kind === 'entry');
    expect(entries.map((entry) => entry.id)).toEqual([
      ids.first,
      ids.second,
      ids.other,
      ids.superseder,
    ]);
    expect(at(entries, 0)).toMatchObject({
      at: '2026-01-01T00:00:01.000Z',
      process: 'first',
      seq: 0,
      type: 'report',
      agent: AGENT,
      target: TARGET,
      supersededBy: [ids.superseder],
    });
    expect(at(entries, 0).attachment?.text).toBe(BIG_TEXT);
    expect(at(entries, 3)).toMatchObject({ supersedes: [ids.first] });
    expect(code).toBe(0);
  });

  test('sem --full o attachment não traz text', () => {
    const { out } = runTimeline(xdgHome, PROJECT, TARGET, '--json');
    const entry = JSON.parse(at(out.trim().split('\n'), 2)) as { attachment: object };
    expect(entry.attachment).toEqual({ hash: hashes.big, status: 'ok' });
  });
});

describe('read-only', () => {
  test('a árvore do data dir (hash e mtime) fica igual depois da execução', () => {
    const before = snapshot(path.join(xdgHome, 'hexlog'));
    runTimeline(xdgHome, PROJECT, TARGET, '--full');
    runTimeline(xdgHome, PROJECT, TARGET, '--json');
    expect(snapshot(path.join(xdgHome, 'hexlog'))).toEqual(before);
  });
});

describe('integridade', () => {
  test('blob adulterado → exit 2, corrupted na saída, aviso no stderr', () => {
    const xdg = copyToXdg(path.join(xdgHome, 'hexlog'));
    fs.writeFileSync(path.join(xdg, 'hexlog', PROJECT, 'attachments', hashes.small), 'adulterado');

    const { code, out, err } = runTimeline(xdg, PROJECT, TARGET);

    expect(code).toBe(2);
    expect(out).toContain(`attachment: ${hashes.small} (corrupted)`);
    expect(err).toContain('warning ATTACHMENT_CORRUPTED');
  });

  test('blob removido → exit 2 e missing', () => {
    const xdg = copyToXdg(path.join(xdgHome, 'hexlog'));
    fs.rmSync(path.join(xdg, 'hexlog', PROJECT, 'attachments', hashes.small));

    const { code, out } = runTimeline(xdg, PROJECT, TARGET, '--json');

    expect(code).toBe(2);
    expect(out).toContain('"status":"missing"');
  });

  test('linha adulterada → exit 2 e chain BROKEN, sem --full', () => {
    const xdg = copyToXdg(path.join(xdgHome, 'hexlog'));
    const eventsFile = path.join(xdg, 'hexlog', PROJECT, 'first', 'events.jsonl');
    fs.writeFileSync(
      eventsFile,
      fs.readFileSync(eventsFile, 'utf8').replace('"grande"', '"trocado"'),
    );

    const { code, out, err } = runTimeline(xdg, PROJECT, TARGET);

    expect(code).toBe(2);
    expect(out).toContain('process first: chain BROKEN');
    expect(err).toContain('warning CHAIN_BROKEN');
  });
});

describe('process.json corrompido', () => {
  test.each([
    ['truncado', (manifest: string) => manifest.slice(0, 20)],
    [
      'hash divergente',
      (manifest: string) =>
        manifest.replace(/"schemas": "[0-9a-f]{64}"/, () => `"schemas": "${'0'.repeat(64)}"`),
    ],
  ])('%s → exit 2, aviso no stderr e o processo fora do --json', (_name, corrupt) => {
    const xdg = copyToXdg(path.join(xdgHome, 'hexlog'));
    const manifest = path.join(xdg, 'hexlog', PROJECT, 'second', 'process.json');
    fs.writeFileSync(manifest, corrupt(fs.readFileSync(manifest, 'utf8')));

    const { code, out, err } = runTimeline(xdg, PROJECT, TARGET, '--json');
    const lines = out
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line) as { kind: string; process: string });

    expect(code).toBe(2);
    expect(err).toContain("warning PROCESS_CORRUPTED: process 'second'");
    expect(lines.filter((line) => line.kind === 'chain').map((line) => line.process)).toEqual([
      'first',
    ]);
    expect(lines.filter((line) => line.kind === 'entry').map((line) => line.process)).toEqual([
      'first',
      'first',
      'first',
    ]);
  });
});

describe('uso incorreto e erros', () => {
  test.each([
    ['sem argumentos', []],
    ['sem target', [PROJECT]],
    ['flag desconhecida', [PROJECT, TARGET, '--bogus']],
  ])('%s → exit 1 com o uso no stderr', (_name, args) => {
    const { code, err } = runTimeline(xdgHome, ...args);
    expect(err).toContain('timeline failed: usage:');
    expect(code).toBe(1);
  });

  test('projeto inexistente → timeline failed: PROJECT_NOT_FOUND, exit 1', () => {
    const { code, err } = runTimeline(xdgHome, 'ghost', TARGET);
    expect(err).toContain('timeline failed: PROJECT_NOT_FOUND:');
    expect(code).toBe(1);
  });

  test.each(['../x', 'A', 'a/b'])(
    'nome de projeto %j → timeline failed: INVALID_INPUT, exit 1',
    (project) => {
      const { code, err } = runTimeline(xdgHome, project, TARGET);
      expect(err).toContain('timeline failed: INVALID_INPUT:');
      expect(code).toBe(1);
    },
  );

  test('target fora do formato → timeline failed: INVALID_INPUT, exit 1', () => {
    const { code, err } = runTimeline(xdgHome, PROJECT, 'plano');
    expect(err).toContain('timeline failed: INVALID_INPUT:');
    expect(code).toBe(1);
  });
});
