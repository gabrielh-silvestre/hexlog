import { beforeAll, describe, expect, jest, test } from '@jest/globals';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { blobFile, processPaths } from '../src/adapters/fs/data-format.ts';
import { compose, composeReader } from '../src/compose.ts';
import type { RecordId } from '../src/domain/ids.ts';
import { HexlogError } from '../src/errors.ts';
import type { QueryResult } from '../src/queries/query-service.ts';
import { formatCliError } from '../scripts/cli-error.ts';
import { parseRdscArgs, run } from '../scripts/rdsc-projections-run.ts';
import type { RdscReader } from '../scripts/rdsc-projections-run.ts';
import { AUTHOR, DOC, ghostId, NOTE, NOW, PROJECT } from './commands/register-fakes.ts';
import { at, captureError, copyToXdg, createTempDir } from './helpers.ts';

const repoRoot = path.resolve(__dirname, '..');
const legacyFixture = path.join(__dirname, 'fixtures', 'legacy-0x');
const PROCESS_TIMEOUT = 30_000;
const MAIN = 'main';
const FAILURE_PREFIX = 'rdsc-projections failed:';
const EXHAUSTION_MESSAGE = 'marker changed on 3 consecutive reads';

// C1 (CSI) e RLO bidi: o JSON.stringify os deixa crus e o escapeControls os troca por \uXXXX
const C1_CSI = String.fromCodePoint(0x9b);
const BIDI_RLO = String.fromCodePoint(0x202e);
const HOSTILE_TEXT = `a${C1_CSI}b${BIDI_RLO}c`;
const escapedCode = (codePoint: number) => `\\u${codePoint.toString(16).padStart(4, '0')}`;

type Relation = { to: RecordId; kind: 'supersedes' | 'revokes' | 'supports' };
type Line = { kind: string } & Record<string, unknown>;

/** Escritor sobre um `<D>` temporário: o relógio e a chave de idempotência avançam a cada registro. */
function createWriter(xdg: string) {
  const dataDir = path.join(xdg, 'hexlog');
  fs.mkdirSync(dataDir);
  let now = NOW;
  let seq = 0;
  const { services } = compose({ dataDir, cwd: xdg, clock: () => now, logger: () => undefined });
  const register = async (
    process: string,
    type: string,
    target: string,
    data: Record<string, string>,
    relations: Relation[] = [],
  ) => {
    now = new Date(NOW.getTime() + (seq += 1) * 1000);
    const { records } = await services.process.register({
      project: PROJECT,
      process,
      author: AUTHOR,
      key: `k${seq}`,
      records: [{ type, target, data, relations }],
    });
    return at(records, 0).id;
  };
  return { dataDir, services, register };
}

type Writer = ReturnType<typeof createWriter>;

/** Tipos `thing` e `note`, um gate que olha o alvo e outro com pergunta de escopo projeto. */
function defineFlow({ services }: Writer) {
  services.definition.defineType({ project: PROJECT, name: 'thing', schema: DOC });
  services.definition.defineType({ project: PROJECT, name: 'note', schema: NOTE });
  services.definition.defineGate({
    project: PROJECT,
    name: 'has-note',
    questions: [{ kind: 'occurred', select: { type: 'note' } }],
  });
  services.definition.defineGate({
    project: PROJECT,
    name: 'cross-scope',
    questions: [{ kind: 'occurred', select: { type: 'thing' }, scope: 'project' }],
  });
}

function runCli(xdg: string, ...args: string[]) {
  const result = spawnSync(process.execPath, ['scripts/rdsc-projections.ts', ...args], {
    cwd: repoRoot,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
    env: { ...process.env, XDG_DATA_HOME: xdg },
  });
  return { code: result.status, out: result.stdout, err: result.stderr };
}

const parseLines = (out: string): Line[] =>
  out
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line) as Line);

/** Roda o CLI esperando exit 0 e devolve as linhas JSONL. */
function snapshotOf(xdg: string, ...args: string[]): Line[] {
  const { code, out } = runCli(xdg, ...args);
  expect(code).toBe(0);
  return parseLines(out);
}

