import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, test } from '@jest/globals';
import { omit } from 'es-toolkit';
import { z } from 'zod';
import {
  parsePremises,
  planSync,
  scanPremises,
  type ExtractedRule,
  type PlannedRecord,
  type SyncInput,
  type SyncPlan,
  type VigentRule,
} from '../scripts/flow/sync.ts';
import type { Defined } from '../src/commands/definition.ts';
import type { RegisterResult } from '../src/commands/process.ts';
import { hashOfJcs, sha256hex } from '../src/domain/chain.ts';
import type {
  GateEvaluation,
  ListResult,
  QueryRecord,
  QueryResult,
  VerifyChainResult,
} from '../src/queries/query-service.ts';
import { KINDS, defineFlowDefinitions, definitionOf, namesIn } from './flow-data.ts';
import { at, createTempDir } from './helpers.ts';
import { type Environment, createEnvironment, expectError } from './mcp/environment.ts';

const repoRoot = path.resolve(__dirname, '..');
const flowDir = path.join(repoRoot, 'scripts/flow');

const PROJECT = 'hexlog';
const DIRECTIVES = 'directives';
const WORK = 'feat-x';
const AGENT = 'flow-run';
const COMMIT = 'abc1234';

let environment: Environment;
let defined: Record<string, Defined>;

beforeEach(async () => {
  environment = await createEnvironment();
  defined = await defineFlowDefinitions(environment);
  for (const process of [DIRECTIVES, `${DIRECTIVES}-2`, WORK]) {
    await environment.ok('create_process', { project: PROJECT, process });
  }
});

afterEach(async () => {
  await environment.close();
});

// ---- gravação e leitura ----

type Item = {
  type: string;
  target: string;
  data: Record<string, unknown>;
  alias?: string;
  relations?: Record<string, unknown>[];
};

const writeBatch = (process: string, records: Item[], key?: string) =>
  environment.call('register', { project: PROJECT, process, agent: AGENT, key, records });

const register = (process: string, records: Item[], key?: string) =>
  environment.ok<RegisterResult>('register', {
    project: PROJECT,
    process,
    agent: AGENT,
    key,
    records,
  });

/** Registro `directive` de `convencoes`; `text` é o conteúdo do anexo que `source` cita. */
const directiveItem = (
  slug: string,
  text: string,
  relations: Record<string, unknown>[] = [],
): Item => ({
  type: 'directive',
  target: `directives.convencoes.${slug}`,
  data: { rule: `Rule ${slug}`, section: 'Section', source: sha256hex(text) },
  relations,
});

/** Id do único registro gravado. */
async function registerOne(process: string, record: Item): Promise<string> {
  const { records } = await register(process, [record]);
  return at(records, 0).id;
}

/** Todas as páginas de um `query`, seguindo o `cursor` até ele sumir. */
async function queryAll(
  args: Record<string, unknown>,
): Promise<{ records: QueryRecord[]; pages: number }> {
  const records: QueryRecord[] = [];
  let cursor: string | undefined;
  let pages = 0;
  do {
    const page = await environment.ok<QueryResult>('query', {
      project: PROJECT,
      relations: 'full',
      ...args,
      cursor,
    });
    records.push(...page.records);
    cursor = page.cursor;
    pages += 1;
  } while (cursor);
  return { records, pages };
}

const evaluate = (gate: string, process = WORK) =>
  environment.ok<GateEvaluation>('evaluate_gate', {
    project: PROJECT,
    process,
    gate,
    target: WORK,
  });

const passed = async (gate: string): Promise<boolean> => (await evaluate(gate)).passed;

// ---- dados de exemplo ----

const opening = () => ({
  mode: 'autonomous',
  route: 'direct',
  request: 'Add retry to the uploader',
  branch: 'feat/x',
  commit: COMMIT,
  sync: 'up-to-date',
});

const decisionData = (overrides: Record<string, unknown> = {}) => ({
  choice: 'Use exponential backoff',
  alternatives: [{ option: 'Fixed delay', reason: 'Piles up retries under load' }],
  rationale: 'The directive asks for bounded retries',
  grounds: 'directive',
  confidence: 'high',
  ...overrides,
});

const gapData = () => ({
  question: 'How many attempts before giving up?',
  context: 'No directive covers retry limits',
  provisionalChoice: '3 attempts',
});

const findingData = (severity: string) => ({
  severity,
  origin: 'review',
  description: 'Retry loop has no upper bound',
  location: 'src/upload.ts',
});

const verificationData = (result: 'passed' | 'failed') => ({
  result,
  commit: COMMIT,
  commands: [{ command: 'npm test', ok: result === 'passed', summary: `tests ${result}` }],
});

const workRecord = (type: string, short: string, data: Record<string, unknown>): Item => ({
  type,
  target: `${WORK}.${type}.${short}`,
  data,
});

const registerGap = (short = 'retry') => registerOne(WORK, workRecord('gap', short, gapData()));

// ---- sync (a rotina da skill, em volta do módulo puro) ----

const docPath = (docSlug: string) => `docs/directives/${docSlug}.md`;

/** `n` regras com texto perto do teto de 400 caracteres, para a consulta passar de uma página. */
const rulesOf = (count: number, prefix = 'r', version = 1): ExtractedRule[] =>
  Array.from({ length: count }, (_, index) => ({
    slug: `${prefix}${index + 1}`,
    rule: `Rule ${prefix}${index + 1} v${version}: ${'x'.repeat(350)}`,
    section: 'Section',
  }));

/** Premissas de `estrategia`, com texto dentro do teto de 255 caracteres do `statement`. */
const premisesOf = (count: number, prefix = 'p', version = 1): ExtractedRule[] =>
  Array.from({ length: count }, (_, index) => ({
    slug: `${prefix}${index + 1}`,
    rule: `Premise ${prefix}${index + 1} v${version}`,
    section: '',
  }));

const STRATEGY = 'estrategia';
const RuleData = z.object({ rule: z.string(), section: z.string() });
// `estrategia` carrega premissas: o `statement` faz o papel de `rule` e não há seção.
const PremiseData = z
  .object({ statement: z.string() })
  .transform(({ statement }) => ({ rule: statement, section: '' }));
const DocData = z.object({ source: z.string(), removed: z.boolean().default(false) });

async function inputFor(
  process: string,
  docSlug: string,
  text: string | null,
  extracted: ExtractedRule[] | null,
): Promise<SyncInput> {
  const prefix = `directives.${docSlug}`;
  const docs = await queryAll({ process, type: 'doc', targetPrefix: prefix });
  expect(docs.records.length).toBeLessThanOrEqual(1);
  const doc = docs.records[0];
  const strategy = docSlug === STRATEGY;
  const rules = await queryAll({
    process,
    type: strategy ? 'premise' : 'directive',
    targetPrefix: prefix,
  });
  const vigent: VigentRule[] = rules.records.map(({ id, target, data, out }) => ({
    id,
    target,
    ...(strategy ? PremiseData : RuleData).parse(data),
    out: (out ?? []).map(({ as, kind, to }) => ({ ...(as && { as }), kind, to })),
  }));
  return {
    docSlug,
    path: docPath(docSlug),
    hash: text === null ? '' : sha256hex(text),
    current: doc ? { id: doc.id, ...DocData.parse(doc.data) } : null,
    vigent,
    extracted,
  };
}

/** Planeja e grava os lotes em ordem, com o anexo guardado antes (a rotina da `flow-run`). */
async function runSync(
  process: string,
  docSlug: string,
  text: string | null,
  extracted: ExtractedRule[] | null,
  tweak: (records: PlannedRecord[]) => PlannedRecord[] = (records) => records,
): Promise<SyncPlan> {
  const plan = planSync(await inputFor(process, docSlug, text, extracted));
  if (plan.upToDate || plan.error) return plan;
  if (text !== null) await environment.ok('attach', { project: PROJECT, text });
  for (const batch of plan.batches) await register(process, tweak(batch.records), batch.key);
  return plan;
}

