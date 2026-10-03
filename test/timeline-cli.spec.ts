import { beforeAll, describe, expect, test } from '@jest/globals';
import type { ServerContext } from '@modelcontextprotocol/server';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { z } from 'zod';
import { blobFile, processPaths } from '../src/adapters/fs/data-format.ts';
import { sha256hex } from '../src/domain/chain.ts';
import { compose } from '../src/compose.ts';
import { execute, type Services } from '../src/mcp/kernel.ts';
import { AUTHOR, DOC, NOW, PROJECT } from './commands/register-fakes.ts';
import { at, createTempDir } from './helpers.ts';

const repoRoot = path.resolve(__dirname, '..');
const TARGET = 'plan.f6';
const REVOKE_TARGET = 'revoke.case';

// texto grande (> 200 KB), com acentos, emoji, CRLF, BOM e NUL: tem que sair byte-idêntico
const BIG_TEXT = `\uFEFF${'Decisão — ação 😀\r\nlinha com NUL \u0000 no meio\n'.repeat(5_000)}`;
const SMALL_TEXT = 'relatório curto';

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

function runTimeline(xdg: string, ...args: string[]) {
  const result = spawnSync(process.execPath, ['scripts/timeline.ts', ...args], {
    cwd: repoRoot,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
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
  test('alcance projeto: registros dos dois processos, o não vigente com a marca [superseded by <id>]', () => {
    const { code, out } = runTimeline(xdgHome, PROJECT, TARGET);

    expect(out).toContain(`target ${TARGET}: 4 records`);
    for (const id of [ids.first, ids.second, ids.other, ids.superseder]) expect(out).toContain(id);
    expect(out).not.toContain(ids.unrelated);
    expect(out).toContain(`[superseded by ${ids.superseder}]`);
    expect(out).toContain(`out: supersedes -> ${ids.first}`);
    expect(code).toBe(0);
  });

  test('registro revogado leva a marca [revoked by <id>]', () => {
    const { code, out } = runTimeline(xdgHome, PROJECT, REVOKE_TARGET);

    expect(out).toContain(`[revoked by ${ids.revoker}]`);
    expect(code).toBe(0);
  });

  test('mais de um target gera uma seção por target', () => {
    const { code, out } = runTimeline(xdgHome, PROJECT, TARGET, 'other.thing');

    expect(out).toContain(`target ${TARGET}: 4 records`);
    expect(out).toContain('target other.thing: 1 records');
    expect(code).toBe(0);
  });
});

describe('--json', () => {
  test('toda linha é um registro, por (at, processo, seq), com attachmentText igual ao original', () => {
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

  test('sem --full não há attachmentText, e o status do anexo continua', () => {
    const { out } = runTimeline(xdgHome, PROJECT, TARGET, '--json');
    const entry = at(jsonRecords(out), 0);

    expect(entry).not.toHaveProperty('attachmentText');
    expect(entry).toMatchObject({ attachmentStatus: { [hashes.big]: 'ok' } });
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
    fs.writeFileSync(blobFile(path.join(xdg, 'hexlog'), PROJECT, hashes.small), 'adulterado');

    const { code, out, err } = runTimeline(xdg, PROJECT, TARGET, '--full');

    expect(code).toBe(2);
    expect(out).toContain(`attachment: ${hashes.small} (corrupted)`);
    expect(err).toContain('warning ATTACHMENT_CORRUPTED');
  });

  test('blob removido → exit 2 e missing', () => {
    const xdg = copyToXdg(path.join(xdgHome, 'hexlog'));
    fs.rmSync(blobFile(path.join(xdg, 'hexlog'), PROJECT, hashes.small));

    const { code, out } = runTimeline(xdg, PROJECT, TARGET, '--json');

    expect(code).toBe(2);
    expect(out).toContain('"missing"');
  });

  test('cadeia adulterada → exit 2 e PROCESS_CORRUPTED nomeando o processo, sem saída', () => {
    const xdg = copyToXdg(path.join(xdgHome, 'hexlog'));
    const { log } = processPaths(path.join(xdg, 'hexlog'), { project: PROJECT, process: 'first' });
    fs.writeFileSync(log, fs.readFileSync(log, 'utf8').replace('"grande"', '"trocado"'));

    const { code, out, err } = runTimeline(xdg, PROJECT, TARGET);

    expect(err).toContain('timeline failed: PROCESS_CORRUPTED: process chain is broken (first:');
    expect(out).toBe('');
    expect(code).toBe(2);
  });

  test('process.json truncado → exit 2 e PROCESS_CORRUPTED', () => {
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
});

describe('dado 0.x', () => {
  test('P11: <D> com dado 0.x sai com 2 e a mesma mensagem do LEGACY_DATA do servidor', async () => {
    const xdg = copyToXdg(path.join(__dirname, 'fixtures', 'legacy-0x'));
    const { message, details } = await serverLegacyBody();

    const { code, out, err } = runTimeline(xdg, PROJECT, TARGET);

    expect(err).toContain(`timeline failed: LEGACY_DATA: ${message}`);
    expect(err).toContain(at(details, 0).message);
    expect(out).toBe('');
    expect(code).toBe(2);
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
    const { code, err } = runTimeline(xdgHome, PROJECT, 'Plano.F6');
    expect(err).toContain('timeline failed: INVALID_INPUT:');
    expect(code).toBe(1);
  });
});