const ofKind = (lines: Line[], kind: string) => lines.filter((line) => line.kind === kind);
const findKind = (lines: Line[], kind: string) => at(ofKind(lines, kind), 0);
const keysOf = (line: object) => Object.keys(line).sort();
const gateTargets = (lines: Line[]) => ofKind(lines, 'gate').map(({ target }) => target);
const sinceOf = (id: string | null) => JSON.stringify({ [MAIN]: id });

/** O que identifica uma falha do CLI: stdout, exit code e o início do stderr (`<prefixo> CODE:`). */
const failureOf = ({ out, err, code }: ReturnType<typeof runCli>) => ({
  out,
  code,
  head: /^rdsc-projections failed: [^:]+:/.exec(err)?.[0],
});
const failed = (label: string, code: number) => ({
  out: '',
  code,
  head: `${FAILURE_PREFIX} ${label}:`,
});

let xdgMain: string;
let ids: Record<
  'first' | 'second' | 'tenth' | 'note' | 'secondV2' | 'revoked' | 'revoker',
  RecordId
>;
let blobs: { missing: string; corrupted: string; intact: string };

// `main` (versões, revogação, gates), `attach` (anexos), `review` (apoio vencido), `ctl` (controles
// no data), `many` (mais de 50 vigentes) e `other` (para o --since com id de fora do processo)
beforeAll(async () => {
  xdgMain = createTempDir('xdg');
  const writer = createWriter(xdgMain);
  const { services, register } = writer;
  defineFlow(writer);
  for (const process of [MAIN, 'attach', 'review', 'ctl', 'many', 'other']) {
    services.process.createProcess({ project: PROJECT, process });
  }

  const first = await register(MAIN, 'thing', 'thing-1.a', { note: 'first' });
  const second = await register(MAIN, 'thing', 'thing-2.a', { note: 'second' });
  const tenth = await register(MAIN, 'thing', 'thing-10.a', { note: 'tenth' });
  const note = await register(MAIN, 'note', 'thing-1.n', { text: 'covers thing-1' });
  const secondV2 = await register(MAIN, 'thing', 'thing-2.b', { note: 'second v2' }, [
    { to: second, kind: 'supersedes' },
  ]);
  const revoked = await register(MAIN, 'thing', 'thing-3.x', { note: 'to be revoked' });
  const revoker = await register(MAIN, 'note', 'gone.r', { text: 'revokes thing-3' }, [
    { to: revoked, kind: 'revokes' },
  ]);
  ids = { first, second, tenth, note, secondV2, revoked, revoker };
  await register('other', 'note', 'elsewhere.n', { text: 'another process' });

  blobs = {
    missing: services.attachment.attach({ project: PROJECT, text: 'blob that goes missing' }).hash,
    corrupted: services.attachment.attach({ project: PROJECT, text: 'blob that gets tampered' })
      .hash,
    intact: services.attachment.attach({ project: PROJECT, text: 'blob that stays intact' }).hash,
  };
  for (const [label, body] of Object.entries(blobs)) {
    await register('attach', 'thing', `blob-${label}`, { body });
  }

  const base = await register('review', 'note', 'base.n', { text: 'base v1' });
  await register('review', 'note', 'sup.n', { text: 'supporter' }, [
    { to: base, kind: 'supports' },
  ]);
  await register('review', 'note', 'base.n', { text: 'base v2' }, [
    { to: base, kind: 'supersedes' },
  ]);

  await register('ctl', 'note', 'ctl.n', { text: HOSTILE_TEXT });

  for (let index = 1; index <= 60; index += 1) {
    await register('many', 'note', `item-${index}`, { text: `n${index}` });
  }
}, 240_000);