/** As regras fecham a lacuna: a extração entrega `closes` e o módulo planeja o `closes-gap`. */
const closingRules = (rules: ExtractedRule[], gapId: string): ExtractedRule[] =>
  rules.map((rule) => ({ ...rule, closes: [gapId] }));

const currentDirective = async (slug: string, docSlug = 'convencoes', process = DIRECTIVES) =>
  at(
    (await queryAll({ process, type: 'directive', targetPrefix: `directives.${docSlug}.${slug}` }))
      .records,
    0,
  );

const currentPremise = async (slug: string, process = DIRECTIVES) =>
  at(
    (await queryAll({ process, type: 'premise', targetPrefix: `directives.${STRATEGY}.${slug}` }))
      .records,
    0,
  );

/** Premissa atemporal `p1` carregada na geração 2 por sync de `estrategia`; devolve o id dela. */
async function seedPremise(text = 'v1'): Promise<string> {
  await runSync(`${DIRECTIVES}-2`, STRATEGY, text, premisesOf(1));
  return (await currentPremise('p1', `${DIRECTIVES}-2`)).id;
}

/** `convencoes` v1 com `r1`, uma lacuna e a v2 cuja regra `retry1` a fecha; devolve o id da lacuna. */
async function seedClosedGap(): Promise<string> {
  await runSync(DIRECTIVES, 'convencoes', 'v1', rulesOf(1));
  const gapId = await registerGap();
  await runSync(DIRECTIVES, 'convencoes', 'v2', [
    ...rulesOf(1),
    ...closingRules(rulesOf(1, 'retry'), gapId),
  ]);
  return gapId;
}

/** Sincroniza `convencoes` com uma regra `r1` e devolve o id dela, para ancorar decisões. */
async function seedDirective(): Promise<string> {
  await runSync(DIRECTIVES, 'convencoes', 'v1', rulesOf(1));
  return (await currentDirective('r1')).id;
}

describe('schemas and relations', () => {
  test('each type accepts a valid record', async () => {
    await seedDirective();

    const { records } = await register(WORK, [
      workRecord('opening', 'main', opening()),
      workRecord('decision', 'a', decisionData()),
      workRecord('gap', 'a', gapData()),
      workRecord('finding', 'a', findingData('NORMAL')),
      workRecord('verification', 'main', verificationData('passed')),
    ]);

    expect(records).toHaveLength(5);
    const seeded = await queryAll({ process: DIRECTIVES });
    expect(seeded.records.map(({ type }) => type).sort()).toEqual(['directive', 'doc']);
  });

  test.each([
    ['without grounds', omit(decisionData(), ['grounds'])],
    ['without rationale', omit(decisionData(), ['rationale'])],
    ['with an unknown field', decisionData({ extra: 'x' })],
    ['without alternatives', decisionData({ alternatives: [] })],
    ['with confidence outside the enum', decisionData({ confidence: 'sure' })],
  ])('decision %s is INVALID_RECORD', async (_label, data) => {
    const result = await writeBatch(WORK, [workRecord('decision', 'bad', data)]);

    expectError(result, 'INVALID_RECORD');
  });

  test.each([
    [
      'opening with mode outside the enum',
      workRecord('opening', 'main', { ...opening(), mode: 'x' }),
    ],
    [
      'opening with a commit that is not a sha',
      workRecord('opening', 'main', { ...opening(), commit: 'HEAD' }),
    ],
    ['gap without context', workRecord('gap', 'a', { question: 'Q?' })],
    ['finding with severity outside the enum', workRecord('finding', 'a', findingData('HIGH'))],
    [
      'verification with 13 commands',
      workRecord('verification', 'main', {
        ...verificationData('passed'),
        commands: Array.from({ length: 13 }, () => ({ command: 'npm test', ok: true })),
      }),
    ],
  ])('%s is INVALID_RECORD', async (_label, record) => {
    expectError(await writeBatch(WORK, [record]), 'INVALID_RECORD');
  });

  test('a commit that is not a git-sha is refused with the format code at the field path', async () => {
    const result = await writeBatch(WORK, [
      workRecord('verification', 'main', { ...verificationData('passed'), commit: 'HEAD' }),
    ]);

    expect(expectError(result, 'INVALID_RECORD').details).toEqual([
      expect.objectContaining({ path: '/records/0/data/commit', code: 'format' }),
    ]);
  });

  test('doc with an empty path is INVALID_RECORD; the path rule lives in the planSync guard', async () => {
    const { hash: source } = await environment.ok<{ hash: string }>('attach', {
      project: PROJECT,
      text: 'v1',
    });

    const empty = await writeBatch(DIRECTIVES, [
      { type: 'doc', target: 'directives.x', data: { path: '', source } },
    ]);
    expectError(empty, 'INVALID_RECORD');

    const { records } = await register(DIRECTIVES, [
      { type: 'doc', target: 'directives.x', data: { path: 'docs/x.md', source } },
      { type: 'doc', target: 'directives.y', data: { path: docPath('y'), source } },
    ]);
    expect(records).toHaveLength(2);
  });

  test('an attachment hash that was not stored is ATTACHMENT_NOT_FOUND', async () => {
    const result = await writeBatch(DIRECTIVES, [directiveItem('r1', 'never attached')]);

    expectError(result, 'ATTACHMENT_NOT_FOUND');
  });

  test('the four relations accept the declared endpoints', async () => {
    const directiveId = await seedDirective();
    const gapId = await registerGap();
    const findingId = await registerOne(WORK, workRecord('finding', 'a', findingData('URGENT')));

    const decisionId = await registerOne(WORK, {
      ...workRecord('decision', 'a', decisionData()),
      relations: [
        { to: directiveId, as: 'anchored-in' },
        { to: gapId, as: 'about-gap' },
        { to: findingId, as: 'resolves-finding' },
      ],
    });
    const closerId = await registerOne(
      DIRECTIVES,
      directiveItem('r2', 'v1', [{ to: gapId, as: 'closes-gap' }]),
    );

    const stored = await queryAll({ scope: 'project', ids: [decisionId, closerId] });
    const outOf = (id: string) => stored.records.find((record) => record.id === id)?.out;
    expect(
      outOf(decisionId)
        ?.map(({ as }) => as)
        .sort(),
    ).toEqual(['about-gap', 'anchored-in', 'resolves-finding']);
    expect(outOf(closerId)?.map(({ as }) => as)).toEqual(['closes-gap']);
  });

  test('decision does not close a gap: closes-gap requires a directive origin (endpoint-type)', async () => {
    const gapId = await registerGap();

    const body = expectError(
      await writeBatch(WORK, [
        {
          ...workRecord('decision', 'a', decisionData()),
          relations: [{ to: gapId, as: 'closes-gap' }],
        },
      ]),
      'INVALID_RECORD',
    );

    expect(body.details[0]?.code).toBe('endpoint-type');
  });

  type Ends = { gapId: string; findingId: string };
  test.each([
    [
      'directive with resolves-finding',
      ({ findingId }: Ends): [string, Item] => [
        DIRECTIVES,
        directiveItem('r9', 'v1', [{ to: findingId, as: 'resolves-finding' }]),
      ],
    ],
    [
      'decision with anchored-in to a gap',
      ({ gapId }: Ends): [string, Item] => [
        WORK,
        {
          ...workRecord('decision', 'b', decisionData()),
          relations: [{ to: gapId, as: 'anchored-in' }],
        },
      ],
    ],
    [
      'decision with about-gap to a finding',
      ({ findingId }: Ends): [string, Item] => [
        WORK,
        {
          ...workRecord('decision', 'b', decisionData()),
          relations: [{ to: findingId, as: 'about-gap' }],
        },
      ],
    ],
  ])('endpoint outside the declared ones: %s is INVALID_RECORD', async (_label, build) => {
    await seedDirective();
    const gapId = await registerGap();
    const findingId = await registerOne(WORK, workRecord('finding', 'a', findingData('URGENT')));
    const [process, record] = build({ gapId, findingId });

    const body = expectError(await writeBatch(process, [record]), 'INVALID_RECORD');

    expect(body.details[0]?.code).toBe('endpoint-type');
  });
});

