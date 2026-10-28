import fs from 'node:fs';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from '@jest/globals';
import type { CreateProcessResult } from '../../src/commands/process.ts';
import type { QueryResult } from '../../src/queries/query-service.ts';
import { at, createTempDir, detail } from '../helpers.ts';
import {
  NOTE_SCHEMA,
  PROJECT,
  createEnvironment,
  expectError,
  registerNote,
} from './environment.ts';
import type { Environment } from './environment.ts';

let environment: Environment;

// Cada describe de topo liga estas funções aos hooks: `jest/require-top-level-describe` barra hook fora de describe.
const openEnvironment = async () => {
  environment = await createEnvironment();
  await environment.ok('define_type', { project: PROJECT, name: 'note', schema: NOTE_SCHEMA });
  await environment.ok('define_relation', { project: PROJECT, name: 'approves', kind: 'supports' });
  await environment.ok('create_process', { project: PROJECT, process: 'run-1' });
  await environment.ok('create_process', { project: PROJECT, process: 'run-2' });
};

const closeEnvironment = async () => {
  await environment.close();
};

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

/**
 * `run-1` com duas notas e `run-2` com uma, adulterando `run-1` no fim. Confere que a busca por
 * `text` indexou `segunda` antes da adulteração, senão os casos de índice velho passariam em vazio.
 */
async function registerWarmCheckThenTamper() {
  await registerNote(environment, { process: 'run-1', text: 'primeira' });
  await registerNote(environment, { process: 'run-1', text: 'segunda' });
  await registerNote(environment, { process: 'run-2', text: 'de outro processo' });
  const warmed = await query({ process: 'run-1', text: 'segunda' });

  expect(at(warmed.records, 0).data).toEqual({ text: 'segunda' });

  tamper('run-1');
}

describe('query', () => {
  beforeEach(openEnvironment);
  afterEach(closeEnvironment);

  describe('when the process is tampered', () => {
    beforeEach(async () => {
      await registerWarmCheckThenTamper();
    }, 30_000);

    it('should refuse the project scope with PROCESS_CORRUPTED naming the tampered process', async () => {
      const error = await environment.fail(
        'query',
        { project: PROJECT, scope: 'project' },
        'PROCESS_CORRUPTED',
      );

      expect(at(error.details, 0)).toMatchObject({ code: 'broken-chain', process: 'run-1' });
    });

    it('should keep serving the process that was not tampered', async () => {
      const page = await query({ process: 'run-2' });

      expect(page.records.map(({ data }) => data)).toEqual([{ text: 'de outro processo' }]);
    });
  });

  describe('when the tampered process is moved out', () => {
    let quarantined: string;

    beforeEach(async () => {
      await registerWarmCheckThenTamper();
      quarantined = quarantine('run-1');
    }, 30_000);

    it('should serve the project scope again with what is left', async () => {
      const page = await query({ scope: 'project' });

      expect(page.records.map(({ data }) => data)).toEqual([{ text: 'de outro processo' }]);
    });

    it('should answer PROCESS_NOT_FOUND for the moved process name', async () => {
      const result = await environment.call('query', { project: PROJECT, process: 'run-1' });

      expectError(result, 'PROCESS_NOT_FOUND');
    });

    it('should let create_process recreate the name with no records', async () => {
      await environment.ok<CreateProcessResult>('create_process', {
        project: PROJECT,
        process: 'run-1',
      });

      const page = await query({ process: 'run-1' });

      expect(page.records).toEqual([]);
    });

    it('should not find the old text by search in the recreated process', async () => {
      await environment.ok<CreateProcessResult>('create_process', {
        project: PROJECT,
        process: 'run-1',
      });

      const page = await query({ process: 'run-1', text: 'segunda' });

      expect(page.records).toEqual([]);
    });

    it('should search the project scope only in what is left', async () => {
      const moved = await query({ scope: 'project', text: 'segunda' });
      const kept = await query({ scope: 'project', text: 'outro' });

      expect(moved.records).toEqual([]);
      expect(kept.records).toHaveLength(1);
    });

    it('should keep the moved process on disk for audit', () => {
      expect(fs.existsSync(path.join(quarantined, 'records.jsonl'))).toBe(true);
    });
  });

  it('should return a stored relation to the moved process without `current`', async () => {
    const { records } = await registerNote(environment, { process: 'run-1', text: 'alvo' });
    const target = at(records, 0).id;
    await registerNote(environment, {
      process: 'run-2',
      text: 'aprova',
      relations: [{ to: target, kind: 'supports', as: 'approves' }],
    });
    quarantine('run-1');

    const [approver] = (await query({ process: 'run-2', relations: 'full' })).records;

    expect(approver?.out).toEqual([{ kind: 'supports', as: 'approves', to: target }]);
  }, 30_000);
});

describe('register', () => {
  beforeEach(openEnvironment);
  afterEach(closeEnvironment);

  it('should refuse a new relation to the moved process with RELATION_NOT_FOUND', async () => {
    const { records } = await registerNote(environment, { process: 'run-1', text: 'alvo' });
    const target = at(records, 0).id;
    quarantine('run-1');

    const error = await environment.fail(
      'register',
      {
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
      },
      'RELATION_NOT_FOUND',
    );

    expect(error.details).toEqual([detail('/records/0/relations/0', 'missing')]);
  }, 30_000);
});
