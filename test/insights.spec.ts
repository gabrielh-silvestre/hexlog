import { beforeAll, describe, expect, test } from '@jest/globals';
import { keyBy, mapValues } from 'es-toolkit';
import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { spawnSync } from 'node:child_process';
import { blobFile, processPaths } from '../src/adapters/fs/data-format.ts';
import { compose } from '../src/compose.ts';
import { AUTHOR, DOC, NOTE, note } from './commands/register-fakes.ts';
import { writeRecordsCorpus } from './fixtures/records-corpus.ts';
import { createTempDir } from './helpers.ts';

const repoRoot = path.resolve(__dirname, '..');
const legacyFixture = path.join(__dirname, 'fixtures', 'legacy-0x');
const PROJECT = 'alpha';
const MINUTE = 60_000;
const START = Date.parse('2026-01-01T00:00:00.000Z');

/** `HOME` e `XDG_DATA_HOME` temporários: o script nunca toca o diretório de dados real. */
function runInsights(xdg: string, ...args: string[]) {
  const result = spawnSync(process.execPath, ['scripts/insights.ts', ...args], {
    cwd: repoRoot,
    encoding: 'utf8',
    env: { ...process.env, HOME: xdg, XDG_DATA_HOME: xdg },
  });
  return { code: result.status, out: result.stdout, err: result.stderr };
}

function snapshot(dir: string): Record<string, string> {
  const entries = fs.readdirSync(dir, { recursive: true, withFileTypes: true });
  const files = keyBy(
    entries.filter((entry) => entry.isFile()),
    (entry) => path.join(entry.parentPath, entry.name),
  );
  return mapValues(files, (_entry, file) => {
    const hash = createHash('sha256').update(fs.readFileSync(file)).digest('hex');
    return `${hash}:${fs.statSync(file).mtimeMs}`;
  });
}

/** Cria o `<D>` de um `XDG_DATA_HOME` temporário; devolve os dois. */
function newDataHome(): { xdg: string; dataDir: string } {
  const xdg = createTempDir('xdg');
  const dataDir = path.join(xdg, 'hexlog');
  fs.mkdirSync(dataDir);
  return { xdg, dataDir };
}

function copyOf(xdg: string): string {
  const copy = createTempDir('xdg');
  fs.cpSync(xdg, copy, { recursive: true });
  return copy;
}

let xdgHome: string;
let dataHome: string;
let attachmentHash: string;

const ATTACHMENT_TEXT = 'relatório de anexo';

// alpha/run-1: 5 lotes de 1 registro (seq 0 a 4), 1 minuto de intervalo; alpha/run-2: vazio.
//   seq 0 note com chave `k-a` e seq 4 note com outra chave e o mesmo conteúdo (nenhum é chave em excesso);
//   seq 1 note sem chave e seq 2 note sem chave com o mesmo conteúdo (possível duplicata);
//   seq 3 task com chave e conteúdo único (chave em excesso).
// alpha/run-3: um lote de 2 registros com chave e conteúdo único (G4: não é chave em excesso) e um
//   registro `doc` que cita um anexo.
beforeAll(async () => {
  ({ xdg: xdgHome, dataDir: dataHome } = newDataHome());
  let now = START;
  const { services } = compose({
    dataDir: dataHome,
    cwd: xdgHome,
    clock: () => new Date(now),
    logger: () => undefined,
  });
  services.definition.defineType({ project: PROJECT, name: 'note', schema: NOTE });
  services.definition.defineType({ project: PROJECT, name: 'task', schema: NOTE });
  services.definition.defineType({ project: PROJECT, name: 'doc', schema: DOC });
  for (const process of ['run-1', 'run-2', 'run-3']) {
    services.process.createProcess({ project: PROJECT, process });
  }
  const batches = [
    { key: 'k-a', records: [note('a')] },
    { records: [note('dup')] },
    { records: [note('dup')] },
    { key: 'k-t', records: [note('t', { type: 'task' })] },
    { key: 'k-a2', records: [note('a')] },
  ];
  for (const batch of batches) {
    await services.process.register({
      project: PROJECT,
      process: 'run-1',
      author: AUTHOR,
      ...batch,
    });
    now += MINUTE;
  }
  attachmentHash = services.attachment.attach({ project: PROJECT, text: ATTACHMENT_TEXT }).hash;
  await services.process.register({
    project: PROJECT,
    process: 'run-3',
    author: AUTHOR,
    key: 'k-m',
    records: [note('m1'), note('m2')],
  });
  await services.process.register({
    project: PROJECT,
    process: 'run-3',
    author: AUTHOR,
    records: [note('d', { type: 'doc', data: { body: attachmentHash } })],
  });
});

