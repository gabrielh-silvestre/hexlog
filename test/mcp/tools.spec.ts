import fs from 'node:fs';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, test } from '@jest/globals';
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

// Restrições do Claude Code ao `inputSchema` (TM1): nome de propriedade de topo, draft e raiz sem combinadores.
const PROPERTY_NAME = /^[A-Za-z0-9_.-]{1,64}$/;
const JSON_SCHEMA_DRAFT = 'https://json-schema.org/draft/2020-12/schema';
const ROOT_COMBINATORS = ['anyOf', 'oneOf', 'allOf'];

// Limites do plano (TM2, TM7): descrição por tool e soma dos `outputSchema` anunciados.
const DESCRIPTION_MAX_CHARS = 2_048;
const OUTPUT_SCHEMA_TOTAL_MAX_CHARS = 24_280;

let environment: Environment;

beforeEach(async () => {
  environment = await createEnvironment();
});

afterEach(async () => {
  await environment.close();
});

const succeed = <T>(tool: string, args: Record<string, unknown>): Promise<T> =>
  environment.ok<T>(tool, args);

/** Serviços reais sobre o mesmo `<D>` do servidor sob teste: a referência do SE7. */
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

describe('TM1: catálogo anunciado em tools/list', () => {
  test('devolve exatamente os 12 nomes', async () => {
    const { tools } = await environment.client.listTools();

    expect(tools.map(({ name }) => name).sort()).toEqual([...ALL_TOOLS].sort());
  });

  test('marca readOnlyHint nas 6 tools de leitura e em nenhuma outra', async () => {
    const { tools } = await environment.client.listTools();

    const readOnly = tools.filter(({ annotations }) => annotations?.readOnlyHint === true);

    expect(readOnly.map(({ name }) => name).sort()).toEqual([...READ_ONLY_TOOLS].sort());
  });

  test('marca alwaysLoad só no register', async () => {
    const { tools } = await environment.client.listTools();

    const alwaysLoad = tools.filter(({ _meta }) => _meta?.['anthropic/alwaysLoad'] === true);

    expect(alwaysLoad.map(({ name }) => name)).toEqual(['register']);
  });

  test.each(ALL_TOOLS)('%s anuncia title e as anotações completas', async (name) => {
    const { tools } = await environment.client.listTools();
    const tool = tools.find((candidate) => candidate.name === name);
    const annotations = READ_ONLY_TOOLS.includes(name)
      ? { readOnlyHint: true, openWorldHint: false }
      : {
          readOnlyHint: false,
          destructiveHint: false,
          // Sem `key`, repetir o `register` grava de novo.
          idempotentHint: name !== 'register',
          openWorldHint: false,
        };

    expect(tool?.title).toMatch(/\S/);
    expect(tool?.annotations).toEqual(annotations);
  });

  test.each(ALL_TOOLS)('inputSchema de %s cumpre as restrições do Claude Code', async (name) => {
    const { tools } = await environment.client.listTools();
    const inputSchema = tools.find((candidate) => candidate.name === name)?.inputSchema;

    expect(inputSchema).toMatchObject({ $schema: JSON_SCHEMA_DRAFT, type: 'object' });
    expect(
      Object.keys(inputSchema?.properties ?? {}).filter((key) => !PROPERTY_NAME.test(key)),
    ).toEqual([]);
    expect(ROOT_COMBINATORS.filter((keyword) => keyword in (inputSchema ?? {}))).toEqual([]);
  });
});

describe('TM2: descrição das tools', () => {
  test('nenhuma descrição passa de 2.048 caracteres e todas existem', async () => {
    const { tools } = await environment.client.listTools();

    const outOfRange = tools
      .map(({ name, description }) => ({ name, chars: description?.length ?? 0 }))
      .filter(({ chars }) => chars === 0 || chars > DESCRIPTION_MAX_CHARS);

    expect(outOfRange).toEqual([]);
  });

  test('query descreve fields e o teto de 50 nomes', async () => {
    const { tools } = await environment.client.listTools();

    const description = tools.find((tool) => tool.name === 'query')?.description;

    expect(description).toMatch(/fields \(at most 50\).*empty list omits data/s);
  });

  test('register manda ler o schema com describe_type e o id vigente com query', async () => {
    const { tools } = await environment.client.listTools();

    const description = tools.find((tool) => tool.name === 'register')?.description;

    expect(description).toMatch(/schema with describe_type/);
    expect(description).toMatch(/read the current id with query/);
  });

  test('define_type avisa que pattern é recusado e aponta o catálogo', async () => {
    const { tools } = await environment.client.listTools();

    const description = tools.find((tool) => tool.name === 'define_type')?.description;

    expect(description).toMatch(/pattern-not-allowed/);
    expect(description).toMatch(/unless it carries a `pattern` or `patternProperties`/);
    expect(description).toMatch(/git-sha/);
    expect(description).not.toMatch(/maxLength. of at most 256/);
  });

  test('query avisa o teto de changes e evaluate_gate o de evidence', async () => {
    const { tools } = await environment.client.listTools();
    const descriptionOf = (name: string) => tools.find((tool) => tool.name === name)?.description;

    expect(descriptionOf('query')).toMatch(
      new RegExp(`at most ${CHANGES_ITEMS_CAP} ids.*omitted.*must not be reused`, 's'),
    );
    expect(descriptionOf('evaluate_gate')).toMatch(
      new RegExp(`at most ${EVIDENCE_ITEMS_CAP} ids.*omitted`, 's'),
    );
  });
});