describe('saída do snapshot', () => {
  test(
    'imprime meta, os registros na ordem do log e end como última linha',
    () => {
      const lines = snapshotOf(xdgMain, PROJECT, MAIN);

      expect(lines.map(({ kind }) => kind)).toEqual([
        'meta',
        ...Array<string>(7).fill('record'),
        'end',
      ]);
      expect(ofKind(lines, 'record').map(({ id }) => id)).toEqual([
        ids.first,
        ids.second,
        ids.tenth,
        ids.note,
        ids.secondV2,
        ids.revoked,
        ids.revoker,
      ]);
    },
    PROCESS_TIMEOUT,
  );

  test(
    'meta leva o head igual ao marker do processo e a versão 1',
    () => {
      const meta = findKind(snapshotOf(xdgMain, PROJECT, MAIN), 'meta');

      expect(meta).toMatchObject({
        project: PROJECT,
        process: MAIN,
        version: 1,
        head: ids.revoker,
      });
      expect(meta.marker).toEqual({ [MAIN]: ids.revoker });
    },
    PROCESS_TIMEOUT,
  );

  test(
    'duas execuções sem escrita no meio saem byte a byte iguais',
    () => {
      const args = [PROJECT, MAIN, '--gate', 'has-note', '--gate-per-target', 'has-note:^thing-'];

      expect(runCli(xdgMain, ...args).out).toBe(runCli(xdgMain, ...args).out);
    },
    PROCESS_TIMEOUT,
  );

  test(
    'marca current falso no registro supersedido e no revogado e verdadeiro nos demais',
    () => {
      const records = ofKind(snapshotOf(xdgMain, PROJECT, MAIN), 'record');

      expect(Object.fromEntries(records.map(({ id, current }) => [id, current]))).toEqual({
        [ids.first]: true,
        [ids.second]: false,
        [ids.tenth]: true,
        [ids.note]: true,
        [ids.secondV2]: true,
        [ids.revoked]: false,
        [ids.revoker]: true,
      });
    },
    PROCESS_TIMEOUT,
  );

  test.each([
    ['sem gate', []],
    ['com --gate', ['--gate', 'has-note']],
    ['com --gate-per-target', ['--gate-per-target', 'has-note:^thing-']],
    ['com gate não fixado e de escopo projeto', ['--gate', 'nope', '--gate', 'cross-scope']],
    ['com --since', ['--since', sinceOf(null)]],
  ])(
    'end é a última linha e os contadores batem com as linhas emitidas (%s)',
    (_name, extra) => {
      const lines = snapshotOf(xdgMain, PROJECT, MAIN, ...extra);

      expect(lines.at(-1)).toEqual({
        kind: 'end',
        records: ofKind(lines, 'record').length,
        gates: ofKind(lines, 'gate').length,
      });
      expect(ofKind(lines, 'end')).toHaveLength(1);
    },
    PROCESS_TIMEOUT,
  );
});

describe('chaves por kind', () => {
  let lines: Line[];

  beforeAll(() => {
    lines = snapshotOf(
      xdgMain,
      PROJECT,
      MAIN,
      '--gate',
      'has-note',
      '--gate',
      'nope',
      '--since',
      sinceOf(null),
    );
  }, PROCESS_TIMEOUT);

  test('meta tem exatamente as chaves do contrato', () => {
    expect(keysOf(findKind(lines, 'meta'))).toEqual([
      'head',
      'kind',
      'marker',
      'process',
      'project',
      'version',
    ]);
  });

  test('record sem apoio vencido nem anexo tem exatamente as chaves do contrato', () => {
    expect(keysOf(findKind(lines, 'record'))).toEqual([
      'at',
      'author',
      'current',
      'data',
      'id',
      'in',
      'kind',
      'out',
      'target',
      'type',
    ]);
  });

  test('gate avaliado tem as chaves do contrato e nenhuma a mais, marker incluído', () => {
    const gate = at(
      ofKind(lines, 'gate').filter((line) => !('error' in line)),
      0,
    );

    expect(keysOf(gate)).toEqual(['gate', 'kind', 'passed', 'questions', 'target']);
    expect(keysOf(at(gate.questions as object[], 0))).toEqual([
      'evidence',
      'index',
      'kind',
      'passed',
    ]);
  });

  test('gate de erro tem apenas kind, gate e error', () => {
    const gate = at(
      ofKind(lines, 'gate').filter((line) => 'error' in line),
      0,
    );

    expect(keysOf(gate)).toEqual(['error', 'gate', 'kind']);
  });

  test('changes tem exatamente kind, baseline, entered e left', () => {
    expect(keysOf(findKind(lines, 'changes'))).toEqual(['baseline', 'entered', 'kind', 'left']);
  });

  test('end tem exatamente kind, records e gates', () => {
    expect(keysOf(findKind(lines, 'end'))).toEqual(['gates', 'kind', 'records']);
  });
});