describe('relatório de integridade e linha do tempo', () => {
  test('processo íntegro sai com 0, cadeia ok e processo vazio sem registros', () => {
    const { code, out } = runInsights(xdgHome);

    expect(code).toBe(0);
    expect(out).toContain('## alpha/run-1');
    expect(out).toContain('- chain: ok, 5 records, repaired lines: 0');
    expect(out).toContain('- attachments: ok');
    expect(out).toContain('- total duration: 4.0 min');
    expect(out).toContain('  - note: 4');
    expect(out).toContain('  - task: 1');
    expect(out).toContain('## alpha/run-2\n- chain: ok, 0 records, repaired lines: 0');
    expect(out).toContain('- timeline: no records');
  });

  test('o filtro projeto/processo limita o relatório e filtro sem alvo sai com 1', () => {
    const only = runInsights(xdgHome, 'alpha/run-2');
    const none = runInsights(xdgHome, 'alpha/ghost');

    expect(only.out).not.toContain('## alpha/run-1');
    expect(only.code).toBe(0);
    expect(none.out).toContain('No processes found in');
    expect(none.out).toContain("matching 'alpha/ghost'");
    expect(none.code).toBe(1);
  });

  test('sem nenhum processo, sai com 0', () => {
    const { xdg } = newDataHome();

    const { code, out } = runInsights(xdg);

    expect(code).toBe(0);
    expect(out).toContain('No processes found');
  });

  test('não altera nenhum arquivo do diretório de dados', () => {
    const before = snapshot(dataHome);

    runInsights(xdgHome);

    expect(snapshot(dataHome)).toEqual(before);
  });
});

describe('linha do tempo', () => {
  // intervalos de 10 min, 1 h, 2 h e 5 min, atravessando a meia-noite: dois dias e 4 intervalos
  // distintos, para a ordem e o corte do top 3 serem observáveis
  const OFFSETS = [0, 10 * MINUTE, 70 * MINUTE, 190 * MINUTE, 195 * MINUTE];

  test('primeiro e último registro, registros por dia e os maiores intervalos em ordem, cortados no top 3', async () => {
    const { xdg, dataDir } = newDataHome();
    const first = Date.parse('2026-01-01T22:00:00.000Z');
    let now = first;
    const { services } = compose({
      dataDir,
      cwd: xdg,
      clock: () => new Date(now),
      logger: () => undefined,
    });
    services.definition.defineType({ project: PROJECT, name: 'note', schema: NOTE });
    services.process.createProcess({ project: PROJECT, process: 'run-t' });
    for (const [index, offset] of OFFSETS.entries()) {
      now = first + offset;
      await services.process.register({
        project: PROJECT,
        process: 'run-t',
        author: AUTHOR,
        records: [note(`t${index}`)],
      });
    }

    const { code, out } = runInsights(xdg, 'alpha/run-t');

    expect(out).toContain('- first record: 2026-01-01T22:00:00.000Z');
    expect(out).toContain('- last record: 2026-01-02T01:15:00.000Z');
    expect(out).toContain('- records per day:\n  - 2026-01-01: 3\n  - 2026-01-02: 2\n');
    expect(out).toContain(
      '- largest gaps (top 3):\n  - 2.0 h between seq 2 and 3\n  - 1.0 h between seq 1 and 2\n  - 10.0 min between seq 0 and 1\n',
    );
    expect(out).not.toContain('between seq 3 and 4');
    expect(code).toBe(0);
  });
});

