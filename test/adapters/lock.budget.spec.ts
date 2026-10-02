import { afterEach, describe, expect, test } from '@jest/globals';
import { sumBy } from 'es-toolkit';
import { verifyProcess } from '../../src/shared/loader.ts';
import { killChildren, runWriteStress } from './lock-helpers.ts';

// Medição para o ADR 0009, não contrato: repete o estresse de `lock.spec.ts` (8 filhos x 25
// gravações, com lock de dono morto pré-plantado) e imprime, por rodada, as taxas de `lock-lost`
// (soma dos `retries` dos filhos) e de `lock-busy` (filho que saiu com status != 0), mais
// `chain-ok` e `records`. `lock-lost` é um piso: filho que falha não imprime `retries` e fica fora
// da soma. Asserido: a cadeia íntegra em toda rodada e os 200 registros nas rodadas sem filho
// falho.
// Para rodar só este spec (o `npm run test:budget` roda todos os `*.budget.spec.ts`, e um caminho
// posicional após `--` vira padrão de ignorados e some do resultado):
//   npx jest --errorOnDeprecated --runInBand --testPathPatterns=lock.budget --testPathIgnorePatterns=/node_modules/
//
// O número de rodadas vem de `LOCK_BUDGET_ROUNDS` (inteiro positivo; padrão 20, o valor local). O CI
// define um valor menor em `.github/workflows/ci.yml`.
const DEFAULT_ROUNDS = 20;

function readRounds(raw: string | undefined): number {
  if (raw === undefined) return DEFAULT_ROUNDS;
  if (!/^[1-9]\d*$/.test(raw)) {
    throw new Error(`LOCK_BUDGET_ROUNDS must be a positive integer, got '${raw}'`);
  }
  return Number(raw);
}

const ROUNDS = readRounds(process.env.LOCK_BUDGET_ROUNDS);
const EXPECTED_RECORDS = 200;

afterEach(killChildren);

describe('N7', () => {
  test(`medição: ${ROUNDS} rodadas do estresse de 8 filhos x 25 gravações imprimem lock-lost e lock-busy`, async () => {
    const samples: {
      round: number;
      lockLost: number;
      failedChildren: number;
      chainOk: boolean;
      records: number;
    }[] = [];

    for (let round = 1; round <= ROUNDS; round++) {
      const { store, ref, results } = await runWriteStress();
      const succeeded = results.filter(({ status }) => status === 0);
      const lockLost = sumBy(
        succeeded,
        ({ stdout }) => (JSON.parse(stdout) as { retries: number }).retries,
      );
      const failedChildren = results.length - succeeded.length;
      const { ok: chainOk, totalRecords: records } = verifyProcess(store.read(ref)).chain;
      samples.push({ round, lockLost, failedChildren, chainOk, records });
      process.stdout.write(
        `N7 round=${round} lock-lost=${lockLost} lock-busy=${failedChildren} chain-ok=${chainOk} records=${records}\n`,
      );
    }

    const lockLostRounds = samples.filter(({ lockLost }) => lockLost > 0).length;
    const failedRounds = samples.filter(({ failedChildren }) => failedChildren > 0).length;
    process.stdout.write(
      `N7 summary rounds=${ROUNDS} rounds-with-lock-lost=${lockLostRounds} rounds-with-child-failure=${failedRounds}\n`,
    );

    expect(samples.filter(({ chainOk }) => !chainOk)).toEqual([]);
    expect(
      samples.filter(
        ({ failedChildren, records }) => failedChildren === 0 && records !== EXPECTED_RECORDS,
      ),
    ).toEqual([]);
  }, 900_000);
});
