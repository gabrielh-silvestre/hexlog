import fs from 'node:fs';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, test } from '@jest/globals';
import type { CreateProcessResult, RegisterResult } from '../../src/commands/process.ts';
import type { QueryResult } from '../../src/queries/query-service.ts';
import { at, createTempDir } from '../helpers.ts';
import { createEnvironment, expectError } from './environment.ts';
import type { Environment } from './environment.ts';

const PROJECT = 'alpha';
const NOTE = {
  type: 'object',
  properties: { text: { type: 'string' } },
  required: ['text'],
  additionalProperties: false,
};

let environment: Environment;

beforeEach(async () => {
  environment = await createEnvironment();
  await environment.ok('define_type', { project: PROJECT, name: 'note', schema: NOTE });
  await environment.ok('define_relation', { project: PROJECT, name: 'approves', kind: 'supports' });
  await environment.ok('create_process', { project: PROJECT, process: 'run-1' });
  await environment.ok('create_process', { project: PROJECT, process: 'run-2' });
});

afterEach(async () => {
  await environment.close();
});

const registerNote = (process: string, text: string, relations: unknown[] = []) =>
  environment.ok<RegisterResult>('register', {
    project: PROJECT,
    process,
    agent: 'executor',
    records: [{ type: 'note', target: 'run.step', data: { text }, relations }],
  });

const query = (args: Record<string, unknown>) =>
  environment.ok<QueryResult>('query', { project: PROJECT, ...args });

/** Adultera o texto de uma linha já gravada, como uma edição externa do log. */
function tamper(process: string): void {
  const log = path.join(environment.dataDir, '.v1', PROJECT, process, 'records.jsonl');
  fs.writeFileSync(log, fs.readFileSync(log, 'utf8').replace('"text":"', '"text":"x'));
}

/** Passo 2 do runbook de `docs/dados.md`: move o processo para fora do caminho, preservando-o. */
function quarantine(process: string): string {
  const quarantineDir = createTempDir('quarantine');
  const target = path.join(quarantineDir, process);
  fs.renameSync(path.join(environment.dataDir, '.v1', PROJECT, process), target);
  return target;
}

describe('M21: runbook de quarentena de processo corrompido (docs/dados.md)', () => {
  test('mover o processo adulterado destrava o alcance projeto, libera o nome e descarta o índice velho', async () => {
    await registerNote('run-1', 'primeira');
    await registerNote('run-1', 'segunda');
    await registerNote('run-2', 'de outro processo');
    // Esquenta o índice de busca com o texto que vai sumir.
    expect(at((await query({ process: 'run-1', text: 'segunda' })).records, 0).data).toEqual({
      text: 'segunda',
    });

    tamper('run-1');
    const project = expectError(
      await environment.call('query', { project: PROJECT, scope: 'project' }),
      'PROCESS_CORRUPTED',
    );
    expect(at(project.details, 0)).toMatchObject({ code: 'broken-chain', process: 'run-1' });
    expect(await query({ process: 'run-2' })).toMatchObject({ records: [expect.anything()] });

    const quarantined = quarantine('run-1');

    // (a) o alcance projeto volta a funcionar, só com o que sobrou
    const afterMove = await query({ scope: 'project' });
    expect(afterMove.records.map(({ data }) => data)).toEqual([{ text: 'de outro processo' }]);

    // (b) o nome do processo fica livre para `create_process`
    expectError(
      await environment.call('query', { project: PROJECT, process: 'run-1' }),
      'PROCESS_NOT_FOUND',
    );
    await environment.ok<CreateProcessResult>('create_process', {
      project: PROJECT,
      process: 'run-1',
    });
    expect((await query({ process: 'run-1' })).records).toEqual([]);

    // (c) a busca não devolve o índice velho, no processo recriado nem no alcance projeto
    expect((await query({ process: 'run-1', text: 'segunda' })).records).toEqual([]);
    expect((await query({ scope: 'project', text: 'segunda' })).records).toEqual([]);
    expect((await query({ scope: 'project', text: 'outro' })).records).toHaveLength(1);

    // o processo em quarentena segue no disco para auditoria
    expect(fs.existsSync(path.join(quarantined, 'records.jsonl'))).toBe(true);
  }, 30_000);

  test('relação gravada que apontava para o processo sai sem `current` e relação nova para ele dá RELATION_NOT_FOUND', async () => {
    const { records } = await registerNote('run-1', 'alvo');
    const target = at(records, 0).id;
    await registerNote('run-2', 'aprova', [{ to: target, kind: 'supports', as: 'approves' }]);

    quarantine('run-1');

    const [approver] = (await query({ process: 'run-2' })).records;
    expect(approver?.out).toEqual([{ kind: 'supports', as: 'approves', to: target }]);

    const error = expectError(
      await environment.call('register', {
        project: PROJECT,
        process: 'run-2',
        agent: 'executor',
        records: [
          {
            type: 'note',
            target: 'run.step',
            data: { text: 'nova' },
            relations: [{ to: target, kind: 'supports', as: 'approves' }],
          },
        ],
      }),
      'RELATION_NOT_FOUND',
    );
    expect(error.details.length).toBeGreaterThan(0);
  }, 30_000);
});
