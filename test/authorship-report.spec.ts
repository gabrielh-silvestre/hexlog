import { beforeAll, describe, expect, it } from '@jest/globals';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { RecordType } from '../src/domain/definitions.ts';
import { composeReader } from '../src/compose.ts';
import { Name } from '../src/domain/ids.ts';
import { BATCH_MAX, type BatchItem } from '../src/domain/record.ts';
import { formatLine, verifyProcess } from '../src/shared/loader.ts';
import { processPaths } from '../src/adapters/fs/data-format.ts';
import { AUTHOR, NOTE, composeIn } from './commands/fakes.ts';
import { idAt, linkAt } from './fixtures/chain-line.ts';
import { createLegacyLineageProcess, definitionOf, namesIn } from './flow-data.ts';
import { at, copyToXdg, createDataHome, snapshot } from './helpers.ts';
import { diskStores } from './queries/query-setup.ts';

const repoRoot = path.resolve(__dirname, '..');
const PACKAGE_DIR = path.join(
  repoRoot,
  'skills',
  'hexlog-setup',
  'references',
  'decision-authorship',
);
const legacyFixture = path.join(__dirname, 'fixtures', 'legacy-0x');
// `createLegacyLineageProcess` abre o processo sem herança sempre neste projeto.
const PROJECT = 'hexlog';
const CLI_TIMEOUT = 15_000;
const SEED_TIMEOUT = 60_000;

const FORGED = 'x\nhuman without basis (0)\n  fake\t';
const FORGED_JSON = JSON.stringify(FORGED);
const BIDI = String.fromCharCode(0x202e);
const C1_CSI = String.fromCharCode(0x9b);
const DEL = String.fromCharCode(0x7f);
const LINE_SEPARATOR = String.fromCharCode(0x2028);
const VOLUME = 101;
const LIST_CAP = 100;

const EVIDENCE_TYPES = ['own-judgment', 'external-team', 'doc-author', 'convergence'] as const;

// Relações com nome fora do pacote, mas de espécie `supports`: o relatório identifica pela espécie.
const RENAMED_RELATIONS = [
  { name: 'vouches', from: [...EVIDENCE_TYPES] },
  { name: 'ratifies', from: ['approval'] },
  { name: 'annotates', from: ['note'] },
];

const DECISION: RecordType = {
  type: 'object',
  properties: { choice: { type: 'string' } },
  required: ['choice'],
  additionalProperties: false,
};

type Services = ReturnType<typeof composeIn>;
type RelationDef = Omit<Parameters<Services['definition']['defineRelation']>[0], 'project'>;
type Relation = { to: string; as?: string; kind?: 'revokes' | 'supersedes' };

function runReport(xdg: string, ...args: string[]) {
  const result = spawnSync(process.execPath, ['scripts/authorship-report.ts', ...args], {
    cwd: repoRoot,
    encoding: 'utf8',
    env: { ...process.env, XDG_DATA_HOME: xdg },
  });
  return { code: result.status, out: result.stdout, err: result.stderr };
}

/** `runReport` de um caso que tem de sair com 0: qualquer outro status lança com o stderr. */
function runReportOk(xdg: string, ...args: string[]) {
  const result = runReport(xdg, ...args);
  if (result.code !== 0) throw new Error(`authorship-report exited ${result.code}: ${result.err}`);
  return result;
}

/** Bloco de `name` da saída: os blocos são separados por uma linha em branco. */
function blockOf(out: string, name: string): string {
  const block = out.split('\n\n').find((text) => text.split('\n')[0]?.split(' ')[1] === name);
  if (block === undefined) throw new Error(`no block for process ${name}`);
  return block;
}

/** Linhas (aparadas) sob o título `title (N)` de um bloco, até a próxima linha de dois espaços. */
function sectionOf(block: string, title: string): string[] {
  const lines = block.split('\n');
  const rest = lines.slice(lines.findIndex((line) => line.startsWith(`  ${title} (`)) + 1);
  const end = rest.findIndex((line) => !line.startsWith('    '));
  return (end === -1 ? rest : rest.slice(0, end)).map((line) => line.trim());
}

