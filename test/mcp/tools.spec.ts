import { afterEach, beforeEach, describe, expect, test } from '@jest/globals';
import { compose } from '../../src/compose.ts';
import { BATCH_MAX } from '../../src/domain/record.ts';
import { CHANGES_ITEMS_CAP, PAGE_CHARS_CAP } from '../../src/mcp/kernel.ts';
import type { Defined } from '../../src/commands/definition.ts';
import type { CreateProcessResult, RegisterResult } from '../../src/commands/process.ts';
import type { AttachmentPut } from '../../src/ports.ts';
import type {
  AttachmentPage,
  GateEvaluation,
  ListResult,
  QueryResult,
  VerifyChainResult,
} from '../../src/queries/query-service.ts';
import { at, expectError } from '../helpers.ts';
import { type Environment, createEnvironment } from './environment.ts';

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
async function prepareProcess(process = 'run-1', gate = 'has-note'): Promise<void> {
  await succeed('define_type', { project: PROJECT, name: 'note', schema: NOTE });
  await succeed('define_gate', { project: PROJECT, name: gate, questions: NOTE_GATE });
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

  test('evaluate_gate com marker de sucesso reavalia sobre o que existia então', async () => {
    await prepareProcess();
    const args = { project: PROJECT, process: 'run-1', gate: 'has-note' };
    const { marker } = await succeed<GateEvaluation>('evaluate_gate', args);
    await registerNote('run-1', 'olá');

    const replayed = await succeed<GateEvaluation>('evaluate_gate', { ...args, marker });
    const current = await succeed<GateEvaluation>('evaluate_gate', args);

    expect([replayed.passed, current.passed]).toEqual([false, true]);
  });

  test('evaluate_gate aprova o gate depois do registro', async () => {
    await prepareProcess();
    const args = { project: PROJECT, process: 'run-1', gate: 'has-note' };

    const before = await succeed<GateEvaluation>('evaluate_gate', args);
    await registerNote('run-1', 'olá');
    const after = await succeed<GateEvaluation>('evaluate_gate', args);

    expect([before.passed, after.passed]).toEqual([false, true]);
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

describe('N5: nome constructor é válido e nunca vira INTERNAL', () => {
  test('processo e gate chamados constructor funcionam de ponta a ponta', async () => {
    await prepareProcess('constructor', 'constructor');

    const before = await succeed<GateEvaluation>('evaluate_gate', {
      project: PROJECT,
      process: 'constructor',
      gate: 'constructor',
    });
    await registerNote('constructor', 'olá');
    const after = await succeed<GateEvaluation>('evaluate_gate', {
      project: PROJECT,
      process: 'constructor',
      gate: 'constructor',
    });
    const page = await succeed<QueryResult>('query', { project: PROJECT, process: 'constructor' });

    expect([before.passed, after.passed]).toEqual([false, true]);
    expect(page.records).toHaveLength(1);
  });

  test('gate constructor que o processo não fixou é GATE_NOT_FOUND, não INTERNAL', async () => {
    await prepareProcess();

    const result = await environment.call('evaluate_gate', {
      project: PROJECT,
      process: 'run-1',
      gate: 'constructor',
    });

    expectError(result, 'GATE_NOT_FOUND');
  });

  test('processo constructor inexistente é PROCESS_NOT_FOUND, não INTERNAL', async () => {
    await prepareProcess();

    const result = await environment.call('query', { project: PROJECT, process: 'constructor' });

    expectError(result, 'PROCESS_NOT_FOUND');
  });
});
