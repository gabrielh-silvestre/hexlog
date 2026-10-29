import fs from 'node:fs';
import * as path from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from '@jest/globals';
import { BATCH_MAX } from '../../src/domain/record.ts';
import { CHANGES_ITEMS_CAP, EVIDENCE_ITEMS_CAP } from '../../src/mcp/tools/query.ts';
import type { Defined } from '../../src/commands/definition.ts';
import type { CreateProcessResult, RegisterResult } from '../../src/commands/process.ts';
import type { AttachmentPut } from '../../src/ports.ts';
import {
  PAGE_CHARS_CAP,
  type AttachmentPage,
  type DescribeTypeResult,
  type GateEvaluation,
  type QueryResult,
  type VerifyChainResult,
} from '../../src/queries/query-service.ts';
import { at, createTempDir } from '../helpers.ts';
import {
  type Environment,
  NOTE_SCHEMA,
  PROJECT,
  TOOL_NAMES,
  createEnvironment,
  registerBulk,
  registerNote,
  servicesOver,
} from './environment.ts';

const NOTE_GATE = [{ kind: 'occurred', select: { type: 'note' } }];

const READ_ONLY_TOOLS = [
  'query',
  'evaluate_gate',
  'verify_chain',
  'read_attachment',
  'list',
  'describe_type',
];

// Restrições do Claude Code ao `inputSchema`: nome de propriedade de topo, draft e raiz sem combinadores.
const PROPERTY_NAME = /^[A-Za-z0-9_.-]{1,64}$/;
const JSON_SCHEMA_DRAFT = 'https://json-schema.org/draft/2020-12/schema';
const ROOT_COMBINATORS = ['anyOf', 'oneOf', 'allOf'];

// Limites do plano: descrição por tool e soma dos `outputSchema` anunciados.
const DESCRIPTION_MAX_CHARS = 2_048;
const OUTPUT_SCHEMA_TOTAL_MAX_CHARS = 24_280;

type ListedTool = Awaited<ReturnType<Environment['client']['listTools']>>['tools'][number];

let environment: Environment;

const openEnvironment = async () => {
  environment = await createEnvironment();
};

const closeEnvironment = async () => {
  await environment.close();
};

/** Define um tipo `note`, o gate `has-note` e cria o processo `run-1`, na ordem que o manifesto exige. */
async function prepareProcess(process = 'run-1'): Promise<void> {
  await environment.ok('define_type', { project: PROJECT, name: 'note', schema: NOTE_SCHEMA });
  await environment.ok('define_gate', { project: PROJECT, name: 'has-note', questions: NOTE_GATE });
  await environment.ok('create_process', { project: PROJECT, process });
}

/** Prepara o processo `run-1` com uma nota e devolve o anexo gravado: o estado que o teste lê. */
async function seed() {
  await prepareProcess();
  await registerNote(environment, { process: 'run-1', text: 'olá' });
  return environment.ok<AttachmentPut>('attach', { project: PROJECT, text: 'anexo' });
}