describe('sinais da chave (SE8)', () => {
  test('aponta a possível duplicata sem chave com o registro original', () => {
    const { out } = runInsights(xdgHome, 'alpha/run-1');

    expect(out).toContain('  - possible duplicates without key: 1');
    expect(out).toContain('    - seq 2 repeats seq 1 (note)');
  });

  test('aponta só a chave em excesso cuja impressão ninguém repete', () => {
    const { out } = runInsights(xdgHome, 'alpha/run-1');

    expect(out).toContain('  - keys in excess (proxy): 1');
    expect(out).toContain('    - seq 3 (task)');
    expect(out).not.toContain('seq 0 (note)');
  });

  test('lote de 2 registros com chave e impressão única não é chave em excesso (G4)', () => {
    const { out } = runInsights(xdgHome, 'alpha/run-3');

    expect(out).toContain('  - keys in excess (proxy): 0');
  });

  test('mostra o percentual de lotes com chave por tipo', () => {
    const { out } = runInsights(xdgHome, 'alpha/run-1');

    expect(out).toContain('    - note: 2/4 batches with key (50.0%)');
    expect(out).toContain('    - task: 1/1 batches with key (100.0%)');
  });

  test('processo sem lotes não tem sinais de chave', () => {
    const { out } = runInsights(xdgHome, 'alpha/run-2');

    expect(out).toContain('- key signals: no batches');
  });

  test('lê o corpus gravado direto no disco e conta os lotes com chave por tipo', () => {
    const { xdg, dataDir } = newDataHome();
    writeRecordsCorpus(dataDir, { project: PROJECT, processes: ['proc1'], recordsPerProcess: 6 });

    const { code, out } = runInsights(xdg);

    expect(code).toBe(0);
    expect(out).toContain('- chain: ok, 6 records');
    expect(out).toContain('    - milestone: 1/1 batches with key (100.0%)');
    expect(out).toContain('    - decision: 1/1 batches with key (100.0%)');
  });
});

