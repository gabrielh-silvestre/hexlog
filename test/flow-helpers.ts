import { expect } from '@jest/globals';
import { z } from 'zod';
import {
  planSync,
  type ExtractedRule,
  type PlannedRecord,
  type SyncInput,
  type SyncPlan,
  type VigentRule,
} from '../scripts/flow/sync.ts';
import type { RegisterResult } from '../src/commands/process.ts';
import { sha256hex } from '../src/domain/chain.ts';
import type { GateEvaluation, QueryRecord, QueryResult } from '../src/queries/query-service.ts';
import { defineFlowDefinitions, registerFlowRecord, type FlowRecord } from './flow-data.ts';
import { at } from './helpers.ts';
import { type Environment, createEnvironment } from './mcp/environment.ts';

export const PROJECT = 'hexlog';
export const DIRECTIVES = 'directives';
export const WORK = 'feat-x';
export const STRATEGY = 'estrategia';
const AGENT = 'flow-run';
const COMMIT = 'abc1234';

/** Ambiente do caso em curso; os hooks de cada `describe` de topo o abrem e o fecham. */
export let environment: Environment;

/** Os hooks entram em cada describe que usa o ambiente: o lint barra hook fora de describe. */
export async function openEnvironment(): Promise<void> {
  environment = await createEnvironment();
  await defineFlowDefinitions(environment);
  for (const process of [DIRECTIVES, `${DIRECTIVES}-2`, WORK]) {
    await environment.ok('create_process', { project: PROJECT, process });
  }
}

/** Ambiente sem nenhuma definição: o caso que confere o retorno de `define_*` o chama pela primeira vez. */
export async function openBareEnvironment(): Promise<void> {
  environment = await createEnvironment();
}

export async function closeEnvironment(): Promise<void> {
  await environment.close();
}

// ---- gravação e leitura ----

export type Item = FlowRecord & { alias?: string };

export const writeBatch = (process: string, records: Item[], key?: string) =>
  environment.call('register', { project: PROJECT, process, agent: AGENT, key, records });

export const register = (process: string, records: Item[], key?: string) =>
  environment.ok<RegisterResult>('register', {
    project: PROJECT,
    process,
    agent: AGENT,
    key,
    records,
  });

/** Id do único registro gravado. */
export const registerOne = (process: string, record: FlowRecord): Promise<string> =>
  registerFlowRecord(environment, process, record);

export const withRelations = (item: Item, relations: Record<string, unknown>[]): Item => ({
  ...item,
  relations,
});

/** Registro `directive` de `convencoes`; `text` é o conteúdo do anexo que `source` cita. */
export const directiveItem = (
  slug: string,
  text: string,
  relations: Record<string, unknown>[] = [],
): Item =>
  withRelations(
    {
      type: 'directive',
      target: `directives.convencoes.${slug}`,
      data: { rule: `Rule ${slug}`, section: 'Section', source: sha256hex(text) },
    },
    relations,
  );

/** Guarda o texto como anexo e devolve o hash que um `source` cita. */
export const attachText = async (text = 'research notes'): Promise<string> =>
  (await environment.ok<{ hash: string }>('attach', { project: PROJECT, text })).hash;