describe('gate pre-pr', () => {
  test('fails without verification', async () => {
    expect(await passed('pre-pr')).toBe(false);
  });

  test('passes with a passed verification and fails again when a failed one supersedes it', async () => {
    const passedId = await registerOne(
      WORK,
      workRecord('verification', 'main', verificationData('passed')),
    );
    expect(await passed('pre-pr')).toBe(true);

    await register(WORK, [
      {
        ...workRecord('verification', 'main', verificationData('failed')),
        relations: [{ kind: 'supersedes', to: passedId }],
      },
    ]);

    expect(await passed('pre-pr')).toBe(false);
  });

  test('fails with an URGENT finding lacking resolves-finding and passes with a decision that resolves it', async () => {
    const directiveId = await seedDirective();
    await register(WORK, [workRecord('verification', 'main', verificationData('passed'))]);
    const findingId = await registerOne(WORK, workRecord('finding', 'a', findingData('URGENT')));
    expect(await passed('pre-pr')).toBe(false);

    await register(WORK, [
      {
        ...workRecord(
          'decision',
          'fix',
          decisionData({ rationale: 'Accepted as is: the loop is bounded by the caller' }),
        ),
        relations: [
          { to: findingId, as: 'resolves-finding' },
          { to: directiveId, as: 'anchored-in' },
        ],
      },
    ]);

    expect(await passed('pre-pr')).toBe(true);
  });

  test('a NORMAL finding does not block, and a raw answers from another type does not resolve the URGENT one', async () => {
    await register(WORK, [workRecord('verification', 'main', verificationData('passed'))]);
    await registerOne(WORK, workRecord('finding', 'n', findingData('NORMAL')));
    expect(await passed('pre-pr')).toBe(true);

    const urgentId = await registerOne(WORK, workRecord('finding', 'u', findingData('URGENT')));
    await register(WORK, [
      { ...workRecord('gap', 'g', gapData()), relations: [{ kind: 'answers', to: urgentId }] },
    ]);

    expect(await passed('pre-pr')).toBe(false);
  });
});

describe('gate gaps (directive or premise closes a gap)', () => {
  const closeWithDirective = (gapId: string) =>
    register(DIRECTIVES, [directiveItem('retries', 'v1', [{ to: gapId, as: 'closes-gap' }])]);

  test('passes without any gap and fails with an open gap', async () => {
    expect(await passed('gaps')).toBe(true);

    await registerGap();

    expect(await passed('gaps')).toBe(false);
  });

  test('passes when a directive from another process closes the gap', async () => {
    await environment.ok('attach', { project: PROJECT, text: 'v1' });
    const gapId = await registerGap();

    await closeWithDirective(gapId);

    expect(await passed('gaps')).toBe(true);
  });

  test('keeps failing with a redone decision and a raw answers from a decision to the gap', async () => {
    const gapId = await registerGap();
    const firstId = await registerOne(WORK, {
      ...workRecord('decision', 'a', decisionData({ grounds: 'gap' })),
      relations: [{ to: gapId, as: 'about-gap' }],
    });

    await register(WORK, [
      {
        ...workRecord('decision', 'a', decisionData({ grounds: 'gap', choice: 'Redone' })),
        relations: [
          { kind: 'supersedes', to: firstId },
          { to: gapId, as: 'about-gap' },
          { kind: 'answers', to: gapId },
        ],
      },
    ]);

    expect(await passed('gaps')).toBe(false);
  });
});

