import { beforeAll, describe, expect, it } from '@jest/globals';
import fc from 'fast-check';
import { createSearchIndex } from '../../src/adapters/search.ts';
import type { RecordId } from '../../src/domain/ids.ts';
import type { HexRecord } from '../../src/domain/record.ts';
import type { ProcessRef } from '../../src/ports.ts';
import { idAt } from '../fixtures/chain-line.ts';
import { writeRecordsCorpus } from '../fixtures/records-corpus.ts';
import { createTempDir } from '../helpers.ts';
import { makeRecord } from './search-helpers.ts';

const PROCESS: ProcessRef = { project: 'proj', process: 'proc' };

// Índice novo por chamada: cada caso mede a busca sem cache; o que o cache muda está em search.cache.spec.ts.
const search = (records: HexRecord[], text: string, allowed?: ReadonlySet<RecordId>) =>
  createSearchIndex().search(PROCESS, records, text, allowed);

const idsOf = (records: HexRecord[]) => records.map((record) => record.id);

describe('createSearchIndex', () => {
  it('should find nothing in an empty list', () => {
    expect(search([], 'anything')).toEqual([]);
  });

  it('should find nothing when no record matches', () => {
    const records = [makeRecord({ data: { text: 'webhook' } })];

    expect(search(records, 'kubernetes')).toEqual([]);
  });

  it.each([
    { field: 'type', term: 'decision', expected: 'byType' },
    { field: 'target', term: 'invoice', expected: 'byTarget' },
    { field: 'data string', term: 'refund', expected: 'byData' },
    { field: 'nested data string', term: 'quarantine', expected: 'nested' },
  ] as const)('should index the record $field', ({ term, expected }) => {
    const indexed = {
      byType: makeRecord({ type: 'decision' }),
      byTarget: makeRecord({ target: 'billing.invoice' }),
      byData: makeRecord({ data: { text: 'refund' } }),
      nested: makeRecord({ data: { deep: { list: [{ note: 'quarantine' }] } } }),
    };

    expect(search(Object.values(indexed), term)).toEqual([indexed[expected].id]);
  });

  it.each([
    { field: 'data key', term: 'secretkey' },
    { field: 'author agent', term: 'zebra' },
    { field: 'author client', term: 'quokka' },
    { field: 'relation kind', term: 'supports' },
    { field: 'record id', term: 'proc' },
  ])('should not index the $field', ({ term }) => {
    const record = makeRecord({
      data: { secretkey: 1, flag: true, none: null },
      relations: [{ kind: 'supports', to: idAt('other', 1) }],
      author: { agent: 'zebra', client: 'quokka' },
    });

    expect(search([record], term)).toEqual([]);
  });

  it('should return the ids by decreasing relevance', () => {
    const weak = makeRecord({ data: { text: 'one webhook among many other filler words here' } });
    const strong = makeRecord({ data: { text: 'webhook' }, target: 'webhook.retry' });
    const none = makeRecord({ data: { text: 'unrelated' } });

    expect(search([weak, none, strong], 'webhook')).toEqual([strong.id, weak.id]);
  });

  it.each([
    { order: 'the record order', arrange: (records: HexRecord[]) => records },
    { order: 'the reversed record order', arrange: (records: HexRecord[]) => records.toReversed() },
  ])('should keep $order on a relevance tie', ({ arrange }) => {
    const records = arrange([1, 2, 3].map(() => makeRecord({ data: { text: 'webhook' } })));

    expect(search(records, 'webhook')).toEqual(idsOf(records));
  });

  it.each([
    { where: 'text', text: 'Configuração Crítica', query: 'configuracao critica' },
    { where: 'query', text: 'configuracao', query: 'CONFIGURAÇÃO' },
  ])('should ignore accents and case in the $where', ({ text, query }) => {
    const record = makeRecord({ data: { text } });

    expect(search([record], query)).toEqual([record.id]);
  });

  it('should not index a term that is empty after stripping the accent', () => {
    const record = makeRecord({ data: { text: '\u0301 webhook' } });

    expect(search([record], '\u0301')).toEqual([]);
  });

  it('should keep the rest of the record searchable when a term vanishes after stripping the accent', () => {
    const record = makeRecord({ data: { text: '\u0301 webhook' } });

    expect(search([record], 'webhook')).toEqual([record.id]);
  });

  it('should match by prefix', () => {
    const record = makeRecord({ data: { text: 'authentication' } });

    expect(search([record], 'authent')).toEqual([record.id]);
  });

  it('should tolerate one typo', () => {
    const record = makeRecord({ data: { text: 'authentication' } });

    expect(search([record], 'authentcation')).toEqual([record.id]);
  });

  it('should require every term (AND) when some record has them all', () => {
    const both = makeRecord({ data: { text: 'webhook retry' } });
    const one = makeRecord({ data: { text: 'webhook only' } });

    expect(search([one, both], 'webhook retry')).toEqual([both.id]);
  });

  it('should fall back to OR when AND finds nothing, so any of 2 terms is enough', () => {
    const webhookOnly = makeRecord({ data: { text: 'webhook and unrelated words' } });

    // 2 termos: o piso é 1, qualquer um dos dois basta.
    expect(search([webhookOnly], 'webhook retry')).toEqual([webhookOnly.id]);
  });

  it('should fall back to OR when AND finds nothing, requiring 2 of 3 terms', () => {
    const webhookOnly = makeRecord({ data: { text: 'webhook and unrelated words' } });
    const webhookAndTimeout = makeRecord({ data: { text: 'webhook timeout' } });

    // 3 termos: o piso é 2, e só o registro com dois dos três entra.
    expect(search([webhookOnly, webhookAndTimeout], 'webhook timeout retry')).toEqual([
      webhookAndTimeout.id,
    ]);
  });

  it('should let the unfiltered AND match both terms in the doc without allowed', () => {
    const doc = makeRecord({ type: 'doc', data: { text: 'banana uva' } });
    const banana = makeRecord({ data: { text: 'banana' } });
    const uva = makeRecord({ data: { text: 'uva' } });

    // Sem o filtro o doc casa os dois termos e o OR nunca roda.
    expect(search([doc, banana, uva], 'banana uva')).toEqual([doc.id]);
  });

  it('should decide the AND and the OR floor over the allowed records', () => {
    const doc = makeRecord({ type: 'doc', data: { text: 'banana uva' } });
    const banana = makeRecord({ data: { text: 'banana' } });
    const uva = makeRecord({ data: { text: 'uva' } });

    // Só as notas permitidas: nenhuma casa os dois, então o OR devolve as duas.
    expect(search([doc, banana, uva], 'banana uva', new Set([banana.id, uva.id]))).toEqual([
      banana.id,
      uva.id,
    ]);
  });

  it('should find nothing with an empty allowed set', () => {
    const banana = makeRecord({ data: { text: 'banana' } });
    const other = makeRecord({ data: { text: 'laranja' } });

    expect(search([banana, other], 'banana', new Set())).toEqual([]);
  });

  it('should not return an allowed record that does not match', () => {
    const banana = makeRecord({ data: { text: 'banana' } });
    const other = makeRecord({ data: { text: 'laranja' } });

    expect(search([banana, other], 'banana', new Set([other.id]))).toEqual([]);
  });

  it.each(['', '   ', '\n\t', '!!! ---'])('should find nothing for the blank query %j', (text) => {
    const records = [makeRecord({ data: { text: 'webhook' } })];

    expect(search(records, text)).toEqual([]);
  });

  it('should never fall back to OR for a single-term query', () => {
    const records = [makeRecord({ data: { text: 'webhook' } })];

    expect(search(records, 'retry')).toEqual([]);
  });

  it('should not weigh a repeated query term more than the other terms', () => {
    const mostlyBeta = makeRecord({ data: { text: 'beta beta beta beta alpha' } });
    const mostlyAlpha = makeRecord({ data: { text: 'alpha alpha alpha alpha beta' } });
    const records = [mostlyBeta, mostlyAlpha];
    const deduplicated = search(records, 'alpha beta');

    // `Alpha alpha` não pode empurrar `mostlyAlpha` para cima.
    expect(search(records, 'Alpha alpha beta')).toEqual(deduplicated);
  });

  it('should rank records that match both terms equally in record order', () => {
    const mostlyBeta = makeRecord({ data: { text: 'beta beta beta beta alpha' } });
    const mostlyAlpha = makeRecord({ data: { text: 'alpha alpha alpha alpha beta' } });
    const records = [mostlyBeta, mostlyAlpha];

    expect(search(records, 'alpha beta')).toEqual(idsOf(records));
  });

  it('should count a repeated term once in the AND', () => {
    const both = makeRecord({ data: { text: 'webhook retry' } });
    const webhookOnly = makeRecord({ data: { text: 'webhook and unrelated words' } });

    // `webhook` repetido não exige nada além de `webhook` e `retry`.
    expect(search([webhookOnly, both], 'webhook webhook retry')).toEqual([both.id]);
  });

  it('should count a repeated term once in the OR floor', () => {
    const webhookOnly = makeRecord({ data: { text: 'webhook and unrelated words' } });

    // 2 termos distintos dão piso 1; contados com a repetição seriam 3 e piso 2.
    expect(search([webhookOnly], 'webhook webhook retry')).toEqual([webhookOnly.id]);
  });

  it('should cost the same for a term repeated thousands of times as for a single term', () => {
    const records = Array.from({ length: 5_000 }, () =>
      makeRecord({ data: { text: 'webhook delivery' } }),
    );

    const start = performance.now();
    const ids = search(records, 'webhook '.repeat(2_000));
    const elapsed = performance.now() - start;

    expect(ids).toHaveLength(records.length);
    // Guarda de complexidade, não orçamento: com o dedupe custa ~100 ms contra o teto de 2 s, e sem
    // ele passa de 12 s; a margem larga evita falso vermelho em máquina lenta.
    expect(elapsed).toBeLessThanOrEqual(2_000);
  });

  it('should return the distinct query terms without accents and in lower case', () => {
    expect(createSearchIndex().terms('Ação ação, WEBHOOK')).toEqual(['acao', 'webhook']);
  });

  // Garante que `terms` nunca recusa texto que o motor casaria: sem termo a busca é vazia, e com
  // termo o registro que contém o próprio texto é achado.
  it('should find a record by its own text exactly when the text has terms', () => {
    const symbols = fc.string({ unit: fc.constantFrom(...'aB9é!&:§ ,.=+$-́ 😀'), maxLength: 12 });
    const texts = fc.oneof(symbols, fc.string({ unit: 'grapheme', maxLength: 12 }));
    const index = createSearchIndex();

    fc.assert(
      fc.property(texts, (text) => {
        const record = makeRecord({ data: { text } });

        const found = index.search(PROCESS, [record], text).length === 1;

        expect(found).toBe(index.terms(text).length > 0);
      }),
    );
  });

  describe('with the writeRecordsCorpus corpus', () => {
    let corpus: HexRecord[];

    beforeAll(() => {
      corpus = writeRecordsCorpus(createTempDir('search-corpus'), {
        recordsPerProcess: 300,
      }).records;
    });

    /** Gabarito: registros cujo `data.text` tem `word` como palavra inteira. */
    const withWord = (word: string) =>
      corpus.filter((record) => {
        const { text } = record.data;
        return typeof text === 'string' && new RegExp(`\\b${word}\\b`).test(text);
      });

    it('should find every record of "authentication" with one typo, a recall of 1.0', () => {
      const expected = idsOf(withWord('authentication'));

      expect(expected).not.toHaveLength(0);

      const found = search(corpus, 'authentcation');

      expect(found).toEqual(expect.arrayContaining(expected));
    });

    it('should return only the records that have "authentication", a precision of 1.0', () => {
      const expected = idsOf(withWord('authentication'));

      const found = search(corpus, 'authentication');

      expect([...found].sort()).toEqual([...expected].sort());
    });

    it('should return only the records with both words for "webhook retry" in the AND, a precision of 1.0', () => {
      const retry = new Set(idsOf(withWord('retry')));
      const expected = idsOf(withWord('webhook')).filter((id) => retry.has(id));

      expect(expected).not.toHaveLength(0);

      const found = search(corpus, 'webhook retry');

      expect([...found].sort()).toEqual([...expected].sort());
    });

    it('should find nothing for a term that is not in the corpus', () => {
      expect(search(corpus, 'zzqxwv')).toEqual([]);
    });

    it('should return the same result from the cached index and a fresh one as from the cold index', () => {
      const index = createSearchIndex();
      const cold = index.search(PROCESS, corpus, 'webhook retry', undefined);

      expect(cold).not.toHaveLength(0);

      const repeated = [
        index.search(PROCESS, corpus, 'webhook retry', undefined),
        ...Array.from({ length: 3 }, () => search(corpus, 'webhook retry')),
      ];

      expect(repeated).toEqual(repeated.map(() => cold));
    });
  });
});
