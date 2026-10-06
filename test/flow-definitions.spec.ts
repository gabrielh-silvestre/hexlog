import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, test } from '@jest/globals';
import { omit } from 'es-toolkit';
import { z } from 'zod';
import {
  planSync,
  type ExtractedRule,
  type PlannedRecord,
  type SyncInput,
  type SyncPlan,
  type VigentRule,
} from '../.claude/hooks/flow-sync.ts';
import type { Defined } from '../src/commands/definition.ts';
import type { RegisterResult } from '../src/commands/process.ts';
import { hashOfJcs } from '../src/domain/chain.ts';
import type {
  GateEvaluation,
  ListResult,
  QueryRecord,
  QueryResult,
  VerifyChainResult,
} from '../src/queries/query-service.ts';
import { at, parseJson } from './helpers.ts';
import { type Environment, createEnvironment, expectError } from './mcp/environment.ts';

const repoRoot = path.resolve(__dirname, '..');
const hexlogDir = path.join(repoRoot, '.hexlog');

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

const sha256 = (text: string): string => createHash('sha256').update(text).digest('hex');

let environment: Environment;
let defined: Record<string, Defined>;

beforeEach(async () => {
  environment = await createEnvironment();
  defined = {};
  for (const kind of KINDS) {
    for (const name of namesIn(kind)) {
      const body = definitionOf(kind, name);
      const input = kind === 'types' ? { name, schema: body } : body;
      defined[`${kind}/${name}`] = await environment.ok<Defined>(DEFINE_TOOL[kind], {
        project: PROJECT,
        ...input,
      });
    }
  }
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
  data: { rule: `Rule ${slug}`, section: 'Section', source: sha256(text) },
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
    const page = await environment.ok<QueryResult>('query', { project: PROJECT, ...args, cursor });
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

const RuleData = z.object({ rule: z.string(), section: z.string() });
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
  const rules = await queryAll({ process, type: 'directive', targetPrefix: prefix });
  const vigent: VigentRule[] = rules.records.map(({ id, target, data, out }) => ({
    id,
    target,
    ...RuleData.parse(data),
    out: out.map(({ as, kind, to }) => ({ ...(as && { as }), kind, to })),
  }));
  return {
    docSlug,
    path: docPath(docSlug),
    hash: text === null ? '' : sha256(text),
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

/** Sincroniza `convencoes` com uma regra `r1` e devolve o id dela, para ancorar decisões. */
async function seedDirective(): Promise<string> {
  await runSync(DIRECTIVES, 'convencoes', 'v1', rulesOf(1));
  return (await currentDirective('r1')).id;
}

describe('schemas e relações', () => {
  test('cada tipo aceita um registro válido', async () => {
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
    ['sem grounds', omit(decisionData(), ['grounds'])],
    ['sem rationale', omit(decisionData(), ['rationale'])],
    ['com campo desconhecido', decisionData({ extra: 'x' })],
    ['sem alternativas', decisionData({ alternatives: [] })],
    ['com confiança fora do enum', decisionData({ confidence: 'sure' })],
  ])('decision %s é INVALID_RECORD', async (_label, data) => {
    const result = await writeBatch(WORK, [workRecord('decision', 'bad', data)]);

    expectError(result, 'INVALID_RECORD');
  });

  test.each([
    ['opening com modo fora do enum', workRecord('opening', 'main', { ...opening(), mode: 'x' })],
    [
      'opening com commit que não é sha',
      workRecord('opening', 'main', { ...opening(), commit: 'HEAD' }),
    ],
    ['gap sem contexto', workRecord('gap', 'a', { question: 'Q?' })],
    ['finding com severidade fora do enum', workRecord('finding', 'a', findingData('HIGH'))],
    [
      'verification com 13 comandos',
      workRecord('verification', 'main', {
        ...verificationData('passed'),
        commands: Array.from({ length: 13 }, () => ({ command: 'npm test', ok: true })),
      }),
    ],
  ])('%s é INVALID_RECORD', async (_label, record) => {
    expectError(await writeBatch(WORK, [record]), 'INVALID_RECORD');
  });

  test('doc com caminho fora de docs/directives é INVALID_RECORD e o válido passa', async () => {
    const { hash: source } = await environment.ok<{ hash: string }>('attach', {
      project: PROJECT,
      text: 'v1',
    });

    const bad = await writeBatch(DIRECTIVES, [
      { type: 'doc', target: 'directives.x', data: { path: 'docs/x.md', source } },
    ]);
    expectError(bad, 'INVALID_RECORD');

    const { records } = await register(DIRECTIVES, [
      { type: 'doc', target: 'directives.x', data: { path: docPath('x'), source } },
    ]);
    expect(records).toHaveLength(1);
  });

  test('hash de anexo que não foi guardado é ATTACHMENT_NOT_FOUND', async () => {
    const result = await writeBatch(DIRECTIVES, [directiveItem('r1', 'never attached')]);

    expectError(result, 'ATTACHMENT_NOT_FOUND');
  });

  test('as quatro relações aceitam as pontas declaradas', async () => {
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

  test('decision não fecha lacuna: closes-gap exige origem directive (endpoint-type)', async () => {
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
      'directive com resolves-finding',
      ({ findingId }: Ends): [string, Item] => [
        DIRECTIVES,
        directiveItem('r9', 'v1', [{ to: findingId, as: 'resolves-finding' }]),
      ],
    ],
    [
      'decision com anchored-in para lacuna',
      ({ gapId }: Ends): [string, Item] => [
        WORK,
        {
          ...workRecord('decision', 'b', decisionData()),
          relations: [{ to: gapId, as: 'anchored-in' }],
        },
      ],
    ],
    [
      'decision com about-gap para achado',
      ({ findingId }: Ends): [string, Item] => [
        WORK,
        {
          ...workRecord('decision', 'b', decisionData()),
          relations: [{ to: findingId, as: 'about-gap' }],
        },
      ],
    ],
  ])('ponta fora do declarado: %s é INVALID_RECORD', async (_label, build) => {
    await seedDirective();
    const gapId = await registerGap();
    const findingId = await registerOne(WORK, workRecord('finding', 'a', findingData('URGENT')));
    const [process, record] = build({ gapId, findingId });

    const body = expectError(await writeBatch(process, [record]), 'INVALID_RECORD');

    expect(body.details[0]?.code).toBe('endpoint-type');
  });
});

describe('gate pre-pr', () => {
  test('falha sem verificação', async () => {
    expect(await passed('pre-pr')).toBe(false);
  });

  test('passa com verificação passed e volta a falhar quando uma failed a supera', async () => {
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

  test('falha com achado URGENT sem resolves-finding e passa com uma decisão que o resolve', async () => {
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

  test('achado NORMAL não barra, e answers cru de outro tipo não resolve o URGENT', async () => {
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

describe('gate gaps (só directive fecha lacuna)', () => {
  const closeWithDirective = (gapId: string) =>
    register(DIRECTIVES, [directiveItem('retries', 'v1', [{ to: gapId, as: 'closes-gap' }])]);

  test('passa sem nenhuma lacuna e falha com lacuna aberta', async () => {
    expect(await passed('gaps')).toBe(true);

    await registerGap();

    expect(await passed('gaps')).toBe(false);
  });

  test('passa quando uma directive de outro processo fecha a lacuna', async () => {
    await environment.ok('attach', { project: PROJECT, text: 'v1' });
    const gapId = await registerGap();

    await closeWithDirective(gapId);

    expect(await passed('gaps')).toBe(true);
  });

  test('continua falhando com decisão refeita e answers cru de decision para a lacuna', async () => {
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
  test('(i) carga de 60 regras em duas páginas e dois lotes, e a edição editorial só troca o doc', async () => {
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

  test('(i) sem mudança de hash o resultado é em dia e sem lote', async () => {
    await runSync(DIRECTIVES, 'fronteiras', 'v1', rulesOf(3));

    const again = await runSync(DIRECTIVES, 'fronteiras', 'v1', rulesOf(3));

    expect(again).toEqual({ upToDate: true, batches: [], warnings: [] });
  });

  test('(ii) regra intacta não é superada e a alterada ganha registro novo', async () => {
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

  test('(iii) regra alterada que fechava lacuna: com a cópia o gate segue passando', async () => {
    await runSync(DIRECTIVES, 'convencoes', 'v1', rulesOf(1));
    const gapId = await registerGap();
    await runSync(DIRECTIVES, 'convencoes', 'v2', [
      ...rulesOf(1),
      ...closingRules(rulesOf(1, 'retry'), gapId),
    ]);
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

  test('(iii) sem copiar closes-gap o gate volta a falhar', async () => {
    await runSync(DIRECTIVES, 'convencoes', 'v1', rulesOf(1));
    const gapId = await registerGap();
    await runSync(DIRECTIVES, 'convencoes', 'v2', [
      ...rulesOf(1),
      ...closingRules(rulesOf(1, 'retry'), gapId),
    ]);

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

  test('closes: regra nova fecha a lacuna e o gate passa; sem closes a lacuna segue aberta', async () => {
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

  test('closes: regra nova sem versão anterior leva só o closes-gap, sem supersedes', async () => {
    await runSync(DIRECTIVES, 'convencoes', 'v1', rulesOf(1));
    const gapId = await registerGap();

    const plan = await runSync(DIRECTIVES, 'convencoes', 'v2', [
      ...rulesOf(1),
      ...closingRules(rulesOf(1, 'retry'), gapId),
    ]);

    expect(at(plan.batches, 0).records[0]?.relations).toEqual([{ to: gapId, as: 'closes-gap' }]);
    expect(await passed('gaps')).toBe(true);
  });

  test('closes: regra existente e inalterada vira supersedes e o gate passa', async () => {
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

  test('closes: regra que já fecha a lacuna não gera registro novo, e o edge copiado não duplica', async () => {
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

  test('(iv) regra removida que fechava lacuna é revogada, avisa e o gate falha', async () => {
    await runSync(DIRECTIVES, 'convencoes', 'v1', rulesOf(1));
    const gapId = await registerGap();
    await runSync(DIRECTIVES, 'convencoes', 'v2', [
      ...rulesOf(1),
      ...closingRules(rulesOf(1, 'retry'), gapId),
    ]);

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

  test('(iv) regra removida que não fechava lacuna não gera aviso nem afeta o gate', async () => {
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

  test('(v) documento apagado vira lápide e some do vigente; recriado supera a lápide', async () => {
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

  test('(v) documento que nunca teve sync e foi apagado não gera lote', async () => {
    expect(await runSync(DIRECTIVES, 'fantasma', null, null)).toEqual({
      upToDate: true,
      batches: [],
      warnings: [],
    });
  });

  test('(vi) falha no segundo lote, re-sync converge e o mesmo lote reenviado é replay', async () => {
    const rules = rulesOf(60);
    const plan = planSync(await inputFor(DIRECTIVES, 'fronteiras', 'v1', rules));
    await environment.ok('attach', { project: PROJECT, text: 'v1' });
    const [first, second] = [at(plan.batches, 0), at(plan.batches, 1)];
    const firstResult = await register(DIRECTIVES, first.records, first.key);
    const refused = second.records.map((record) =>
      record.type === 'doc'
        ? { ...record, data: { ...record.data, path: 'docs/oops.md' } }
        : record,
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

  test('(vi) a mesma key com outro lote é IDEMPOTENCY_CONFLICT, por isso a key deriva do conteúdo', async () => {
    const rules = rulesOf(60);
    const plan = planSync(await inputFor(DIRECTIVES, 'fronteiras', 'v1', rules));
    await environment.ok('attach', { project: PROJECT, text: 'v1' });
    const first = at(plan.batches, 0);
    await register(DIRECTIVES, first.records, first.key);

    const other = await writeBatch(DIRECTIVES, at(plan.batches, 1).records, first.key);

    expectError(other, 'IDEMPOTENCY_CONFLICT');
    expect(at(plan.batches, 1).key).not.toBe(first.key);
  });

  test('(vii) dois syncs concorrentes: o segundo recebe FORK_REJECTED e refaz a partir do estado novo', async () => {
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
    expect((await currentDirective('r1', 'fronteiras')).data.rule).toContain('v2');
  });

  test('(passo 8) a query de auditoria lista target vigente duplicado e não acusa sync normal', async () => {
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

  test('(viii) regra interpreted não muda os registros gerados', async () => {
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

  test('revogar 99 regras de uma vez cabe em 100 relações e 100 devolvem too-many-relations', async () => {
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
      hash: sha256('v2'),
      current: null,
      vigent,
      extracted: [],
    });
    expect(refused).toMatchObject({ upToDate: false, batches: [], error: 'too-many-relations' });
  });
});

describe('duas gerações do processo de diretrizes', () => {
  test('query com process devolve uma, com scope project devolve as duas', async () => {
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

  test('lacuna fechada pela geração 1 segue fechada com a geração 2 existente; sem o fechamento falha', async () => {
    const gapId = await registerGap();
    await runSync(`${DIRECTIVES}-2`, 'convencoes', 'v1', rulesOf(1));
    expect(await passed('gaps')).toBe(false);

    await runSync(DIRECTIVES, 'convencoes', 'v1', closingRules(rulesOf(1), gapId));

    expect(await passed('gaps')).toBe(true);
  });
});

describe('hashes das definições', () => {
  test.each(KINDS.flatMap((kind) => namesIn(kind).map((name) => [kind, name] as const)))(
    '%s/%s: o hash devolvido por define_* é o hashOfJcs do corpo montado do arquivo',
    (kind, name) => {
      expect(defined[`${kind}/${name}`]?.hash).toBe(hashOfJcs(definitionOf(kind, name)));
    },
  );

  test('o hash de uma relação sem o nome não coincide', () => {
    const withoutName = omit(definitionOf('relations', 'closes-gap'), ['name']);

    expect(hashOfJcs(withoutName)).not.toBe(defined['relations/closes-gap']?.hash);
  });

  test('os 3 hashes de list com process são o hashOfJcs do mapa nome para definição de cada tipo', async () => {
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
    expect(list.process?.pinned.types).toHaveLength(7);
    expect(list.process?.pinned.relations).toHaveLength(4);
    expect(list.process?.pinned.gates).toHaveLength(2);
  });

  test('o mapa sem um dos arquivos dá outro hash', async () => {
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

describe('ensaio de um trabalho completo', () => {
  test('da abertura aos dois gates, com lacuna fechada por diretriz nova e sync repetido', async () => {
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