describe('sync', () => {
  test('(i) load of 60 rules in two pages and two batches, and the editorial edit only replaces the doc', async () => {
    const rules = rulesOf(60);

    const load = await runSync(DIRECTIVES, 'fronteiras', 'v1', rules);

    expect(load.batches.map(({ records }) => records.length)).toEqual([50, 11]);
    expect(at(load.batches, 1).records.at(-1)?.type).toBe('doc');
    expect(load.batches[0]?.key).toMatch(/^sync-fronteiras-[0-9a-f]{12}-[0-9a-f]{12}$/);
    const loaded = await queryAll({
      process: DIRECTIVES,
      type: 'directive',
      targetPrefix: 'directives.fronteiras',
    });
    expect(loaded.records).toHaveLength(60);
    expect(loaded.pages).toBeGreaterThanOrEqual(2);

    const edit = await runSync(DIRECTIVES, 'fronteiras', 'v1 with a typo fixed', rules);

    expect(edit.batches).toHaveLength(1);
    expect(at(edit.batches, 0).records.map(({ type }) => type)).toEqual(['doc']);
    expect((await runSync(DIRECTIVES, 'fronteiras', 'v1 with a typo fixed', rules)).upToDate).toBe(
      true,
    );
  });

  test('(i) without a hash change the result is up to date and has no batch', async () => {
    await runSync(DIRECTIVES, 'fronteiras', 'v1', rulesOf(3));

    const again = await runSync(DIRECTIVES, 'fronteiras', 'v1', rulesOf(3));

    expect(again).toEqual({ upToDate: true, batches: [], warnings: [] });
  });

  test('(ii) an intact rule is not superseded and the changed one gets a new record', async () => {
    await runSync(DIRECTIVES, 'fronteiras', 'v1', rulesOf(2));
    const [untouched, changed] = [
      await currentDirective('r1', 'fronteiras'),
      await currentDirective('r2', 'fronteiras'),
    ];
    const edited = [at(rulesOf(2), 0), at(rulesOf(2, 'r', 2), 1)];

    const plan = await runSync(DIRECTIVES, 'fronteiras', 'v2', edited);

    expect(at(plan.batches, 0).records.map(({ target }) => target)).toEqual([
      'directives.fronteiras.r2',
      'directives.fronteiras',
    ]);
    expect((await currentDirective('r1', 'fronteiras')).id).toBe(untouched.id);
    expect((await currentDirective('r2', 'fronteiras')).id).not.toBe(changed.id);
  });

  test('(iii) changed rule that closed a gap: with the copy the gate keeps passing', async () => {
    const gapId = await seedClosedGap();
    expect(await passed('gaps')).toBe(true);

    const plan = await runSync(DIRECTIVES, 'convencoes', 'v3', [
      ...rulesOf(1),
      ...rulesOf(1, 'retry', 2),
    ]);

    expect(at(plan.batches, 0).records[0]?.relations).toEqual(
      expect.arrayContaining([expect.objectContaining({ as: 'closes-gap', to: gapId })]),
    );
    expect(await passed('gaps')).toBe(true);
  });

  test('(iii) without copying closes-gap the gate fails again', async () => {
    await seedClosedGap();
    await runSync(
      DIRECTIVES,
      'convencoes',
      'v3',
      [...rulesOf(1), ...rulesOf(1, 'retry', 2)],
      (records) =>
        records.map((record) => ({
          ...record,
          relations: record.relations.filter(({ as }) => as !== 'closes-gap'),
        })),
    );

    expect(await passed('gaps')).toBe(false);
  });

  test('closes: a new rule closes the gap and the gate passes; without closes the gap stays open', async () => {
    await runSync(DIRECTIVES, 'convencoes', 'v1', rulesOf(1));
    const gapId = await registerGap();

    await runSync(DIRECTIVES, 'convencoes', 'v2', [...rulesOf(1), ...rulesOf(1, 'retry')]);
    expect(await passed('gaps')).toBe(false);
    const before = await currentDirective('retry1');

    const plan = await runSync(DIRECTIVES, 'convencoes', 'v3', [
      ...rulesOf(1),
      ...closingRules(rulesOf(1, 'retry', 2), gapId),
    ]);

    expect(at(plan.batches, 0).records[0]?.relations).toEqual([
      { kind: 'supersedes', to: before.id },
      { to: gapId, as: 'closes-gap' },
    ]);
    expect(await passed('gaps')).toBe(true);
  });

  test('closes: a new rule with no previous version carries only closes-gap, without supersedes', async () => {
    await runSync(DIRECTIVES, 'convencoes', 'v1', rulesOf(1));
    const gapId = await registerGap();

    const plan = await runSync(DIRECTIVES, 'convencoes', 'v2', [
      ...rulesOf(1),
      ...closingRules(rulesOf(1, 'retry'), gapId),
    ]);

    expect(at(plan.batches, 0).records[0]?.relations).toEqual([{ to: gapId, as: 'closes-gap' }]);
    expect(await passed('gaps')).toBe(true);
  });

  test('closes: an existing unchanged rule becomes supersedes and the gate passes', async () => {
    await runSync(DIRECTIVES, 'convencoes', 'v1', rulesOf(2));
    const gapId = await registerGap();
    const before = await currentDirective('r1');

    const plan = await runSync(DIRECTIVES, 'convencoes', 'v2', [
      ...closingRules(rulesOf(1), gapId),
      ...rulesOf(2).slice(1),
    ]);

    expect(at(plan.batches, 0).records.map(({ target }) => target)).toEqual([
      'directives.convencoes.r1',
      'directives.convencoes',
    ]);
    expect(at(plan.batches, 0).records[0]?.relations).toEqual([
      { kind: 'supersedes', to: before.id },
      { to: gapId, as: 'closes-gap' },
    ]);
    expect(await passed('gaps')).toBe(true);
  });

  test('closes: an up-to-date doc (same text) still writes closes-gap, with no new doc', async () => {
    await runSync(DIRECTIVES, 'convencoes', 'v1', rulesOf(1));
    const gapId = await registerGap();
    const before = await currentDirective('r1');

    const plan = await runSync(DIRECTIVES, 'convencoes', 'v1', closingRules(rulesOf(1), gapId));

    expect(plan.upToDate).toBe(false);
    expect(at(plan.batches, 0).records.map(({ target }) => target)).toEqual([
      'directives.convencoes.r1',
    ]);
    expect(at(plan.batches, 0).records[0]?.relations).toEqual([
      { kind: 'supersedes', to: before.id },
      { to: gapId, as: 'closes-gap' },
    ]);
    expect(await passed('gaps')).toBe(true);
  });

  test('closes: a rule that already closes the gap generates no new record, and the copied edge is not duplicated', async () => {
    await runSync(DIRECTIVES, 'convencoes', 'v1', rulesOf(1));
    const [firstGap, secondGap] = [await registerGap('a'), await registerGap('b')];
    await runSync(DIRECTIVES, 'convencoes', 'v2', closingRules(rulesOf(1), firstGap));

    const again = planSync(
      await inputFor(DIRECTIVES, 'convencoes', 'v3', closingRules(rulesOf(1), firstGap)),
    );
    expect(again.batches.flatMap(({ records }) => records.map(({ type }) => type))).toEqual([
      'doc',
    ]);

    const plan = await runSync(DIRECTIVES, 'convencoes', 'v4', [
      { ...at(rulesOf(1, 'r', 2), 0), closes: [firstGap, secondGap, secondGap] },
    ]);

    const closes = at(plan.batches, 0).records[0]?.relations.filter(
      ({ as }) => as === 'closes-gap',
    );
    expect(closes?.map(({ to }) => to).sort()).toEqual([firstGap, secondGap].sort());
    expect(await passed('gaps')).toBe(true);
  });

  test('(iv) a removed rule that closed a gap is revoked, warns, and the gate fails', async () => {
    const gapId = await seedClosedGap();

    const plan = await runSync(DIRECTIVES, 'convencoes', 'v3', rulesOf(1));

    expect(plan.warnings).toEqual([{ code: 'reopens-gap', rule: 'retry1', gaps: [gapId] }]);
    const rules = await queryAll({
      process: DIRECTIVES,
      type: 'directive',
      targetPrefix: 'directives.convencoes',
    });
    expect(rules.records.map(({ target }) => target)).toEqual(['directives.convencoes.r1']);
    expect(await passed('gaps')).toBe(false);
  });

  test('(iv) a removed rule that did not close a gap generates no warning and does not affect the gate', async () => {
    await runSync(DIRECTIVES, 'convencoes', 'v1', rulesOf(2));
    await registerGap();

    const plan = await runSync(DIRECTIVES, 'convencoes', 'v2', rulesOf(1));

    expect(plan.warnings).toEqual([]);
    expect(
      at(plan.batches, 0)
        .records.at(-1)
        ?.relations.filter(({ kind }) => kind === 'revokes'),
    ).toHaveLength(1);
  });

  test('(v) a deleted document becomes a tombstone and leaves the current set; recreated, it supersedes the tombstone', async () => {
    await runSync(DIRECTIVES, 'fronteiras', 'v1', rulesOf(2));
    const before = await inputFor(DIRECTIVES, 'fronteiras', null, null);

    const plan = await runSync(DIRECTIVES, 'fronteiras', null, null);

    const tombstone = at(plan.batches, 0).records.at(-1);
    expect(tombstone?.data).toEqual({
      path: docPath('fronteiras'),
      source: before.current?.source,
      removed: true,
    });
    expect(tombstone?.relations).toHaveLength(3);
    const after = await inputFor(DIRECTIVES, 'fronteiras', null, null);
    expect(after.vigent).toEqual([]);
    expect(after.current?.removed).toBe(true);
    expect((await runSync(DIRECTIVES, 'fronteiras', null, null)).upToDate).toBe(true);

    const back = await runSync(DIRECTIVES, 'fronteiras', 'v2', rulesOf(1));
    expect(at(back.batches, 0).records.at(-1)?.relations).toEqual([
      { kind: 'supersedes', to: after.current?.id },
    ]);
    expect((await inputFor(DIRECTIVES, 'fronteiras', 'v2', null)).current?.removed).toBe(false);
  });

  test('(v) a document that never had a sync and was deleted generates no batch', async () => {
    expect(await runSync(DIRECTIVES, 'fantasma', null, null)).toEqual({
      upToDate: true,
      batches: [],
      warnings: [],
    });
  });

  test('(vi) failure on the second batch, re-sync converges and the same batch resent is a replay', async () => {
    const rules = rulesOf(60);
    const plan = planSync(await inputFor(DIRECTIVES, 'fronteiras', 'v1', rules));
    await environment.ok('attach', { project: PROJECT, text: 'v1' });
    const [first, second] = [at(plan.batches, 0), at(plan.batches, 1)];
    const firstResult = await register(DIRECTIVES, first.records, first.key);
    const refused = second.records.map((record) =>
      record.type === 'doc' ? { ...record, data: { ...record.data, removed: 'x' } } : record,
    );
    expectError(await writeBatch(DIRECTIVES, refused, second.key), 'INVALID_RECORD');

    const resync = await runSync(DIRECTIVES, 'fronteiras', 'v1', rules);

    expect(resync.batches).toHaveLength(1);
    expect(at(resync.batches, 0).records).toHaveLength(11);
    // o lote recusado não gravou nada, então o replanejamento gera o mesmo lote e a mesma key
    expect(at(resync.batches, 0).key).toBe(second.key);
    expect((await runSync(DIRECTIVES, 'fronteiras', 'v1', rules)).upToDate).toBe(true);
    const replay = await register(DIRECTIVES, first.records, first.key);
    expect(replay.replayed).toBe(true);
    expect(replay.records).toEqual(firstResult.records);
  });

  test('(vi) the same key with another batch is IDEMPOTENCY_CONFLICT, so the key derives from the content', async () => {
    const rules = rulesOf(60);
    const plan = planSync(await inputFor(DIRECTIVES, 'fronteiras', 'v1', rules));
    await environment.ok('attach', { project: PROJECT, text: 'v1' });
    const first = at(plan.batches, 0);
    await register(DIRECTIVES, first.records, first.key);

    const other = await writeBatch(DIRECTIVES, at(plan.batches, 1).records, first.key);

    expectError(other, 'IDEMPOTENCY_CONFLICT');
    expect(at(plan.batches, 1).key).not.toBe(first.key);
  });

  test('(vii) two concurrent syncs: the second gets FORK_REJECTED and redoes from the new state', async () => {
    await runSync(DIRECTIVES, 'fronteiras', 'v1', rulesOf(1));
    const stale = planSync(await inputFor(DIRECTIVES, 'fronteiras', 'v2', rulesOf(1, 'r', 2)));
    await runSync(DIRECTIVES, 'fronteiras', 'v3', rulesOf(1, 'r', 3));
    await environment.ok('attach', { project: PROJECT, text: 'v2' });

    expectError(
      await writeBatch(DIRECTIVES, at(stale.batches, 0).records, at(stale.batches, 0).key),
      'FORK_REJECTED',
    );

    const redone = await runSync(DIRECTIVES, 'fronteiras', 'v2', rulesOf(1, 'r', 2));
    expect(redone.upToDate).toBe(false);
    expect((await currentDirective('r1', 'fronteiras')).data?.rule).toContain('v2');
  });

  test('(step 8) the audit query lists a duplicated current target and does not flag a normal sync', async () => {
    await runSync(DIRECTIVES, 'fronteiras', 'v1', rulesOf(2));
    const duplicates = async (): Promise<string[]> => {
      const { records } = await queryAll({ process: DIRECTIVES, type: 'directive' });
      const targets = records.map(({ target }) => target);
      return targets.filter((target, index) => targets.indexOf(target) !== index);
    };
    expect(await duplicates()).toEqual([]);

    // dois syncs que planejaram do mesmo estado vazio criam a mesma regra nova, sem supersedes
    await register(DIRECTIVES, [
      { ...directiveItem('r1', 'v1'), target: 'directives.fronteiras.r1' },
    ]);

    expect(await duplicates()).toEqual(['directives.fronteiras.r1']);
  });

  test('(viii) an interpreted rule does not change the generated records', async () => {
    const input = await inputFor(DIRECTIVES, 'fronteiras', 'v1', rulesOf(2));
    const interpreted = {
      ...input,
      extracted: rulesOf(2).map((rule) => ({ ...rule, interpreted: true })),
    };

    const plan = planSync(interpreted);

    expect(plan).toEqual(planSync(input));
    expect(JSON.stringify(plan)).not.toContain('interpreted');
    await environment.ok('attach', { project: PROJECT, text: 'v1' });
    await register(DIRECTIVES, at(plan.batches, 0).records, at(plan.batches, 0).key);
  });

  test('revoking 99 rules at once fits in 100 relations and 100 return too-many-relations', async () => {
    await runSync(DIRECTIVES, 'fronteiras', 'v1', rulesOf(99));

    const plan = await runSync(DIRECTIVES, 'fronteiras', 'v2', []);

    expect(plan.error).toBeUndefined();
    expect(at(plan.batches, 0).records[0]?.relations).toHaveLength(100);

    const vigent = Array.from({ length: 100 }, (_, index) => ({
      id: `directives:${index}`,
      target: `directives.big.r${index}`,
      rule: 'r',
      section: 's',
      out: [],
    }));
    const refused = planSync({
      docSlug: 'big',
      path: docPath('big'),
      hash: sha256hex('v2'),
      current: null,
      vigent,
      extracted: [],
    });
    expect(refused).toMatchObject({ upToDate: false, batches: [], error: 'too-many-relations' });
  });
});

