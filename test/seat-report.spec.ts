import { beforeAll, describe, expect, it } from '@jest/globals';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { RecordType } from '../src/domain/definitions.ts';
import { processPaths } from '../src/adapters/fs/data-format.ts';
import { BATCH_MAX } from '../src/domain/record.ts';
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
const MAIN_SESSION = { agent: 'main-session', model: 'claude-opus-y', client: 'claude-code' };
const OCCUPANT_OTHER_CLIENT = { ...OCCUPANT, client: 'other-client' };

const FORGED = 'x\naudited answers (1)\n  unit-1:fake  fake [audited by agent="a"]\t';
const FORGED_JSON = JSON.stringify(FORGED);
const ESC = String.fromCharCode(0x1b);
const BIDI = String.fromCharCode(0x202e);
const C1_CSI = String.fromCharCode(0x9b);
const DEL = String.fromCharCode(0x7f);
const LINE_SEPARATOR = String.fromCharCode(0x2028);
const VOLUME_GAPS = 52;

const SECTION = {
  withoutCriteria: 'simulated answers without criteria',
  openGaps: 'open gaps',
  notAudited: 'simulated answers not audited',
  audited: 'audited answers',
  human: 'human answers',
  unattributed: 'answers without answeredBy',
  unrecognized: 'answers with an unrecognized answeredBy',
  nonCurrentGap: 'answers to a non-current gap',
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

/** Contagem `(N)` do título de cada seção, pelo título sem ela. */
function countsOf(out: string): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const line of out.split('\n')) {
    const match = /^(\S.*) \((\d+)\)$/.exec(line);
    if (match) counts[at(match, 1)] = Number(at(match, 2));
  }
  return counts;
}

/** Cada seção que lista o `target` (linha `<id>  <target>  ...`), com a linha. */
function placements(out: string, target: string) {
  return Object.entries(sectionsOf(out)).flatMap(([section, lines]) =>
    lines.filter((line) => line.includes(`  ${target}  `)).map((line) => ({ section, line })),
  );
}

const packageType = (name: string) =>
  JSON.parse(fs.readFileSync(path.join(packageDir, `${name}.json`), 'utf8')) as RecordType;

/** `premise` do pacote sem os enums de `answeredBy`, `basis` e `actionUsed`, para registrar o valor que o pacote recusa. */
function loosePremise(): RecordType {
  const premise = packageType('premise');
  const properties = premise.properties as Record<string, unknown>;
  return {
    ...premise,
    properties: {
      ...properties,
      answeredBy: { type: 'string' },
      basis: { type: 'string' },
      actionUsed: { type: 'string' },
    },
  };
}