/** Todas as páginas de um `query`, seguindo o `cursor` até ele sumir. */
export async function queryAll(
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

/** Arestas de saída do registro `id`, de qualquer processo do projeto. */
export async function outEdgesOf(id: string): Promise<NonNullable<QueryRecord['out']>> {
  const { records } = await queryAll({ scope: 'project', ids: [id] });
  return at(records, 0).out ?? [];
}

export const passed = async (gate: string): Promise<boolean> =>
  (
    await environment.ok<GateEvaluation>('evaluate_gate', {
      project: PROJECT,
      process: WORK,
      gate,
      target: WORK,
    })
  ).passed;

// ---- dados de exemplo ----

export const opening = () => ({
  mode: 'autonomous',
  route: 'direct',
  request: 'Add retry to the uploader',
  branch: 'feat/x',
  commit: COMMIT,
  sync: 'up-to-date',
});

export const decisionData = (overrides: Record<string, unknown> = {}) => ({
  choice: 'Use exponential backoff',
  alternatives: [{ option: 'Fixed delay', reason: 'Piles up retries under load' }],
  rationale: 'The directive asks for bounded retries',
  grounds: 'directive',
  confidence: 'high',
  ...overrides,
});

export const gapData = () => ({
  question: 'How many attempts before giving up?',
  context: 'No directive covers retry limits',
  provisionalChoice: '3 attempts',
});

export const findingData = (severity: string) => ({
  severity,
  origin: 'review',
  description: 'Retry loop has no upper bound',
  location: 'src/upload.ts',
});

export const workRecord = (type: string, short: string, data: Record<string, unknown>): Item => ({
  type,
  target: `${WORK}.${type}.${short}`,
  data,
});

export const premise = (short: string, statement = `Premise ${short}`): Item =>
  workRecord('premise', short, { statement });

export const registerGap = (short = 'retry') =>
  registerOne(WORK, workRecord('gap', short, gapData()));

// ---- sync (a rotina da skill, em volta do módulo puro) ----

export const docPath = (docSlug: string) => `docs/directives/${docSlug}.md`;

/** `n` regras com texto perto do teto de 400 caracteres, para a consulta passar de uma página. */
export const rulesOf = (count: number, prefix = 'r', version = 1): ExtractedRule[] =>
  Array.from({ length: count }, (_, index) => ({
    slug: `${prefix}${index + 1}`,
    rule: `Rule ${prefix}${index + 1} v${version}: ${'x'.repeat(350)}`,
    section: 'Section',
  }));

/** Premissas de `estrategia`, com texto dentro do teto de 255 caracteres do `statement`. */
export const premisesOf = (count: number, prefix = 'p', version = 1): ExtractedRule[] =>
  Array.from({ length: count }, (_, index) => ({
    slug: `${prefix}${index + 1}`,
    rule: `Premise ${prefix}${index + 1} v${version}`,
    section: '',
  }));

const RuleData = z.object({ rule: z.string(), section: z.string() });
// `estrategia` carrega premissas: o `statement` faz o papel de `rule` e não há seção.
const PremiseData = z
  .object({ statement: z.string() })
  .transform(({ statement }) => ({ rule: statement, section: '' }));
const DocData = z.object({ source: z.string(), removed: z.boolean().default(false) });

export async function inputFor(
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
export async function runSync(
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
export const closingRules = (rules: ExtractedRule[], gapId: string): ExtractedRule[] =>
  rules.map((rule) => ({ ...rule, closes: [gapId] }));

export const currentDirective = async (
  slug: string,
  docSlug = 'convencoes',
  process = DIRECTIVES,
) =>
  at(
    (await queryAll({ process, type: 'directive', targetPrefix: `directives.${docSlug}.${slug}` }))
      .records,
    0,
  );

export const currentPremise = async (slug: string, process = DIRECTIVES) =>
  at(
    (await queryAll({ process, type: 'premise', targetPrefix: `directives.${STRATEGY}.${slug}` }))
      .records,
    0,
  );

/** Premissa atemporal `p1` carregada na geração 2 por sync de `estrategia`; devolve o id dela. */
export async function seedPremise(text = 'v1'): Promise<string> {
  await runSync(`${DIRECTIVES}-2`, STRATEGY, text, premisesOf(1));
  return (await currentPremise('p1', `${DIRECTIVES}-2`)).id;
}

/** Sincroniza `convencoes` com uma regra `r1` e devolve o id dela, para ancorar decisões. */
export async function seedDirective(): Promise<string> {
  await runSync(DIRECTIVES, 'convencoes', 'v1', rulesOf(1));
  return (await currentDirective('r1')).id;
}

/** O lote planejado sobre o estado atual, gravado depois por outro sync: o `register` dele é obsoleto. */
export async function staleBatch(): Promise<{ records: PlannedRecord[]; key: string }> {
  await runSync(DIRECTIVES, 'fronteiras', 'v1', rulesOf(1));
  const stale = planSync(await inputFor(DIRECTIVES, 'fronteiras', 'v2', rulesOf(1, 'r', 2)));
  await runSync(DIRECTIVES, 'fronteiras', 'v3', rulesOf(1, 'r', 3));
  await attachText('v2');
  return at(stale.batches, 0);
}