describe('--gate', () => {
  test(
    'avalia o gate com target nulo e devolve passed e a evidência das perguntas',
    () => {
      const gate = findKind(snapshotOf(xdgMain, PROJECT, MAIN, '--gate', 'has-note'), 'gate');

      expect(gate).toMatchObject({
        gate: 'has-note',
        target: null,
        passed: true,
        questions: [{ index: 0, kind: 'occurred', passed: true }],
      });
    },
    PROCESS_TIMEOUT,
  );

  test(
    'gate não fixado vira uma linha GATE_NOT_FOUND e sai 0',
    () => {
      const lines = snapshotOf(xdgMain, PROJECT, MAIN, '--gate', 'nope');

      expect(ofKind(lines, 'gate')).toEqual([
        { kind: 'gate', gate: 'nope', error: 'GATE_NOT_FOUND' },
      ]);
    },
    PROCESS_TIMEOUT,
  );

  test(
    'gate com pergunta de escopo projeto vira uma linha PROJECT_SCOPE_UNSUPPORTED e sai 0',
    () => {
      const lines = snapshotOf(xdgMain, PROJECT, MAIN, '--gate', 'cross-scope');

      expect(ofKind(lines, 'gate')).toEqual([
        { kind: 'gate', gate: 'cross-scope', error: 'PROJECT_SCOPE_UNSUPPORTED' },
      ]);
    },
    PROCESS_TIMEOUT,
  );

  test(
    'end.gates conta também as linhas de erro',
    () => {
      const lines = snapshotOf(xdgMain, PROJECT, MAIN, '--gate', 'nope', '--gate', 'cross-scope');

      expect(findKind(lines, 'end')).toMatchObject({ gates: 2 });
    },
    PROCESS_TIMEOUT,
  );

  test(
    '--gate repetido gera linhas repetidas, sem dedupe',
    () => {
      const lines = snapshotOf(xdgMain, PROJECT, MAIN, '--gate', 'has-note', '--gate', 'has-note');

      expect(ofKind(lines, 'gate')).toHaveLength(2);
    },
    PROCESS_TIMEOUT,
  );

  test(
    'as linhas seguem a ordem do argv',
    () => {
      const lines = snapshotOf(xdgMain, PROJECT, MAIN, '--gate', 'nope', '--gate', 'has-note');

      expect(ofKind(lines, 'gate').map(({ gate }) => gate)).toEqual(['nope', 'has-note']);
    },
    PROCESS_TIMEOUT,
  );
});

