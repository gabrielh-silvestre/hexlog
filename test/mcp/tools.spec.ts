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
];
const READ_ONLY_TOOLS = ['query', 'evaluate_gate', 'verify_chain', 'read_attachment', 'list'];

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
  test('devolve exatamente os 11 nomes', async () => {
    const { tools } = await environment.client.listTools();

    expect(tools.map(({ name }) => name).sort()).toEqual([...ALL_TOOLS].sort());
  });

  test('marca readOnlyHint nas 5 tools de leitura e em nenhuma outra', async () => {
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

describe('SL8: alcance projeto no lugar da tool timeline', () => {
  test('a tool timeline não existe no catálogo', async () => {
    const { tools } = await environment.client.listTools();

    expect(tools.map(({ name }) => name)).not.toContain('timeline');
  });

  test('o query com scope project lê registros de mais de um processo', async () => {
    await prepareProcess('run-1');
    await succeed('create_process', { project: PROJECT, process: 'run-2' });
    await registerNote('run-1', 'primeiro');
    await registerNote('run-2', 'segundo');

    const page = await succeed<QueryResult>('query', { project: PROJECT, scope: 'project' });

    expect(page.records.map(({ data }) => data)).toEqual([
      { text: 'primeiro' },
      { text: 'segundo' },
    ]);
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
  test('a soma do outputSchema das 11 tools fica abaixo de 24.280 caracteres', async () => {
    const { tools } = await environment.client.listTools();

    const sizes = tools.map(({ outputSchema }) => JSON.stringify(outputSchema ?? null).length);

    expect(tools.every(({ outputSchema }) => outputSchema !== undefined)).toBe(true);
    expect(sizes.reduce((total, size) => total + size, 0)).toBeLessThan(
      OUTPUT_SCHEMA_TOTAL_MAX_CHARS,
    );
  });
});

describe('um fluxo feliz por tool', () => {
  test('define_type devolve a versão criada e o replay não cria outra', async () => {
    const created = await succeed<Defined>('define_type', {
      project: PROJECT,
      name: 'note',
      schema: NOTE,
    });
    const replay = await succeed<Defined>('define_type', {
      project: PROJECT,
      name: 'note',
      schema: NOTE,
    });

    expect(created).toMatchObject({ name: 'note', version: '1.0', created: true });
    expect(replay).toMatchObject({
      name: 'note',
      version: '1.0',
      hash: created.hash,
      created: false,
    });
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

  test('create_process fixa o que está definido e é idempotente por nome', async () => {
    await succeed('define_type', { project: PROJECT, name: 'note', schema: NOTE });
    await succeed('define_gate', { project: PROJECT, name: 'has-note', questions: NOTE_GATE });

    const created = await succeed<CreateProcessResult>('create_process', {
      project: PROJECT,
      process: 'run-1',
    });
    const again = await succeed<CreateProcessResult>('create_process', {
      project: PROJECT,
      process: 'run-1',
    });

    expect(created).toMatchObject({
      project: PROJECT,
      process: 'run-1',
      created: true,
      pinned: { types: ['note'], gates: ['has-note'] },
    });
    expect(again).toMatchObject({ created: false, pinned: created.pinned });
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

  test('register com a mesma chave e o mesmo lote devolve replayed com os mesmos ids, sem gravar de novo', async () => {
    await prepareProcess();
    const input = {
      project: PROJECT,
      process: 'run-1',
      agent: 'executor',
      key: 'lote-1',
      records: [{ type: 'note', target: 'run.step', data: { text: 'olá' } }],
    };

    const first = await succeed<RegisterResult>('register', input);
    const replay = await succeed<RegisterResult>('register', input);
    const page = await succeed<QueryResult>('query', { project: PROJECT, process: 'run-1' });

    expect(replay).toEqual({ ...first, replayed: true });
    expect(page.records).toHaveLength(1);
  });

  test('register com a mesma chave e outro lote dá IDEMPOTENCY_CONFLICT', async () => {
    await prepareProcess();
    const input = (text: string) => ({
      project: PROJECT,
      process: 'run-1',
      agent: 'executor',
      key: 'lote-1',
      records: [{ type: 'note', target: 'run.step', data: { text } }],
    });
    await succeed('register', input('olá'));

    const result = await environment.call('register', input('outro'));

    expectError(result, 'IDEMPOTENCY_CONFLICT');
  });

  test('attach guarda o texto e a repetição vem como deduplicated', async () => {
    const first = await succeed<AttachmentPut>('attach', { project: PROJECT, text: 'conteúdo' });
    const second = await succeed<AttachmentPut>('attach', { project: PROJECT, text: 'conteúdo' });

    expect(first).toMatchObject({ bytes: Buffer.byteLength('conteúdo'), deduplicated: false });
    expect(second).toEqual({ ...first, deduplicated: true });
  });

  test('read_attachment devolve o texto guardado pelo hash', async () => {
    const { hash } = await succeed<AttachmentPut>('attach', { project: PROJECT, text: 'conteúdo' });

    const page = await succeed<AttachmentPage>('read_attachment', { project: PROJECT, hash });

    expect(page).toEqual({ text: 'conteúdo', status: 'ok' });
  });

  test('query devolve o registro gravado', async () => {
    await prepareProcess();
    const { records } = await registerNote('run-1', 'olá');

    const page = await succeed<QueryResult>('query', { project: PROJECT, process: 'run-1' });

    expect(page.records.map(({ id }) => id)).toEqual(records.map(({ id }) => id));
  });

  test('read_attachment sem maxChars pagina em PAGE_CHARS_CAP', async () => {
    const text = 'x'.repeat(PAGE_CHARS_CAP + 1);
    const { hash } = await succeed<AttachmentPut>('attach', { project: PROJECT, text });

    const page = await succeed<AttachmentPage>('read_attachment', { project: PROJECT, hash });

    expect(page.text).toHaveLength(PAGE_CHARS_CAP);
    expect(page.next).toBe(PAGE_CHARS_CAP);
  });

  test('read_attachment segue next até a última página e devolve o texto inteiro', async () => {
    const text = 'abcdefghijklmnopqrst';
    const { hash } = await succeed<AttachmentPut>('attach', { project: PROJECT, text });
    const pages: AttachmentPage[] = [];
    let offset: number | undefined;

    do {
      const page: AttachmentPage = await succeed('read_attachment', {
        project: PROJECT,
        hash,
        offset,
        maxChars: 7,
      });
      pages.push(page);
      offset = page.next;
    } while (offset !== undefined);

    expect(pages.map((page) => page.text)).toEqual(['abcdefg', 'hijklmn', 'opqrst']);
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

  test('query com changesSince válido corta entered em CHANGES_ITEMS_CAP e informa omitted', async () => {
    await prepareProcess();
    await registerNote('run-1', 'primeira');
    const { marker } = await succeed<QueryResult>('query', { project: PROJECT, process: 'run-1' });
    const batch = (size: number) =>
      succeed<RegisterResult>('register', {
        project: PROJECT,
        process: 'run-1',
        agent: 'executor',
        records: Array.from({ length: size }, (_, i) => ({
          type: 'note',
          target: 'run.step',
          data: { text: `n${i}` },
        })),
      });
    await batch(BATCH_MAX);
    await batch(BATCH_MAX);
    await batch(1);

    const page = await succeed<QueryResult>('query', {
      project: PROJECT,
      process: 'run-1',
      changesSince: marker,
    });

    expect(page.changes?.entered).toHaveLength(CHANGES_ITEMS_CAP);
    expect(page.changes).toMatchObject({ omitted: { entered: 1, left: 0 } });
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

  test('evaluate_gate com marker de sucesso reavalia sobre o que existia então', async () => {
    await prepareProcess();
    const args = { project: PROJECT, process: 'run-1', gate: 'has-note' };
    const { marker } = await succeed<GateEvaluation>('evaluate_gate', args);
    await registerNote('run-1', 'olá');

    const replayed = await succeed<GateEvaluation>('evaluate_gate', { ...args, marker });
    const current = await succeed<GateEvaluation>('evaluate_gate', args);

    expect([replayed.passed, current.passed]).toEqual([false, true]);
  });

  test('verify_chain confirma a cadeia íntegra', async () => {
    await prepareProcess();
    await registerNote('run-1', 'olá');

    const chain = await succeed<VerifyChainResult>('verify_chain', {
      project: PROJECT,
      process: 'run-1',
    });

    expect(chain).toMatchObject({
      ok: true,
      totalRecords: 1,
      breaks: [],
      totalBreaks: 0,
      attachmentBreaks: [],
      totalAttachmentBreaks: 0,
    });
  });

  test('list mostra o projeto, o processo e as definições', async () => {
    await prepareProcess();

    const projects = await succeed<ListResult>('list', {});
    const project = await succeed<ListResult>('list', { project: PROJECT });

    expect(projects.projects).toEqual([{ name: PROJECT, processes: 1 }]);
    expect(project.project?.processes.map(({ name }) => name)).toEqual(['run-1']);
    expect(project.project?.types.map(({ name }) => name)).toEqual(['note']);
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

  test('a recusa do serviço sai como o erro dele, sem regra própria da tool', async () => {
    const result = await environment.call('query', { project: PROJECT, process: 'inexistente' });

    const body = expectError(result, 'PROCESS_NOT_FOUND');
    expect(at(body.details, 0).path).toBe('/process');
  });
});
