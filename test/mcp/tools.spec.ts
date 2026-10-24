import fs from 'node:fs';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from '@jest/globals';
import { compose } from '../../src/compose.ts';
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
  type ListResult,
  type QueryResult,
  type VerifyChainResult,
} from '../../src/queries/query-service.ts';
import { at, createTempDir } from '../helpers.ts';
import { type Environment, createEnvironment, expectError } from './environment.ts';

const PROJECT = 'alpha';
const NOTE = {
  type: 'object',
  properties: { text: { type: 'string' } },
  required: ['text'],
  additionalProperties: false,
};
const NOTE_GATE = [{ kind: 'occurred', select: { type: 'note' } }];

const ALL_TOOLS = [
  'create_process',
  'register',
  'attach',
  'define_type',
  'define_relation',
  'define_gate',
  'query',
  'evaluate_gate',
  'verify_chain',
  'read_attachment',
  'list',
  'describe_type',
];
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

let environment: Environment;

// Cada describe de topo liga estas funções aos hooks: `jest/require-top-level-describe` barra hook fora de describe.
const openEnvironment = async () => {
  environment = await createEnvironment();
};

const closeEnvironment = async () => {
  await environment.close();
};

const succeed = <T>(tool: string, args: Record<string, unknown>): Promise<T> =>
  environment.ok<T>(tool, args);

/** Serviços reais sobre o mesmo `<D>` do servidor sob teste: a referência do teste. */
const servicesOverServerData = () =>
  compose({
    dataDir: environment.dataDir,
    cwd: process.cwd(),
    clock: () => new Date('2026-01-01T00:00:00.000Z'),
    logger: () => undefined,
  }).services;

/** Define um tipo `note`, o gate `has-note` e cria o processo `run-1`, na ordem que o manifesto exige. */
async function prepareProcess(process = 'run-1'): Promise<void> {
  await succeed('define_type', { project: PROJECT, name: 'note', schema: NOTE });
  await succeed('define_gate', { project: PROJECT, name: 'has-note', questions: NOTE_GATE });
  await succeed('create_process', { project: PROJECT, process });
}

const registerNote = (process: string, text: string, target = 'run.step') =>
  succeed<RegisterResult>('register', {
    project: PROJECT,
    process,
    agent: 'executor',
    records: [{ type: 'note', target, data: { text } }],
  });

/** Prepara o processo `run-1` com uma nota e devolve o anexo gravado: o estado que o teste lê. */
async function seed() {
  await prepareProcess();
  await registerNote('run-1', 'olá');
  return succeed<AttachmentPut>('attach', { project: PROJECT, text: 'anexo' });
}