describe('cadeia adulterada (SL1)', () => {
  test('conteúdo adulterado no log é detectado: BROKEN e saída 2', () => {
    const xdg = copyOf(xdgHome);
    const log = processPaths(path.join(xdg, 'hexlog'), { project: PROJECT, process: 'run-1' }).log;
    fs.writeFileSync(log, fs.readFileSync(log, 'utf8').replace('"text":"dup"', '"text":"dux"'));

    const { code, out } = runInsights(xdg, 'alpha/run-1');

    expect(out).toMatch(/- chain: BROKEN \(\d+ breaks: .*hash-mismatch@\d+\), \d+ valid records/);
    expect(code).toBe(2);
  });

  test('primeiro elo quebrado: nenhum registro válido e linha do tempo indisponível, não vazia', async () => {
    const { xdg, dataDir } = newDataHome();
    const { services } = compose({
      dataDir,
      cwd: xdg,
      clock: () => new Date(START),
      logger: () => undefined,
    });
    services.definition.defineType({ project: PROJECT, name: 'note', schema: NOTE });
    services.process.createProcess({ project: PROJECT, process: 'run-b' });
    await services.process.register({
      project: PROJECT,
      process: 'run-b',
      author: AUTHOR,
      records: [note('b')],
    });
    const { log } = processPaths(dataDir, { project: PROJECT, process: 'run-b' });
    fs.writeFileSync(log, fs.readFileSync(log, 'utf8').replace('"seq":0', '"seq":9'));

    const { code, out } = runInsights(xdg, 'alpha/run-b');

    expect(out).toMatch(/- chain: BROKEN \(.*diverging-seq@0.*\), 0 valid records/);
    expect(out).toContain('- timeline: unavailable (chain broken)');
    expect(out).not.toContain('no records');
    expect(code).toBe(2);
  });

  test('blob de anexo adulterado: attachments BROKEN e saída 2', () => {
    const xdg = copyOf(xdgHome);
    fs.writeFileSync(blobFile(path.join(xdg, 'hexlog'), PROJECT, attachmentHash), 'adulterado');

    const { code, out } = runInsights(xdg, 'alpha/run-3');

    expect(out).toContain(`- attachments: BROKEN (1: ${attachmentHash} attachment-corrupted)`);
    expect(code).toBe(2);
  });

  test('falha ao ler o log de um processo: linha com o código e saída 1, sem derrubar os outros', () => {
    const xdg = copyOf(xdgHome);
    const { log } = processPaths(path.join(xdg, 'hexlog'), { project: PROJECT, process: 'run-3' });
    fs.rmSync(log);
    fs.mkdirSync(log);

    const { code, out } = runInsights(xdg);

    expect(out).toMatch(/## alpha\/run-3\n- insights failed: IO_ERROR: /);
    expect(out).toContain('## alpha/run-1\n- chain: ok');
    expect(code).toBe(1);
  });

  test('falha de leitura (1) misturada com cadeia quebrada (2): o maior código vence', () => {
    const xdg = copyOf(xdgHome);
    const dir = path.join(xdg, 'hexlog');
    const unreadable = processPaths(dir, { project: PROJECT, process: 'run-3' }).log;
    fs.rmSync(unreadable);
    fs.mkdirSync(unreadable);
    const tampered = processPaths(dir, { project: PROJECT, process: 'run-1' }).log;
    fs.writeFileSync(
      tampered,
      fs.readFileSync(tampered, 'utf8').replace('"text":"dup"', '"text":"dux"'),
    );

    const { code, out } = runInsights(xdg);

    expect(out).toMatch(/## alpha\/run-3\n- insights failed: IO_ERROR: /);
    expect(out).toContain('- chain: BROKEN');
    expect(code).toBe(2);
  });

  test('process.json truncado: relatório completo com o processo marcado PROCESS_CORRUPTED e saída 2', () => {
    const xdg = copyOf(xdgHome);
    const { manifest } = processPaths(path.join(xdg, 'hexlog'), {
      project: PROJECT,
      process: 'run-3',
    });
    fs.writeFileSync(manifest, '{');

    const { code, out, err } = runInsights(xdg);

    expect(out).toMatch(/## alpha\/run-3\n- insights failed: PROCESS_CORRUPTED: .*run-3/);
    expect(out).toContain('## alpha/run-1\n- chain: ok');
    expect(out).toContain('## alpha/run-2\n- chain: ok');
    expect(err).toBe('');
    expect(code).toBe(2);
  });
});

describe('uso incorreto', () => {
  test.each([
    ['flag desconhecida', ['--bogus']],
    ['mais de um filtro', ['alpha/run-1', 'alpha/run-2']],
  ])('%s → exit 1 com o uso no stderr e nada no stdout', (_name, args) => {
    const { code, out, err } = runInsights(xdgHome, ...args);

    expect(err).toContain('insights failed: usage:');
    expect(out).toBe('');
    expect(code).toBe(1);
  });
});

describe('dado 0.x (P11)', () => {
  test('sobre <D> com dado 0.x sai com código 2 e a mensagem do LEGACY_DATA', () => {
    const xdg = createTempDir('xdg');
    fs.cpSync(legacyFixture, path.join(xdg, 'hexlog'), { recursive: true });

    const { code, out, err } = runInsights(xdg);

    expect(code).toBe(2);
    expect(out).toBe('');
    expect(err).toContain('LEGACY_DATA');
    expect(err).toContain('legacy 0.x data found; archive it first');
    expect(err).toContain('node scripts/install.ts --archive-0x (from the hexlog repository)');
  });

  test('a recusa de dado 0.x vale também com filtro de processo', () => {
    const xdg = createTempDir('xdg');
    fs.cpSync(legacyFixture, path.join(xdg, 'hexlog'), { recursive: true });

    expect(runInsights(xdg, 'alpha/run-1').code).toBe(2);
  });
});