describe('--gate-per-target', () => {
  test(
    'avalia os rótulos em ordem natural, thing-10 depois de thing-2',
    () => {
      const lines = snapshotOf(xdgMain, PROJECT, MAIN, '--gate-per-target', 'has-note:^thing-');

      expect(gateTargets(lines)).toEqual(['thing-1', 'thing-2', 'thing-10']);
    },
    PROCESS_TIMEOUT,
  );

  test(
    'cada avaliação usa o rótulo como target e reflete os registros dele',
    () => {
      const gates = ofKind(
        snapshotOf(xdgMain, PROJECT, MAIN, '--gate-per-target', 'has-note:^thing-'),
        'gate',
      );

      expect(gates.map(({ target, passed }) => [target, passed])).toEqual([
        ['thing-1', true],
        ['thing-2', false],
        ['thing-10', false],
      ]);
      expect(at(gates, 0).questions).toEqual([
        { index: 0, kind: 'occurred', passed: true, evidence: { found: [ids.note] } },
      ]);
    },
    PROCESS_TIMEOUT,
  );

  test(
    'o regex vale só para o primeiro rótulo do target, antes do primeiro ponto',
    () => {
      const lines = snapshotOf(xdgMain, PROJECT, MAIN, '--gate-per-target', 'has-note:^thing-2$');

      expect(gateTargets(lines)).toEqual(['thing-2']);
    },
    PROCESS_TIMEOUT,
  );

  test(
    'regex que só casaria com o target inteiro não gera avaliação',
    () => {
      const lines = snapshotOf(xdgMain, PROJECT, MAIN, '--gate-per-target', 'has-note:thing-2\\.a');

      expect(ofKind(lines, 'gate')).toEqual([]);
    },
    PROCESS_TIMEOUT,
  );

  test(
    'registro supersedido com o sucessor em outro target do mesmo rótulo gera uma avaliação só',
    () => {
      const lines = snapshotOf(xdgMain, PROJECT, MAIN, '--gate-per-target', 'has-note:^thing-2$');

      expect(ofKind(lines, 'gate')).toHaveLength(1);
    },
    PROCESS_TIMEOUT,
  );

  test(
    'rótulo presente só em registro revogado não gera avaliação',
    () => {
      const lines = snapshotOf(xdgMain, PROJECT, MAIN, '--gate-per-target', 'has-note:^thing-3$');

      expect(ofKind(lines, 'gate')).toEqual([]);
    },
    PROCESS_TIMEOUT,
  );

  test(
    'considera todos os vigentes, mesmo com mais de 50, e o rótulo além do 50º aparece',
    () => {
      const lines = snapshotOf(xdgMain, PROJECT, 'many', '--gate-per-target', 'has-note:^item-');

      expect(ofKind(lines, 'record')).toHaveLength(60);
      expect(gateTargets(lines)).toHaveLength(60);
      expect(gateTargets(lines).slice(-2)).toEqual(['item-59', 'item-60']);
    },
    PROCESS_TIMEOUT,
  );

  test(
    'gate não fixado gera uma única linha GATE_NOT_FOUND, sem uma por rótulo',
    () => {
      const lines = snapshotOf(xdgMain, PROJECT, MAIN, '--gate-per-target', 'nope:^thing-');

      expect(ofKind(lines, 'gate')).toEqual([
        { kind: 'gate', gate: 'nope', error: 'GATE_NOT_FOUND' },
      ]);
    },
    PROCESS_TIMEOUT,
  );

  test(
    'gate de escopo projeto gera uma única linha PROJECT_SCOPE_UNSUPPORTED, sem uma por rótulo',
    () => {
      const lines = snapshotOf(xdgMain, PROJECT, MAIN, '--gate-per-target', 'cross-scope:^thing-');

      expect(ofKind(lines, 'gate')).toEqual([
        { kind: 'gate', gate: 'cross-scope', error: 'PROJECT_SCOPE_UNSUPPORTED' },
      ]);
    },
    PROCESS_TIMEOUT,
  );

  test(
    '--gate vem antes de --gate-per-target mesmo com o argv invertido',
    () => {
      const lines = snapshotOf(
        xdgMain,
        PROJECT,
        MAIN,
        '--gate-per-target',
        'has-note:^thing-1$',
        '--gate',
        'has-note',
      );

      expect(gateTargets(lines)).toEqual([null, 'thing-1']);
    },
    PROCESS_TIMEOUT,
  );
});

describe('--since', () => {
  test(
    'id que existe no log gera changes com baseline verdadeiro',
    () => {
      const lines = snapshotOf(xdgMain, PROJECT, MAIN, '--since', sinceOf(ids.first));

      expect(findKind(lines, 'changes')).toMatchObject({ baseline: true });
    },
    PROCESS_TIMEOUT,
  );

  test(
    'id que existe no log lista como entered o que entrou depois dele',
    () => {
      const lines = snapshotOf(xdgMain, PROJECT, MAIN, '--since', sinceOf(ids.first));

      expect(findKind(lines, 'changes').entered).toEqual(
        expect.arrayContaining([ids.secondV2, ids.revoker]),
      );
    },
    PROCESS_TIMEOUT,
  );

  test(
    'valor null gera changes com baseline verdadeiro',
    () => {
      const lines = snapshotOf(xdgMain, PROJECT, MAIN, '--since', sinceOf(null));

      expect(findKind(lines, 'changes')).toMatchObject({ baseline: true });
    },
    PROCESS_TIMEOUT,
  );

  test(
    'id inexistente gera baseline falso com entered e left vazios e sai 0',
    () => {
      const lines = snapshotOf(xdgMain, PROJECT, MAIN, '--since', sinceOf(ghostId(MAIN)));

      expect(findKind(lines, 'changes')).toEqual({
        kind: 'changes',
        baseline: false,
        entered: [],
        left: [],
      });
    },
    PROCESS_TIMEOUT,
  );

  test(
    'id de outro processo gera baseline falso com entered e left vazios',
    () => {
      const lines = snapshotOf(xdgMain, PROJECT, MAIN, '--since', sinceOf(ghostId('other')));

      expect(findKind(lines, 'changes')).toMatchObject({ baseline: false, entered: [], left: [] });
    },
    PROCESS_TIMEOUT,
  );

  test(
    'sem --since não há linha changes',
    () => {
      expect(ofKind(snapshotOf(xdgMain, PROJECT, MAIN), 'changes')).toEqual([]);
    },
    PROCESS_TIMEOUT,
  );
});