describe('TM7: outputSchema anunciado', () => {
  test('a soma do outputSchema das 12 tools fica abaixo de 24.280 caracteres', async () => {
    const { tools } = await environment.client.listTools();

    const sizes = tools.map(({ outputSchema }) => JSON.stringify(outputSchema ?? null).length);

    expect(tools.every(({ outputSchema }) => outputSchema !== undefined)).toBe(true);
    expect(sizes.reduce((total, size) => total + size, 0)).toBeLessThan(
      OUTPUT_SCHEMA_TOTAL_MAX_CHARS,
    );
  });
});

describe('um fluxo feliz por tool', () => {
  test('define_type devolve a versão criada', async () => {
    const created = await succeed<Defined>('define_type', {
      project: PROJECT,
      name: 'note',
      schema: NOTE,
    });

    expect(created).toMatchObject({ name: 'note', version: '1.0', created: true });
  });

  test('define_relation devolve a versão criada', async () => {
    const created = await succeed<Defined>('define_relation', {
      project: PROJECT,
      name: 'approves',
      kind: 'supports',
    });

    expect(created).toMatchObject({ name: 'approves', version: '1.0', created: true });
  });

  test('define_gate devolve a versão criada', async () => {
    const created = await succeed<Defined>('define_gate', {
      project: PROJECT,
      name: 'has-note',
      questions: NOTE_GATE,
    });

    expect(created).toMatchObject({ name: 'has-note', version: '1.0', created: true });
  });

  test('create_process fixa o que está definido', async () => {
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
      pinned: { types: ['note'], gates: ['has-note'] },
    });
  });

  test('register grava o lote e devolve ids, replayed e marcador', async () => {
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

  test('register grava o author com o client do envelope e o model só quando informado', async () => {
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

  test('attach guarda o texto e a repetição vem como deduplicated', async () => {
    const first = await succeed<AttachmentPut>('attach', { project: PROJECT, text: 'conteúdo' });
    const second = await succeed<AttachmentPut>('attach', { project: PROJECT, text: 'conteúdo' });

    expect(first).toMatchObject({ bytes: Buffer.byteLength('conteúdo'), deduplicated: false });
    expect(second).toEqual({ ...first, deduplicated: true });
  });

  test('read_attachment sem maxChars pagina em PAGE_CHARS_CAP', async () => {
    const text = 'x'.repeat(PAGE_CHARS_CAP + 1);
    const { hash } = await succeed<AttachmentPut>('attach', { project: PROJECT, text });

    const page = await succeed<AttachmentPage>('read_attachment', { project: PROJECT, hash });

    expect(page.text).toHaveLength(PAGE_CHARS_CAP);
    expect(page.next).toBe(PAGE_CHARS_CAP);
  });

  test('attach por path guarda os bytes do arquivo sob o cwd do servidor', async () => {
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

  test('N1: com omitted, reusar o marker perde os ids cortados e a releitura completa os devolve', async () => {
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
    const reused = await succeed<QueryResult>('query', {
      project: PROJECT,
      process: 'run-1',
      changesSince: first.marker,
    });
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

    const omittedIds = registered.filter((id) => !first.changes?.entered.includes(id));
    expect(first.changes).toMatchObject({ omitted: { entered: omittedIds.length, left: 0 } });
    expect(omittedIds).toHaveLength(registered.length - CHANGES_ITEMS_CAP);
    expect(reused.changes?.entered).toEqual([]);
    expect(reread).toEqual(expect.arrayContaining(omittedIds));
  });

  test('query com fields recorta o data e mantém o resto do registro', async () => {
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

  test('#85: 41 registros de ~700 caracteres estouram o teto sem fields e cabem com fields vazio', async () => {
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
    const input = { project: PROJECT, process: 'run-1', limit: 100 };

    const full = await succeed<QueryResult>('query', input);
    const light = await succeed<QueryResult>('query', { ...input, fields: [] });

    expect(full.records.length).toBeLessThan(41);
    expect(full.cursor).toEqual(expect.any(String));
    expect(light.records).toHaveLength(41);
    expect(light.cursor).toBeUndefined();
  });

  test('evaluate_gate corta cada lista de evidence em EVIDENCE_ITEMS_CAP e informa omitted', async () => {
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
      { project: PROJECT, process: 'run-1', gate: 'has-note' },
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

  test('evaluate_gate abaixo do teto não leva omitted', async () => {
    await prepareProcess();
    await registerNote('run-1', 'olá');

    const result = await succeed<GateEvaluation>('evaluate_gate', {
      project: PROJECT,
      process: 'run-1',
      gate: 'has-note',
    });

    expect(result.questions[0]).not.toHaveProperty('omitted');
  });
});

describe('describe_type', () => {
  const NOTE_V2 = { ...NOTE, properties: { ...NOTE.properties, tag: { type: 'string' } } };

  /** Fixa `note` 1.0 no processo `run-1` e depois define `note` 1.1 e `other` no projeto. */
  async function pinNoteThenEvolve(): Promise<void> {
    await succeed('define_type', { project: PROJECT, name: 'note', schema: NOTE });
    await succeed('create_process', { project: PROJECT, process: 'run-1' });
    await succeed('define_type', { project: PROJECT, name: 'note', schema: NOTE_V2 });
    await succeed('define_type', { project: PROJECT, name: 'other', schema: NOTE });
  }

  test('com process devolve o schema fixado, sem version, mesmo com versão nova no projeto', async () => {
    await pinNoteThenEvolve();

    const result = await succeed<DescribeTypeResult>('describe_type', {
      project: PROJECT,
      type: 'note',
      process: 'run-1',
    });

    expect(result).toEqual({ name: 'note', schema: NOTE });
  });

  test('sem process devolve a versão vigente e, com version, a pedida', async () => {
    await pinNoteThenEvolve();

    const current = await succeed<DescribeTypeResult>('describe_type', {
      project: PROJECT,
      type: 'note',
    });
    const asked = await succeed<DescribeTypeResult>('describe_type', {
      project: PROJECT,
      type: 'note',
      version: '1.0',
    });

    expect(current).toEqual({ name: 'note', version: '1.1', schema: NOTE_V2 });
    expect(asked).toEqual({ name: 'note', version: '1.0', schema: NOTE });
  });

  test('process e version juntos dão INVALID_INPUT em /version', async () => {
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

  test('version fora de <major>.<minor> dá INVALID_INPUT em /version com invalid-version', async () => {
    await pinNoteThenEvolve();

    const body = expectError(
      await environment.call('describe_type', { project: PROJECT, type: 'note', version: '1' }),
      'INVALID_INPUT',
    );

    expect(body.details).toEqual([
      expect.objectContaining({ path: '/version', code: 'invalid-version' }),
    ]);
  });

  test('tipo não fixado no processo dá TYPE_NOT_PINNED e, sem process, tipo ausente dá TYPE_NOT_FOUND', async () => {
    await pinNoteThenEvolve();

    const notPinned = expectError(
      await environment.call('describe_type', {
        project: PROJECT,
        type: 'other',
        process: 'run-1',
      }),
      'TYPE_NOT_PINNED',
    );
    const notFound = expectError(
      await environment.call('describe_type', { project: PROJECT, type: 'ghost' }),
      'TYPE_NOT_FOUND',
    );

    expect(notPinned.details).toEqual([expect.objectContaining({ path: '/type' })]);
    expect(notFound.details).toEqual([expect.objectContaining({ path: '/type' })]);
  });
});

describe('SE7: as tools devolvem o que o serviço devolve', () => {
  async function seed() {
    await prepareProcess();
    await registerNote('run-1', 'olá');
    return succeed<AttachmentPut>('attach', { project: PROJECT, text: 'anexo' });
  }

  test('query', async () => {
    await seed();
    const input = { project: PROJECT, process: 'run-1' };

    const viaTool = await succeed<QueryResult>('query', input);

    expect(viaTool).toEqual(
      JSON.parse(JSON.stringify(servicesOverServerData().query.queryRecords(input))),
    );
  });

  test('evaluate_gate', async () => {
    await seed();
    const input = { project: PROJECT, process: 'run-1', gate: 'has-note' };

    const viaTool = await succeed<GateEvaluation>('evaluate_gate', input);

    expect(viaTool).toEqual(
      JSON.parse(JSON.stringify(servicesOverServerData().query.evaluateGate(input))),
    );
  });

  test('verify_chain', async () => {
    await seed();
    const input = { project: PROJECT, process: 'run-1' };

    const viaTool = await succeed<VerifyChainResult>('verify_chain', input);

    expect(viaTool).toEqual(
      JSON.parse(JSON.stringify(servicesOverServerData().query.verifyChain(input))),
    );
  });

  test('read_attachment', async () => {
    const { hash } = await seed();
    const input = { project: PROJECT, hash };

    const viaTool = await succeed<AttachmentPage>('read_attachment', input);

    expect(viaTool).toEqual(servicesOverServerData().query.readAttachment(input));
  });

  test('list', async () => {
    await seed();
    const input = { project: PROJECT };

    const viaTool = await succeed<ListResult>('list', input);

    expect(viaTool).toEqual(JSON.parse(JSON.stringify(servicesOverServerData().query.list(input))));
  });

  test('describe_type', async () => {
    await seed();
    const input = { project: PROJECT, type: 'note' };

    const viaTool = await succeed<DescribeTypeResult>('describe_type', input);

    expect(viaTool).toEqual(servicesOverServerData().query.describeType(input));
  });

  test('a recusa do serviço sai como o erro dele, sem regra própria da tool', async () => {
    const result = await environment.call('query', { project: PROJECT, process: 'inexistente' });

    const body = expectError(result, 'PROCESS_NOT_FOUND');
    expect(at(body.details, 0).path).toBe('/process');
  });
});
