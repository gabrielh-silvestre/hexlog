import { describe, expect, it } from '@jest/globals';
import { createValidator } from '../../src/adapters/validator.ts';
import type { RecordType } from '../../src/domain/definitions.ts';
import type { HexRecord } from '../../src/domain/record.ts';

const RECORDS = 50;
const RUNS = 5;
// 50 registros x 50 ms, o custo por registro aceito no ADR 0009 (emenda de 2026-10-24)
const BUDGET_MS = 2_500;
const LEAF = 'too long';

const ref = { $ref: '#' };
const short = { type: 'string', maxLength: 2 };

// Cada ciclo volta a `#` por uma palavra-chave que desce um nível de dado, então o schema valida
// de verdade; o `dependentSchemas` só volta a `#` depois de descer por `properties`.
type Data = HexRecord['data'];

const VARIANTS: {
  schema: () => RecordType;
  data: (next: Data) => Data;
  base: Data;
}[] = [
  {
    schema: () => ({
      type: 'object',
      properties: { a: ref, d: ref, b: short },
      propertyNames: ref,
    }),
    data: (next) => ({ a: next, b: LEAF }),
    base: {},
  },
  {
    schema: () => ({
      type: 'object',
      properties: { a: ref, d: ref, b: short },
      unevaluatedProperties: ref,
    }),
    data: (next) => ({ a: next, b: LEAF, c: {} }),
    base: {},
  },
  {
    schema: () => ({
      type: 'object',
      properties: {
        list: { type: 'array', prefixItems: [ref, ref, ref, short], minItems: 4, maxItems: 4 },
        d: ref,
      },
    }),
    data: (next) => ({ list: [next, {}, {}, LEAF] }),
    base: {},
  },
  {
    schema: () => ({
      type: 'object',
      properties: { a: ref, b: short },
      dependentSchemas: { a: { properties: { c: ref, d: ref } } },
    }),
    data: (next) => ({ a: next, b: LEAF, c: {} }),
    base: {},
  },
];

const batch = Array.from({ length: RECORDS }, (_, i) => {
  const variant = VARIANTS[i % VARIANTS.length];
  if (variant === undefined) throw new Error('batch without variant');
  const { schema, data, base } = variant;
  const depth = 7 + (i % 3);
  let value = base;
  for (let level = 0; level < depth; level++) value = data(value);
  return { schema: schema(), value };
});

describe('createValidator', () => {
  it('should cap the violations of 50 hostile recursive records within 2,500 ms (minimum of 5)', () => {
    const times = Array.from({ length: RUNS }, () => {
      const validator = createValidator();
      const start = performance.now();
      const results = batch.map(({ schema, value }) => validator.validate(schema, value));
      const elapsed = performance.now() - start;

      for (const details of results) {
        const codes = details.map(({ code }) => code);

        expect(codes.length).toBeGreaterThan(1);
        expect(codes).toContain('violations-capped');
      }

      return elapsed;
    });

    const validateMin = Math.min(...times);
    process.stdout.write(
      `min validate (${RECORDS} hostile records): ${validateMin.toFixed(2)} ms\n`,
    );

    expect(validateMin).toBeLessThanOrEqual(BUDGET_MS);
  }, 60_000);
});