describe('apoio vencido e controles', () => {
  test(
    'o registro vigente cujo apoio morreu leva needsReview',
    () => {
      const records = ofKind(snapshotOf(xdgMain, PROJECT, 'review'), 'record');
      const supporter = at(
        records.filter(({ target }) => target === 'sup.n'),
        0,
      );
      const baseV1 = at(records, 0);

      expect(supporter.needsReview).toEqual({ staleIn: [], staleOut: [baseV1.id] });
    },
    PROCESS_TIMEOUT,
  );

  test(
    'registro sem apoio vencido não leva a chave needsReview',
    () => {
      const records = ofKind(snapshotOf(xdgMain, PROJECT, 'review'), 'record');

      expect(at(records, 0)).not.toHaveProperty('needsReview');
    },
    PROCESS_TIMEOUT,
  );

  test(
    'controle no data sai como \\uXXXX e a linha continua JSON válido',
    () => {
      const { code, out } = runCli(xdgMain, PROJECT, 'ctl');
      const record = findKind(parseLines(out), 'record');

      expect(code).toBe(0);
      expect(out).not.toContain(C1_CSI);
      expect(out).not.toContain(BIDI_RLO);
      expect(out).toContain(`a${escapedCode(0x9b)}b${escapedCode(0x202e)}c`);
      expect(record.data).toEqual({ text: HOSTILE_TEXT });
    },
    PROCESS_TIMEOUT,
  );
});

describe('anexos', () => {
  const statusOf = (lines: Line[], label: string) =>
    at(
      ofKind(lines, 'record').filter(({ target }) => target === `blob-${label}`),
      0,
    ).attachmentStatus;

  test(
    'anexo íntegro sai com attachmentStatus ok',
    () => {
      const lines = snapshotOf(xdgMain, PROJECT, 'attach');

      expect(statusOf(lines, 'intact')).toEqual({ [blobs.intact]: 'ok' });
    },
    PROCESS_TIMEOUT,
  );

  test(
    'anexo ausente sai 0 com attachmentStatus missing',
    () => {
      const xdg = copyToXdg(path.join(xdgMain, 'hexlog'));
      fs.rmSync(blobFile(path.join(xdg, 'hexlog'), PROJECT, blobs.missing));

      const { code, out, err } = runCli(xdg, PROJECT, 'attach');

      expect(statusOf(parseLines(out), 'missing')).toEqual({ [blobs.missing]: 'missing' });
      expect(err).toBe('');
      expect(code).toBe(0);
    },
    PROCESS_TIMEOUT,
  );

  test(
    'anexo corrompido sai 0 com attachmentStatus corrupted',
    () => {
      const xdg = copyToXdg(path.join(xdgMain, 'hexlog'));
      fs.writeFileSync(blobFile(path.join(xdg, 'hexlog'), PROJECT, blobs.corrupted), 'tampered');

      const { code, out, err } = runCli(xdg, PROJECT, 'attach');

      expect(statusOf(parseLines(out), 'corrupted')).toEqual({ [blobs.corrupted]: 'corrupted' });
      expect(err).toBe('');
      expect(code).toBe(0);
    },
    PROCESS_TIMEOUT,
  );

  test(
    'o texto do anexo nunca é lido nem impresso',
    () => {
      const { out } = runCli(xdgMain, PROJECT, 'attach');

      expect(out).not.toContain('blob that stays intact');
    },
    PROCESS_TIMEOUT,
  );
});

