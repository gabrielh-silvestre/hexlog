import fs from 'node:fs';
import { createAttachmentStore } from '../../src/adapters/fs/attachment-store.ts';
import { createDefinitionStore } from '../../src/adapters/fs/definition-store.ts';
import { processPaths } from '../../src/adapters/fs/data-format.ts';
import { createProcessStore } from '../../src/adapters/fs/process-store.ts';
import { createSearchIndex } from '../../src/adapters/search.ts';
import { createValidator } from '../../src/adapters/validator.ts';
import { createProcessService } from '../../src/commands/process.ts';
import { createDefinitionService } from '../../src/commands/definition.ts';
import type { Gate, RecordType, RelationName } from '../../src/domain/definitions.ts';
import type { Name, RecordId } from '../../src/domain/ids.ts';
import type { BatchItem } from '../../src/domain/record.ts';
import { createQueryService } from '../../src/queries/query-service.ts';
import type { QueryInput } from '../../src/queries/query-service.ts';
import type { DefinitionStore } from '../../src/ports.ts';
import { AUTHOR, DOC, NOTE, PROJECT, createUuids, note } from '../commands/register-fakes.ts';
import { at, createTempDir } from '../helpers.ts';

export { PROJECT };

/** Instante de teste: `minutes` depois de 12:00 de 2026-10-02. */
export const instant = (minutes: number): Date => new Date(Date.UTC(2026, 9, 2, 12, minutes));

/**
 * Os serviços de escrita e de consulta sobre os adaptadores de disco de verdade, num diretório
 * temporário e com relógio injetado: o que cada spec grava é lido de volta pelo `queryRecords`.
 */
export function querySetup({ defaults = true } = {}) {
  const dataDir = createTempDir('queries');
  const store = createProcessStore({ dataDir, log: () => undefined });
  const definitions = createDefinitionStore({ dataDir });
  const attachments = createAttachmentStore({ dataDir, cwd: dataDir });
  let now = instant(0);
  const writer = createProcessService({
    store,
    definitions,
    attachments,
    validator: createValidator(),
    clock: () => now,
    newUuid: createUuids(),
    logger: () => undefined,
  });
  const queries = createQueryService({
    store,
    definitions,
    attachments,
    search: createSearchIndex(),
    clock: () => now,
    logger: () => undefined,
  });
  if (defaults) {
    definitions.write(PROJECT, 'types', 'note', '1.0', NOTE);
    definitions.write(PROJECT, 'types', 'doc', '1.0', DOC);
    definitions.write(PROJECT, 'relations', 'approves', '1.0', {
      name: 'approves',
      kind: 'supports',
    });
  }

  const createProcess = (process: string) => writer.createProcess({ project: PROJECT, process });

  /** Grava `records` em `process` no instante `minutes` e devolve os ids, na ordem do lote. */
  async function register(process: string, records: BatchItem[], minutes = 0): Promise<RecordId[]> {
    now = instant(minutes);
    const result = await writer.register({ project: PROJECT, process, author: AUTHOR, records });
    return result.records.map(({ id }) => id);
  }

  const registerOne = async (process: string, item: BatchItem, minutes = 0): Promise<RecordId> =>
    at(await register(process, [item], minutes), 0);

  return {
    dataDir,
    attachments,
    definitions,
    queries,
    createProcess,
    register,
    registerOne,
    /** Corrompe o log trocando o texto de uma linha já gravada (cadeia quebrada). */
    tamper: (process: string) => {
      const log = processPaths(dataDir, { project: PROJECT, process }).log;
      fs.writeFileSync(log, fs.readFileSync(log, 'utf8').replace('"text":"', '"text":"x'));
    },
    /** Como `tamper`, mas na linha `index` (base 0): a seguinte passa a ser rejeitada pelo encadeamento. */
    tamperLine: (process: string, index: number) => {
      const log = processPaths(dataDir, { project: PROJECT, process }).log;
      const lines = fs.readFileSync(log, 'utf8').split('\n');
      lines[index] = at(lines, index).replace('"text":"', '"text":"x');
      fs.writeFileSync(log, lines.join('\n'));
    },
    query: (input: Omit<QueryInput, 'project'>) =>
      queries.queryRecords({ project: PROJECT, ...input }),
  };
}

/** Fluxo como dado: só tipos, nomes de relação e gates (`test/fixtures/domains/`). */
export type Domain = { types: Record<Name, RecordType>; relations: RelationName[]; gates: Gate[] };

/** Define o fluxo no projeto pelo `DefinitionService`, como um agente faria, antes do `createProcess`. */
export function defineDomain(definitions: DefinitionStore, domain: Domain): void {
  const service = createDefinitionService({ store: definitions, validator: createValidator() });
  for (const [name, schema] of Object.entries(domain.types)) {
    service.defineType({ project: PROJECT, name, schema });
  }
  for (const relation of domain.relations)
    service.defineRelation({ project: PROJECT, ...relation });
  for (const gate of domain.gates) service.defineGate({ project: PROJECT, ...gate });
}

/** Ids da página, na ordem em que saíram. */
export const idsOf = (page: { records: readonly { id: RecordId }[] }): RecordId[] =>
  page.records.map(({ id }) => id);

/** Cursor da página, que o teste espera ter. */
export function cursorOf(page: { cursor?: string }): string {
  if (page.cursor === undefined) throw new Error('a página deveria ter cursor');
  return page.cursor;
}

/**
 * Um processo `run-1` com três registros no alvo `run.step`/`run.step.sub`/`run.stepper` e uma
 * segunda versão de `v1`: `v1` não é vigente, `task`, `other` e `v2` são.
 */
export async function seeded() {
  const setup = querySetup();
  setup.createProcess('run-1');
  const ids = await setup.register('run-1', [
    note('primeira versão', { target: 'run.step' }),
    note('tarefa', { target: 'run.step.sub' }),
    { type: 'doc', target: 'run.stepper', data: {} },
  ]);
  const [v1, task, other] = [at(ids, 0), at(ids, 1), at(ids, 2)];
  const v2 = await setup.registerOne(
    'run-1',
    note('segunda versão', { target: 'run.step', relations: [{ to: v1, kind: 'supersedes' }] }),
    1,
  );
  return { ...setup, v1, task, other, v2 };
}
