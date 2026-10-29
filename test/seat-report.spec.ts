import { beforeAll, describe, expect, it } from '@jest/globals';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { RecordType } from '../src/domain/definitions.ts';
import { AUTHOR, NOTE, PROJECT, composeIn } from './commands/fakes.ts';
import { at, copyToXdg, createDataHome, snapshot } from './helpers.ts';

const repoRoot = path.resolve(__dirname, '..');
const legacyFixture = path.join(__dirname, 'fixtures', 'legacy-0x');
const packageDir = path.join(
  repoRoot,
  'skills',
  'hexlog-setup',
  'references',
  'owner-seat',
  'types',
);
const CLI_TIMEOUT = 15_000;
const SEED_TIMEOUT = 30_000;

const OCCUPANT = { agent: 'owner-seat-claude', model: 'claude-sonnet-x', client: 'claude-code' };
const AUDITOR = { agent: 'owner-seat-auditor', model: 'claude-opus-y', client: 'claude-code' };

const FORGED = 'x\naudited answers (1)\n  unit-1:fake  fake [audited by agent="a"]\t';
const ESC = String.fromCharCode(0x1b);
const BIDI = String.fromCharCode(0x202e);

const SECTION = {
  withoutCriteria: 'simulated answers without criteria',
  openGaps: 'open gaps',
  notAudited: 'simulated answers not audited',
  audited: 'audited answers',
  human: 'human answers',
  unattributed: 'answers without answeredBy',
} as const;
const SECTION_ORDER = Object.values(SECTION);

function runReport(xdg: string, ...args: string[]) {
  const result = spawnSync(process.execPath, ['scripts/seat-report.ts', ...args], {
    cwd: repoRoot,
    encoding: 'utf8',
    env: { ...process.env, XDG_DATA_HOME: xdg },
  });
  return { code: result.status, out: result.stdout, err: result.stderr };
}

/** `runReport` de um caso que tem de sair com 0: qualquer outro status lança com o stderr. */
function runReportOk(xdg: string, ...args: string[]) {
  const result = runReport(xdg, ...args);
  if (result.code !== 0) throw new Error(`seat-report exited ${result.code}: ${result.err}`);
  return result;
}

/** Título (sem a contagem) para as linhas do corpo, que começam por dois espaços. */
function sectionsOf(out: string): Record<string, string[]> {
  const sections: Record<string, string[]> = {};
  let body: string[] = [];
  for (const line of out.split('\n').filter((text) => text !== '')) {
    if (line.startsWith(' ')) body.push(line.trim());
    else {
      body = [];
      sections[line.replace(/ \(\d+\)$/, '')] = body;
    }
  }
  return sections;
}

/** Cada seção que lista o `target` (linha `<id>  <target>  ...`), com a linha. */
function placements(out: string, target: string) {
  return Object.entries(sectionsOf(out)).flatMap(([section, lines]) =>
    lines.filter((line) => line.includes(`  ${target}  `)).map((line) => ({ section, line })),
  );
}

const packageType = (name: string) =>
  JSON.parse(fs.readFileSync(path.join(packageDir, `${name}.json`), 'utf8')) as RecordType;

type Seeded = {
  xdg: string;
  criteriaHash: string;
  auditIds: { approved: string; precedence: string; mapped: string };
};

