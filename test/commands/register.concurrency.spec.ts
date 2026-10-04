import { afterEach, describe, expect, test } from '@jest/globals';
import { createProcessStore } from '../../src/adapters/fs/process-store.ts';
import { compose } from '../../src/compose.ts';
import type { BatchItem } from '../../src/domain/record.ts';
import { verifyProcess } from '../../src/shared/loader.ts';
import { killChildren, runFixture } from '../adapters/lock-helpers.ts';
import { createTempDir } from '../helpers.ts';
import { AUTHOR, NOTE, PROJECT, note } from './register-fakes.ts';

const ROUNDS = 5;
const TIMEOUT_MS = 60_000;

afterEach(killChildren);

type ChildOutcome = { ok: true; replayed: boolean } | { ok: false; code: string };

/** Diretório de dados temporário com o tipo `note` e os serviços reais que o pai usa para preparar e conferir. */
function setup() {
  const dataDir = createTempDir('register-concurrency');
  const { services } = compose({
    dataDir,
    cwd: dataDir,
    clock: () => new Date(),
    logger: () => undefined,
  });
  services.definition.defineType({ project: PROJECT, name: 'note', schema: NOTE });
  const store = createProcessStore({ dataDir, log: () => undefined });

  /** Solta dois filhos juntos na barreira, cada um com um `register` do mesmo processo. */
  async function registerTwice(
    process: string,
    inputs: [{ key?: string; records: BatchItem[] }, { key?: string; records: BatchItem[] }],
  ): Promise<ChildOutcome[]> {
    const barrier = createTempDir('register-barrier');
    const results = await Promise.all(
      inputs.map((input) =>
        runFixture('register', {
          dataDir,
          project: PROJECT,
          process,
          barrierDir: barrier,
          total: inputs.length,
          input,
        }),
      ),
    );
    expect(results.map(({ status, stderr }) => ({ status, stderr }))).toEqual(
      inputs.map(() => ({ status: 0, stderr: '' })),
    );
    return results.map(({ stdout }) => JSON.parse(stdout) as ChildOutcome);
  }

  const verified = (process: string) => verifyProcess(store.read({ project: PROJECT, process }));

  return { services, registerTwice, verified };
}

describe('register concorrente em processos filhos (SE5, SE3c)', () => {
  test(
    'dois supersedes ao mesmo destino: um é aceito e o outro é FORK_REJECTED, nunca os dois',
    async () => {
      const { services, registerTwice, verified } = setup();

      for (let round = 0; round < ROUNDS; round += 1) {
        const process = `run-${round}`;
        services.process.createProcess({ project: PROJECT, process });
        const target = await services.process.register({
          project: PROJECT,
          process,
          author: AUTHOR,
          records: [note('destino')],
        });
        const supersede = (text: string) => ({
          records: [
            note(text, { relations: [{ to: target.records[0]!.id, kind: 'supersedes' as const }] }),
          ],
        });

        const outcomes = await registerTwice(process, [supersede('a'), supersede('b')]);

        expect(outcomes).toEqual(
          expect.arrayContaining([
            { ok: true, replayed: false },
            { ok: false, code: 'FORK_REJECTED' },
          ]),
        );
        expect(verified(process).records).toHaveLength(2);
      }
    },
    TIMEOUT_MS,
  );

  test(
    'duas gravações com a mesma key: uma grava e a outra devolve replayed (D-05)',
    async () => {
      const { services, registerTwice, verified } = setup();

      for (let round = 0; round < ROUNDS; round += 1) {
        const process = `run-${round}`;
        services.process.createProcess({ project: PROJECT, process });
        const input = { key: 'k1', records: [note('mesmo lote')] };

        const outcomes = await registerTwice(process, [input, input]);

        expect(outcomes).toEqual(
          expect.arrayContaining([
            { ok: true, replayed: false },
            { ok: true, replayed: true },
          ]),
        );
        expect(verified(process).records).toHaveLength(1);
      }
    },
    TIMEOUT_MS,
  );
});