describe('planSync invalid-path guard', () => {
  const inputWith = (docSlug: string, path: string): SyncInput => ({
    docSlug,
    path,
    hash: sha256hex('v1'),
    current: null,
    vigent: [],
    extracted: rulesOf(1),
  });
  const refused = { upToDate: false, batches: [], warnings: [], error: 'invalid-path' };

  test.each([
    ['empty', 'fronteiras', ''],
    ['outside docs/directives', 'fronteiras', 'docs/x.md'],
    ['absolute', 'fronteiras', `/tmp/${docPath('fronteiras')}`],
    ['with ..', 'fronteiras', 'docs/directives/../x.md'],
    ['from another document', 'fronteiras', docPath('convencoes')],
    ['with docSlug outside [a-z0-9-]', '../x', docPath('../x')],
    ['absolute in estrategia', STRATEGY, `/tmp/${docPath(STRATEGY)}`],
    ['outside the pattern in estrategia', STRATEGY, 'docs/estrategia.md'],
  ])('path %s returns invalid-path with no batch', (_label, docSlug, path) => {
    expect(planSync(inputWith(docSlug, path))).toEqual(refused);
  });

  test('the right path plans normally', () => {
    expect(planSync(inputWith('fronteiras', docPath('fronteiras'))).error).toBeUndefined();
  });

  test('an up-to-date document with an invalid path also returns invalid-path', () => {
    const upToDate: SyncInput = {
      ...inputWith('fronteiras', 'docs/x.md'),
      current: { id: 'directives:0', source: sha256hex('v1') },
    };

    expect(planSync(upToDate)).toEqual(refused);
  });

  test('tombstone (extracted null) with an invalid path also returns invalid-path', () => {
    expect(planSync({ ...inputWith('fronteiras', ''), extracted: null })).toEqual(refused);
  });
});

describe('two generations of the directives process', () => {
  test('query with process returns one, with scope project returns both', async () => {
    await runSync(DIRECTIVES, 'convencoes', 'v1', rulesOf(1));
    await runSync(`${DIRECTIVES}-2`, 'convencoes', 'v1', rulesOf(1));

    const one = await queryAll({
      process: `${DIRECTIVES}-2`,
      type: 'directive',
      targetPrefix: 'directives.convencoes.r1',
    });
    const both = await queryAll({
      scope: 'project',
      type: 'directive',
      targetPrefix: 'directives.convencoes.r1',
    });

    expect(one.records).toHaveLength(1);
    expect(both.records).toHaveLength(2);
  });

  test('a gap closed by generation 1 stays closed with generation 2 present; without the closure it fails', async () => {
    const gapId = await registerGap();
    await runSync(`${DIRECTIVES}-2`, 'convencoes', 'v1', rulesOf(1));
    expect(await passed('gaps')).toBe(false);

    await runSync(DIRECTIVES, 'convencoes', 'v1', closingRules(rulesOf(1), gapId));

    expect(await passed('gaps')).toBe(true);
  });

  test('timeless premise of generation 2: the decision cites it and a query with process does not see generation 1', async () => {
    await runSync(DIRECTIVES, STRATEGY, 'v1', premisesOf(1));
    const premiseId = await seedPremise();

    const decisionId = await registerOne(WORK, {
      ...workRecord('decision', 'a', decisionData()),
      relations: [{ to: premiseId, as: 'rests-on' }],
    });

    const one = await queryAll({
      process: `${DIRECTIVES}-2`,
      type: 'premise',
      targetPrefix: `directives.${STRATEGY}.p1`,
    });
    const both = await queryAll({
      scope: 'project',
      type: 'premise',
      targetPrefix: `directives.${STRATEGY}.p1`,
    });
    expect(one.records.map(({ id }) => id)).toEqual([premiseId]);
    expect(both.records).toHaveLength(2);
    const [stored] = (await queryAll({ scope: 'project', ids: [decisionId] })).records;
    expect(stored?.out).toEqual([expect.objectContaining({ as: 'rests-on', to: premiseId })]);
  });
});