describe('tools/list', () => {
  let tools: ListedTool[];
  const toolOf = (name: string) => tools.find((candidate) => candidate.name === name);
  const descriptionOf = (name: string) => toolOf(name)?.description;

  beforeAll(async () => {
    await openEnvironment();
    ({ tools } = await environment.client.listTools());
  });
  afterAll(closeEnvironment);

  it('should announce exactly the 12 tool names', () => {
    expect(tools.map(({ name }) => name).sort()).toEqual([...TOOL_NAMES].sort());
  });

  it('should set readOnlyHint on the 6 read tools and on no other', () => {
    const readOnly = tools.filter(({ annotations }) => annotations?.readOnlyHint === true);

    expect(readOnly.map(({ name }) => name).sort()).toEqual([...READ_ONLY_TOOLS].sort());
  });

  it('should set alwaysLoad only on register', () => {
    const alwaysLoad = tools.filter(({ _meta }) => _meta?.['anthropic/alwaysLoad'] === true);

    expect(alwaysLoad.map(({ name }) => name)).toEqual(['register']);
  });

  it.each(TOOL_NAMES)('should announce title and the full annotations of %s', (name) => {
    const annotations = READ_ONLY_TOOLS.includes(name)
      ? { readOnlyHint: true, openWorldHint: false }
      : {
          readOnlyHint: false,
          destructiveHint: false,
          // Sem `key`, repetir o `register` grava de novo.
          idempotentHint: name !== 'register',
          openWorldHint: false,
        };

    const tool = toolOf(name);

    expect(tool?.title).toMatch(/\S/);
    expect(tool?.annotations).toEqual(annotations);
  });

  it.each(TOOL_NAMES)(
    'should keep the inputSchema of %s within the Claude Code restrictions',
    (name) => {
      const inputSchema = toolOf(name)?.inputSchema;

      expect(inputSchema).toMatchObject({ $schema: JSON_SCHEMA_DRAFT, type: 'object' });
      expect(
        Object.keys(inputSchema?.properties ?? {}).filter((key) => !PROPERTY_NAME.test(key)),
      ).toEqual([]);
      expect(ROOT_COMBINATORS.filter((keyword) => keyword in (inputSchema ?? {}))).toEqual([]);
    },
  );

  it('should keep every description present and within 2,048 characters', () => {
    const outOfRange = tools
      .map(({ name, description }) => ({ name, chars: description?.length ?? 0 }))
      .filter(({ chars }) => chars === 0 || chars > DESCRIPTION_MAX_CHARS);

    expect(outOfRange).toEqual([]);
  });

  it('should announce inherit for approved and no_pending only in the define_gate description', () => {
    expect(descriptionOf('define_gate')).toMatch(
      /`approved` and `no_pending` accept `inherit: true`.*`occurred` and `no_open_contradiction` do not/s,
    );
  });

  it('should tell register to read the schema with describe_type and the current id with query', () => {
    const description = descriptionOf('register');

    expect(description).toMatch(/schema with describe_type/);
    expect(description).toMatch(/read the current id with query/);
  });

  it('should tell register that as alone is enough and that every schema violation is reported', () => {
    const description = descriptionOf('register');

    expect(description).toMatch(/as alone is enough/);
    expect(description).toMatch(/kind must equal the pinned one \(else kind-mismatch\)/);
    expect(description).toMatch(/reports every schema violation of each record \(at most 50/);
    expect(description).toMatch(
      /a very costly schema ends the list with a violations-capped detail pointing to describe_type/,
    );
  });

  it('should tell register that supersedes needs the same type and target and how to move a fact', () => {
    expect(descriptionOf('register')).toMatch(
      /supersedes also needs the same type and target, else INVALID_RECORD \(target-mismatch\); to move a fact to another target, register one record there with revokes and derivesFrom to the old one/,
    );
  });

  it('should warn in the define_type description that pattern is refused and point to the catalog', () => {
    const description = descriptionOf('define_type');

    expect(description).toMatch(/pattern-not-allowed/);
    expect(description).toMatch(/unless it carries a `pattern` or `patternProperties`/);
    expect(description).toMatch(/git-sha/);
    expect(description).not.toMatch(/maxLength. of at most 256/);
  });

  it('should warn about the evidence cap in the evaluate_gate description', () => {
    expect(descriptionOf('evaluate_gate')).toMatch(
      new RegExp(`at most ${EVIDENCE_ITEMS_CAP} ids.*omitted`, 's'),
    );
  });

  it('should announce an outputSchema for every tool', () => {
    expect(tools.every(({ outputSchema }) => outputSchema !== undefined)).toBe(true);
  });

  it.each(['inheritedIn', 'inheritedOut', 'inheritedInCounts', 'inheritedOutCounts'])(
    'should announce %s in the query outputSchema',
    (key) => {
      const outputSchema = JSON.stringify(toolOf('query')?.outputSchema);

      expect(outputSchema).toContain(`"${key}":`);
    },
  );

  it('should keep the sum of the 12 tools outputSchema below 24,280 characters', () => {
    const sizes = tools.map(({ outputSchema }) => JSON.stringify(outputSchema ?? null).length);

    expect(sizes.reduce((total, size) => total + size, 0)).toBeLessThan(
      OUTPUT_SCHEMA_TOTAL_MAX_CHARS,
    );
  });
});

describe('tools/call', () => {
  beforeEach(openEnvironment);
  afterEach(closeEnvironment);

  it.each([
    ['define_type', { project: PROJECT, name: 'note', schema: NOTE_SCHEMA }, 'note'],
    ['define_relation', { project: PROJECT, name: 'approves', kind: 'supports' }, 'approves'],
    ['define_gate', { project: PROJECT, name: 'has-note', questions: NOTE_GATE }, 'has-note'],
  ])('should return the created version of %s', async (tool, args, name) => {
    const created = await environment.ok<Defined>(tool, args);

    expect(created).toMatchObject({ name, version: '1.0', created: true });
  });

  it.each([
    ['query', 'queryRecords', () => ({ project: PROJECT, process: 'run-1', relations: 'full' })],
    [
      'evaluate_gate',
      'evaluateGate',
      () => ({ project: PROJECT, process: 'run-1', gate: 'has-note', evidence: 'full' }),
    ],
    ['verify_chain', 'verifyChain', () => ({ project: PROJECT, process: 'run-1' })],
    ['read_attachment', 'readAttachment', (hash: string) => ({ project: PROJECT, hash })],
    ['list', 'list', () => ({ project: PROJECT })],
    ['describe_type', 'describeType', () => ({ project: PROJECT, type: 'note' })],
  ])('should return what the service returns for %s', async (tool, method, inputOf) => {
    const { hash } = await seed();
    const input = inputOf(hash);
    const service = servicesOver(environment).query as unknown as Record<
      string,
      (input: unknown) => unknown
    >;

    const viaTool = await environment.ok(tool, input);

    expect(viaTool).toEqual(JSON.parse(JSON.stringify(service[method]?.(input))));
  });
});

describe('create_process', () => {
  beforeEach(openEnvironment);
  afterEach(closeEnvironment);

  it('should pin what is defined', async () => {
    await environment.ok('define_type', { project: PROJECT, name: 'note', schema: NOTE_SCHEMA });
    await environment.ok('define_gate', {
      project: PROJECT,
      name: 'has-note',
      questions: NOTE_GATE,
    });

    const created = await environment.ok<CreateProcessResult>('create_process', {
      project: PROJECT,
      process: 'run-1',
    });

    expect(created).toMatchObject({
      project: PROJECT,
      process: 'run-1',
      created: true,
      lineageInheritance: true,
      pinned: { types: ['note'], gates: ['has-note'] },
    });
  });
});

describe('register', () => {
  beforeEach(openEnvironment);
  afterEach(closeEnvironment);

  /**
   * Autor que o `register` grava num servidor próprio, porque o cliente declara `claude-code` no
   * envelope e o ambiente do `beforeEach` não leva `clientInfo`.
   */
  async function authorWithEnvelope(extra: { model?: string }) {
    const withEnvelope = await createEnvironment({
      clientInfo: { name: 'claude-code', version: '2' },
    });
    try {
      await withEnvelope.ok('define_type', { project: PROJECT, name: 'note', schema: NOTE_SCHEMA });
      await withEnvelope.ok('create_process', { project: PROJECT, process: 'run-1' });
      await withEnvelope.ok('register', {
        project: PROJECT,
        process: 'run-1',
        agent: 'executor',
        ...extra,
        records: [{ type: 'note', target: 'run.step', data: { text: 'olá' } }],
      });
      const page = await withEnvelope.ok<QueryResult>('query', {
        project: PROJECT,
        process: 'run-1',
      });
      return at(page.records, 0).author;
    } finally {
      await withEnvelope.close();
    }
  }

  it('should write the batch and return ids, replayed and marker', async () => {
    await prepareProcess();

    const result = await environment.ok<RegisterResult>('register', {
      project: PROJECT,
      process: 'run-1',
      agent: 'executor',
      key: 'lote-1',
      records: [{ alias: 'first', type: 'note', target: 'run.step', data: { text: 'olá' } }],
    });

    const [saved] = result.records;

    expect(result).toMatchObject({ replayed: false, records: [{ alias: 'first' }] });
    expect(result.marker).toEqual({ 'run-1': saved?.id });
  });

  it('should write the author with the envelope client and no model when none is given', async () => {
    const author = await authorWithEnvelope({});

    expect(author).toEqual({ agent: 'executor', client: 'claude-code' });
  });

  it('should write the author with the model when it is given', async () => {
    const author = await authorWithEnvelope({ model: 'sonnet' });

    expect(author).toEqual({ agent: 'executor', model: 'sonnet', client: 'claude-code' });
  });
});

describe('attach', () => {
  beforeEach(openEnvironment);
  afterEach(closeEnvironment);

  it('should store the text and return its byte count', async () => {
    const stored = await environment.ok<AttachmentPut>('attach', {
      project: PROJECT,
      text: 'conteúdo',
    });

    expect(stored).toMatchObject({ bytes: Buffer.byteLength('conteúdo'), deduplicated: false });
  });

  it('should return a repeated text as deduplicated', async () => {
    const first = await environment.ok<AttachmentPut>('attach', {
      project: PROJECT,
      text: 'conteúdo',
    });

    const second = await environment.ok<AttachmentPut>('attach', {
      project: PROJECT,
      text: 'conteúdo',
    });

    expect(second).toEqual({ ...first, deduplicated: true });
  });

  // Servidor próprio: o `cwd` do `attach` por `path` é opção de `createEnvironment`, que o `beforeEach` não passa.
  it('should store the file bytes under the server cwd when given a path', async () => {
    const cwd = createTempDir('mcp-cwd');
    const text = 'conteúdo do plano';
    fs.writeFileSync(path.join(cwd, 'plano.md'), text);
    const scoped = await createEnvironment({ cwd });

    try {
      const put = await scoped.ok<AttachmentPut>('attach', {
        project: PROJECT,
        path: path.join(cwd, 'plano.md'),
      });

      const page = await scoped.ok<AttachmentPage>('read_attachment', {
        project: PROJECT,
        hash: put.hash,
      });

      expect(put).toMatchObject({ bytes: Buffer.byteLength(text), deduplicated: false });
      expect(page.text).toBe(text);
    } finally {
      await scoped.close();
    }
  });
});

describe('query', () => {
  beforeEach(openEnvironment);
  afterEach(closeEnvironment);

  /**
   * Registra 3 lotes de `BATCH_MAX` notas depois de um marcador: o `changesSince` da primeira
   * página sai cortado em `CHANGES_ITEMS_CAP`. Confere a pré-condição: há ids omitidos.
   */
  async function registerCutChangesAndCheckCut() {
    await prepareProcess();
    await registerNote(environment, { process: 'run-1', text: 'primeira' });
    const { marker } = await environment.ok<QueryResult>('query', {
      project: PROJECT,
      process: 'run-1',
    });
    const registered = await registerBulk(environment, BATCH_MAX * 3, { process: 'run-1' });
    const first = await environment.ok<QueryResult>('query', {
      project: PROJECT,
      process: 'run-1',
      changesSince: marker,
    });
    const omittedIds = registered.filter((id) => !first.changes?.entered.includes(id));

    expect(first.changes).toMatchObject({ omitted: { entered: omittedIds.length, left: 0 } });
    expect(omittedIds).toHaveLength(registered.length - CHANGES_ITEMS_CAP);

    return { first, omittedIds };
  }

  /** Registra 41 notas de ~700 caracteres: a página cheia estoura o teto, a de `fields: []` cabe. */
  async function registerLongNotes() {
    await prepareProcess();
    await registerBulk(environment, 41, { process: 'run-1', text: 'x'.repeat(700) });
  }

  it('should lose the cut ids when the marker of a cut changes is reused', async () => {
    const { first } = await registerCutChangesAndCheckCut();

    const reused = await environment.ok<QueryResult>('query', {
      project: PROJECT,
      process: 'run-1',
      changesSince: first.marker,
    });

    expect(reused.changes?.entered).toEqual([]);
  });

  it('should return the cut ids on a full reread', async () => {
    const { omittedIds } = await registerCutChangesAndCheckCut();

    const reread: string[] = [];
    let cursor: string | undefined;
    do {
      const page: QueryResult = await environment.ok('query', {
        project: PROJECT,
        process: 'run-1',
        cursor,
      });
      reread.push(...page.records.map(({ id }) => id));
      cursor = page.cursor;
    } while (cursor !== undefined);

    expect(reread).toEqual(expect.arrayContaining(omittedIds));
  });

  it('should trim data to the requested fields and keep the rest of the record', async () => {
    await prepareProcess();
    await registerNote(environment, { process: 'run-1', text: 'olá' });

    const page = await environment.ok<QueryResult>('query', {
      project: PROJECT,
      process: 'run-1',
      fields: ['text', 'ausente'],
    });

    expect(page.records).toEqual([
      expect.objectContaining({ type: 'note', target: 'run.step', data: { text: 'olá' } }),
    ]);
  });

  it('should exceed the cap and return a cursor without fields', async () => {
    await registerLongNotes();
    const input = { project: PROJECT, process: 'run-1', limit: 100 };

    const full = await environment.ok<QueryResult>('query', input);

    expect(full.records.length).toBeLessThan(41);
    expect(full.cursor).toEqual(expect.any(String));
  });

  it('should fit in one page with empty fields', async () => {
    await registerLongNotes();
    const input = { project: PROJECT, process: 'run-1', limit: 100, fields: [] };

    const light = await environment.ok<QueryResult>('query', input);

    expect(light.records).toHaveLength(41);
    expect(light.cursor).toBeUndefined();
  });

  it('should surface the service refusal as its own error, with no rule of the tool', async () => {
    const body = await environment.fail(
      'query',
      { project: PROJECT, process: 'inexistente' },
      'PROCESS_NOT_FOUND',
    );

    expect(at(body.details, 0).path).toBe('/process');
  });
});

describe('evaluate_gate', () => {
  beforeEach(openEnvironment);
  afterEach(closeEnvironment);

  it('should cut each evidence list at EVIDENCE_ITEMS_CAP and report omitted', async () => {
    await prepareProcess();
    await registerBulk(environment, BATCH_MAX * 3, { process: 'run-1' });

    const result = await environment.ok<GateEvaluation & { questions: { omitted?: unknown }[] }>(
      'evaluate_gate',
      { project: PROJECT, process: 'run-1', gate: 'has-note', evidence: 'full' },
    );

    const [question] = result.questions;

    expect(result.passed).toBe(true);
    expect(question).toMatchObject({
      passed: true,
      evidence: { found: expect.any(Array) },
      omitted: { found: BATCH_MAX * 3 - EVIDENCE_ITEMS_CAP },
    });
    expect(question?.evidence).toHaveProperty('found.length', EVIDENCE_ITEMS_CAP);
  });

  it('should carry no omitted below the cap', async () => {
    await prepareProcess();
    await registerNote(environment, { process: 'run-1', text: 'olá' });

    const result = await environment.ok<GateEvaluation>('evaluate_gate', {
      project: PROJECT,
      process: 'run-1',
      gate: 'has-note',
    });

    expect(result.questions[0]).not.toHaveProperty('omitted');
  });
});

describe('verify_chain', () => {
  beforeEach(openEnvironment);
  afterEach(closeEnvironment);

  it('should pass with an expectedHead equal to the head from its own output', async () => {
    await seed();
    const input = { project: PROJECT, process: 'run-1' };
    const { head } = await environment.ok<VerifyChainResult>('verify_chain', input);

    const known = await environment.ok<VerifyChainResult>('verify_chain', {
      ...input,
      expectedHead: head,
    });

    expect(known.ok).toBe(true);
  });

  it('should break with head-not-found for an unknown expectedHead hash', async () => {
    await seed();
    const input = { project: PROJECT, process: 'run-1' };
    const { totalRecords } = await environment.ok<VerifyChainResult>('verify_chain', input);

    const unknown = await environment.ok<VerifyChainResult>('verify_chain', {
      ...input,
      expectedHead: 'a'.repeat(64),
    });

    expect(unknown).toMatchObject({
      ok: false,
      breaks: [{ index: totalRecords, reason: 'head-not-found' }],
      totalBreaks: 1,
    });
  });

  it.each([
    { scenario: 'outside the hash format', expectedHead: 'não-é-hash' },
    { scenario: 'empty', expectedHead: '' },
  ])(
    'should refuse an expectedHead $scenario with INVALID_INPUT at /expectedHead',
    async ({ expectedHead }) => {
      await seed();

      const body = await environment.fail(
        'verify_chain',
        {
          project: PROJECT,
          process: 'run-1',
          expectedHead,
        },
        'INVALID_INPUT',
      );

      expect(body.details).toEqual([expect.objectContaining({ path: '/expectedHead' })]);
    },
  );
});

describe('read_attachment', () => {
  beforeEach(openEnvironment);
  afterEach(closeEnvironment);

  it('should page at PAGE_CHARS_CAP without maxChars', async () => {
    const text = 'x'.repeat(PAGE_CHARS_CAP + 1);
    const { hash } = await environment.ok<AttachmentPut>('attach', { project: PROJECT, text });

    const page = await environment.ok<AttachmentPage>('read_attachment', {
      project: PROJECT,
      hash,
    });

    expect(page.text).toHaveLength(PAGE_CHARS_CAP);
    expect(page.next).toBe(PAGE_CHARS_CAP);
  });
});

describe('describe_type', () => {
  beforeEach(openEnvironment);
  afterEach(closeEnvironment);

  const NOTE_V2 = {
    ...NOTE_SCHEMA,
    properties: { ...NOTE_SCHEMA.properties, tag: { type: 'string' } },
  };

  /** Fixa `note` 1.0 no processo `run-1` e depois define `note` 1.1 e `other` no projeto. */
  async function pinNoteThenEvolve(): Promise<void> {
    await environment.ok('define_type', { project: PROJECT, name: 'note', schema: NOTE_SCHEMA });
    await environment.ok('create_process', { project: PROJECT, process: 'run-1' });
    await environment.ok('define_type', { project: PROJECT, name: 'note', schema: NOTE_V2 });
    await environment.ok('define_type', { project: PROJECT, name: 'other', schema: NOTE_SCHEMA });
  }

  it('should return the pinned schema without version with process, even with a newer version in the project', async () => {
    await pinNoteThenEvolve();

    const result = await environment.ok<DescribeTypeResult>('describe_type', {
      project: PROJECT,
      type: 'note',
      process: 'run-1',
    });

    expect(result).toEqual({ name: 'note', schema: NOTE_SCHEMA });
  });

  it('should return the current version without process', async () => {
    await pinNoteThenEvolve();

    const current = await environment.ok<DescribeTypeResult>('describe_type', {
      project: PROJECT,
      type: 'note',
    });

    expect(current).toEqual({ name: 'note', version: '1.1', schema: NOTE_V2 });
  });

  it('should return the requested version with version', async () => {
    await pinNoteThenEvolve();

    const asked = await environment.ok<DescribeTypeResult>('describe_type', {
      project: PROJECT,
      type: 'note',
      version: '1.0',
    });

    expect(asked).toEqual({ name: 'note', version: '1.0', schema: NOTE_SCHEMA });
  });

  it('should refuse process and version together with INVALID_INPUT at /version', async () => {
    await pinNoteThenEvolve();

    const body = await environment.fail(
      'describe_type',
      {
        project: PROJECT,
        type: 'note',
        process: 'run-1',
        version: '1.0',
      },
      'INVALID_INPUT',
    );

    expect(body.details).toEqual([expect.objectContaining({ path: '/version' })]);
  });

  it('should refuse a version outside <major>.<minor> with INVALID_INPUT at /version, code invalid-version', async () => {
    await pinNoteThenEvolve();

    const body = await environment.fail(
      'describe_type',
      { project: PROJECT, type: 'note', version: '1' },
      'INVALID_INPUT',
    );

    expect(body.details).toEqual([
      expect.objectContaining({ path: '/version', code: 'invalid-version' }),
    ]);
  });

  it('should refuse a type not pinned in the process with TYPE_NOT_PINNED at /type', async () => {
    await pinNoteThenEvolve();

    const notPinned = await environment.fail(
      'describe_type',
      {
        project: PROJECT,
        type: 'other',
        process: 'run-1',
      },
      'TYPE_NOT_PINNED',
    );

    expect(notPinned.details).toEqual([expect.objectContaining({ path: '/type' })]);
  });

  it('should refuse a missing type without process with TYPE_NOT_FOUND at /type', async () => {
    await pinNoteThenEvolve();

    const notFound = await environment.fail(
      'describe_type',
      { project: PROJECT, type: 'ghost' },
      'TYPE_NOT_FOUND',
    );

    expect(notFound.details).toEqual([expect.objectContaining({ path: '/type' })]);
  });
});