describe('exit 1: uso e leitura recusada', () => {
  test.each([
    ['sem argumentos', []],
    ['sem o processo', [PROJECT]],
    ['posicional a mais', [PROJECT, MAIN, 'extra']],
    ['flag desconhecida', [PROJECT, MAIN, '--bogus']],
    ['nome de projeto inválido', ['Bad Name', MAIN]],
    ['nome de gate inválido', [PROJECT, MAIN, '--gate', 'Bad Name']],
    ['regex inválido', [PROJECT, MAIN, '--gate-per-target', 'has-note:[']],
    ['regex vazio', [PROJECT, MAIN, '--gate-per-target', 'has-note:']],
    ['--gate-per-target sem dois-pontos', [PROJECT, MAIN, '--gate-per-target', 'has-note']],
    ['--since com JSON inválido', [PROJECT, MAIN, '--since', 'not json']],
    ['--since com a chave de outro processo', [PROJECT, MAIN, '--since', '{"other":null}']],
    [
      '--since com chave extra',
      [PROJECT, MAIN, '--since', JSON.stringify({ [MAIN]: null, other: null })],
    ],
    ['--since com valor malformado', [PROJECT, MAIN, '--since', sinceOf('not-an-id')]],
  ])(
    '%s sai 1 com o uso no stderr e stdout vazio',
    (_name, args) => {
      expect(failureOf(runCli(xdgMain, ...args))).toEqual(failed('usage', 1));
    },
    PROCESS_TIMEOUT,
  );

  test(
    'projeto inexistente sai 1 com PROCESS_NOT_FOUND',
    () => {
      expect(failureOf(runCli(xdgMain, 'ghost', MAIN))).toEqual(failed('PROCESS_NOT_FOUND', 1));
    },
    PROCESS_TIMEOUT,
  );

  test(
    'processo inexistente sai 1 com PROCESS_NOT_FOUND',
    () => {
      expect(failureOf(runCli(xdgMain, PROJECT, 'ghost'))).toEqual(failed('PROCESS_NOT_FOUND', 1));
    },
    PROCESS_TIMEOUT,
  );
});

describe('exit 2: dado que o operador resolve', () => {
  test(
    'dado 0.x sai 2 com LEGACY_DATA',
    () => {
      const xdg = createTempDir('xdg');
      fs.cpSync(legacyFixture, path.join(xdg, 'hexlog'), { recursive: true });

      expect(failureOf(runCli(xdg, PROJECT, MAIN))).toEqual(failed('LEGACY_DATA', 2));
    },
    PROCESS_TIMEOUT,
  );

  test(
    'cadeia adulterada sai 2 com PROCESS_CORRUPTED nomeando o processo',
    () => {
      const xdg = copyToXdg(path.join(xdgMain, 'hexlog'));
      const { log } = processPaths(path.join(xdg, 'hexlog'), { project: PROJECT, process: MAIN });
      fs.writeFileSync(log, fs.readFileSync(log, 'utf8').replace('"first"', '"tampered"'));

      const result = runCli(xdg, PROJECT, MAIN, '--gate', 'has-note');

      expect(failureOf(result)).toEqual(failed('PROCESS_CORRUPTED', 2));
      expect(result.err).toContain('process chain is broken (main:');
    },
    PROCESS_TIMEOUT,
  );

  test(
    'process.json ilegível sai 2 com PROCESS_CORRUPTED',
    () => {
      const xdg = copyToXdg(path.join(xdgMain, 'hexlog'));
      const { manifest } = processPaths(path.join(xdg, 'hexlog'), {
        project: PROJECT,
        process: MAIN,
      });
      fs.writeFileSync(manifest, fs.readFileSync(manifest, 'utf8').slice(0, 20));

      expect(failureOf(runCli(xdg, PROJECT, MAIN))).toEqual(failed('PROCESS_CORRUPTED', 2));
    },
    PROCESS_TIMEOUT,
  );
});