/** Valor da linha `  <label>: N` do bloco. */
function countOf(block: string, label: string): number {
  const match = new RegExp(`^  ${label.replace(/[()\\]/g, '\\$&')}: (\\d+)$`, 'm').exec(block);
  if (match === null) throw new Error(`no count line for ${label}`);
  return Number(at(match, 1));
}

const packageType = (name: string) => definitionOf('types', name, PACKAGE_DIR) as RecordType;

type Seeded = {
  xdg: string;
  dataDir: string;
  lineageEvidenceId: string;
};

/** `<D>` temporário com o pacote de autoria e um processo por cenário do relatório. */
async function seedAuthorship(): Promise<Seeded> {
  const home = createDataHome();
  const services = composeIn(home);
  const { definition, process: processes } = services;
  let sequence = 0;

  const register = async (
    process: string,
    items: BatchItem[],
    author: typeof AUTHOR = AUTHOR,
  ): Promise<string[]> => {
    const { records } = await processes.register({
      decidedBy: 'agent',
      project: PROJECT,
      process,
      author,
      key: `k${(sequence += 1)}`,
      records: items,
    });
    return records.map(({ id }) => id);
  };
  const decision = (
    process: string,
    short: string,
    decidedBy: 'agent' | 'human' | 'third-party',
    relations: Relation[] = [],
  ): BatchItem => ({
    type: 'decision',
    target: `${process}.decision.${short}`,
    data: { choice: short },
    decidedBy,
    relations,
  });
  const basis = (
    process: string,
    type: string,
    short: string,
    decisionId: string,
    relation = 'backs',
  ): BatchItem => ({
    type,
    target: `${process}.basis.${short}`,
    data: { summary: `basis of ${short}` },
    relations: [{ to: decisionId, as: relation }],
  });
  const registerOne = async (process: string, item: BatchItem) =>
    at(await register(process, [item]), 0);

  definition.defineType({ project: PROJECT, name: 'decision', schema: DECISION });
  definition.defineType({ project: PROJECT, name: 'note', schema: NOTE });
  processes.createProcess({ project: PROJECT, process: 'old' });
  await register('old', [decision('old', 'by-dev', 'human')]);

  for (const name of [...EVIDENCE_TYPES, 'approval']) {
    definition.defineType({ project: PROJECT, name, schema: packageType(name) });
  }
  for (const name of namesIn('relations', PACKAGE_DIR)) {
    definition.defineRelation({
      project: PROJECT,
      ...(definitionOf('relations', name, PACKAGE_DIR) as RelationDef),
    });
  }
  for (const { name, from } of RENAMED_RELATIONS) {
    definition.defineRelation({ project: PROJECT, name, kind: 'supports', from, to: ['decision'] });
  }
  for (const process of ['counts', 'flagged', 'kinds', 'lineage', 'volume', 'escape']) {
    processes.createProcess({ project: PROJECT, process });
  }
  createLegacyLineageProcess({ dataDir: home.dataDir }, 'flat');

  // counts: dois agentes, uma versão trocada, um humano, um terceiro e um elo sem o campo
  await register('counts', [
    decision('counts', 'agent-a', 'agent'),
    decision('counts', 'agent-b', 'agent'),
    decision('counts', 'human-a', 'human'),
    decision('counts', 'third-a', 'third-party'),
  ]);
  const versioned = await registerOne('counts', decision('counts', 'versioned', 'agent'));
  await registerOne(
    'counts',
    decision('counts', 'versioned', 'agent', [{ to: versioned, kind: 'supersedes' }]),
  );
  const ref = { project: Name.parse(PROJECT), process: Name.parse('counts') };
  await diskStores(home.dataDir).store.write(ref, (raw) => {
    const { end } = verifyProcess(raw);
    return {
      line: formatLine([
        linkAt(end, {
          id: idAt('counts', end.seq),
          type: 'decision',
          target: 'counts.decision.legacy',
          data: { choice: 'legacy' },
        }),
      ]),
      result: undefined,
    };
  });

  // flagged: cada tipo de base, base revogada, aprovação e a decisão do agente
  const flagged = (short: string, role: 'agent' | 'human' | 'third-party') =>
    registerOne('flagged', decision('flagged', short, role));
  await flagged('human-nobasis', 'human');
  await flagged('agent-plain', 'agent');
  const backed = {
    'own-judgment': await flagged('backed-own-judgment', 'human'),
    'external-team': await flagged('backed-external-team', 'third-party'),
    'doc-author': await flagged('backed-doc-author', 'third-party'),
    convergence: await flagged('backed-convergence', 'human'),
  };
  for (const [type, id] of Object.entries(backed)) {
    await registerOne('flagged', basis('flagged', type, type, id));
  }
  const revoked = await flagged('third-revoked', 'third-party');
  const revokedBasis = await registerOne(
    'flagged',
    basis('flagged', 'own-judgment', 'gone', revoked),
  );
  await registerOne('flagged', {
    type: 'note',
    target: 'flagged.note.revoker',
    data: { text: 'revokes the basis' },
    relations: [{ to: revokedBasis, kind: 'revokes' }],
  });
  const approved = await flagged('human-approved', 'human');
  await registerOne('flagged', basis('flagged', 'approval', 'ok', approved, 'approves'));

  // kinds: a espécie `supports` decide, não o nome da relação
  const kinds = (short: string) => registerOne('kinds', decision('kinds', short, 'human'));
  const renamedBasis = await kinds('renamed-basis');
  await registerOne('kinds', basis('kinds', 'own-judgment', 'renamed', renamedBasis, 'vouches'));
  const renamedRevoked = await kinds('renamed-revoked');
  const renamedGone = await registerOne(
    'kinds',
    basis('kinds', 'convergence', 'gone', renamedRevoked, 'vouches'),
  );
  await registerOne('kinds', {
    type: 'note',
    target: 'kinds.note.revoker',
    data: { text: 'revokes the basis' },
    relations: [{ to: renamedGone, kind: 'revokes' }],
  });
  const renamedApproved = await kinds('renamed-approved');
  await registerOne('kinds', basis('kinds', 'approval', 'ok', renamedApproved, 'ratifies'));
  const notedOnly = await kinds('noted-only');
  await registerOne('kinds', {
    type: 'note',
    target: 'kinds.note.annotation',
    data: { text: 'supports but is no evidence' },
    relations: [{ to: notedOnly, as: 'annotates' }],
  });

  // lineage: a base chega à versão nova pela herança da linhagem
  const first = await registerOne('lineage', decision('lineage', 'inherited', 'human'));
  const lineageEvidenceId = await registerOne(
    'lineage',
    basis('lineage', 'own-judgment', 'dev', first),
  );
  await registerOne(
    'lineage',
    decision('lineage', 'inherited', 'human', [{ to: first, kind: 'supersedes' }]),
  );

  // flat: sem herança, só a aresta direta vale
  const flatFirst = await registerOne('flat', decision('flat', 'renewed', 'human'));
  await registerOne('flat', basis('flat', 'own-judgment', 'dev', flatFirst));
  await registerOne(
    'flat',
    decision('flat', 'renewed', 'human', [{ to: flatFirst, kind: 'supersedes' }]),
  );
  const direct = await registerOne('flat', decision('flat', 'direct', 'human'));
  await registerOne('flat', basis('flat', 'convergence', 'direct', direct));

  // volume: mais decisões sem base do que o teto da lista
  for (let start = 0; start < VOLUME; start += BATCH_MAX) {
    const count = Math.min(BATCH_MAX, VOLUME - start);
    await register(
      'volume',
      Array.from({ length: count }, (_, index) => decision('volume', `d${start + index}`, 'human')),
    );
  }

  // escape: valores do autor com controles de terminal
  await register('escape', [decision('escape', 'forged', 'human')], {
    agent: FORGED,
    model: `m${BIDI}${C1_CSI}${DEL}${LINE_SEPARATOR}x`,
    client: 'c',
  });

  definition.defineType({ project: 'bare', name: 'decision', schema: DECISION });
  processes.createProcess({ project: 'bare', process: 'w' });
  definition.defineType({ project: 'nodecision', name: 'note', schema: NOTE });
  processes.createProcess({ project: 'nodecision', process: 'w' });

  return { xdg: home.xdg, dataDir: home.dataDir, lineageEvidenceId };
}

