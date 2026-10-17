import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from '@jest/globals';
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
} from '../.claude/hooks/flow-sync.ts';
import type { Defined } from '../src/commands/definition.ts';
import type { RegisterResult } from '../src/commands/process.ts';
import { hashOfJcs, sha256hex } from '../src/domain/chain.ts';
import { classifyTypeChange, type RecordType } from '../src/domain/definitions.ts';
import type {
  GateEvaluation,
  ListResult,
  QueryRecord,
  QueryResult,
  VerifyChainResult,
} from '../src/queries/query-service.ts';
import { at, createTempDir, parseJson } from './helpers.ts';
import { type Environment, createEnvironment, expectError } from './mcp/environment.ts';

const repoRoot = path.resolve(__dirname, '..');
const hexlogDir = path.join(repoRoot, '.hexlog');
const hookPath = path.join(repoRoot, '.claude/hooks/flow-hooks.ts');

const PROJECT = 'hexlog';
const DIRECTIVES = 'directives';
const WORK = 'feat-x';
const AGENT = 'flow-run';
const COMMIT = 'abc1234';

type Kind = 'types' | 'relations' | 'gates';
const KINDS: Kind[] = ['types', 'relations', 'gates'];
const DEFINE_TOOL: Record<Kind, string> = {
  types: 'define_type',
  relations: 'define_relation',
  gates: 'define_gate',
};

const namesIn = (kind: Kind): string[] =>
  fs
    .readdirSync(path.join(hexlogDir, kind))
    .filter((file) => file.endsWith('.json'))
    .map((file) => file.replace(/\.json$/, ''))
    .sort();

const fileBody = (kind: Kind, name: string): Record<string, unknown> =>
  parseJson(
    z.record(z.string(), z.json()),
    fs.readFileSync(path.join(hexlogDir, kind, `${name}.json`), 'utf8'),
  );

/** Corpo que a chamada `define_*` recebe a partir do arquivo: o tipo é o schema; as demais levam o nome. */
const definitionOf = (kind: Kind, name: string): Record<string, unknown> =>
  kind === 'types' ? fileBody(kind, name) : { name, ...fileBody(kind, name) };

/** Entrada da tool `define_*` para o arquivo: o tipo leva o schema; as demais, o corpo com o nome. */
const defineArgs = (kind: Kind, name: string): Record<string, unknown> =>
  kind === 'types' ? { name, schema: definitionOf(kind, name) } : definitionOf(kind, name);

let environment: Environment;

// Os hooks entram em cada describe de topo que usa o ambiente: o lint barra hook fora de describe.
async function openEnvironment(): Promise<void> {
  environment = await createEnvironment();
  for (const kind of KINDS) {
    for (const name of namesIn(kind)) {
      await environment.ok(DEFINE_TOOL[kind], { project: PROJECT, ...defineArgs(kind, name) });
    }
  }
  for (const process of [DIRECTIVES, `${DIRECTIVES}-2`, WORK]) {
    await environment.ok('create_process', { project: PROJECT, process });
  }
}

/** Ambiente sem nenhuma definição: o caso que confere o retorno de `define_*` o chama pela primeira vez. */
async function openBareEnvironment(): Promise<void> {
  environment = await createEnvironment();
}

async function closeEnvironment(): Promise<void> {
  await environment.close();
}

// ---- gravação e leitura ----

type Item = {
  type: string;
  target: string;
  data: Record<string, unknown>;
  alias?: string;
  relations?: Record<string, unknown>[];
};

/** Pontas de uma relação, montadas pelo caso depois de gravar o que ela aponta. */
type Ends = { gapId: string; findingId: string };
type Seeds = { directiveId: string; premiseId: string };

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

const withRelations = (item: Item, relations: Record<string, unknown>[]): Item => ({
  ...item,
  relations,
});

/** Guarda o texto como anexo e devolve o hash que um `source` cita. */
const attachText = async (text = 'research notes'): Promise<string> =>
  (await environment.ok<{ hash: string }>('attach', { project: PROJECT, text })).hash;

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

const premise = (short: string, statement = `Premise ${short}`): Item =>
  workRecord('premise', short, { statement });

/** Alvos de `directive` que aparecem mais de uma vez no vigente: o que a consulta de auditoria lista. */
async function duplicatedTargets(): Promise<string[]> {
  const { records } = await queryAll({ process: DIRECTIVES, type: 'directive' });
  const targets = records.map(({ target }) => target);
  return targets.filter((target, index) => targets.indexOf(target) !== index);
}

/** Planeja 60 regras, grava o 1º lote e recusa o 2º (doc com `removed` inválido). */
async function failSecondBatch() {
  const rules = rulesOf(60);
  const plan = planSync(await inputFor(DIRECTIVES, 'fronteiras', 'v1', rules));
  await attachText('v1');
  const [first, second] = [at(plan.batches, 0), at(plan.batches, 1)];
  const firstResult = await register(DIRECTIVES, first.records, first.key);
  const refused = second.records.map((record) =>
    record.type === 'doc' ? { ...record, data: { ...record.data, removed: 'x' } } : record,
  );
  expectError(await writeBatch(DIRECTIVES, refused, second.key), 'INVALID_RECORD');
  return { rules, first, second, firstResult };
}