describe('tools/list', () => {
  beforeEach(openEnvironment);
  afterEach(closeEnvironment);

  it('should announce exactly the 12 tool names', async () => {
    const { tools } = await environment.client.listTools();

    expect(tools.map(({ name }) => name).sort()).toEqual([...ALL_TOOLS].sort());
  });

  it('should set readOnlyHint on the 6 read tools and on no other', async () => {
    const { tools } = await environment.client.listTools();

    const readOnly = tools.filter(({ annotations }) => annotations?.readOnlyHint === true);

    expect(readOnly.map(({ name }) => name).sort()).toEqual([...READ_ONLY_TOOLS].sort());
  });

  it('should set alwaysLoad only on register', async () => {
    const { tools } = await environment.client.listTools();

    const alwaysLoad = tools.filter(({ _meta }) => _meta?.['anthropic/alwaysLoad'] === true);

    expect(alwaysLoad.map(({ name }) => name)).toEqual(['register']);
  });

  it.each(ALL_TOOLS)('should announce title and the full annotations of %s', async (name) => {
    const annotations = READ_ONLY_TOOLS.includes(name)
      ? { readOnlyHint: true, openWorldHint: false }
      : {
          readOnlyHint: false,
          destructiveHint: false,
          // Sem `key`, repetir o `register` grava de novo.
          idempotentHint: name !== 'register',
          openWorldHint: false,
        };

    const { tools } = await environment.client.listTools();

    const tool = tools.find((candidate) => candidate.name === name);

    expect(tool?.title).toMatch(/\S/);
    expect(tool?.annotations).toEqual(annotations);
  });

  it.each(ALL_TOOLS)(
    'should keep the inputSchema of %s within the Claude Code restrictions',
    async (name) => {
      const { tools } = await environment.client.listTools();

      const inputSchema = tools.find((candidate) => candidate.name === name)?.inputSchema;

      expect(inputSchema).toMatchObject({ $schema: JSON_SCHEMA_DRAFT, type: 'object' });
      expect(
        Object.keys(inputSchema?.properties ?? {}).filter((key) => !PROPERTY_NAME.test(key)),
      ).toEqual([]);
      expect(ROOT_COMBINATORS.filter((keyword) => keyword in (inputSchema ?? {}))).toEqual([]);
    },
  );

  it('should keep every description present and within 2,048 characters', async () => {
    const { tools } = await environment.client.listTools();

    const outOfRange = tools
      .map(({ name, description }) => ({ name, chars: description?.length ?? 0 }))
      .filter(({ chars }) => chars === 0 || chars > DESCRIPTION_MAX_CHARS);

    expect(outOfRange).toEqual([]);
  });

  it('should describe fields and the 50-name cap in the query description', async () => {
    const { tools } = await environment.client.listTools();

    const description = tools.find((tool) => tool.name === 'query')?.description;

    expect(description).toMatch(/fields \(at most 50\).*empty list omits data/s);
  });

  it('should announce inherit for approved and no_pending only in the define_gate description', async () => {
    const { tools } = await environment.client.listTools();

    const description = tools.find((tool) => tool.name === 'define_gate')?.description;

    expect(description).toMatch(
      /`approved` and `no_pending` accept `inherit: true`.*`occurred` and `no_open_contradiction` do not/s,
    );
  });

  it('should tell register to read the schema with describe_type and the current id with query', async () => {
    const { tools } = await environment.client.listTools();

    const description = tools.find((tool) => tool.name === 'register')?.description;

    expect(description).toMatch(/schema with describe_type/);
    expect(description).toMatch(/read the current id with query/);
  });

  it('should tell register that as alone is enough and that every schema violation is reported', async () => {
    const { tools } = await environment.client.listTools();

    const description = tools.find((tool) => tool.name === 'register')?.description;

    expect(description).toMatch(/as alone is enough/);
    expect(description).toMatch(/kind must equal the pinned one \(else kind-mismatch\)/);
    expect(description).toMatch(/reports every schema violation of each record \(at most 50/);
    expect(description).toMatch(/only one over a very costly schema/);
  });

  it('should warn in the define_type description that pattern is refused and point to the catalog', async () => {
    const { tools } = await environment.client.listTools();

    const description = tools.find((tool) => tool.name === 'define_type')?.description;

    expect(description).toMatch(/pattern-not-allowed/);
    expect(description).toMatch(/unless it carries a `pattern` or `patternProperties`/);
    expect(description).toMatch(/git-sha/);
    expect(description).not.toMatch(/maxLength. of at most 256/);
  });

  it('should warn about the changes cap in the query description', async () => {
    const { tools } = await environment.client.listTools();

    const description = tools.find((tool) => tool.name === 'query')?.description;

    expect(description).toMatch(
      new RegExp(`at most ${CHANGES_ITEMS_CAP} ids.*omitted.*must not be reused`, 's'),
    );
  });

  it('should warn about the evidence cap in the evaluate_gate description', async () => {
    const { tools } = await environment.client.listTools();

    const description = tools.find((tool) => tool.name === 'evaluate_gate')?.description;

    expect(description).toMatch(new RegExp(`at most ${EVIDENCE_ITEMS_CAP} ids.*omitted`, 's'));
  });

  it('should keep the sum of the 12 tools outputSchema below 24,280 characters', async () => {
    const { tools } = await environment.client.listTools();

    const sizes = tools.map(({ outputSchema }) => JSON.stringify(outputSchema ?? null).length);

    expect(tools.every(({ outputSchema }) => outputSchema !== undefined)).toBe(true);
    expect(sizes.reduce((total, size) => total + size, 0)).toBeLessThan(
      OUTPUT_SCHEMA_TOTAL_MAX_CHARS,
    );
  });
});

describe('create_process', () => {
  beforeEach(openEnvironment);
  afterEach(closeEnvironment);

  it('should pin what is defined', async () => {
    await succeed('define_type', { project: PROJECT, name: 'note', schema: NOTE });
    await succeed('define_gate', { project: PROJECT, name: 'has-note', questions: NOTE_GATE });

    const created = await succeed<CreateProcessResult>('create_process', {
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

  it('should write the batch and return ids, replayed and marker', async () => {
    await prepareProcess();

    const result = await succeed<RegisterResult>('register', {
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

  it('should write the author with the envelope client and the model only when given', async () => {
    const withEnvelope = await createEnvironment({
      clientInfo: { name: 'claude-code', version: '2' },
    });
    try {
      await withEnvelope.ok('define_type', { project: PROJECT, name: 'note', schema: NOTE });
      await withEnvelope.ok('create_process', { project: PROJECT, process: 'run-1' });
      const note = { type: 'note', target: 'run.step', data: { text: 'olá' } };
      await withEnvelope.ok('register', {
        project: PROJECT,
        process: 'run-1',
        agent: 'executor',
        model: 'sonnet',
        records: [note],
      });

      await withEnvelope.ok('register', {
        project: PROJECT,
        process: 'run-1',
        agent: 'executor',
        records: [note],
      });

      const page = await withEnvelope.ok<QueryResult>('query', {
        project: PROJECT,
        process: 'run-1',
      });

      expect(page.records.map(({ author }) => author)).toEqual([
        { agent: 'executor', model: 'sonnet', client: 'claude-code' },
        { agent: 'executor', client: 'claude-code' },
      ]);
    } finally {
      await withEnvelope.close();
    }
  });
});

describe('attach', () => {
  beforeEach(openEnvironment);
  afterEach(closeEnvironment);

  it('should store the text and return its byte count', async () => {
    const stored = await succeed<AttachmentPut>('attach', { project: PROJECT, text: 'conteúdo' });

    expect(stored).toMatchObject({ bytes: Buffer.byteLength('conteúdo'), deduplicated: false });
  });

  it('should return a repeated text as deduplicated', async () => {
    const first = await succeed<AttachmentPut>('attach', { project: PROJECT, text: 'conteúdo' });

    const second = await succeed<AttachmentPut>('attach', { project: PROJECT, text: 'conteúdo' });

    expect(second).toEqual({ ...first, deduplicated: true });
  });

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

describe('define_type', () => {
  beforeEach(openEnvironment);
  afterEach(closeEnvironment);

  it('should return the created version', async () => {
    const created = await succeed<Defined>('define_type', {
      project: PROJECT,
      name: 'note',
      schema: NOTE,
    });

    expect(created).toMatchObject({ name: 'note', version: '1.0', created: true });
  });
});

describe('define_relation', () => {
  beforeEach(openEnvironment);
  afterEach(closeEnvironment);

  it('should return the created version', async () => {
    const created = await succeed<Defined>('define_relation', {
      project: PROJECT,
      name: 'approves',
      kind: 'supports',
    });

    expect(created).toMatchObject({ name: 'approves', version: '1.0', created: true });
  });
});

describe('define_gate', () => {
  beforeEach(openEnvironment);
  afterEach(closeEnvironment);

  it('should return the created version', async () => {
    const created = await succeed<Defined>('define_gate', {
      project: PROJECT,
      name: 'has-note',
      questions: NOTE_GATE,
    });

    expect(created).toMatchObject({ name: 'has-note', version: '1.0', created: true });
  });
});

describe('query', () => {
  beforeEach(openEnvironment);
  afterEach(closeEnvironment);

  /**
   * Registra 3 lotes de `BATCH_MAX` notas depois de um marcador: o `changesSince` da primeira
   * página sai cortado em `CHANGES_ITEMS_CAP`. Confere a pré-condição: há ids omitidos.
   */
  async function registerCutChanges() {
    await prepareProcess();
    await registerNote('run-1', 'primeira');
    const { marker } = await succeed<QueryResult>('query', { project: PROJECT, process: 'run-1' });
    const registered: string[] = [];
    for (let batch = 0; batch < 3; batch += 1) {
      const { records } = await succeed<RegisterResult>('register', {
        project: PROJECT,
        process: 'run-1',
        agent: 'executor',
        records: Array.from({ length: BATCH_MAX }, (_, i) => ({
          type: 'note',
          target: 'run.step',
          data: { text: `n${batch}-${i}` },
        })),
      });
      registered.push(...records.map(({ id }) => id));
    }
    const first = await succeed<QueryResult>('query', {
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
    await succeed<RegisterResult>('register', {
      project: PROJECT,
      process: 'run-1',
      agent: 'executor',
      records: Array.from({ length: 41 }, () => ({
        type: 'note',
        target: 'run.step',
        data: { text: 'x'.repeat(700) },
      })),
    });
  }

  it('should lose the cut ids when the marker of a cut changes is reused', async () => {
    const { first } = await registerCutChanges();

    const reused = await succeed<QueryResult>('query', {
      project: PROJECT,
      process: 'run-1',
      changesSince: first.marker,
    });

    expect(reused.changes?.entered).toEqual([]);
  });

  it('should return the cut ids on a full reread', async () => {
    const { omittedIds } = await registerCutChanges();

    const reread: string[] = [];
    let cursor: string | undefined;
    do {
      const page: QueryResult = await succeed('query', {
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
    await registerNote('run-1', 'olá');

    const page = await succeed<QueryResult>('query', {
      project: PROJECT,
      process: 'run-1',
      fields: ['text', 'ausente'],
    });

    expect(page.records).toEqual([
      expect.objectContaining({ type: 'note', target: 'run.step', data: { text: 'olá' } }),
    ]);
  });

  it('should exceed the cap and return a cursor without fields (#85)', async () => {
    await registerLongNotes();
    const input = { project: PROJECT, process: 'run-1', limit: 100 };

    const full = await succeed<QueryResult>('query', input);

    expect(full.records.length).toBeLessThan(41);
    expect(full.cursor).toEqual(expect.any(String));
  });

  it('should fit in one page with empty fields (#85)', async () => {
    await registerLongNotes();
    const input = { project: PROJECT, process: 'run-1', limit: 100, fields: [] };

    const light = await succeed<QueryResult>('query', input);

    expect(light.records).toHaveLength(41);
    expect(light.cursor).toBeUndefined();
  });

  it('should return what the service returns', async () => {
    await seed();
    const input = { project: PROJECT, process: 'run-1', relations: 'full' as const };

    const viaTool = await succeed<QueryResult>('query', input);

    expect(viaTool).toEqual(
      JSON.parse(JSON.stringify(servicesOverServerData().query.queryRecords(input))),
    );
  });

  it('should surface the service refusal as its own error, with no rule of the tool', async () => {
    const result = await environment.call('query', { project: PROJECT, process: 'inexistente' });

    const body = expectError(result, 'PROCESS_NOT_FOUND');

    expect(at(body.details, 0).path).toBe('/process');
  });
});

describe('evaluate_gate', () => {
  beforeEach(openEnvironment);
  afterEach(closeEnvironment);

  it('should cut each evidence list at EVIDENCE_ITEMS_CAP and report omitted', async () => {
    await prepareProcess();
    for (let batch = 0; batch < 3; batch += 1) {
      await succeed<RegisterResult>('register', {
        project: PROJECT,
        process: 'run-1',
        agent: 'executor',
        records: Array.from({ length: BATCH_MAX }, (_, i) => ({
          type: 'note',
          target: 'run.step',
          data: { text: `n${batch}-${i}` },
        })),
      });
    }

    const result = await succeed<GateEvaluation & { questions: { omitted?: unknown }[] }>(
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
    await registerNote('run-1', 'olá');

    const result = await succeed<GateEvaluation>('evaluate_gate', {
      project: PROJECT,
      process: 'run-1',
      gate: 'has-note',
    });

    expect(result.questions[0]).not.toHaveProperty('omitted');
  });

  it('should return what the service returns', async () => {
    await seed();
    const input = {
      project: PROJECT,
      process: 'run-1',
      gate: 'has-note',
      evidence: 'full',
    } as const;

    const viaTool = await succeed<GateEvaluation>('evaluate_gate', input);

    expect(viaTool).toEqual(
      JSON.parse(JSON.stringify(servicesOverServerData().query.evaluateGate(input))),
    );
  });
});

describe('verify_chain', () => {
  beforeEach(openEnvironment);
  afterEach(closeEnvironment);

  it('should return what the service returns', async () => {
    await seed();
    const input = { project: PROJECT, process: 'run-1' };

    const viaTool = await succeed<VerifyChainResult>('verify_chain', input);

    expect(viaTool).toEqual(
      JSON.parse(JSON.stringify(servicesOverServerData().query.verifyChain(input))),
    );
  });

  it('should pass with an expectedHead equal to the head from its own output', async () => {
    await seed();
    const input = { project: PROJECT, process: 'run-1' };
    const { head } = await succeed<VerifyChainResult>('verify_chain', input);

    const known = await succeed<VerifyChainResult>('verify_chain', {
      ...input,
      expectedHead: head,
    });

    expect(known.ok).toBe(true);
  });

  it('should break with head-not-found for an unknown expectedHead hash', async () => {
    await seed();
    const input = { project: PROJECT, process: 'run-1' };
    const { totalRecords } = await succeed<VerifyChainResult>('verify_chain', input);

    const unknown = await succeed<VerifyChainResult>('verify_chain', {
      ...input,
      expectedHead: 'a'.repeat(64),
    });

    expect(unknown).toMatchObject({
      ok: false,
      breaks: [{ index: totalRecords, reason: 'head-not-found' }],
      totalBreaks: 1,
    });
  });

  it('should refuse an expectedHead outside the hash format with INVALID_INPUT at /expectedHead', async () => {
    await seed();

    const body = expectError(
      await environment.call('verify_chain', {
        project: PROJECT,
        process: 'run-1',
        expectedHead: 'não-é-hash',
      }),
      'INVALID_INPUT',
    );

    expect(body.details).toEqual([expect.objectContaining({ path: '/expectedHead' })]);
  });

  it('should refuse an empty expectedHead with INVALID_INPUT at /expectedHead', async () => {
    await seed();

    const body = expectError(
      await environment.call('verify_chain', {
        project: PROJECT,
        process: 'run-1',
        expectedHead: '',
      }),
      'INVALID_INPUT',
    );

    expect(body.details).toEqual([expect.objectContaining({ path: '/expectedHead' })]);
  });
});

describe('read_attachment', () => {
  beforeEach(openEnvironment);
  afterEach(closeEnvironment);

  it('should page at PAGE_CHARS_CAP without maxChars', async () => {
    const text = 'x'.repeat(PAGE_CHARS_CAP + 1);
    const { hash } = await succeed<AttachmentPut>('attach', { project: PROJECT, text });

    const page = await succeed<AttachmentPage>('read_attachment', { project: PROJECT, hash });

    expect(page.text).toHaveLength(PAGE_CHARS_CAP);
    expect(page.next).toBe(PAGE_CHARS_CAP);
  });

  it('should return what the service returns', async () => {
    const { hash } = await seed();
    const input = { project: PROJECT, hash };

    const viaTool = await succeed<AttachmentPage>('read_attachment', input);

    expect(viaTool).toEqual(servicesOverServerData().query.readAttachment(input));
  });
});

describe('list', () => {
  beforeEach(openEnvironment);
  afterEach(closeEnvironment);

  it('should return what the service returns', async () => {
    await seed();
    const input = { project: PROJECT };

    const viaTool = await succeed<ListResult>('list', input);

    expect(viaTool).toEqual(JSON.parse(JSON.stringify(servicesOverServerData().query.list(input))));
  });
});

describe('describe_type', () => {
  beforeEach(openEnvironment);
  afterEach(closeEnvironment);

  const NOTE_V2 = { ...NOTE, properties: { ...NOTE.properties, tag: { type: 'string' } } };

  /** Fixa `note` 1.0 no processo `run-1` e depois define `note` 1.1 e `other` no projeto. */
  async function pinNoteThenEvolve(): Promise<void> {
    await succeed('define_type', { project: PROJECT, name: 'note', schema: NOTE });
    await succeed('create_process', { project: PROJECT, process: 'run-1' });
    await succeed('define_type', { project: PROJECT, name: 'note', schema: NOTE_V2 });
    await succeed('define_type', { project: PROJECT, name: 'other', schema: NOTE });
  }

  it('should return the pinned schema without version with process, even with a newer version in the project', async () => {
    await pinNoteThenEvolve();

    const result = await succeed<DescribeTypeResult>('describe_type', {
      project: PROJECT,
      type: 'note',
      process: 'run-1',
    });

    expect(result).toEqual({ name: 'note', schema: NOTE });
  });

  it('should return the current version without process', async () => {
    await pinNoteThenEvolve();

    const current = await succeed<DescribeTypeResult>('describe_type', {
      project: PROJECT,
      type: 'note',
    });

    expect(current).toEqual({ name: 'note', version: '1.1', schema: NOTE_V2 });
  });

  it('should return the requested version with version', async () => {
    await pinNoteThenEvolve();

    const asked = await succeed<DescribeTypeResult>('describe_type', {
      project: PROJECT,
      type: 'note',
      version: '1.0',
    });

    expect(asked).toEqual({ name: 'note', version: '1.0', schema: NOTE });
  });

  it('should refuse process and version together with INVALID_INPUT at /version', async () => {
    await pinNoteThenEvolve();

    const body = expectError(
      await environment.call('describe_type', {
        project: PROJECT,
        type: 'note',
        process: 'run-1',
        version: '1.0',
      }),
      'INVALID_INPUT',
    );

    expect(body.details).toEqual([expect.objectContaining({ path: '/version' })]);
  });

  it('should refuse a version outside <major>.<minor> with INVALID_INPUT at /version, code invalid-version', async () => {
    await pinNoteThenEvolve();

    const body = expectError(
      await environment.call('describe_type', { project: PROJECT, type: 'note', version: '1' }),
      'INVALID_INPUT',
    );

    expect(body.details).toEqual([
      expect.objectContaining({ path: '/version', code: 'invalid-version' }),
    ]);
  });

  it('should refuse a type not pinned in the process with TYPE_NOT_PINNED at /type', async () => {
    await pinNoteThenEvolve();

    const notPinned = expectError(
      await environment.call('describe_type', {
        project: PROJECT,
        type: 'other',
        process: 'run-1',
      }),
      'TYPE_NOT_PINNED',
    );

    expect(notPinned.details).toEqual([expect.objectContaining({ path: '/type' })]);
  });

  it('should refuse a missing type without process with TYPE_NOT_FOUND at /type', async () => {
    await pinNoteThenEvolve();

    const notFound = expectError(
      await environment.call('describe_type', { project: PROJECT, type: 'ghost' }),
      'TYPE_NOT_FOUND',
    );

    expect(notFound.details).toEqual([expect.objectContaining({ path: '/type' })]);
  });

  it('should return what the service returns', async () => {
    await seed();
    const input = { project: PROJECT, type: 'note' };

    const viaTool = await succeed<DescribeTypeResult>('describe_type', input);

    expect(viaTool).toEqual(servicesOverServerData().query.describeType(input));
  });
});