/** `<D>` temporário com os tipos do pacote (e os mapeados) e um processo por cenário do relatório. */
async function seedSeat(): Promise<Seeded> {
  const home = createDataHome();
  const services = composeIn(home);
  const { definition, process: processes, attachment } = services;
  const types: [string, RecordType][] = [
    ['gap', packageType('gap')],
    ['premise', packageType('premise')],
    ['audit', packageType('audit')],
    ['evidence', packageType('evidence')],
    ['note', NOTE],
    ['question', packageType('gap')],
    ['answer', packageType('premise')],
    ['review', packageType('audit')],
  ];
  for (const [name, schema] of types) definition.defineType({ project: PROJECT, name, schema });
  const relations = [
    { name: 'fills-gap', kind: 'answers', from: ['premise'], to: ['gap'] },
    { name: 'audits', kind: 'supports', from: ['audit'], to: ['premise'] },
    { name: 'answers-question', kind: 'answers', from: ['answer'], to: ['question'] },
    { name: 'reviews', kind: 'supports', from: ['review'], to: ['answer'] },
  ] as const;
  for (const relation of relations) {
    definition.defineRelation({
      project: PROJECT,
      ...relation,
      from: [...relation.from],
      to: [...relation.to],
    });
  }
  const scenarios = [
    'no-criteria',
    'open',
    'pending-audit',
    'approved',
    'withdrawn',
    'contested',
    'contested-open',
    'human',
    'unattributed',
    'precedence',
    'escape',
    'forged',
    'mapped',
  ];
  for (const process of scenarios) processes.createProcess({ project: PROJECT, process });

  const criteriaHash = attachment.attach({ project: PROJECT, text: 'criteria doc' }).hash;
  const evidenceSource = attachment.attach({ project: PROJECT, text: 'evidence doc' }).hash;
  let sequence = 0;
  const put = async (
    process: string,
    type: string,
    target: string,
    data: Record<string, string>,
    options: {
      author?: typeof AUTHOR;
      relations?: { to: string; as?: string; kind?: 'revokes' | 'supports' }[];
    } = {},
  ) => {
    const { author = OCCUPANT, relations: edges = [] } = options;
    const { records } = await processes.register({
      project: PROJECT,
      process,
      author,
      key: `k${(sequence += 1)}`,
      records: [{ type, target, data, relations: edges }],
    });
    return at(records, 0).id;
  };
  const gap = (process: string, type = 'gap') =>
    put(
      process,
      type,
      `${process}.gap.q`,
      { question: 'which one?', context: 'ctx' },
      { author: AUTHOR },
    );
  const simulated = { statement: 'chosen', answeredBy: 'simulated' };
  const ruled = { ...simulated, basis: 'rule', rule: 'rule-key', criteria: criteriaHash };
  const answer = (process: string, short: string, gapId: string, data: Record<string, string>) =>
    put(process, 'premise', `${process}.answer.${short}`, data, {
      relations: [{ to: gapId, as: 'fills-gap' }],
    });

  const noCriteria = await gap('no-criteria');
  await answer('no-criteria', 'judgment', noCriteria, { ...simulated, basis: 'judgment' });
  await answer('no-criteria', 'no-basis', noCriteria, simulated);
  await answer('no-criteria', 'no-rule', noCriteria, {
    ...simulated,
    basis: 'rule',
    criteria: criteriaHash,
  });
  await answer('no-criteria', 'no-criteria', noCriteria, {
    ...simulated,
    basis: 'rule',
    rule: 'rule-key',
  });

  await gap('open');

  const pending = await answer('pending-audit', 'a', await gap('pending-audit'), {
    ...ruled,
    actionUsed: 'web',
  });
  await put(
    'pending-audit',
    'evidence',
    'pending-audit.evidence.e',
    { summary: 'found', source: evidenceSource },
    {
      relations: [{ to: pending, kind: 'supports' }],
    },
  );
  await put(
    'pending-audit',
    'note',
    'pending-audit.dependent.d',
    { text: 'built on it' },
    {
      relations: [{ to: pending, kind: 'supports' }],
    },
  );

  const approvedAnswer = await answer('approved', 'a', await gap('approved'), ruled);
  const approved = await put(
    'approved',
    'audit',
    'approved.audit.ok',
    { note: 'checked' },
    {
      author: AUDITOR,
      relations: [{ to: approvedAnswer, as: 'audits' }],
    },
  );

  const withdrawnAnswer = await answer('withdrawn', 'a', await gap('withdrawn'), ruled);
  const withdrawnAudit = await put(
    'withdrawn',
    'audit',
    'withdrawn.audit.ok',
    { note: 'checked' },
    {
      author: AUDITOR,
      relations: [{ to: withdrawnAnswer, as: 'audits' }],
    },
  );
  await put(
    'withdrawn',
    'audit',
    'withdrawn.audit.retraction',
    { note: 'withdrawn: wrong' },
    {
      author: AUDITOR,
      relations: [{ to: withdrawnAudit, kind: 'revokes' }],
    },
  );

  const contestedGap = await gap('contested');
  const contestedAnswer = await answer('contested', 'a', contestedGap, ruled);
  await put(
    'contested',
    'premise',
    'contested.answer.human',
    { statement: 'owner picked', answeredBy: 'human' },
    {
      author: AUDITOR,
      relations: [
        { to: contestedAnswer, kind: 'revokes' },
        { to: contestedGap, as: 'fills-gap' },
      ],
    },
  );

  const lonelyAnswer = await answer('contested-open', 'a', await gap('contested-open'), ruled);
  await put(
    'contested-open',
    'premise',
    'contested-open.answer.objection',
    { statement: 'not this' },
    {
      author: AUDITOR,
      relations: [{ to: lonelyAnswer, kind: 'revokes' }],
    },
  );

  await answer('human', 'a', await gap('human'), {
    statement: 'owner picked',
    answeredBy: 'human',
  });
  await answer('unattributed', 'a', await gap('unattributed'), { statement: 'old answer' });

  const precedenceAnswer = await answer('precedence', 'a', await gap('precedence'), {
    ...simulated,
    basis: 'judgment',
  });
  const precedence = await put(
    'precedence',
    'audit',
    'precedence.audit.ok',
    { note: 'checked' },
    {
      author: AUDITOR,
      relations: [{ to: precedenceAnswer, as: 'audits' }],
    },
  );

  await answer('escape', 'a', await gap('escape'), { ...ruled, rule: `rule${ESC}[31m${BIDI}end` });

  await put(
    'forged',
    'premise',
    'forged.answer.a',
    { ...ruled, rule: FORGED },
    {
      author: { ...OCCUPANT, agent: FORGED },
      relations: [{ to: await gap('forged'), as: 'fills-gap' }],
    },
  );

  const question = await gap('mapped', 'question');
  const mappedAnswer = await put('mapped', 'answer', 'mapped.answer.a', ruled, {
    relations: [{ to: question, as: 'answers-question' }],
  });
  const mapped = await put(
    'mapped',
    'review',
    'mapped.review.ok',
    { note: 'checked' },
    {
      author: AUDITOR,
      relations: [{ to: mappedAnswer, as: 'reviews' }],
    },
  );

  return { xdg: home.xdg, criteriaHash, auditIds: { approved, precedence, mapped } };
}