describe('premise and evidence', () => {
  const withRelations = (item: Item, relations: Record<string, unknown>[]): Item => ({
    ...item,
    relations,
  });
  const premise = (short: string, statement = `Premise ${short}`): Item =>
    workRecord('premise', short, { statement });

  const attachText = async (text = 'research notes'): Promise<string> =>
    (await environment.ok<{ hash: string }>('attach', { project: PROJECT, text })).hash;

  test('premise accepts a statement of up to 255 characters', async () => {
    const { records } = await register(WORK, [premise('a', 'x'.repeat(255))]);

    expect(records).toHaveLength(1);
  });

  test.each([
    ['with 256 characters', { statement: 'x'.repeat(256) }],
    ['empty', { statement: '' }],
    ['with an extra field', { statement: 'ok', extra: 'x' }],
    ['without statement', {}],
  ])('premise %s is INVALID_RECORD', async (_label, data) => {
    expectError(await writeBatch(WORK, [workRecord('premise', 'bad', data)]), 'INVALID_RECORD');
  });

  test('evidence accepts summary and source of an existing attachment', async () => {
    const source = await attachText();

    const { records } = await register(WORK, [
      workRecord('evidence', 'a', { summary: 'Benchmarks agree', source }),
    ]);

    expect(records).toHaveLength(1);
  });

  test.each([
    ['without source', () => ({ summary: 'Benchmarks agree' })],
    [
      'with a source that is not a hash',
      () => ({ summary: 'Benchmarks agree', source: 'not-a-hash' }),
    ],
    [
      'with an extra field',
      (source: string) => ({ summary: 'Benchmarks agree', source, extra: 'x' }),
    ],
  ])('evidence %s is INVALID_RECORD', async (_label, build) => {
    const source = await attachText();

    expectError(
      await writeBatch(WORK, [workRecord('evidence', 'bad', build(source))]),
      'INVALID_RECORD',
    );
  });

  describe('rests-on and raw derivesFrom', () => {
    test('work decision cites a premise from directives-2, and the relation shows up in query', async () => {
      const premiseId = await seedPremise();

      const decisionId = await registerOne(
        WORK,
        withRelations(workRecord('decision', 'a', decisionData()), [
          { to: premiseId, as: 'rests-on' },
        ]),
      );

      const [stored] = (await queryAll({ scope: 'project', ids: [decisionId] })).records;
      expect(stored?.out?.map(({ as }) => as)).toEqual(['rests-on']);
    });

    test.each([
      [
        'decision to directive',
        ({ directiveId }: { directiveId: string; premiseId: string }): Item =>
          withRelations(workRecord('decision', 'a', decisionData()), [
            { to: directiveId, as: 'rests-on' },
          ]),
      ],
      [
        'finding to premise',
        ({ premiseId }: { directiveId: string; premiseId: string }): Item =>
          withRelations(workRecord('finding', 'a', findingData('NORMAL')), [
            { to: premiseId, as: 'rests-on' },
          ]),
      ],
    ])('endpoint outside the declared ones: %s is endpoint-type', async (_label, build) => {
      const directiveId = await seedDirective();
      const premiseId = await seedPremise();

      const body = expectError(
        await writeBatch(WORK, [build({ directiveId, premiseId })]),
        'INVALID_RECORD',
      );

      expect(body.details[0]?.code).toBe('endpoint-type');
    });

    test('raw derivesFrom from a work premise to a timeless premise is accepted and shows up in query', async () => {
      const timelessId = await seedPremise();

      const deliveryId = await registerOne(
        WORK,
        withRelations(premise('delivery'), [{ kind: 'derivesFrom', to: timelessId }]),
      );

      const [stored] = (await queryAll({ scope: 'project', ids: [deliveryId] })).records;
      expect(stored?.out).toEqual([
        expect.objectContaining({ kind: 'derivesFrom', to: timelessId }),
      ]);
    });
  });

  describe('fills-gap and gate gaps', () => {
    const fillsGap = (gapId: string) => [{ to: gapId, as: 'fills-gap' }];

    test('a premise registered before the gap and with no relation to it does not close it', async () => {
      await register(WORK, [premise('early')]);
      expect(await passed('gaps')).toBe(true);

      await registerGap();

      expect(await passed('gaps')).toBe(false);
    });

    test('a new premise in the same batch, after the gap and with an alias, closes it', async () => {
      await register(WORK, [
        { ...workRecord('gap', 'retry', gapData()), alias: 'gap' },
        withRelations(premise('fill'), [{ to: '@gap', as: 'fills-gap' }]),
      ]);

      expect(await passed('gaps')).toBe(true);
    });

    test('a new premise registered after the gap, with the id, closes it', async () => {
      const gapId = await registerGap();
      expect(await passed('gaps')).toBe(false);

      await register(WORK, [withRelations(premise('fill'), fillsGap(gapId))]);

      expect(await passed('gaps')).toBe(true);
    });

    test('decision with fills-gap is endpoint-type', async () => {
      const gapId = await registerGap();

      const body = expectError(
        await writeBatch(WORK, [
          withRelations(workRecord('decision', 'a', decisionData()), fillsGap(gapId)),
        ]),
        'INVALID_RECORD',
      );

      expect(body.details[0]?.code).toBe('endpoint-type');
    });

    test('a gap closed by a directive and another by a premise pass together', async () => {
      await environment.ok('attach', { project: PROJECT, text: 'v1' });
      const [byDirective, byPremise] = [await registerGap('a'), await registerGap('b')];

      await register(DIRECTIVES, [
        directiveItem('retries', 'v1', [{ to: byDirective, as: 'closes-gap' }]),
      ]);
      expect(await passed('gaps')).toBe(false);
      await register(WORK, [withRelations(premise('fill'), fillsGap(byPremise))]);

      expect(await passed('gaps')).toBe(true);
    });

    test('a premise that closed, revoked by another, reopens the gap and a third with fills-gap closes it', async () => {
      const gapId = await registerGap();
      const firstId = await registerOne(WORK, withRelations(premise('first'), fillsGap(gapId)));
      expect(await passed('gaps')).toBe(true);

      await register(WORK, [withRelations(premise('other'), [{ kind: 'revokes', to: firstId }])]);
      expect(await passed('gaps')).toBe(false);

      await register(WORK, [withRelations(premise('third'), fillsGap(gapId))]);

      expect(await passed('gaps')).toBe(true);
    });
  });

  describe('evidence with supports', () => {
    test('supports to the current decision is accepted; once the decision is superseded, a new supports is stale-destination', async () => {
      const source = await attachText();
      const decisionId = await registerOne(WORK, workRecord('decision', 'a', decisionData()));

      const evidenceId = await registerOne(
        WORK,
        withRelations(workRecord('evidence', 'a', { summary: 'Benchmarks agree', source }), [
          { kind: 'supports', to: decisionId },
        ]),
      );

      const [stored] = (await queryAll({ scope: 'project', ids: [evidenceId] })).records;
      expect(stored?.out).toEqual([expect.objectContaining({ kind: 'supports', to: decisionId })]);

      await register(WORK, [
        withRelations(workRecord('decision', 'a', decisionData({ choice: 'Redone' })), [
          { kind: 'supersedes', to: decisionId },
        ]),
      ]);
      const late = await writeBatch(WORK, [
        withRelations(workRecord('evidence', 'b', { summary: 'Late evidence', source }), [
          { kind: 'supports', to: decisionId },
        ]),
      ]);

      const body = expectError(late, 'INVALID_RECORD');
      expect(body.details[0]?.code).toBe('stale-destination');
    });
  });

  describe('what the gate does not enforce', () => {
    test('no_pending with resolvedBy derivesFrom from a premise only sees incoming relations', async () => {
      await environment.ok('define_gate', {
        project: PROJECT,
        name: 'decision-anchored',
        questions: [
          {
            kind: 'no_pending',
            pending: { type: 'decision' },
            resolvedBy: { kind: 'derivesFrom', from: ['premise'] },
          },
        ],
      });
      const process = 'anchor-check';
      await environment.ok('create_process', { project: PROJECT, process });
      const premiseId = await seedPremise();
      const decisionId = await registerOne(
        process,
        withRelations({ type: 'decision', target: `${process}.decision.a`, data: decisionData() }, [
          { to: premiseId, as: 'rests-on' },
        ]),
      );
      const anchored = async () =>
        (
          await environment.ok<GateEvaluation>('evaluate_gate', {
            project: PROJECT,
            process,
            gate: 'decision-anchored',
            target: process,
          })
        ).passed;

      expect(await anchored()).toBe(false);

      await register(process, [
        withRelations(
          { type: 'premise', target: `${process}.premise.a`, data: { statement: 'p' } },
          [{ kind: 'derivesFrom', to: decisionId }],
        ),
      ]);

      expect(await anchored()).toBe(true);
    });
  });
});

