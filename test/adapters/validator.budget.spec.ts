import { describe, expect, test } from '@jest/globals';
import { median } from 'es-toolkit';
import { createValidator } from '../../src/adapters/validator.ts';
import { DATA_MAX_CHARS } from '../../src/domain/record.ts';

const ROUNDS = 5;
// O `format` não passa pelo motor limitado de regex do relatório (`Validator.report`), então o custo
// por campo é o de uma string de `DATA_MAX_CHARS`, o maior que o `register` aceita. Medido em
// 2026-10-06 sobre ~20 entradas adversariais de `uri` e `uri-reference` (a pior, userinfo longo
// sem separador): menos de 1 ms por campo com o schema já compilado; a primeira chamada custa ~75 ms
// (compilação e JIT), e é ela que aparece nos 68 a 82 ms do primeiro relatório. O teto é valor
// absoluto, ~100x a medida, para máquina lenta: uma regressão de regex custaria segundos.
const FORMAT_MEDIAN_CEILING_MS = 100;

describe('format no relatório', () => {
  const validator = createValidator();

  test.each(['uri', 'uri-reference'])(
    `%s em string de ${DATA_MAX_CHARS} caracteres: orçamento ≤ ${FORMAT_MEDIAN_CEILING_MS} ms por campo (mediana de ${ROUNDS})`,
    (format) => {
      const schema = { type: 'object', properties: { a: { type: 'string', format } } };
      const data = { a: `http://${'a'.repeat(DATA_MAX_CHARS - 9)}@ ` };
      // A primeira chamada compila o schema; só a avaliação entra na medida.
      validator.report(schema, data);

      const times = Array.from({ length: ROUNDS }, () => {
        const start = performance.now();
        validator.report(schema, data);
        return performance.now() - start;
      });

      process.stdout.write(`format ${format} median: ${median(times).toFixed(2)} ms\n`);
      expect(median(times)).toBeLessThanOrEqual(FORMAT_MEDIAN_CEILING_MS);
    },
    15_000,
  );
});