describe('scripts/authorship-report.ts', () => {
  let seeded: Seeded;
  let out: string;

  beforeAll(async () => {
    seeded = await seedAuthorship();
    out = runReportOk(seeded.xdg, PROJECT).out;
  }, SEED_TIMEOUT);

  describe('with the project scope', () => {
    it('should count the current decisions by decidedBy', () => {
      const block = blockOf(out, 'counts');

      expect(block).toContain('process counts (6 current decisions)');
      expect(countOf(block, 'agent (declared)')).toBe(3);
      expect(countOf(block, 'human')).toBe(1);
      expect(countOf(block, 'third-party')).toBe(1);
    });

    it('should count a decision written without decidedBy apart from a declared agent', () => {
      expect(countOf(blockOf(out, 'counts'), 'agent (no field)')).toBe(1);
    });

    it('should flag a human decision without a basis from an evidence type', () => {
      const lines = sectionOf(blockOf(out, 'flagged'), 'human without basis');

      expect(lines).toEqual(
        expect.arrayContaining([expect.stringContaining('flagged.decision.human-nobasis  ')]),
      );
    });

    it('should flag a third-party decision whose only evidence was revoked', () => {
      const lines = sectionOf(blockOf(out, 'flagged'), 'third-party without basis');

      expect(lines).toEqual([expect.stringContaining('flagged.decision.third-revoked  ')]);
    });

    it('should flag a human decision whose only supports comes from an approval', () => {
      const lines = sectionOf(blockOf(out, 'flagged'), 'human without basis');

      expect(lines).toEqual(
        expect.arrayContaining([
          expect.stringMatching(
            /flagged\.decision\.human-approved .*\(approved, but approval is not a basis\)$/,
          ),
        ]),
      );
    });

    it('should not mark a flagged decision that has no approval', () => {
      const lines = sectionOf(blockOf(out, 'flagged'), 'human without basis');

      expect(lines.find((line) => line.includes('human-nobasis'))).not.toContain('approved');
    });

    it('should not flag an agent decision', () => {
      expect(blockOf(out, 'flagged')).not.toContain('flagged.decision.agent-plain');
    });

    it.each(EVIDENCE_TYPES)('should not flag a decision backed by a %s record', (type) => {
      expect(blockOf(out, 'flagged')).not.toContain(`flagged.decision.backed-${type}`);
    });

    it('should not flag a human decision backed by an evidence record through a renamed supports relation', () => {
      expect(blockOf(out, 'kinds')).not.toContain('kinds.decision.renamed-basis');
    });

    it('should flag a human decision whose renamed supports relation was revoked', () => {
      const lines = sectionOf(blockOf(out, 'kinds'), 'human without basis');

      expect(lines).toEqual(
        expect.arrayContaining([expect.stringContaining('kinds.decision.renamed-revoked  ')]),
      );
    });

    it('should only mark a decision supported by an approval through a renamed relation', () => {
      const lines = sectionOf(blockOf(out, 'kinds'), 'human without basis');

      expect(lines).toEqual(
        expect.arrayContaining([
          expect.stringMatching(
            /kinds\.decision\.renamed-approved .*\(approved, but approval is not a basis\)$/,
          ),
        ]),
      );
    });

    it('should flag a human decision whose only supports comes from a type that is not evidence', () => {
      const lines = sectionOf(blockOf(out, 'kinds'), 'human without basis');

      expect(lines).toEqual(
        expect.arrayContaining([expect.stringContaining('kinds.decision.noted-only  ')]),
      );
    });

    it('should not mark approval on a decision supported by a type that is not evidence', () => {
      const lines = sectionOf(blockOf(out, 'kinds'), 'human without basis');

      expect(lines.find((line) => line.includes('noted-only'))).not.toContain('approved');
    });

    it('should not flag a human decision whose evidence reaches it through lineage', () => {
      const block = blockOf(out, 'lineage');

      expect(sectionOf(block, 'human without basis')).toEqual([]);
      expect(block).toContain('human without basis (0)');
    });

    it('should agree with the inheritedIn of the query on a lineage-inherited basis', () => {
      const reader = composeReader({
        dataDir: seeded.dataDir,
        cwd: seeded.xdg,
        logger: () => undefined,
      });

      const { records } = reader.query.queryRecords({
        project: Name.parse(PROJECT),
        process: Name.parse('lineage'),
        type: Name.parse('decision'),
        relations: 'full',
      });

      expect(at(records, 0).inheritedIn).toEqual([
        expect.objectContaining({ from: seeded.lineageEvidenceId, as: 'backs' }),
      ]);
    });

    it('should not say that lineage inheritance is off in a process that has it', () => {
      expect(blockOf(out, 'lineage')).not.toContain('lineage inheritance is off');
    });

    it('should say that only direct edges are read in a process without lineage inheritance', () => {
      expect(blockOf(out, 'flat')).toContain(
        'lineage inheritance is off: only direct supports edges are read',
      );
    });

    it('should flag the new version of a decision in a process without lineage inheritance', () => {
      const lines = sectionOf(blockOf(out, 'flat'), 'human without basis');

      expect(lines).toEqual([expect.stringContaining('flat.decision.renewed  ')]);
    });

    it('should not flag a decision with a direct backs edge in a process without lineage inheritance', () => {
      expect(blockOf(out, 'flat')).not.toContain('flat.decision.direct');
    });

    it('should not flag a decision in a process that pinned no evidence type', () => {
      const block = blockOf(out, 'old');

      expect(block).toContain('  not applicable: no evidence type pinned');
      expect(block).not.toContain('without basis');
      expect(countOf(block, 'human')).toBe(1);
    });

    it('should cut each list at 100 and print the total', () => {
      const block = blockOf(out, 'volume');

      const lines = sectionOf(block, 'human without basis');

      expect(block).toContain(`human without basis (${VOLUME})`);
      expect(lines.filter((line) => !line.startsWith('...'))).toHaveLength(LIST_CAP);
      expect(lines).toContain(`... ${VOLUME - LIST_CAP} more not shown`);
    });

    it('should say that edges from another process are not read', () => {
      expect(out.trimEnd().split('\n').at(-1)).toBe(
        'note: edges from another process are not read',
      );
    });
  });

  describe('with agent-controlled values', () => {
    it('should keep a forged agent name inside one quoted value', () => {
      const lines = sectionOf(blockOf(out, 'escape'), 'human without basis');

      expect(lines).toEqual([expect.stringContaining(`agent=${FORGED_JSON}`)]);
    });

    it.each([
      ['bidi override', BIDI, '\\u202e'],
      ['C1 control', C1_CSI, '\\u009b'],
      ['DEL', DEL, '\\u007f'],
      ['line separator', LINE_SEPARATOR, '\\u2028'],
    ])('should escape the %s that JSON.stringify leaves raw', (_name, character, escaped) => {
      const block = blockOf(out, 'escape');

      expect(block).toContain(escaped);
      expect(block).not.toContain(character);
    });
  });

  describe('with the process scope', () => {
    it(
      'should report only the named process',
      () => {
        const scoped = runReportOk(seeded.xdg, PROJECT, '--process', 'flagged').out;

        expect(scoped).toContain('process flagged (');
        expect(scoped).not.toContain('process counts');
      },
      CLI_TIMEOUT,
    );
  });

  describe('with a type mapping', () => {
    it.each([
      {
        name: 'a cited evidence type',
        args: [PROJECT, '--types', 'own-judgment=gone'],
        missing: 'own-judgment=gone',
      },
      {
        name: 'a cited decision type',
        args: [PROJECT, '--types', 'decision=nope'],
        missing: 'decision=nope',
      },
      { name: 'the default decision type', args: ['nodecision'], missing: 'decision=decision' },
    ])(
      'should exit 1 naming $name that the project does not define',
      ({ args, missing }) => {
        const { code, out: stdout, err } = runReport(seeded.xdg, ...args);

        expect(err).toContain(
          `authorship-report failed: INVALID_INPUT: type not defined in the project: ${missing}`,
        );
        expect(stdout).toBe('');
        expect(code).toBe(1);
      },
      CLI_TIMEOUT,
    );

    it(
      'should print not applicable without refusing when the project defines no evidence type',
      () => {
        const { code, out: stdout } = runReport(seeded.xdg, 'bare');

        expect(stdout).toContain('process w (0 current decisions)');
        expect(stdout).toContain('  not applicable: no evidence type pinned');
        expect(code).toBe(0);
      },
      CLI_TIMEOUT,
    );
  });

  describe('with a process that cannot be read', () => {
    let tampered: { code: number | null; out: string };

    beforeAll(() => {
      const xdg = copyToXdg(path.join(seeded.xdg, 'hexlog'));
      const { log } = processPaths(path.join(xdg, 'hexlog'), {
        project: PROJECT,
        process: 'counts',
      });
      fs.writeFileSync(
        log,
        fs.readFileSync(log, 'utf8').replace('"choice":"agent-a"', '"choice":"tampered"'),
      );
      tampered = runReport(xdg, PROJECT);
    }, CLI_TIMEOUT);

    it('should mark the broken process as unreadable', () => {
      expect(blockOf(tampered.out, 'counts')).toContain(
        '  unreadable: authorship-report failed: PROCESS_CORRUPTED:',
      );
    });

    it('should keep reporting the other processes', () => {
      expect(blockOf(tampered.out, 'flagged')).toContain('process flagged (');
    });

    it('should exit 2 for a corrupted process', () => {
      expect(tampered.code).toBe(2);
    });
  });

  it(
    'should leave the data dir tree (hash and mtime) unchanged after running',
    () => {
      const before = snapshot(path.join(seeded.xdg, 'hexlog'));

      runReport(seeded.xdg, PROJECT);
      runReport(seeded.xdg, PROJECT, '--process', 'flagged');

      expect(snapshot(path.join(seeded.xdg, 'hexlog'))).toEqual(before);
    },
    CLI_TIMEOUT,
  );

  it(
    'should exit 2 with the LEGACY_DATA message over a <D> with 0.x data',
    () => {
      const xdg = copyToXdg(legacyFixture);

      const { code, out: stdout, err } = runReport(xdg, PROJECT);

      expect(err).toContain('authorship-report failed: LEGACY_DATA:');
      expect(stdout).toBe('');
      expect(code).toBe(2);
    },
    CLI_TIMEOUT,
  );

  it.each([
    { name: 'without arguments', args: [] },
    { name: 'with two projects', args: [PROJECT, 'other'] },
    { name: 'with an unknown flag', args: [PROJECT, '--bogus'] },
  ])(
    'should exit 1 with the usage on stderr when called $name',
    ({ args }) => {
      const { code, err } = runReport(seeded.xdg, ...args);

      expect(err).toContain('authorship-report failed: usage:');
      expect(code).toBe(1);
    },
    CLI_TIMEOUT,
  );

  it.each([
    { name: 'an invalid project', args: ['A'] },
    { name: 'an invalid process', args: [PROJECT, '--process', 'Bad'] },
    { name: 'an unknown role in --types', args: [PROJECT, '--types', 'bogus=x'] },
    { name: 'an invalid type name in --types', args: [PROJECT, '--types', 'decision=Bad'] },
    { name: 'a --types item without a name', args: [PROJECT, '--types', 'decision'] },
    { name: 'a --types item with two equals', args: [PROJECT, '--types', 'decision=a=b'] },
  ])(
    'should exit 1 with INVALID_INPUT for $name',
    ({ args }) => {
      const { code, out: stdout, err } = runReport(seeded.xdg, ...args);

      expect(err).toContain('authorship-report failed: INVALID_INPUT:');
      expect(stdout).toBe('');
      expect(code).toBe(1);
    },
    CLI_TIMEOUT,
  );

  it(
    'should exit 1 with PROJECT_NOT_FOUND for a missing project',
    () => {
      const { code, err } = runReport(seeded.xdg, 'ghost');

      expect(err).toContain('authorship-report failed: PROJECT_NOT_FOUND:');
      expect(code).toBe(1);
    },
    CLI_TIMEOUT,
  );
});