describe('register', () => {
  beforeEach(openEnvironment);
  afterEach(closeEnvironment);

  it('should accept a valid record of each type', async () => {
    await seedDirective();
    const seeded = await queryAll({ process: DIRECTIVES });

    const { records } = await register(WORK, [
      workRecord('opening', 'main', opening()),
      workRecord('decision', 'a', decisionData()),
      workRecord('gap', 'a', gapData()),
      workRecord('finding', 'a', findingData('NORMAL')),
      workRecord('verification', 'main', verificationData('passed')),
    ]);

    expect(records).toHaveLength(5);
    expect(seeded.records.map(({ type }) => type).sort()).toEqual(['directive', 'doc']);
  });

  it.each([
    { label: 'without grounds', data: omit(decisionData(), ['grounds']) },
    { label: 'without rationale', data: omit(decisionData(), ['rationale']) },
    { label: 'with an unknown field', data: decisionData({ extra: 'x' }) },
    { label: 'without alternatives', data: decisionData({ alternatives: [] }) },
    { label: 'with confidence outside the enum', data: decisionData({ confidence: 'sure' }) },
  ])('should refuse a decision $label with INVALID_RECORD', async ({ data }) => {
    expectError(await writeBatch(WORK, [workRecord('decision', 'bad', data)]), 'INVALID_RECORD');
  });

  it.each([
    {
      label: 'an opening with a mode outside the enum',
      record: workRecord('opening', 'main', { ...opening(), mode: 'x' }),
    },
    {
      label: 'an opening with a commit that is not a sha',
      record: workRecord('opening', 'main', { ...opening(), commit: 'HEAD' }),
    },
    { label: 'a gap without context', record: workRecord('gap', 'a', { question: 'Q?' }) },
    {
      label: 'a finding with a severity outside the enum',
      record: workRecord('finding', 'a', findingData('HIGH')),
    },
    {
      label: 'a verification with 13 commands',
      record: workRecord('verification', 'main', {
        ...verificationData('passed'),
        commands: Array.from({ length: 13 }, () => ({ command: 'npm test', ok: true })),
      }),
    },
  ])('should refuse $label with INVALID_RECORD', async ({ record }) => {
    expectError(await writeBatch(WORK, [record]), 'INVALID_RECORD');
  });

  it('should refuse a commit that is not a git-sha with code format at the field path', async () => {
    const result = await writeBatch(WORK, [
      workRecord('verification', 'main', { ...verificationData('passed'), commit: 'HEAD' }),
    ]);

    expect(expectError(result, 'INVALID_RECORD').details).toEqual([
      expect.objectContaining({ path: '/records/0/data/commit', code: 'format' }),
    ]);
  });

  it('should refuse a doc with an empty path with INVALID_RECORD', async () => {
    const source = await attachText('v1');

    expectError(
      await writeBatch(DIRECTIVES, [
        { type: 'doc', target: 'directives.x', data: { path: '', source } },
      ]),
      'INVALID_RECORD',
    );
  });

  it('should accept a doc path outside docs/directives, since the path rule lives in the planSync guard', async () => {
    const source = await attachText('v1');

    const { records } = await register(DIRECTIVES, [
      { type: 'doc', target: 'directives.x', data: { path: 'docs/x.md', source } },
      { type: 'doc', target: 'directives.y', data: { path: docPath('y'), source } },
    ]);

    expect(records).toHaveLength(2);
  });

  it('should refuse an attachment hash that was not stored with ATTACHMENT_NOT_FOUND', async () => {
    expectError(
      await writeBatch(DIRECTIVES, [directiveItem('r1', 'never attached')]),
      'ATTACHMENT_NOT_FOUND',
    );
  });

  it('should store anchored-in, about-gap and resolves-finding on a decision', async () => {
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

    const [stored] = (await queryAll({ scope: 'project', ids: [decisionId] })).records;

    expect(stored?.out?.map(({ as }) => as).sort()).toEqual([
      'about-gap',
      'anchored-in',
      'resolves-finding',
    ]);
  });

  it('should store closes-gap from a directive of another process to a gap', async () => {
    const gapId = await registerGap();
    await attachText('v1');

    const closerId = await registerOne(
      DIRECTIVES,
      directiveItem('r2', 'v1', [{ to: gapId, as: 'closes-gap' }]),
    );

    const [stored] = (await queryAll({ scope: 'project', ids: [closerId] })).records;

    expect(stored?.out?.map(({ as }) => as)).toEqual(['closes-gap']);
  });

  it('should refuse closes-gap from a decision with endpoint-type, since it requires a directive origin', async () => {
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

  it.each([
    {
      label: 'a directive with resolves-finding',
      build: ({ findingId }: Ends): [string, Item] => [
        DIRECTIVES,
        directiveItem('r9', 'v1', [{ to: findingId, as: 'resolves-finding' }]),
      ],
    },
    {
      label: 'a decision with anchored-in to a gap',
      build: ({ gapId }: Ends): [string, Item] => [
        WORK,
        {
          ...workRecord('decision', 'b', decisionData()),
          relations: [{ to: gapId, as: 'anchored-in' }],
        },
      ],
    },
    {
      label: 'a decision with about-gap to a finding',
      build: ({ findingId }: Ends): [string, Item] => [
        WORK,
        {
          ...workRecord('decision', 'b', decisionData()),
          relations: [{ to: findingId, as: 'about-gap' }],
        },
      ],
    },
  ])(
    'should refuse $label with endpoint-type, since the endpoint is outside the declared ones',
    async ({ build }) => {
      await seedDirective();
      const gapId = await registerGap();
      const findingId = await registerOne(WORK, workRecord('finding', 'a', findingData('URGENT')));
      const [process, record] = build({ gapId, findingId });

      const body = expectError(await writeBatch(process, [record]), 'INVALID_RECORD');

      expect(body.details[0]?.code).toBe('endpoint-type');
    },
  );

  it('should accept a premise statement of up to 255 characters', async () => {
    const { records } = await register(WORK, [premise('a', 'x'.repeat(255))]);

    expect(records).toHaveLength(1);
  });

  it.each([
    { label: 'with a statement of 256 characters', data: { statement: 'x'.repeat(256) } },
    { label: 'with an empty statement', data: { statement: '' } },
    { label: 'with an extra field', data: { statement: 'ok', extra: 'x' } },
    { label: 'without a statement', data: {} },
  ])('should refuse a premise $label with INVALID_RECORD', async ({ data }) => {
    expectError(await writeBatch(WORK, [workRecord('premise', 'bad', data)]), 'INVALID_RECORD');
  });

  it.each(['human', 'simulated', 'simulated-approved'])(
    'should accept a premise with answeredBy %s',
    async (answeredBy) => {
      const { records } = await register(WORK, [
        workRecord('premise', 'a', { statement: 'ok', answeredBy }),
      ]);

      expect(records).toHaveLength(1);
    },
  );

  it('should refuse a premise with answeredBy outside the enum with INVALID_RECORD', async () => {
    const result = await writeBatch(WORK, [
      workRecord('premise', 'bad', { statement: 'ok', answeredBy: 'robot' }),
    ]);

    expectError(result, 'INVALID_RECORD');
  });

  it('should accept a premise without answeredBy', async () => {
    const { records } = await register(WORK, [premise('a')]);

    expect(records).toHaveLength(1);
  });

  it('should accept evidence with a summary and the source of an existing attachment', async () => {
    const source = await attachText();

    const { records } = await register(WORK, [
      workRecord('evidence', 'a', { summary: 'Benchmarks agree', source }),
    ]);

    expect(records).toHaveLength(1);
  });

  it.each([
    { label: 'without source', build: () => ({ summary: 'Benchmarks agree' }) },
    {
      label: 'with a source that is not a hash',
      build: () => ({ summary: 'Benchmarks agree', source: 'not-a-hash' }),
    },
    {
      label: 'with an extra field',
      build: (source: string) => ({ summary: 'Benchmarks agree', source, extra: 'x' }),
    },
  ])('should refuse evidence $label with INVALID_RECORD', async ({ build }) => {
    const source = await attachText();

    expectError(
      await writeBatch(WORK, [workRecord('evidence', 'bad', build(source))]),
      'INVALID_RECORD',
    );
  });

  it('should store the rests-on relation of a work decision to a directives-2 premise', async () => {
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

  it('should store rests-on from a decision to the premise of generation 2', async () => {
    await runSync(DIRECTIVES, STRATEGY, 'v1', premisesOf(1));
    const premiseId = await seedPremise();

    const decisionId = await registerOne(WORK, {
      ...workRecord('decision', 'a', decisionData()),
      relations: [{ to: premiseId, as: 'rests-on' }],
    });

    const [stored] = (await queryAll({ scope: 'project', ids: [decisionId] })).records;

    expect(stored?.out).toEqual([expect.objectContaining({ as: 'rests-on', to: premiseId })]);
  });

  it.each([
    {
      label: 'a decision that rests on a directive',
      build: ({ directiveId }: Seeds): Item =>
        withRelations(workRecord('decision', 'a', decisionData()), [
          { to: directiveId, as: 'rests-on' },
        ]),
    },
    {
      label: 'a finding that rests on a premise',
      build: ({ premiseId }: Seeds): Item =>
        withRelations(workRecord('finding', 'a', findingData('NORMAL')), [
          { to: premiseId, as: 'rests-on' },
        ]),
    },
  ])(
    'should refuse $label with endpoint-type, since the endpoint is outside the declared ones',
    async ({ build }) => {
      const directiveId = await seedDirective();
      const premiseId = await seedPremise();

      const body = expectError(
        await writeBatch(WORK, [build({ directiveId, premiseId })]),
        'INVALID_RECORD',
      );

      expect(body.details[0]?.code).toBe('endpoint-type');
    },
  );

  it('should store a raw derivesFrom from a work premise to a timeless premise', async () => {
    const timelessId = await seedPremise();

    const deliveryId = await registerOne(
      WORK,
      withRelations(premise('delivery'), [{ kind: 'derivesFrom', to: timelessId }]),
    );

    const [stored] = (await queryAll({ scope: 'project', ids: [deliveryId] })).records;

    expect(stored?.out).toEqual([expect.objectContaining({ kind: 'derivesFrom', to: timelessId })]);
  });

  it('should refuse fills-gap from a decision with endpoint-type', async () => {
    const gapId = await registerGap();

    const body = expectError(
      await writeBatch(WORK, [
        withRelations(workRecord('decision', 'a', decisionData()), [
          { to: gapId, as: 'fills-gap' },
        ]),
      ]),
      'INVALID_RECORD',
    );

    expect(body.details[0]?.code).toBe('endpoint-type');
  });

  it('should store supports from evidence to the current decision', async () => {
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
  });

  it('should refuse supports to a superseded decision with stale-destination', async () => {
    const source = await attachText();
    const decisionId = await registerOne(WORK, workRecord('decision', 'a', decisionData()));
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

    expect(expectError(late, 'INVALID_RECORD').details[0]?.code).toBe('stale-destination');
  });

  it('should refuse the same key with another batch with IDEMPOTENCY_CONFLICT, so the key derives from the content (vi)', async () => {
    const rules = rulesOf(60);
    const plan = planSync(await inputFor(DIRECTIVES, 'fronteiras', 'v1', rules));
    await attachText('v1');
    const first = at(plan.batches, 0);
    await register(DIRECTIVES, first.records, first.key);

    const other = await writeBatch(DIRECTIVES, at(plan.batches, 1).records, first.key);

    expectError(other, 'IDEMPOTENCY_CONFLICT');

    expect(at(plan.batches, 1).key).not.toBe(first.key);
  });

  it('should refuse the stale batch of a concurrent sync with FORK_REJECTED (vii)', async () => {
    await runSync(DIRECTIVES, 'fronteiras', 'v1', rulesOf(1));
    const stale = planSync(await inputFor(DIRECTIVES, 'fronteiras', 'v2', rulesOf(1, 'r', 2)));
    await runSync(DIRECTIVES, 'fronteiras', 'v3', rulesOf(1, 'r', 3));
    await attachText('v2');

    expectError(
      await writeBatch(DIRECTIVES, at(stale.batches, 0).records, at(stale.batches, 0).key),
      'FORK_REJECTED',
    );
  });

  it('should accept the batch planned from an interpreted rule (viii)', async () => {
    const input = await inputFor(DIRECTIVES, 'fronteiras', 'v1', rulesOf(2));
    const interpreted = {
      ...input,
      extracted: rulesOf(2).map((rule) => ({ ...rule, interpreted: true })),
    };
    const plan = planSync(interpreted);
    await attachText('v1');

    await expect(
      register(DIRECTIVES, at(plan.batches, 0).records, at(plan.batches, 0).key),
    ).resolves.toBeDefined();
  });
});

describe('evaluate_gate', () => {
  beforeEach(openEnvironment);
  afterEach(closeEnvironment);

  describe('with the pre-pr gate', () => {
    it('should fail when there is no verification', async () => {
      expect(await passed('pre-pr')).toBe(false);
    });

    it('should pass with a passed verification', async () => {
      await register(WORK, [workRecord('verification', 'main', verificationData('passed'))]);

      expect(await passed('pre-pr')).toBe(true);
    });

    it('should fail when a failed verification supersedes the passed one', async () => {
      const passedId = await registerOne(
        WORK,
        workRecord('verification', 'main', verificationData('passed')),
      );
      await register(WORK, [
        {
          ...workRecord('verification', 'main', verificationData('failed')),
          relations: [{ kind: 'supersedes', to: passedId }],
        },
      ]);

      expect(await passed('pre-pr')).toBe(false);
    });

    it('should fail with an URGENT finding that no decision resolves', async () => {
      await register(WORK, [workRecord('verification', 'main', verificationData('passed'))]);
      await register(WORK, [workRecord('finding', 'a', findingData('URGENT'))]);

      expect(await passed('pre-pr')).toBe(false);
    });

    it('should pass when a decision resolves the URGENT finding', async () => {
      const directiveId = await seedDirective();
      await register(WORK, [workRecord('verification', 'main', verificationData('passed'))]);
      const findingId = await registerOne(WORK, workRecord('finding', 'a', findingData('URGENT')));
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

    it('should not be blocked by a NORMAL finding', async () => {
      await register(WORK, [workRecord('verification', 'main', verificationData('passed'))]);
      await registerOne(WORK, workRecord('finding', 'n', findingData('NORMAL')));

      expect(await passed('pre-pr')).toBe(true);
    });

    it('should keep failing when a raw answers of another type points to the URGENT finding', async () => {
      await register(WORK, [workRecord('verification', 'main', verificationData('passed'))]);
      const urgentId = await registerOne(WORK, workRecord('finding', 'u', findingData('URGENT')));
      await register(WORK, [
        { ...workRecord('gap', 'g', gapData()), relations: [{ kind: 'answers', to: urgentId }] },
      ]);

      expect(await passed('pre-pr')).toBe(false);
    });
  });

  describe('with the gaps gate', () => {
    const closeWithDirective = (gapId: string) =>
      register(DIRECTIVES, [directiveItem('retries', 'v1', [{ to: gapId, as: 'closes-gap' }])]);
    const fillsGap = (gapId: string) => [{ to: gapId, as: 'fills-gap' }];

    it('should pass when there is no gap', async () => {
      expect(await passed('gaps')).toBe(true);
    });

    it('should fail when a gap is open', async () => {
      await registerGap();

      expect(await passed('gaps')).toBe(false);
    });

    it('should pass when a directive from another process closes the gap', async () => {
      await attachText('v1');
      const gapId = await registerGap();
      await closeWithDirective(gapId);

      expect(await passed('gaps')).toBe(true);
    });

    it('should keep failing when a redone decision and a raw answers point to the gap', async () => {
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

    it('should keep failing for a premise recorded before the gap with no relation to it', async () => {
      await register(WORK, [premise('early')]);

      expect(await passed('gaps')).toBe(true);

      await registerGap();

      expect(await passed('gaps')).toBe(false);
    });

    it('should pass when a premise in the same batch, after the gap, fills it by alias', async () => {
      await register(WORK, [
        { ...workRecord('gap', 'retry', gapData()), alias: 'gap' },
        withRelations(premise('fill'), [{ to: '@gap', as: 'fills-gap' }]),
      ]);

      expect(await passed('gaps')).toBe(true);
    });

    it('should pass when a premise recorded after the gap fills it by id', async () => {
      const gapId = await registerGap();

      expect(await passed('gaps')).toBe(false);

      await register(WORK, [withRelations(premise('fill'), fillsGap(gapId))]);

      expect(await passed('gaps')).toBe(true);
    });

    it('should pass when a directive closes one gap and a premise fills another', async () => {
      await attachText('v1');
      const [byDirective, byPremise] = [await registerGap('a'), await registerGap('b')];
      await register(DIRECTIVES, [
        directiveItem('retries', 'v1', [{ to: byDirective, as: 'closes-gap' }]),
      ]);

      expect(await passed('gaps')).toBe(false);

      await register(WORK, [withRelations(premise('fill'), fillsGap(byPremise))]);

      expect(await passed('gaps')).toBe(true);
    });

    it('should reopen the gap when the premise that filled it is revoked', async () => {
      const gapId = await registerGap();
      const firstId = await registerOne(WORK, withRelations(premise('first'), fillsGap(gapId)));

      expect(await passed('gaps')).toBe(true);

      await register(WORK, [withRelations(premise('other'), [{ kind: 'revokes', to: firstId }])]);

      expect(await passed('gaps')).toBe(false);
    });

    it('should close the gap again when a third premise fills it after the revoke', async () => {
      const gapId = await registerGap();
      const firstId = await registerOne(WORK, withRelations(premise('first'), fillsGap(gapId)));
      await register(WORK, [withRelations(premise('other'), [{ kind: 'revokes', to: firstId }])]);
      await register(WORK, [withRelations(premise('third'), fillsGap(gapId))]);

      expect(await passed('gaps')).toBe(true);
    });

    it('should fail while only generation 2 holds a rule and nothing closes the gap', async () => {
      await registerGap();
      await runSync(`${DIRECTIVES}-2`, 'convencoes', 'v1', rulesOf(1));

      expect(await passed('gaps')).toBe(false);
    });

    it('should pass when generation 1 closes the gap with generation 2 present', async () => {
      const gapId = await registerGap();
      await runSync(`${DIRECTIVES}-2`, 'convencoes', 'v1', rulesOf(1));
      await runSync(DIRECTIVES, 'convencoes', 'v1', closingRules(rulesOf(1), gapId));

      expect(await passed('gaps')).toBe(true);
    });
  });

  it('should resolve a pending decision only by an incoming derivesFrom from a premise, not by its own rests-on', async () => {
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
      withRelations({ type: 'premise', target: `${process}.premise.a`, data: { statement: 'p' } }, [
        { kind: 'derivesFrom', to: decisionId },
      ]),
    ]);

    expect(await anchored()).toBe(true);
  });
});

describe('query', () => {
  beforeEach(openEnvironment);
  afterEach(closeEnvironment);

  it('should return only the record of the generation named by process', async () => {
    await runSync(DIRECTIVES, 'convencoes', 'v1', rulesOf(1));
    await runSync(`${DIRECTIVES}-2`, 'convencoes', 'v1', rulesOf(1));

    const { records } = await queryAll({
      process: `${DIRECTIVES}-2`,
      type: 'directive',
      targetPrefix: 'directives.convencoes.r1',
    });

    expect(records).toHaveLength(1);
  });

  it('should return the record of both generations with scope project', async () => {
    await runSync(DIRECTIVES, 'convencoes', 'v1', rulesOf(1));
    await runSync(`${DIRECTIVES}-2`, 'convencoes', 'v1', rulesOf(1));

    const { records } = await queryAll({
      scope: 'project',
      type: 'directive',
      targetPrefix: 'directives.convencoes.r1',
    });

    expect(records).toHaveLength(2);
  });

  it('should return only the premise of generation 2 with process', async () => {
    await runSync(DIRECTIVES, STRATEGY, 'v1', premisesOf(1));
    const premiseId = await seedPremise();

    const { records } = await queryAll({
      process: `${DIRECTIVES}-2`,
      type: 'premise',
      targetPrefix: `directives.${STRATEGY}.p1`,
    });

    expect(records.map(({ id }) => id)).toEqual([premiseId]);
  });

  it('should return the premise of both generations with scope project', async () => {
    await runSync(DIRECTIVES, STRATEGY, 'v1', premisesOf(1));
    await seedPremise();

    const { records } = await queryAll({
      scope: 'project',
      type: 'premise',
      targetPrefix: `directives.${STRATEGY}.p1`,
    });

    expect(records).toHaveLength(2);
  });

  it('should show the rests-on edge as not current when a sync supersedes the premise', async () => {
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

  it('should not list a duplicated current target after a normal sync (step 8)', async () => {
    await runSync(DIRECTIVES, 'fronteiras', 'v1', rulesOf(2));

    expect(await duplicatedTargets()).toEqual([]);
  });

  it('should list a duplicated current target after two syncs planned from the same empty state (step 8)', async () => {
    await runSync(DIRECTIVES, 'fronteiras', 'v1', rulesOf(2));
    // dois syncs que planejaram do mesmo estado vazio criam a mesma regra nova, sem supersedes
    await register(DIRECTIVES, [
      { ...directiveItem('r1', 'v1'), target: 'directives.fronteiras.r1' },
    ]);

    expect(await duplicatedTargets()).toEqual(['directives.fronteiras.r1']);
  });
});

describe('planSync', () => {
  beforeEach(openEnvironment);
  afterEach(closeEnvironment);

  const inputWith = (docSlug: string, path: string): SyncInput => ({
    docSlug,
    path,
    hash: sha256hex('v1'),
    current: null,
    vigent: [],
    extracted: rulesOf(1),
  });
  const refused = { upToDate: false, batches: [], warnings: [], error: 'invalid-path' };
  const premiseTypes = (plan: SyncPlan) =>
    plan.batches.flatMap(({ records }) => records.map(({ type }) => type));

  it('should load 60 rules in two pages and two batches, with the doc last (i)', async () => {
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
  });

  it('should swap only the doc on an editorial edit (i)', async () => {
    const rules = rulesOf(60);
    await runSync(DIRECTIVES, 'fronteiras', 'v1', rules);

    const edit = await runSync(DIRECTIVES, 'fronteiras', 'v1 with a typo fixed', rules);

    expect(edit.batches).toHaveLength(1);
    expect(at(edit.batches, 0).records.map(({ type }) => type)).toEqual(['doc']);
  });

  it('should be up to date when the same edited text is synced again (i)', async () => {
    const rules = rulesOf(60);
    await runSync(DIRECTIVES, 'fronteiras', 'v1', rules);
    await runSync(DIRECTIVES, 'fronteiras', 'v1 with a typo fixed', rules);

    const again = await runSync(DIRECTIVES, 'fronteiras', 'v1 with a typo fixed', rules);

    expect(again.upToDate).toBe(true);
  });

  it('should return up to date with no batch when the hash did not change (i)', async () => {
    await runSync(DIRECTIVES, 'fronteiras', 'v1', rulesOf(3));

    const again = await runSync(DIRECTIVES, 'fronteiras', 'v1', rulesOf(3));

    expect(again).toEqual({ upToDate: true, batches: [], warnings: [] });
  });

  it('should leave an untouched rule alone and give a changed one a new record (ii)', async () => {
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

  it('should keep the gaps gate passing when the rewrite of a rule that closed a gap copies closes-gap (iii)', async () => {
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

  it('should fail the gaps gate again when the rewrite does not copy closes-gap (iii)', async () => {
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

  it('should keep the gap open when a new rule is synced without closes', async () => {
    await runSync(DIRECTIVES, 'convencoes', 'v1', rulesOf(1));
    await registerGap();
    await runSync(DIRECTIVES, 'convencoes', 'v2', [...rulesOf(1), ...rulesOf(1, 'retry')]);

    expect(await passed('gaps')).toBe(false);
  });

  it('should plan supersedes and closes-gap for a rewritten rule that closes the gap', async () => {
    await runSync(DIRECTIVES, 'convencoes', 'v1', rulesOf(1));
    const gapId = await registerGap();
    await runSync(DIRECTIVES, 'convencoes', 'v2', [...rulesOf(1), ...rulesOf(1, 'retry')]);
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

  it('should plan only closes-gap, without supersedes, for a new rule that closes the gap', async () => {
    await runSync(DIRECTIVES, 'convencoes', 'v1', rulesOf(1));
    const gapId = await registerGap();

    const plan = await runSync(DIRECTIVES, 'convencoes', 'v2', [
      ...rulesOf(1),
      ...closingRules(rulesOf(1, 'retry'), gapId),
    ]);

    expect(at(plan.batches, 0).records[0]?.relations).toEqual([{ to: gapId, as: 'closes-gap' }]);
    expect(await passed('gaps')).toBe(true);
  });

  it('should turn an existing unchanged rule into supersedes when it closes the gap', async () => {
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

  it('should still write closes-gap, with no new doc, when the doc text is up to date', async () => {
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

  it('should yield no new record for a rule that already closes the gap', async () => {
    await runSync(DIRECTIVES, 'convencoes', 'v1', rulesOf(1));
    const firstGap = await registerGap('a');
    await registerGap('b');
    await runSync(DIRECTIVES, 'convencoes', 'v2', closingRules(rulesOf(1), firstGap));

    const again = planSync(
      await inputFor(DIRECTIVES, 'convencoes', 'v3', closingRules(rulesOf(1), firstGap)),
    );

    expect(again.batches.flatMap(({ records }) => records.map(({ type }) => type))).toEqual([
      'doc',
    ]);
  });

  it('should not duplicate the copied closes-gap edge when closes repeats a gap', async () => {
    await runSync(DIRECTIVES, 'convencoes', 'v1', rulesOf(1));
    const [firstGap, secondGap] = [await registerGap('a'), await registerGap('b')];
    await runSync(DIRECTIVES, 'convencoes', 'v2', closingRules(rulesOf(1), firstGap));

    const plan = await runSync(DIRECTIVES, 'convencoes', 'v4', [
      { ...at(rulesOf(1, 'r', 2), 0), closes: [firstGap, secondGap, secondGap] },
    ]);

    const closes = at(plan.batches, 0).records[0]?.relations.filter(
      ({ as }) => as === 'closes-gap',
    );

    expect(closes?.map(({ to }) => to).sort()).toEqual([firstGap, secondGap].sort());
    expect(await passed('gaps')).toBe(true);
  });

  it('should revoke a removed rule that closed a gap, warn and fail the gaps gate (iv)', async () => {
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

  it('should yield no warning and one revokes for a removed rule that closed no gap (iv)', async () => {
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

  it('should turn a deleted document into a tombstone and drop its rules from the current set (v)', async () => {
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
  });

  it('should be up to date when the deleted document is synced again (v)', async () => {
    await runSync(DIRECTIVES, 'fronteiras', 'v1', rulesOf(2));
    await runSync(DIRECTIVES, 'fronteiras', null, null);

    const again = await runSync(DIRECTIVES, 'fronteiras', null, null);

    expect(again.upToDate).toBe(true);
  });

  it('should supersede the tombstone when the deleted document is recreated (v)', async () => {
    await runSync(DIRECTIVES, 'fronteiras', 'v1', rulesOf(2));
    await runSync(DIRECTIVES, 'fronteiras', null, null);
    const tombstoned = await inputFor(DIRECTIVES, 'fronteiras', null, null);

    const back = await runSync(DIRECTIVES, 'fronteiras', 'v2', rulesOf(1));

    expect(at(back.batches, 0).records.at(-1)?.relations).toEqual([
      { kind: 'supersedes', to: tombstoned.current?.id },
    ]);
    expect((await inputFor(DIRECTIVES, 'fronteiras', 'v2', null)).current?.removed).toBe(false);
  });

  it('should yield no batch for a document that never had a sync and was deleted (v)', async () => {
    expect(await runSync(DIRECTIVES, 'fantasma', null, null)).toEqual({
      upToDate: true,
      batches: [],
      warnings: [],
    });
  });

  it('should plan only the missing batch, with the same key, on a re-sync after the second batch failed (vi)', async () => {
    const { rules, second } = await failSecondBatch();

    const resync = await runSync(DIRECTIVES, 'fronteiras', 'v1', rules);

    expect(resync.batches).toHaveLength(1);
    expect(at(resync.batches, 0).records).toHaveLength(11);
    // o lote recusado não gravou nada, então o replanejamento gera o mesmo lote e a mesma key
    expect(at(resync.batches, 0).key).toBe(second.key);
  });

  it('should be up to date after a re-sync that follows the failed second batch (vi)', async () => {
    const { rules } = await failSecondBatch();
    await runSync(DIRECTIVES, 'fronteiras', 'v1', rules);

    const again = await runSync(DIRECTIVES, 'fronteiras', 'v1', rules);

    expect(again.upToDate).toBe(true);
  });

  it('should replay the first batch when it is resent after the re-sync (vi)', async () => {
    const { rules, first, firstResult } = await failSecondBatch();
    await runSync(DIRECTIVES, 'fronteiras', 'v1', rules);

    const replay = await register(DIRECTIVES, first.records, first.key);

    expect(replay.replayed).toBe(true);
    expect(replay.records).toEqual(firstResult.records);
  });

  it('should redo the sync from the new state after FORK_REJECTED (vii)', async () => {
    await runSync(DIRECTIVES, 'fronteiras', 'v1', rulesOf(1));
    const stale = planSync(await inputFor(DIRECTIVES, 'fronteiras', 'v2', rulesOf(1, 'r', 2)));
    await runSync(DIRECTIVES, 'fronteiras', 'v3', rulesOf(1, 'r', 3));
    await attachText('v2');
    expectError(
      await writeBatch(DIRECTIVES, at(stale.batches, 0).records, at(stale.batches, 0).key),
      'FORK_REJECTED',
    );

    const redone = await runSync(DIRECTIVES, 'fronteiras', 'v2', rulesOf(1, 'r', 2));

    expect(redone.upToDate).toBe(false);
    expect((await currentDirective('r1', 'fronteiras')).data?.rule).toContain('v2');
  });

  it('should not change the generated records for an interpreted rule (viii)', async () => {
    const input = await inputFor(DIRECTIVES, 'fronteiras', 'v1', rulesOf(2));
    const interpreted = {
      ...input,
      extracted: rulesOf(2).map((rule) => ({ ...rule, interpreted: true })),
    };

    const plan = planSync(interpreted);

    expect(plan).toEqual(planSync(input));
    expect(JSON.stringify(plan)).not.toContain('interpreted');
  });

  it('should fit the revocation of 99 rules in 100 relations', async () => {
    await runSync(DIRECTIVES, 'fronteiras', 'v1', rulesOf(99));

    const plan = await runSync(DIRECTIVES, 'fronteiras', 'v2', []);

    expect(plan.error).toBeUndefined();
    expect(at(plan.batches, 0).records[0]?.relations).toHaveLength(100);
  });

  it('should return too-many-relations when 100 rules are revoked at once', () => {
    const vigent = Array.from({ length: 100 }, (_, index) => ({
      id: `directives:${index}`,
      target: `directives.big.r${index}`,
      rule: 'r',
      section: 's',
      out: [],
    }));

    const plan = planSync({
      docSlug: 'big',
      path: docPath('big'),
      hash: sha256hex('v2'),
      current: null,
      vigent,
      extracted: [],
    });

    expect(plan).toMatchObject({ upToDate: false, batches: [], error: 'too-many-relations' });
  });

  it('should still generate a directive with source and section after a strategy doc is synced', async () => {
    const strategy = await runSync(DIRECTIVES, STRATEGY, 'v1', premisesOf(1));

    expect(premiseTypes(strategy)).toContain('premise');

    const convencoes = await runSync(DIRECTIVES, 'convencoes', 'v1', rulesOf(1));

    expect(at(convencoes.batches, 0).records[0]).toMatchObject({
      type: 'directive',
      data: { section: 'Section', source: sha256hex('v1') },
    });
  });

  it('should plan normally for the right path', () => {
    expect(planSync(inputWith('fronteiras', docPath('fronteiras'))).error).toBeUndefined();
  });

  describe('when the document path is invalid', () => {
    it.each([
      { label: 'an empty path', docSlug: 'fronteiras', path: '' },
      { label: 'a path outside docs/directives', docSlug: 'fronteiras', path: 'docs/x.md' },
      { label: 'an absolute path', docSlug: 'fronteiras', path: `/tmp/${docPath('fronteiras')}` },
      { label: 'a path with ..', docSlug: 'fronteiras', path: 'docs/directives/../x.md' },
      {
        label: 'a path from another document',
        docSlug: 'fronteiras',
        path: docPath('convencoes'),
      },
      { label: 'a docSlug outside [a-z0-9-]', docSlug: '../x', path: docPath('../x') },
      {
        label: 'an absolute path in estrategia',
        docSlug: STRATEGY,
        path: `/tmp/${docPath(STRATEGY)}`,
      },
      {
        label: 'a path outside the pattern in estrategia',
        docSlug: STRATEGY,
        path: 'docs/estrategia.md',
      },
    ])('should return invalid-path with no batch for $label', ({ docSlug, path }) => {
      expect(planSync(inputWith(docSlug, path))).toEqual(refused);
    });

    it('should return invalid-path for an up-to-date document', () => {
      const upToDate: SyncInput = {
        ...inputWith('fronteiras', 'docs/x.md'),
        current: { id: 'directives:0', source: sha256hex('v1') },
      };

      expect(planSync(upToDate)).toEqual(refused);
    });

    it('should return invalid-path for a tombstone (extracted null)', () => {
      expect(planSync({ ...inputWith('fronteiras', ''), extracted: null })).toEqual(refused);
    });
  });

  describe('with the estrategia document', () => {
    it('should generate a premise whose data is only the statement', async () => {
      const plan = await runSync(DIRECTIVES, STRATEGY, 'v1', premisesOf(2));

      const [first] = at(plan.batches, 0).records;

      expect(premiseTypes(plan)).toEqual(['premise', 'premise', 'doc']);
      expect(first).toEqual({
        type: 'premise',
        target: `directives.${STRATEGY}.p1`,
        data: { statement: 'Premise p1 v1' },
        relations: [],
      });
    });

    it('should generate nothing when the same text is synced twice', async () => {
      await runSync(DIRECTIVES, STRATEGY, 'v1', premisesOf(2));

      const again = await runSync(DIRECTIVES, STRATEGY, 'v1', premisesOf(2));

      expect(again).toEqual({ upToDate: true, batches: [], warnings: [] });
    });

    it('should plan only a supersedes relation for a changed premise, ignoring closes', async () => {
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

    it('should revoke, in the doc, a slug that was removed', async () => {
      await runSync(DIRECTIVES, STRATEGY, 'v1', premisesOf(2));
      const removed = await currentPremise('p2');

      const plan = await runSync(DIRECTIVES, STRATEGY, 'v2', premisesOf(1));

      expect(
        at(plan.batches, 0)
          .records.at(-1)
          ?.relations.filter(({ kind }) => kind === 'revokes'),
      ).toEqual([{ kind: 'revokes', to: removed.id }]);
    });

    it('should stay up to date when closes and section change on an up-to-date doc', async () => {
      await runSync(DIRECTIVES, STRATEGY, 'v1', premisesOf(1));
      const gapId = await registerGap();
      const noisy = premisesOf(1).map((rule) => ({ ...rule, section: 'Theme', closes: [gapId] }));

      const upToDate = await runSync(DIRECTIVES, STRATEGY, 'v1', noisy);

      expect(upToDate).toEqual({ upToDate: true, batches: [], warnings: [] });
    });

    it('should plan the same batches with or without closes and section on a changed doc', async () => {
      await runSync(DIRECTIVES, STRATEGY, 'v1', premisesOf(1));
      const gapId = await registerGap();
      const input = await inputFor(DIRECTIVES, STRATEGY, 'v2', premisesOf(1, 'p', 2));
      const clean = planSync(input);

      expect(clean.batches).not.toEqual([]);

      const withNoise = planSync({
        ...input,
        extracted: premisesOf(1, 'p', 2).map((rule) => ({
          ...rule,
          section: 'Theme',
          closes: [gapId],
        })),
      });

      expect(withNoise).toEqual(clean);
    });

    it('should not rewrite the premise on an up-to-date doc, even with a different statement and closes', async () => {
      await runSync(DIRECTIVES, STRATEGY, 'v1', premisesOf(1));
      const gapId = await registerGap();
      const closing = premisesOf(1, 'p', 2).map((rule) => ({ ...rule, closes: [gapId] }));

      const plan = planSync(await inputFor(DIRECTIVES, STRATEGY, 'v1', closing));

      expect(plan).toEqual({ upToDate: true, batches: [], warnings: [] });
    });
  });
});

describe('.claude/hooks/flow-hooks.ts sync-plan', () => {
  beforeEach(openEnvironment);
  afterEach(closeEnvironment);

  /** O mesmo caminho da skill: o hook lê o documento em `input.path`, extrai as premissas e planeja. */
  const runHook = (input: SyncInput, cwd = repoRoot, hook = hookPath) =>
    spawnSync(process.execPath, [hook, 'sync-plan'], {
      cwd,
      input: JSON.stringify(input),
      encoding: 'utf8',
    });

  const hookPlan = (input: SyncInput): SyncPlan => {
    const result = runHook(input);

    expect(result.stderr).toBe('');
    expect(result.status).toBe(0);

    return JSON.parse(result.stdout) as SyncPlan;
  };

  const inputForFile = (file: string): SyncInput => ({
    docSlug: STRATEGY,
    path: file,
    hash: '',
    current: null,
    vigent: [],
    extracted: [],
  });

  /** Roda o hook num repositório temporário: o `REPO_ROOT` dele é o temporário e o `path` relativo vale ali. */
  const runHookWithStrategy = (lines: string[]) => {
    const root = createTempDir('strategy');
    const hooks = path.join(root, '.claude/hooks');
    fs.mkdirSync(hooks, { recursive: true });
    for (const file of fs.readdirSync(path.dirname(hookPath)).filter((f) => f.endsWith('.ts'))) {
      fs.copyFileSync(path.join(path.dirname(hookPath), file), path.join(hooks, file));
    }
    fs.mkdirSync(path.join(root, 'docs/directives'), { recursive: true });
    fs.writeFileSync(path.join(root, docPath(STRATEGY)), ['## Tema', ...lines].join('\n'));
    return runHook(inputForFile(docPath(STRATEGY)), root, path.join(hooks, 'flow-hooks.ts'));
  };

  it('should turn the real estrategia.md into one batch of premises plus the doc', async () => {
    const text = fs.readFileSync(path.join(repoRoot, 'docs/directives/estrategia.md'), 'utf8');
    const count = scanPremises(text).premises.length;

    const plan = hookPlan(await inputFor(DIRECTIVES, STRATEGY, text, []));

    expect(plan.batches).toHaveLength(1);
    expect(at(plan.batches, 0).records.map(({ type }) => type)).toEqual([
      ...Array.from({ length: count }, () => 'premise'),
      'doc',
    ]);
  }, 30_000);

  it('should be up to date on the second run of the real estrategia.md once the batch is registered', async () => {
    const text = fs.readFileSync(path.join(repoRoot, 'docs/directives/estrategia.md'), 'utf8');
    const batch = at(hookPlan(await inputFor(DIRECTIVES, STRATEGY, text, [])).batches, 0);
    await attachText(text);
    await register(DIRECTIVES, batch.records, batch.key);

    const again = hookPlan(await inputFor(DIRECTIVES, STRATEGY, text, []));

    expect(again).toEqual({ upToDate: true, batches: [], warnings: [] });
  }, 30_000);

  it('should resolve a relative path from the repository root, with the cwd in another directory', () => {
    const result = runHook(
      { ...inputForFile('docs/directives/estrategia.md'), extracted: [] },
      createTempDir('other-cwd'),
    );

    expect(result.stderr).toBe('');
    expect(result.status).toBe(0);
    expect((JSON.parse(result.stdout) as SyncPlan).batches).toHaveLength(1);
  }, 15_000);

  it.each([
    {
      name: 'a malformed line',
      lines: ['- sem crase: linha ruim'],
      reason: /- sem crase: linha ruim/,
    },
    {
      name: 'a repeated slug',
      lines: ['- `a`: Um. Ver: [x](x.md)', '- `a`: Dois. Ver: [x](x.md)'],
      reason: /duplicate slug "a"/,
    },
    {
      name: 'a statement of 256 code points',
      lines: [`- \`a\`: ${'𝒳'.repeat(256)}`],
      reason: /"a" has 256 code points/,
    },
  ])(
    'should exit with 2 and the reason on stderr for $name',
    ({ lines, reason }) => {
      const result = runHookWithStrategy(lines);

      expect(result.status).toBe(2);
      expect(result.stdout).toBe('');
      expect(result.stderr).toMatch(reason);
    },
    15_000,
  );
});

describe('parsePremises', () => {
  it('should pass a statement of 255 code points, even with 510 UTF-16 units', () => {
    const text = ['## Tema', `- \`a\`: ${'𝒳'.repeat(255)} Ver: [x](x.md)`].join('\n');

    expect(parsePremises(text)).toEqual({
      rules: [{ slug: 'a', rule: '𝒳'.repeat(255), section: '' }],
      malformed: [],
    });
  });
});

describe('classifyTypeChange', () => {
  it('should classify the addition of the optional answeredBy to premise as compatible', () => {
    const previous: RecordType = {
      type: 'object',
      properties: { statement: { type: 'string', minLength: 1, maxLength: 255 } },
      required: ['statement'],
      additionalProperties: false,
    };

    expect(classifyTypeChange(previous, fileBody('types', 'premise') as RecordType)).toBe(
      'compatible',
    );
  });
});

describe('define_type', () => {
  beforeEach(openBareEnvironment);
  afterEach(closeEnvironment);

  it.each(namesIn('types').map((name) => ({ name })))(
    'should return the JCS hash of types/$name.json on the first definition',
    async ({ name }) => {
      const input = defineArgs('types', name);

      const result = await environment.ok<Defined>('define_type', { project: PROJECT, ...input });

      expect(result.hash).toBe(hashOfJcs(definitionOf('types', name)));
    },
  );
});

describe('define_relation', () => {
  beforeEach(openBareEnvironment);
  afterEach(closeEnvironment);

  it.each(namesIn('relations').map((name) => ({ name })))(
    'should return the JCS hash of relations/$name.json on the first definition',
    async ({ name }) => {
      const input = defineArgs('relations', name);

      const result = await environment.ok<Defined>('define_relation', {
        project: PROJECT,
        ...input,
      });

      expect(result.hash).toBe(hashOfJcs(definitionOf('relations', name)));
    },
  );

  it('should not return the JCS hash of relations/closes-gap.json without its name', async () => {
    const input = defineArgs('relations', 'closes-gap');
    const withoutName = omit(definitionOf('relations', 'closes-gap'), ['name']);

    const result = await environment.ok<Defined>('define_relation', {
      project: PROJECT,
      ...input,
    });

    expect(hashOfJcs(withoutName)).not.toBe(result.hash);
  });
});

describe('define_gate', () => {
  beforeEach(openBareEnvironment);
  afterEach(closeEnvironment);

  it.each(namesIn('gates').map((name) => ({ name })))(
    'should return the JCS hash of gates/$name.json on the first definition',
    async ({ name }) => {
      const input = defineArgs('gates', name);

      const result = await environment.ok<Defined>('define_gate', { project: PROJECT, ...input });

      expect(result.hash).toBe(hashOfJcs(definitionOf('gates', name)));
    },
  );
});

describe('list', () => {
  beforeEach(openEnvironment);
  afterEach(closeEnvironment);

  it('should return, for a process, the hash of each kind map and every pinned definition', async () => {
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

  it('should return, for a process, a gates hash that differs from the map without one of the files', async () => {
    const [, ...rest] = namesIn('gates');
    const partial = hashOfJcs(
      Object.fromEntries(rest.map((name) => [name, definitionOf('gates', name)])),
    );

    const list = await environment.ok<ListResult>('list', {
      project: PROJECT,
      process: DIRECTIVES,
    });

    expect(partial).not.toBe(list.process?.hashes.gates);
  });
});

describe('verify_chain', () => {
  beforeEach(openEnvironment);
  afterEach(closeEnvironment);

  it('should report both chains intact after a complete work from the opening to the two gates', async () => {
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

    const chains = await Promise.all(
      [DIRECTIVES, WORK].map((process) =>
        environment.ok<VerifyChainResult>('verify_chain', { project: PROJECT, process }),
      ),
    );

    expect(chains.map(({ ok }) => ok)).toEqual([true, true]);
  });
});