describe('leitor roteirizado', () => {
  const SCRIPTED = 'scripted';
  const everything = { limit: Number.MAX_SAFE_INTEGER, scope: 'process' } as const;

  type Attempt = { all: QueryResult; current: QueryResult };

  let reader: ReturnType<typeof composeReader>;
  let s1: Attempt;
  let s2: Attempt;

  const argsOf = (...argv: string[]) => {
    const args = parseRdscArgs([PROJECT, SCRIPTED, ...argv]);
    if (args === undefined) throw new Error('argv de teste inválido');
    return args;
  };

  const readState = (): Attempt => ({
    all: reader.query.queryRecords({
      project: PROJECT,
      process: SCRIPTED,
      includeNonCurrent: true,
      ...everything,
    }),
    current: reader.query.queryRecords({ project: PROJECT, process: SCRIPTED, ...everything }),
  });

  /** Cada leitura de todos os registros abre uma tentativa; a última se repete se faltar roteiro. */
  function scripted(attempts: Attempt[]) {
    let tries = 0;
    const queryRecords = jest.fn<RdscReader['query']['queryRecords']>((input) => {
      if (input.includeNonCurrent) tries += 1;
      const attempt = at(attempts, Math.min(tries, attempts.length) - 1);
      return input.includeNonCurrent ? attempt.all : attempt.current;
    });
    const evaluateGate = jest.fn<RdscReader['query']['evaluateGate']>((input) =>
      reader.query.evaluateGate(input),
    );
    const scriptedReader: RdscReader = {
      query: { queryRecords, evaluateGate },
      loadProcess: (input) => reader.loadProcess(input),
    };
    return { scriptedReader, queryRecords, evaluateGate };
  }

  beforeAll(async () => {
    const xdg = createTempDir('xdg');
    const writer = createWriter(xdg);
    defineFlow(writer);
    writer.services.process.createProcess({ project: PROJECT, process: SCRIPTED });
    reader = composeReader({ dataDir: writer.dataDir, cwd: xdg, logger: () => undefined });

    await writer.register(SCRIPTED, 'thing', 'thing-1.a', { note: 'before' });
    s1 = readState();
    await writer.register(SCRIPTED, 'note', 'thing-1.n', { text: 'after' });
    s2 = readState();
  });

  test('os dois estados capturados têm markers diferentes', () => {
    expect(s1.all.marker).not.toEqual(s2.all.marker);
  });

  test('repetição bem-sucedida usa o par consistente e avalia o gate com o mesmo marker', () => {
    const { scriptedReader, queryRecords, evaluateGate } = scripted([
      { all: s1.all, current: s2.current },
      s2,
    ]);
    const out: string[] = [];

    run(scriptedReader, argsOf('--gate', 'has-note'), (text) => out.push(text));

    const lines = parseLines(out.join(''));
    expect(queryRecords).toHaveBeenCalledTimes(4);
    expect(findKind(lines, 'meta').marker).toEqual(s2.all.marker);
    expect(ofKind(lines, 'record').map(({ id }) => id)).toEqual(s2.all.records.map(({ id }) => id));
    expect(evaluateGate).toHaveBeenCalledTimes(1);
    expect(evaluateGate).toHaveBeenCalledWith(expect.objectContaining({ marker: s2.all.marker }));
  });

  test('esgotadas as 3 tentativas lança HexlogError INTERNAL com a mensagem do contrato', () => {
    const { scriptedReader } = scripted([{ all: s1.all, current: s2.current }]);

    const error = captureError(() => run(scriptedReader, argsOf(), () => undefined));

    expect(error).toMatchObject({ code: 'INTERNAL', message: EXHAUSTION_MESSAGE });
  });

  test('esgotadas as 3 tentativas não entrega nenhuma linha a out', () => {
    const { scriptedReader, queryRecords } = scripted([{ all: s1.all, current: s2.current }]);
    const out = jest.fn();

    captureError(() => run(scriptedReader, argsOf('--gate', 'has-note'), out));

    expect(queryRecords).toHaveBeenCalledTimes(6);
    expect(out).not.toHaveBeenCalled();
  });

  test('formatCliError trata o INTERNAL da exaustão como exit 1 no formato do CLI', () => {
    const error = new HexlogError('INTERNAL', EXHAUSTION_MESSAGE);

    expect(formatCliError('rdsc-projections', error)).toEqual({
      text: `${FAILURE_PREFIX} INTERNAL: ${EXHAUSTION_MESSAGE}`,
      exitCode: 1,
    });
  });
});