describe('estrategia sync (premises)', () => {
  const premiseTypes = (plan: SyncPlan) =>
    plan.batches.flatMap(({ records }) => records.map(({ type }) => type));

  test('generates a premise with data of only statement and a second run with the same text generates nothing', async () => {
    const plan = await runSync(DIRECTIVES, STRATEGY, 'v1', premisesOf(2));

    const [first] = at(plan.batches, 0).records;
    expect(premiseTypes(plan)).toEqual(['premise', 'premise', 'doc']);
    expect(first).toEqual({
      type: 'premise',
      target: `directives.${STRATEGY}.p1`,
      data: { statement: 'Premise p1 v1' },
      relations: [],
    });
    expect(await runSync(DIRECTIVES, STRATEGY, 'v1', premisesOf(2))).toEqual({
      upToDate: true,
      batches: [],
      warnings: [],
    });
  });

  test('a changed statement supersedes the current one and never generates closes-gap', async () => {
    await runSync(DIRECTIVES, STRATEGY, 'v1', premisesOf(2));
    const before = await currentPremise('p2');
    const gapId = await registerGap();
    const edited = [at(premisesOf(2), 0), { ...at(premisesOf(2, 'p', 2), 1), closes: [gapId] }];

    const plan = await runSync(DIRECTIVES, STRATEGY, 'v2', edited);

    expect(at(plan.batches, 0).records.map(({ target }) => target)).toEqual([
      `directives.${STRATEGY}.p2`,
      `directives.${STRATEGY}`,
    ]);
    expect(at(plan.batches, 0).records[0]?.relations).toEqual([
      { kind: 'supersedes', to: before.id },
    ]);
  });

  test('a removed slug becomes revokes in the doc', async () => {
    await runSync(DIRECTIVES, STRATEGY, 'v1', premisesOf(2));
    const removed = await currentPremise('p2');

    const plan = await runSync(DIRECTIVES, STRATEGY, 'v2', premisesOf(1));

    expect(
      at(plan.batches, 0)
        .records.at(-1)
        ?.relations.filter(({ kind }) => kind === 'revokes'),
    ).toEqual([{ kind: 'revokes', to: removed.id }]);
  });

  test('closes and section do not change the result, not even with an up-to-date doc', async () => {
    await runSync(DIRECTIVES, STRATEGY, 'v1', premisesOf(1));
    const gapId = await registerGap();
    const noisy = premisesOf(1).map((rule) => ({ ...rule, section: 'Theme', closes: [gapId] }));

    const upToDate = await runSync(DIRECTIVES, STRATEGY, 'v1', noisy);

    expect(upToDate).toEqual({ upToDate: true, batches: [], warnings: [] });
    const input = await inputFor(DIRECTIVES, STRATEGY, 'v2', premisesOf(1, 'p', 2));
    const clean = planSync(input);
    const withNoise = planSync({
      ...input,
      extracted: premisesOf(1, 'p', 2).map((rule) => ({
        ...rule,
        section: 'Theme',
        closes: [gapId],
      })),
    });
    expect(clean.batches).not.toEqual([]);
    expect(withNoise).toEqual(clean);
  });

  test('closes does not rewrite the premise with an up-to-date doc, even with a different statement', async () => {
    await runSync(DIRECTIVES, STRATEGY, 'v1', premisesOf(1));
    const gapId = await registerGap();
    const closing = premisesOf(1, 'p', 2).map((rule) => ({ ...rule, closes: [gapId] }));

    const plan = planSync(await inputFor(DIRECTIVES, STRATEGY, 'v1', closing));

    expect(plan).toEqual({ upToDate: true, batches: [], warnings: [] });
  });

  test('a convencoes doc in the same test keeps generating a directive with source and section', async () => {
    const strategy = await runSync(DIRECTIVES, STRATEGY, 'v1', premisesOf(1));

    const convencoes = await runSync(DIRECTIVES, 'convencoes', 'v1', rulesOf(1));

    expect(premiseTypes(strategy)).toContain('premise');
    expect(at(convencoes.batches, 0).records[0]).toMatchObject({
      type: 'directive',
      data: { section: 'Section', source: sha256hex('v1') },
    });
  });

  test('premise superseded by sync: query with scope project shows rests-on with current false', async () => {
    const premiseId = await seedPremise();
    await registerOne(WORK, {
      ...workRecord('decision', 'a', decisionData()),
      relations: [{ to: premiseId, as: 'rests-on' }],
    });

    await runSync(`${DIRECTIVES}-2`, STRATEGY, 'v2', premisesOf(1, 'p', 2));

    const { records } = await queryAll({
      scope: 'project',
      targetPrefix: `${WORK}.decision.a`,
    });
    expect(records.flatMap(({ out }) => out)).toEqual([
      expect.objectContaining({ as: 'rests-on', to: premiseId, current: false }),
    ]);
  });

  /** O mesmo caminho da skill: o CLI lê o documento em `input.path`, extrai as premissas e planeja. */
  const runFlow = (input: SyncInput, cwd = repoRoot, script = path.join(flowDir, 'flow.ts')) =>
    spawnSync(process.execPath, [script, 'sync-plan'], {
      cwd,
      input: JSON.stringify(input),
      encoding: 'utf8',
    });

  const hookPlan = (input: SyncInput): SyncPlan => {
    const result = runFlow(input);
    expect(result.stderr).toBe('');
    expect(result.status).toBe(0);
    return JSON.parse(result.stdout) as SyncPlan;
  };

  /** Roda o CLI num repositório temporário: o `REPO_ROOT` dele é o temporário e o `path` relativo vale ali. */
  const runFlowWithStrategy = (lines: string[]) => {
    const root = createTempDir('strategy');
    const scripts = path.join(root, 'scripts/flow');
    fs.mkdirSync(scripts, { recursive: true });
    for (const file of fs.readdirSync(flowDir).filter((f) => f.endsWith('.ts'))) {
      fs.copyFileSync(path.join(flowDir, file), path.join(scripts, file));
    }
    fs.mkdirSync(path.join(root, 'docs/directives'), { recursive: true });
    fs.writeFileSync(path.join(root, docPath(STRATEGY)), ['## Tema', ...lines].join('\n'));
    return runFlow(inputForFile(docPath(STRATEGY)), root, path.join(scripts, 'flow.ts'));
  };

  const inputForFile = (file: string): SyncInput => ({
    docSlug: STRATEGY,
    path: file,
    hash: '',
    current: null,
    vigent: [],
    extracted: [],
  });

  test('the real estrategia.md becomes a premise batch plus the doc and the second run is up to date', async () => {
    const text = fs.readFileSync(path.join(repoRoot, 'docs/directives/estrategia.md'), 'utf8');
    const count = scanPremises(text).premises.length;

    const plan = hookPlan(await inputFor(DIRECTIVES, STRATEGY, text, []));

    expect(plan.batches).toHaveLength(1);
    const batch = at(plan.batches, 0);
    expect(batch.records.map(({ type }) => type)).toEqual([
      ...Array.from({ length: count }, () => 'premise'),
      'doc',
    ]);
    await environment.ok('attach', { project: PROJECT, text });
    await register(DIRECTIVES, batch.records, batch.key);
    expect(hookPlan(await inputFor(DIRECTIVES, STRATEGY, text, []))).toEqual({
      upToDate: true,
      batches: [],
      warnings: [],
    });
  }, 30_000);

  test('a relative path is resolved from the repository root, with the cwd in another directory', () => {
    const result = runFlow(
      { ...inputForFile('docs/directives/estrategia.md'), extracted: [] },
      createTempDir('other-cwd'),
    );

    expect(result.stderr).toBe('');
    expect(result.status).toBe(0);
    expect((JSON.parse(result.stdout) as SyncPlan).batches).toHaveLength(1);
  }, 15_000);

  test('a statement of 255 code points passes, even with 510 UTF-16 units', () => {
    const text = ['## Tema', `- \`a\`: ${'𝒳'.repeat(255)} Ver: [x](x.md)`].join('\n');

    expect(parsePremises(text)).toEqual({
      rules: [{ slug: 'a', rule: '𝒳'.repeat(255), section: '' }],
      malformed: [],
    });
  });

  test.each([
    ['malformed line', ['- sem crase: linha ruim'], /- sem crase: linha ruim/],
    [
      'repeated slug',
      ['- `a`: Um. Ver: [x](x.md)', '- `a`: Dois. Ver: [x](x.md)'],
      /duplicate slug "a"/,
    ],
    ['statement of 256 code points', [`- \`a\`: ${'𝒳'.repeat(256)}`], /"a" has 256 code points/],
  ])(
    '%s exits with 2 and the reason on stderr',
    (_name, lines, reason) => {
      const result = runFlowWithStrategy(lines);

      expect(result.status).toBe(2);
      expect(result.stdout).toBe('');
      expect(result.stderr).toMatch(reason);
    },
    15_000,
  );
});

