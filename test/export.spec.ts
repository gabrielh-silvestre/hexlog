import { beforeAll, describe, expect, test } from '@jest/globals';
import type { ServerContext } from '@modelcontextprotocol/server';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { z } from 'zod';
import { processPaths } from '../src/adapters/fs/data-format.ts';
import { compose } from '../src/compose.ts';
import { execute, type Services } from '../src/mcp/kernel.ts';
import { AUTHOR, NOTE, NOW, PROJECT, note } from './commands/register-fakes.ts';
import { writeRecordsCorpus } from './fixtures/records-corpus.ts';
import { at, createTempDir } from './helpers.ts';

const repoRoot = path.resolve(__dirname, '..');
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

/** `<xdg>/hexlog` é o `<D>` que o script resolve; `source` vira o conteúdo dele. */
function copyToXdg(source: string): string {
  const xdg = createTempDir('xdg');
  fs.cpSync(source, path.join(xdg, 'hexlog'), { recursive: true });
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

/** O corpo que o servidor devolve para `LEGACY_DATA`: o script tem de dizer o mesmo. */
async function serverLegacyBody(): Promise<{ message: string; details: { message: string }[] }> {
  const result = await execute(
    { services: {} as Services, isLegacy: () => true, logger: () => undefined },
    { name: 'list', schema: z.object({}), args: {}, ctx: {} as ServerContext },
    () => ({}),
  );
  return JSON.parse(at(result.content, 0).text) as {
    message: string;
    details: { message: string }[];
  };
}

// alpha/run-1: três registros; o terceiro supersede o primeiro.
beforeAll(async () => {
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
});

describe('sem --fields', () => {
  test('uma linha JSON por registro, na ordem do log, incluindo o não vigente', () => {
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

  test('processo com mais registros que uma página sai inteiro, em uma chamada só', () => {
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
});

describe('--fields', () => {
  test('projeta só as chaves pedidas, em cada linha', () => {
    const { code, out } = runExport(xdgHome, `${PROJECT}/${PROCESS}`, '--fields', 'id,type');
    const lines = out
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line) as Record<string, unknown>);

    expect(lines).toHaveLength(3);
    for (const line of lines) expect(Object.keys(line).sort()).toEqual(['id', 'type']);
    expect(code).toBe(0);
  });

  test('campo desconhecido falha com mensagem clara e código diferente de zero', () => {
    const { code, err } = runExport(xdgHome, `${PROJECT}/${PROCESS}`, '--fields', 'id,bogus');
    expect(err).toContain('invalid field(s): bogus');
    expect(code).toBe(1);
  });
});

describe('uso incorreto e processo inexistente', () => {
  test.each([
    ['sem argumentos', []],
    ['sem barra', [PROJECT]],
    ['nome inválido', ['A/b']],
    ['três partes', ['a/b/c']],
  ])('%s → exit 1 com o uso no stderr', (_name, args) => {
    const { code, err } = runExport(xdgHome, ...args);
    expect(err).toContain('export failed: usage:');
    expect(code).toBe(1);
  });

  test('processo inexistente falha com PROCESS_NOT_FOUND e exit 1', () => {
    const { code, err } = runExport(xdgHome, `${PROJECT}/ghost`);
    expect(err).toContain('export failed: PROCESS_NOT_FOUND:');
    expect(code).toBe(1);
  });
});

describe('integridade', () => {
  test('SL1: cadeia adulterada é detectada pelo script e sai com 2 sem exportar nada', () => {
    const xdg = copyToXdg(path.join(xdgHome, 'hexlog'));
    const { log } = processPaths(path.join(xdg, 'hexlog'), REF);
    fs.writeFileSync(log, fs.readFileSync(log, 'utf8').replace('"um"', '"trocado"'));

    const { code, out, err } = runExport(xdg, `${PROJECT}/${PROCESS}`);

    expect(err).toContain(`export failed: PROCESS_CORRUPTED: process chain is broken (${PROCESS}:`);
    expect(out).toBe('');
    expect(code).toBe(2);
  });
});

describe('dado 0.x', () => {
  test('P11: <D> com dado 0.x sai com 2 e a mesma mensagem do LEGACY_DATA do servidor', async () => {
    const xdg = copyToXdg(path.join(__dirname, 'fixtures', 'legacy-0x'));
    const { message, details } = await serverLegacyBody();

    const { code, out, err } = runExport(xdg, `${PROJECT}/main`);

    expect(err).toContain(`export failed: LEGACY_DATA: ${message}`);
    expect(err).toContain(at(details, 0).message);
    expect(out).toBe('');
    expect(code).toBe(2);
  });
});

describe('read-only', () => {
  test('hash e mtime de tudo sob <D> ficam iguais depois da execução', () => {
    const before = snapshot(path.join(xdgHome, 'hexlog'));
    runExport(xdgHome, `${PROJECT}/${PROCESS}`);
    expect(snapshot(path.join(xdgHome, 'hexlog'))).toEqual(before);
  });
});