describe('scripts/seat-report.ts', () => {
  let seeded: Seeded;

  beforeAll(async () => {
    seeded = await seedSeat();
  }, SEED_TIMEOUT);

  describe('with the project scope', () => {
    let out: string;

    beforeAll(() => {
      out = runReportOk(seeded.xdg, PROJECT).out;
    }, CLI_TIMEOUT);

    it('should print the six sections in the fixed order', () => {
      expect(Object.keys(sectionsOf(out))).toEqual(SECTION_ORDER);
    });

    it('should list each answer in exactly one section', () => {
      const ids = Object.values(sectionsOf(out)).flatMap((lines) =>
        lines.filter((line) => line !== 'none').map((line) => line.split('  ')[0]),
      );

      expect(new Set(ids).size).toBe(ids.length);
    });

    it('should keep an audited answer without criteria in the criteria section, with the audit suffix', () => {
      const found = placements(out, 'precedence.answer.a');

      expect(found).toEqual([
        {
          section: SECTION.withoutCriteria,
          line: expect.stringContaining(
            `[audited by agent="${AUDITOR.agent}"  model="${AUDITOR.model}" ${seeded.auditIds.precedence}]`,
          ),
        },
      ]);
    });

    it.each([
      ['judgment', 'basis judgment'],
      ['no-basis', 'basis missing'],
      ['no-rule', 'rule missing'],
      ['no-criteria', 'criteria missing'],
    ])(
      'should flag the %s answer in the criteria section as (no criteria: %s)',
      (short, reason) => {
        const found = placements(out, `no-criteria.answer.${short}`);

        expect(found).toEqual([
          {
            section: SECTION.withoutCriteria,
            line: expect.stringContaining(`(no criteria: ${reason})`),
          },
        ]);
      },
    );

    it('should list a gap without a current answer as open', () => {
      const found = placements(out, 'open.gap.q');

      expect(found).toEqual([
        { section: SECTION.openGaps, line: expect.stringContaining('question="which one?"') },
      ]);
    });

    it('should not list a gap that has a current answer as open', () => {
      expect(placements(out, 'pending-audit.gap.q')).toEqual([]);
    });

    it('should put an answer with evidence and a dependent but no audit in the not audited section', () => {
      const found = placements(out, 'pending-audit.answer.a');

      expect(found).toEqual([
        { section: SECTION.notAudited, line: expect.not.stringContaining('[audited by') },
      ]);
    });

    it('should not list the evidence or the dependent of an answer', () => {
      expect(out).not.toContain('pending-audit.evidence.e');
      expect(out).not.toContain('pending-audit.dependent.d');
    });

    it('should print the agent, model, rule, abbreviated criteria hash and action of an answer', () => {
      const [found] = placements(out, 'pending-audit.answer.a');

      expect(found?.line).toContain(
        `pending-audit.answer.a  agent="${OCCUPANT.agent}"  model="${OCCUPANT.model}"  rule="rule-key"  criteria="${seeded.criteriaHash.slice(0, 12)}"  action="web"`,
      );
    });

    it('should put an audited answer in the audited section with the audit agent, model and id', () => {
      const found = placements(out, 'approved.answer.a');

      expect(found).toEqual([
        {
          section: SECTION.audited,
          line: expect.stringContaining(
            `[audited by agent="${AUDITOR.agent}"  model="${AUDITOR.model}" ${seeded.auditIds.approved}]`,
          ),
        },
      ]);
    });

    it('should put the answer back in the not audited section, with no review mark, once its audit is revoked', () => {
      const found = placements(out, 'withdrawn.answer.a');

      expect(found).toEqual([
        { section: SECTION.notAudited, line: expect.not.stringMatching(/audited by|stale|review/) },
      ]);
    });

    it('should ignore the audit that only carries the revokes of a withdrawal', () => {
      expect(out).not.toContain('withdrawn.audit.retraction');
    });

    it('should drop a contested answer and list the human answer that replaced it', () => {
      expect(placements(out, 'contested.answer.a')).toEqual([]);
      expect(placements(out, 'contested.answer.human')).toEqual([
        { section: SECTION.human, line: expect.any(String) },
      ]);
    });

    it('should reopen the gap of a contested answer that has no replacement', () => {
      expect(placements(out, 'contested-open.answer.a')).toEqual([]);
      expect(placements(out, 'contested-open.answer.objection')).toEqual([]);
      expect(placements(out, 'contested-open.gap.q')).toEqual([
        { section: SECTION.openGaps, line: expect.any(String) },
      ]);
    });

    it('should list an answer answered by a human in the human section', () => {
      expect(placements(out, 'human.answer.a')).toEqual([
        { section: SECTION.human, line: expect.any(String) },
      ]);
    });

    it('should list an answer without answeredBy in its own section', () => {
      expect(placements(out, 'unattributed.answer.a')).toEqual([
        { section: SECTION.unattributed, line: expect.any(String) },
      ]);
    });

    it('should leave the records of the mapped type names out when --types is not given', () => {
      expect(out).not.toContain('mapped.');
    });

    it('should escape terminal controls from the record text', () => {
      const [found] = placements(out, 'escape.answer.a');

      expect(found?.line).toContain('rule="rule\\u001b[31m\\u202eend"');
      expect(out).not.toMatch(new RegExp(`[${ESC}${BIDI}]`));
    });

    it('should keep line breaks and TAB in an agent and a rule inside their own answer line', () => {
      const [found] = placements(out, 'forged.answer.a');

      const headers = out
        .split('\n')
        .filter((line) => SECTION_ORDER.some((title) => line.startsWith(`${title} (`)));

      expect(found?.line).toContain(`agent=${JSON.stringify(FORGED)}`);
      expect(found?.line).toContain(`rule=${JSON.stringify(FORGED)}`);
      expect(headers.map((line) => line.replace(/ \(\d+\)$/, ''))).toEqual(SECTION_ORDER);
    });
  });

  describe('with --process', () => {
    let out: string;

    beforeAll(() => {
      out = runReportOk(seeded.xdg, PROJECT, '--process', 'approved').out;
    }, CLI_TIMEOUT);

    it('should list only the records of that process', () => {
      expect(placements(out, 'approved.answer.a')).toHaveLength(1);
      expect(out).not.toContain('pending-audit.');
      expect(out).not.toContain('open.gap.q');
    });

    it('should print none under each empty section', () => {
      const sections = sectionsOf(out);

      expect(sections[SECTION.openGaps]).toEqual(['none']);
      expect(sections[SECTION.human]).toEqual(['none']);
    });
  });

  describe('with --types', () => {
    it(
      'should read the mapped type names and still find the audit of the answer',
      () => {
        const { out } = runReportOk(
          seeded.xdg,
          PROJECT,
          '--process',
          'mapped',
          '--types',
          'gap=question,premise=answer,audit=review',
        );

        expect(placements(out, 'mapped.answer.a')).toEqual([
          {
            section: SECTION.audited,
            line: expect.stringContaining(`[audited by agent="${AUDITOR.agent}"`),
          },
        ]);
      },
      CLI_TIMEOUT,
    );

    it(
      'should keep the default name of a role the mapping does not mention',
      () => {
        const { out } = runReportOk(
          seeded.xdg,
          PROJECT,
          '--process',
          'approved',
          '--types',
          'gap=question',
        );

        expect(placements(out, 'approved.answer.a')).toEqual([
          { section: SECTION.audited, line: expect.any(String) },
        ]);
      },
      CLI_TIMEOUT,
    );
  });

  it(
    'should leave the data dir tree (hash and mtime) unchanged after running',
    () => {
      const before = snapshot(path.join(seeded.xdg, 'hexlog'));

      runReport(seeded.xdg, PROJECT);
      runReport(seeded.xdg, PROJECT, '--process', 'approved');

      expect(snapshot(path.join(seeded.xdg, 'hexlog'))).toEqual(before);
    },
    CLI_TIMEOUT,
  );

  it(
    'should exit 2 with the LEGACY_DATA message over a <D> with 0.x data',
    () => {
      const xdg = copyToXdg(legacyFixture);

      const { code, out, err } = runReport(xdg, PROJECT);

      expect(err).toContain('seat-report failed: LEGACY_DATA:');
      expect(out).toBe('');
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

      expect(err).toContain('seat-report failed: usage:');
      expect(code).toBe(1);
    },
    CLI_TIMEOUT,
  );

  it.each([
    { name: 'an invalid project', args: ['A'] },
    { name: 'an invalid process', args: [PROJECT, '--process', 'Bad'] },
    { name: 'an unknown role in --types', args: [PROJECT, '--types', 'bogus=x'] },
    { name: 'an invalid type name in --types', args: [PROJECT, '--types', 'gap=Bad'] },
    { name: 'a --types item without a name', args: [PROJECT, '--types', 'gap'] },
    { name: 'a --types item with two equals', args: [PROJECT, '--types', 'gap=a=b'] },
  ])(
    'should exit 1 with INVALID_INPUT for $name',
    ({ args }) => {
      const { code, out, err } = runReport(seeded.xdg, ...args);

      expect(err).toContain('seat-report failed: INVALID_INPUT:');
      expect(out).toBe('');
      expect(code).toBe(1);
    },
    CLI_TIMEOUT,
  );

  it(
    'should exit 1 with PROJECT_NOT_FOUND for a missing project',
    () => {
      const { code, err } = runReport(seeded.xdg, 'ghost');

      expect(err).toContain('seat-report failed: PROJECT_NOT_FOUND:');
      expect(code).toBe(1);
    },
    CLI_TIMEOUT,
  );
});