type Seeded = {
  xdg: string;
  criteriaHash: string;
  auditIds: {
    approved: string;
    precedence: string;
    mapped: string;
    retraction: string;
    forged: string;
  };
  unlistedIds: { evidence: string; dependent: string };
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
    ['loose', loosePremise()],
  ];
  for (const [name, schema] of types) definition.defineType({ project: PROJECT, name, schema });
  const relations = [
    { name: 'fills-gap', kind: 'answers', from: ['premise'], to: ['gap'] },
    { name: 'audits', kind: 'supports', from: ['audit'], to: ['premise'] },
    { name: 'answers-question', kind: 'answers', from: ['answer'], to: ['question'] },
    { name: 'reviews', kind: 'supports', from: ['review'], to: ['answer'] },
    { name: 'fills-gap-loose', kind: 'answers', from: ['loose'], to: ['gap'] },
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
    'forged-answer',
    'forged-gap',
    'forged-audit',
    'forged-loose',
    'volume',
    'mapped',
    'superseded-gap',
    'revoked-gap',
    'human-main',
    'self-audited',
    'other-client-audited',
    'unrecognized-answered-by',
    'unrecognized-basis',
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
      relations?: { to: string; as?: string; kind?: 'revokes' | 'supports' | 'supersedes' }[];
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
  const evidenceId = await put(
    'pending-audit',
    'evidence',
    'pending-audit.evidence.e',
    { summary: 'found', source: evidenceSource },
    {
      relations: [{ to: pending, kind: 'supports' }],
    },
  );
  const dependentId = await put(
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
  const retraction = await put(
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

  await answer('escape', 'a', await gap('escape'), {
    ...ruled,
    rule: `rule${ESC}[31m${BIDI}${C1_CSI}${DEL}${LINE_SEPARATOR}end`,
  });

  const forgedAuthor = { agent: FORGED, model: FORGED, client: FORGED };
  await put(
    'forged-answer',
    'premise',
    'forged-answer.answer.a',
    { ...ruled, rule: FORGED },
    {
      author: forgedAuthor,
      relations: [{ to: await gap('forged-answer'), as: 'fills-gap' }],
    },
  );
  await put(
    'forged-gap',
    'gap',
    'forged-gap.gap.q',
    { question: FORGED, context: 'ctx' },
    { author: forgedAuthor },
  );
  const forgedAuditAnswer = await answer('forged-audit', 'a', await gap('forged-audit'), ruled);
  const forgedAudit = await put(
    'forged-audit',
    'audit',
    'forged-audit.audit.ok',
    { note: 'checked' },
    {
      author: { ...AUDITOR, agent: FORGED, model: FORGED },
      relations: [{ to: forgedAuditAnswer, as: 'audits' }],
    },
  );
  await put(
    'forged-loose',
    'loose',
    'forged-loose.answer.a',
    { ...ruled, actionUsed: FORGED },
    { relations: [{ to: await gap('forged-loose'), as: 'fills-gap-loose' }] },
  );

  const putMany = async (
    process: string,
    type: string,
    items: {
      target: string;
      data: Record<string, string>;
      relations?: { to: string; as: string }[];
    }[],
  ) => {
    const ids: string[] = [];
    for (let start = 0; start < items.length; start += BATCH_MAX) {
      const { records } = await processes.register({
        project: PROJECT,
        process,
        author: OCCUPANT,
        key: `k${(sequence += 1)}`,
        records: items.slice(start, start + BATCH_MAX).map((item) => ({ type, ...item })),
      });
      ids.push(...records.map(({ id }) => id));
    }
    return ids;
  };
  const volumeGaps = await putMany(
    'volume',
    'gap',
    Array.from({ length: VOLUME_GAPS }, (_, index) => ({
      target: `volume.gap.g${index}`,
      data: { question: 'which one?', context: 'ctx' },
    })),
  );
  await putMany(
    'volume',
    'premise',
    volumeGaps.slice(0, -1).map((gapId, index) => ({
      target: `volume.answer.a${index}`,
      data: { statement: 'owner picked', answeredBy: 'human' },
      relations: [{ to: gapId, as: 'fills-gap' }],
    })),
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

  const supersededGap = await gap('superseded-gap');
  await answer('superseded-gap', 'a', supersededGap, ruled);
  await put(
    'superseded-gap',
    'gap',
    'superseded-gap.gap.q',
    { question: 'which one, now?', context: 'ctx' },
    { author: AUTHOR, relations: [{ to: supersededGap, kind: 'supersedes' }] },
  );

  const revokedGap = await gap('revoked-gap');
  await answer('revoked-gap', 'a', revokedGap, ruled);
  await put(
    'revoked-gap',
    'gap',
    'revoked-gap.gap.dropped',
    { question: 'never mind', context: 'ctx' },
    { author: AUTHOR, relations: [{ to: revokedGap, kind: 'revokes' }] },
  );

  await put(
    'human-main',
    'premise',
    'human-main.answer.a',
    { statement: 'owner picked', answeredBy: 'human' },
    { author: MAIN_SESSION, relations: [{ to: await gap('human-main'), as: 'fills-gap' }] },
  );

  const selfAnswer = await answer('self-audited', 'a', await gap('self-audited'), ruled);
  await put(
    'self-audited',
    'audit',
    'self-audited.audit.ok',
    { note: 'checked' },
    { author: OCCUPANT, relations: [{ to: selfAnswer, as: 'audits' }] },
  );

  const otherClientAnswer = await answer(
    'other-client-audited',
    'a',
    await gap('other-client-audited'),
    ruled,
  );
  await put(
    'other-client-audited',
    'audit',
    'other-client-audited.audit.ok',
    { note: 'checked' },
    { author: OCCUPANT_OTHER_CLIENT, relations: [{ to: otherClientAnswer, as: 'audits' }] },
  );

  const putLoose = async (process: string, data: Record<string, string>) =>
    put(process, 'loose', `${process}.answer.a`, data, {
      relations: [{ to: await gap(process), as: 'fills-gap-loose' }],
    });
  await putLoose('unrecognized-answered-by', {
    statement: 'approved by me',
    answeredBy: 'simulated-approved',
  });
  await putLoose('unrecognized-basis', { ...ruled, basis: 'gut' });

  return {
    xdg: home.xdg,
    criteriaHash,
    auditIds: { approved, precedence, mapped, retraction, forged: forgedAudit },
    unlistedIds: { evidence: evidenceId, dependent: dependentId },
  };
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

    it('should print the eight sections in the fixed order', () => {
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
            `[audited by agent="${AUDITOR.agent}"  model="${AUDITOR.model}"  client="${AUDITOR.client}" ${seeded.auditIds.precedence}]`,
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
      expect(out).not.toContain(seeded.unlistedIds.evidence);
      expect(out).not.toContain(seeded.unlistedIds.dependent);
    });

    it('should print the agent, model, client, rule, abbreviated criteria hash and action of an answer', () => {
      const [found] = placements(out, 'pending-audit.answer.a');

      expect(found?.line).toContain(
        `pending-audit.answer.a  agent="${OCCUPANT.agent}"  model="${OCCUPANT.model}"  client="${OCCUPANT.client}"  rule="rule-key"  criteria="${seeded.criteriaHash.slice(0, 12)}"  action="web"`,
      );
    });

    it('should put an audited answer in the audited section with the audit agent, model and id', () => {
      const found = placements(out, 'approved.answer.a');

      expect(found).toEqual([
        {
          section: SECTION.audited,
          line: expect.stringContaining(
            `[audited by agent="${AUDITOR.agent}"  model="${AUDITOR.model}"  client="${AUDITOR.client}" ${seeded.auditIds.approved}]`,
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
      expect(out).not.toContain(seeded.auditIds.retraction);
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

    it.each([
      ['superseded', 'superseded-gap'],
      ['revoked', 'revoked-gap'],
    ])('should list the answer to a %s gap in the non-current gap section', (_name, process) => {
      const found = placements(out, `${process}.answer.a`);

      expect(found).toEqual([{ section: SECTION.nonCurrentGap, line: expect.any(String) }]);
    });

    it('should list the replacement of a superseded gap as open', () => {
      expect(placements(out, 'superseded-gap.gap.q')).toEqual([
        { section: SECTION.openGaps, line: expect.any(String) },
      ]);
    });

    it('should mark a human answer whose agent is an owner-seat agent', () => {
      const found = placements(out, 'human.answer.a');

      expect(found).toEqual([
        {
          section: SECTION.human,
          line: expect.stringContaining('(agent is an owner-seat occupant)'),
        },
      ]);
    });

    it('should not mark a human answer whose agent is not an owner-seat agent', () => {
      const found = placements(out, 'human-main.answer.a');

      expect(found).toEqual([
        {
          section: SECTION.human,
          line: expect.not.stringContaining('owner-seat occupant'),
        },
      ]);
    });

    it('should mark an audit written by the same author as the answer', () => {
      const found = placements(out, 'self-audited.answer.a');

      expect(found).toEqual([
        {
          section: SECTION.audited,
          line: expect.stringContaining('(same author as the answer)]'),
        },
      ]);
    });

    it.each([
      ['another agent', 'approved.answer.a'],
      ['the same agent on another client', 'other-client-audited.answer.a'],
    ])('should not mark an audit written by %s', (_name, target) => {
      const [found] = placements(out, target);

      expect(found?.line).toContain('[audited by');
      expect(found?.line).not.toContain('same author');
    });

    it('should leave the records of the mapped type names out when --types is not given', () => {
      expect(out).not.toContain('mapped.');
    });

    it('should print the count of each section title equal to the number of its lines', () => {
      const lines = Object.entries(sectionsOf(out)).map(
        ([title, body]) => [title, body[0] === 'none' ? 0 : body.length] as const,
      );

      expect(countsOf(out)).toEqual(Object.fromEntries(lines));
    });

    it('should escape terminal controls from the record text', () => {
      const [found] = placements(out, 'escape.answer.a');

      expect(found?.line).toContain('rule="rule\\u001b[31m');
      expect(out).not.toMatch(new RegExp(`[${ESC}]`));
    });

    it.each([
      ['bidi override', BIDI, '\\u202e'],
      ['C1 control', C1_CSI, '\\u009b'],
      ['DEL', DEL, '\\u007f'],
      ['line separator', LINE_SEPARATOR, '\\u2028'],
    ])('should escape the %s that JSON.stringify leaves raw', (_name, character, escaped) => {
      const [found] = placements(out, 'escape.answer.a');

      expect(found?.line).toContain(escaped);
      expect(out).not.toContain(character);
    });

    it.each([
      ['answer agent', 'forged-answer.answer.a', `agent=${FORGED_JSON}`],
      ['answer model', 'forged-answer.answer.a', `model=${FORGED_JSON}`],
      ['answer client', 'forged-answer.answer.a', `client=${FORGED_JSON}`],
      ['answer rule', 'forged-answer.answer.a', `rule=${FORGED_JSON}`],
      ['gap question', 'forged-gap.gap.q', `question=${FORGED_JSON}`],
      ['gap agent', 'forged-gap.gap.q', `agent=${FORGED_JSON}`],
      ['gap model', 'forged-gap.gap.q', `model=${FORGED_JSON}`],
      ['audit agent', 'forged-audit.answer.a', `[audited by agent=${FORGED_JSON}`],
      ['audit model', 'forged-audit.answer.a', `model=${FORGED_JSON}  client="claude-code" `],
    ])('should keep the %s with line breaks and TAB inside its own line', (_name, target, text) => {
      const [found] = placements(out, target);

      expect(found?.line).toContain(text);
    });

    it('should not let a forged value start a section header', () => {
      const headers = out
        .split('\n')
        .filter((line) => SECTION_ORDER.some((title) => line.startsWith(`${title} (`)));

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

    it.each([
      ['approved', 'open gaps (0)'],
      ['approved', 'audited answers (1)'],
      ['open', 'open gaps (1)'],
    ])(
      'should print the title with the count when --process is %s: %s',
      (process, title) => {
        const report = runReportOk(seeded.xdg, PROJECT, '--process', process).out;

        expect(report.split('\n')).toContain(title);
      },
      CLI_TIMEOUT,
    );
  });

  describe('with more records of a role than the service page size', () => {
    let out: string;

    beforeAll(() => {
      out = runReportOk(seeded.xdg, PROJECT, '--process', 'volume').out;
    }, CLI_TIMEOUT);

    it('should count every answer past the first service page', () => {
      expect(countsOf(out)[SECTION.human]).toBe(VOLUME_GAPS - 1);
    });

    it('should list the open gap past the first service page', () => {
      const found = placements(out, `volume.gap.g${VOLUME_GAPS - 1}`);

      expect(found).toEqual([{ section: SECTION.openGaps, line: expect.any(String) }]);
    });
  });

  describe('with an answer the package types would refuse', () => {
    let out: string;

    beforeAll(() => {
      out = runReportOk(seeded.xdg, PROJECT, '--types', 'premise=loose').out;
    }, CLI_TIMEOUT);

    it('should list an unrecognized answeredBy in its own section with the value quoted', () => {
      const found = placements(out, 'unrecognized-answered-by.answer.a');

      expect(found).toEqual([
        {
          section: SECTION.unrecognized,
          line: expect.stringContaining('answeredBy="simulated-approved"'),
        },
      ]);
    });

    it('should flag an unrecognized basis apart from a missing one', () => {
      const found = placements(out, 'unrecognized-basis.answer.a');

      expect(found).toEqual([
        {
          section: SECTION.withoutCriteria,
          line: expect.stringContaining('(no criteria: basis unrecognized "gut")'),
        },
      ]);
    });

    it('should keep the action with line breaks and TAB inside its own line', () => {
      const [found] = placements(out, 'forged-loose.answer.a');

      expect(found?.line).toContain(`action=${FORGED_JSON}`);
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
    'should exit 2 with PROCESS_CORRUPTED and no report over a tampered chain',
    () => {
      const xdg = copyToXdg(path.join(seeded.xdg, 'hexlog'));
      const { log } = processPaths(path.join(xdg, 'hexlog'), {
        project: PROJECT,
        process: 'approved',
      });
      fs.writeFileSync(log, fs.readFileSync(log, 'utf8').replace('"which one?"', '"tampered"'));

      const { code, out, err } = runReport(xdg, PROJECT);

      expect(err).toContain(
        'seat-report failed: PROCESS_CORRUPTED: process chain is broken (approved:',
      );
      expect(out).toBe('');
      expect(code).toBe(2);
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

  describe('with a role that has no records', () => {
    let xdg: string;

    beforeAll(() => {
      const home = createDataHome();
      const { definition, process: processes } = composeIn(home);
      definition.defineType({ project: 'nopkg', name: 'note', schema: NOTE });
      processes.createProcess({ project: 'nopkg', process: 'w' });
      for (const name of ['gap', 'premise', 'audit']) {
        definition.defineType({ project: 'bare', name, schema: packageType(name) });
      }
      processes.createProcess({ project: 'bare', process: 'w' });
      xdg = home.xdg;
    }, SEED_TIMEOUT);

    it(
      'should exit 1 naming every role whose type the project does not define',
      () => {
        const { code, out, err } = runReport(xdg, 'nopkg');

        expect(err).toContain(
          'seat-report failed: INVALID_INPUT: type not defined in the project: gap=gap, premise=premise, audit=audit',
        );
        expect(out).toBe('');
        expect(code).toBe(1);
      },
      CLI_TIMEOUT,
    );

    it(
      'should exit 1 for a mistyped --types name even when the other roles have records',
      () => {
        const { code, out, err } = runReport(seeded.xdg, PROJECT, '--types', 'gap=gapp');

        expect(err).toContain('type not defined in the project: gap=gapp');
        expect(out).toBe('');
        expect(code).toBe(1);
      },
      CLI_TIMEOUT,
    );

    it(
      'should print none under every section without a warning when the types exist',
      () => {
        const { code, out, err } = runReport(xdg, 'bare');

        expect(Object.values(sectionsOf(out)).every((lines) => lines.join() === 'none')).toBe(true);
        expect(err).toBe('');
        expect(code).toBe(0);
      },
      CLI_TIMEOUT,
    );
  });

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