describe('definition hashes', () => {
  test.each(KINDS.flatMap((kind) => namesIn(kind).map((name) => [kind, name] as const)))(
    '%s/%s: the hash returned by define_* is the hashOfJcs of the body built from the file',
    (kind, name) => {
      expect(defined[`${kind}/${name}`]?.hash).toBe(hashOfJcs(definitionOf(kind, name)));
    },
  );

  test('the hash of a relation without the name does not match', () => {
    const withoutName = omit(definitionOf('relations', 'closes-gap'), ['name']);

    expect(hashOfJcs(withoutName)).not.toBe(defined['relations/closes-gap']?.hash);
  });

  test('the 3 hashes of list with process are the hashOfJcs of the name-to-definition map of each kind', async () => {
    const list = await environment.ok<ListResult>('list', {
      project: PROJECT,
      process: DIRECTIVES,
    });

    const expected = Object.fromEntries(
      KINDS.map((kind) => [
        kind,
        hashOfJcs(
          Object.fromEntries(namesIn(kind).map((name) => [name, definitionOf(kind, name)])),
        ),
      ]),
    );
    expect(list.process?.hashes).toEqual(expected);
    expect(list.process?.pinned.types).toHaveLength(9);
    expect(list.process?.pinned.relations).toHaveLength(6);
    expect(list.process?.pinned.gates).toHaveLength(2);
  });

  test('the map without one of the files gives another hash', async () => {
    const list = await environment.ok<ListResult>('list', {
      project: PROJECT,
      process: DIRECTIVES,
    });

    const [, ...rest] = namesIn('gates');
    const partial = hashOfJcs(
      Object.fromEntries(rest.map((name) => [name, definitionOf('gates', name)])),
    );

    expect(partial).not.toBe(list.process?.hashes.gates);
  });
});

describe('rehearsal of a complete work', () => {
  test('from opening to the two gates, with a gap closed by a new directive and a repeated sync', async () => {
    await runSync(DIRECTIVES, 'convencoes', 'v1', rulesOf(1));
    const directiveId = (await currentDirective('r1')).id;
    await register(WORK, [workRecord('opening', 'main', { ...opening(), sync: 'initial-load' })]);
    await register(WORK, [
      {
        ...workRecord('decision', 'a', decisionData()),
        relations: [{ to: directiveId, as: 'anchored-in' }],
      },
    ]);
    const gapId = await registerGap();
    const gapDecisionId = await registerOne(WORK, {
      ...workRecord(
        'decision',
        'b',
        decisionData({ grounds: 'gap', choice: 'Provisional: 3 attempts' }),
      ),
      relations: [{ to: gapId, as: 'about-gap' }],
    });
    const findingId = await registerOne(WORK, workRecord('finding', 'a', findingData('URGENT')));
    const failedId = await registerOne(
      WORK,
      workRecord('verification', 'main', verificationData('failed')),
    );
    expect(await passed('pre-pr')).toBe(false);
    expect(await passed('gaps')).toBe(false);

    await register(WORK, [
      {
        ...workRecord('decision', 'fix', decisionData({ rationale: 'Bounded the retry loop' })),
        relations: [
          { to: findingId, as: 'resolves-finding' },
          { to: directiveId, as: 'anchored-in' },
        ],
      },
      {
        ...workRecord('verification', 'main', verificationData('passed')),
        relations: [{ kind: 'supersedes', to: failedId }],
      },
    ]);
    expect(await passed('pre-pr')).toBe(true);
    expect(await passed('gaps')).toBe(false);

    await runSync(DIRECTIVES, 'convencoes', 'v2', [
      ...rulesOf(1),
      ...closingRules(rulesOf(1, 'retry'), gapId),
    ]);
    const retryId = (await currentDirective('retry1')).id;
    await register(WORK, [
      {
        ...workRecord('decision', 'b', decisionData({ choice: 'Retry at most 3 times' })),
        relations: [
          { kind: 'supersedes', to: gapDecisionId },
          { to: retryId, as: 'anchored-in' },
        ],
      },
    ]);

    expect(await passed('gaps')).toBe(true);
    expect(await passed('pre-pr')).toBe(true);
    expect(
      (await runSync(DIRECTIVES, 'convencoes', 'v2', [...rulesOf(1), ...rulesOf(1, 'retry')]))
        .upToDate,
    ).toBe(true);
    for (const process of [DIRECTIVES, WORK]) {
      const chain = await environment.ok<VerifyChainResult>('verify_chain', {
        project: PROJECT,
        process,
      });
      expect(chain.ok).toBe(true);
    }
  });
});
