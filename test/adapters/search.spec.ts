import { describe, expect, test } from '@jest/globals';
import { createSearchIndex } from '../../src/adapters/search.ts';
import type { HexRecord } from '../../src/domain/record.ts';

const index = createSearchIndex();

let counter = 0;

function makeRecord(overrides: Partial<HexRecord> = {}): HexRecord {
  counter += 1;
  return {
    id: `proc:0198f4a0-0000-7000-8000-${counter.toString(16).padStart(12, '0')}`,
    type: 'note',
    at: '2026-01-01T00:00:00.000Z',
    target: 'area.topic',
    author: { agent: 'tester', client: 'test' },
    data: {},
    relations: [],
    ...overrides,
  };
}

const idsOf = (records: HexRecord[]) => records.map((record) => record.id);

describe('createSearchIndex', () => {
  test('não acha nada em lista vazia nem sem correspondência', () => {
    expect(index.search([], 'anything')).toEqual([]);
    expect(index.search([makeRecord({ data: { text: 'webhook' } })], 'kubernetes')).toEqual([]);
  });

  test('indexa type, target e as strings de data, inclusive as aninhadas', () => {
    const byType = makeRecord({ type: 'decision' });
    const byTarget = makeRecord({ target: 'billing.invoice' });
    const byData = makeRecord({ data: { text: 'refund' } });
    const nested = makeRecord({ data: { deep: { list: [{ note: 'quarantine' }] } } });
    const records = [byType, byTarget, byData, nested];

    expect(index.search(records, 'decision')).toEqual([byType.id]);
    expect(index.search(records, 'invoice')).toEqual([byTarget.id]);
    expect(index.search(records, 'refund')).toEqual([byData.id]);
    expect(index.search(records, 'quarantine')).toEqual([nested.id]);
  });

  test('não indexa id, autor, relações, chaves de data nem valores que não são string', () => {
    const record = makeRecord({
      data: { secretkey: 1, flag: true, none: null },
      relations: [{ kind: 'supports', to: 'other:0198f4a0-0000-7000-8000-000000000001' }],
      author: { agent: 'zebra', client: 'quokka' },
    });

    for (const term of ['secretkey', 'zebra', 'quokka', 'supports', 'proc']) {
      expect(index.search([record], term)).toEqual([]);
    }
  });

  test('devolve os ids por relevância decrescente', () => {
    const weak = makeRecord({ data: { text: 'one webhook among many other filler words here' } });
    const strong = makeRecord({ data: { text: 'webhook' }, target: 'webhook.retry' });
    const none = makeRecord({ data: { text: 'unrelated' } });

    expect(index.search([weak, none, strong], 'webhook')).toEqual([strong.id, weak.id]);
  });

  test('empate de relevância mantém a ordem dos registros', () => {
    const records = [1, 2, 3].map(() => makeRecord({ data: { text: 'webhook' } }));

    expect(index.search(records, 'webhook')).toEqual(idsOf(records));
    expect(index.search([...records].reverse(), 'webhook')).toEqual(idsOf(records).reverse());
  });

  test('ignora acento e caixa, na consulta e no texto', () => {
    const record = makeRecord({ data: { text: 'Configuração Crítica' } });

    expect(index.search([record], 'configuracao critica')).toEqual([record.id]);
    expect(
      index.search([makeRecord({ data: { text: 'configuracao' } })], 'CONFIGURAÇÃO'),
    ).toHaveLength(1);
  });

  test('casa por prefixo e tolera um erro de digitação', () => {
    const record = makeRecord({ data: { text: 'authentication' } });

    expect(index.search([record], 'authent')).toEqual([record.id]);
    expect(index.search([record], 'authentcation')).toEqual([record.id]);
  });

  test('exige todos os termos (AND) quando algum registro os tem todos', () => {
    const both = makeRecord({ data: { text: 'webhook retry' } });
    const one = makeRecord({ data: { text: 'webhook only' } });

    expect(index.search([one, both], 'webhook retry')).toEqual([both.id]);
  });

  test('cai para OR quando o AND não acha nada, exigindo metade dos termos arredondada para cima', () => {
    const webhookOnly = makeRecord({ data: { text: 'webhook and unrelated words' } });
    const webhookAndTimeout = makeRecord({ data: { text: 'webhook timeout' } });

    // 2 termos: o piso é 1, qualquer um dos dois basta.
    expect(index.search([webhookOnly], 'webhook retry')).toEqual([webhookOnly.id]);
    // 3 termos: o piso é 2, e só o registro com dois dos três entra.
    expect(index.search([webhookOnly, webhookAndTimeout], 'webhook timeout retry')).toEqual([
      webhookAndTimeout.id,
    ]);
  });

  test('uma consulta de um termo só nunca cai para OR', () => {
    expect(index.search([makeRecord({ data: { text: 'webhook' } })], 'retry')).toEqual([]);
  });

  test('repetir um termo não o torna mais pesado que os outros da consulta', () => {
    const mostlyBeta = makeRecord({ data: { text: 'beta beta beta beta alpha' } });
    const mostlyAlpha = makeRecord({ data: { text: 'alpha alpha alpha alpha beta' } });
    const records = [mostlyBeta, mostlyAlpha];

    // Os dois casam igual `alpha beta`; `Alpha alpha` não pode empurrar `mostlyAlpha` para cima.
    expect(index.search(records, 'Alpha alpha beta')).toEqual(index.search(records, 'alpha beta'));
    expect(index.search(records, 'alpha beta')).toEqual(idsOf(records));
  });

  test('termo repetido conta uma vez só no AND e no piso do OR', () => {
    const both = makeRecord({ data: { text: 'webhook retry' } });
    const webhookOnly = makeRecord({ data: { text: 'webhook and unrelated words' } });

    // AND: `webhook` repetido não exige nada além de `webhook` e `retry`.
    expect(index.search([webhookOnly, both], 'webhook webhook retry')).toEqual([both.id]);
    // OR: 2 termos distintos dão piso 1; contados com a repetição seriam 3 e piso 2.
    expect(index.search([webhookOnly], 'webhook webhook retry')).toEqual([webhookOnly.id]);
  });

  test('consulta com o mesmo termo repetido milhares de vezes custa como a de um termo só', () => {
    const records = Array.from({ length: 5_000 }, () =>
      makeRecord({ data: { text: 'webhook delivery' } }),
    );

    const start = performance.now();
    const ids = index.search(records, 'webhook '.repeat(2_000));
    const elapsed = performance.now() - start;

    expect(ids).toHaveLength(records.length);
    // Sem o dedupe passa de 12 s; com ele o custo é o do índice (~100 ms).
    expect(elapsed).toBeLessThanOrEqual(2_000);
  });
});
