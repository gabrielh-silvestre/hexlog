import { beforeAll, describe, expect, test } from '@jest/globals';
import { createSearchIndex } from '../../src/adapters/search.ts';
import type { RecordId } from '../../src/domain/ids.ts';
import type { HexRecord } from '../../src/domain/record.ts';
import type { ProcessRef } from '../../src/ports.ts';
import { writeRecordsCorpus } from '../fixtures/records-corpus.ts';
import { createTempDir } from '../helpers.ts';
import { makeRecord } from './search-helpers.ts';

const PROCESS: ProcessRef = { project: 'proj', process: 'proc' };

// Índice novo por chamada: cada caso mede a busca sem cache; o que o cache muda está em search.cache.spec.ts.
const search = (records: HexRecord[], text: string, allowed?: ReadonlySet<RecordId>) =>
  createSearchIndex().search(PROCESS, records, text, allowed);

const idsOf = (records: HexRecord[]) => records.map((record) => record.id);

describe('createSearchIndex', () => {
  test('não acha nada em lista vazia nem sem correspondência', () => {
    expect(search([], 'anything')).toEqual([]);
    expect(search([makeRecord({ data: { text: 'webhook' } })], 'kubernetes')).toEqual([]);
  });

  test('indexa type, target e as strings de data, inclusive as aninhadas', () => {
    const byType = makeRecord({ type: 'decision' });
    const byTarget = makeRecord({ target: 'billing.invoice' });
    const byData = makeRecord({ data: { text: 'refund' } });
    const nested = makeRecord({ data: { deep: { list: [{ note: 'quarantine' }] } } });
    const records = [byType, byTarget, byData, nested];

    expect(search(records, 'decision')).toEqual([byType.id]);
    expect(search(records, 'invoice')).toEqual([byTarget.id]);
    expect(search(records, 'refund')).toEqual([byData.id]);
    expect(search(records, 'quarantine')).toEqual([nested.id]);
  });

  test('não indexa id, autor, relações, chaves de data nem valores que não são string', () => {
    const record = makeRecord({
      data: { secretkey: 1, flag: true, none: null },
      relations: [{ kind: 'supports', to: 'other:0198f4a0-0000-7000-8000-000000000001' }],
      author: { agent: 'zebra', client: 'quokka' },
    });

    for (const term of ['secretkey', 'zebra', 'quokka', 'supports', 'proc']) {
      expect(search([record], term)).toEqual([]);
    }
  });

  test('devolve os ids por relevância decrescente', () => {
    const weak = makeRecord({ data: { text: 'one webhook among many other filler words here' } });
    const strong = makeRecord({ data: { text: 'webhook' }, target: 'webhook.retry' });
    const none = makeRecord({ data: { text: 'unrelated' } });

    expect(search([weak, none, strong], 'webhook')).toEqual([strong.id, weak.id]);
  });

  test('empate de relevância mantém a ordem dos registros', () => {
    const records = [1, 2, 3].map(() => makeRecord({ data: { text: 'webhook' } }));

    expect(search(records, 'webhook')).toEqual(idsOf(records));
    expect(search([...records].reverse(), 'webhook')).toEqual(idsOf(records).reverse());
  });

  test('ignora acento e caixa, na consulta e no texto', () => {
    const record = makeRecord({ data: { text: 'Configuração Crítica' } });

    expect(search([record], 'configuracao critica')).toEqual([record.id]);
    expect(search([makeRecord({ data: { text: 'configuracao' } })], 'CONFIGURAÇÃO')).toHaveLength(
      1,
    );
  });

  test('termo que some depois de tirar o acento não é indexado, e o resto do registro continua achável', () => {
    const record = makeRecord({ data: { text: '\u0301 webhook' } });

    expect(search([record], 'webhook')).toEqual([record.id]);
    expect(search([record], '\u0301')).toEqual([]);
  });

  test('casa por prefixo e tolera um erro de digitação', () => {
    const record = makeRecord({ data: { text: 'authentication' } });

    expect(search([record], 'authent')).toEqual([record.id]);
    expect(search([record], 'authentcation')).toEqual([record.id]);
  });

  test('exige todos os termos (AND) quando algum registro os tem todos', () => {
    const both = makeRecord({ data: { text: 'webhook retry' } });
    const one = makeRecord({ data: { text: 'webhook only' } });

    expect(search([one, both], 'webhook retry')).toEqual([both.id]);
  });

  test('cai para OR quando o AND não acha nada, exigindo metade dos termos arredondada para cima', () => {
    const webhookOnly = makeRecord({ data: { text: 'webhook and unrelated words' } });
    const webhookAndTimeout = makeRecord({ data: { text: 'webhook timeout' } });

    // 2 termos: o piso é 1, qualquer um dos dois basta.
    expect(search([webhookOnly], 'webhook retry')).toEqual([webhookOnly.id]);
    // 3 termos: o piso é 2, e só o registro com dois dos três entra.
    expect(search([webhookOnly, webhookAndTimeout], 'webhook timeout retry')).toEqual([
      webhookAndTimeout.id,
    ]);
  });

  test('com `allowed`, o AND e o piso do OR decidem sobre os registros permitidos (paridade com o 0.x)', () => {
    const doc = makeRecord({ type: 'doc', data: { text: 'banana uva' } });
    const banana = makeRecord({ data: { text: 'banana' } });
    const uva = makeRecord({ data: { text: 'uva' } });
    const records = [doc, banana, uva];

    // Sem o filtro o doc casa os dois termos e o OR nunca roda.
    expect(search(records, 'banana uva')).toEqual([doc.id]);
    // Só as notas permitidas: nenhuma casa os dois, então o OR devolve as duas.
    expect(search(records, 'banana uva', new Set([banana.id, uva.id]))).toEqual([
      banana.id,
      uva.id,
    ]);
  });

  test('`allowed` vazio não devolve nada e um permitido que não casa não entra', () => {
    const banana = makeRecord({ data: { text: 'banana' } });
    const other = makeRecord({ data: { text: 'laranja' } });

    expect(search([banana, other], 'banana', new Set())).toEqual([]);
    expect(search([banana, other], 'banana', new Set([other.id]))).toEqual([]);
  });

  test.each(['', '   ', '\n\t', '!!! ---'])('consulta em branco %j não acha nada', (text) => {
    expect(search([makeRecord({ data: { text: 'webhook' } })], text)).toEqual([]);
  });

  test('uma consulta de um termo só nunca cai para OR', () => {
    expect(search([makeRecord({ data: { text: 'webhook' } })], 'retry')).toEqual([]);
  });

  test('repetir um termo não o torna mais pesado que os outros da consulta', () => {
    const mostlyBeta = makeRecord({ data: { text: 'beta beta beta beta alpha' } });
    const mostlyAlpha = makeRecord({ data: { text: 'alpha alpha alpha alpha beta' } });
    const records = [mostlyBeta, mostlyAlpha];

    // Os dois casam igual `alpha beta`; `Alpha alpha` não pode empurrar `mostlyAlpha` para cima.
    expect(search(records, 'Alpha alpha beta')).toEqual(search(records, 'alpha beta'));
    expect(search(records, 'alpha beta')).toEqual(idsOf(records));
  });

  test('termo repetido conta uma vez só no AND e no piso do OR', () => {
    const both = makeRecord({ data: { text: 'webhook retry' } });
    const webhookOnly = makeRecord({ data: { text: 'webhook and unrelated words' } });

    // AND: `webhook` repetido não exige nada além de `webhook` e `retry`.
    expect(search([webhookOnly, both], 'webhook webhook retry')).toEqual([both.id]);
    // OR: 2 termos distintos dão piso 1; contados com a repetição seriam 3 e piso 2.
    expect(search([webhookOnly], 'webhook webhook retry')).toEqual([webhookOnly.id]);
  });

  test('consulta com o mesmo termo repetido milhares de vezes custa como a de um termo só', () => {
    const records = Array.from({ length: 5_000 }, () =>
      makeRecord({ data: { text: 'webhook delivery' } }),
    );

    const start = performance.now();
    const ids = search(records, 'webhook '.repeat(2_000));
    const elapsed = performance.now() - start;

    expect(ids).toHaveLength(records.length);
    // Sem o dedupe passa de 12 s; com ele o custo é o do índice (~100 ms).
    expect(elapsed).toBeLessThanOrEqual(2_000);
  });
});

describe('createSearchIndex sobre o corpus de writeRecordsCorpus (N9)', () => {
  let corpus: HexRecord[];

  beforeAll(() => {
    corpus = writeRecordsCorpus(createTempDir('search-corpus'), { recordsPerProcess: 300 }).records;
  });

  /** Gabarito: registros cujo `data.text` tem `word` como palavra inteira. */
  const withWord = (word: string) =>
    corpus.filter((record) => {
      const { text } = record.data;
      return typeof text === 'string' && new RegExp(`\\b${word}\\b`).test(text);
    });

  test('recall 1,0 com um erro de digitação: acha todo registro da palavra "authentication"', () => {
    const expected = idsOf(withWord('authentication'));
    expect(expected.length).toBeGreaterThan(0);

    expect(search(corpus, 'authentcation')).toEqual(expect.arrayContaining(expected));
  });

  test('precisão 1,0: a palavra "authentication" devolve só os registros que a têm', () => {
    const expected = idsOf(withWord('authentication'));

    expect([...search(corpus, 'authentication')].sort()).toEqual([...expected].sort());
  });

  test('precisão 1,0 no AND: "webhook retry" devolve só quem tem as duas palavras', () => {
    const retry = new Set(idsOf(withWord('retry')));
    const expected = idsOf(withWord('webhook')).filter((id) => retry.has(id));
    expect(expected.length).toBeGreaterThan(0);

    expect([...search(corpus, 'webhook retry')].sort()).toEqual([...expected].sort());
  });

  test('um termo que não está no corpus não acha nada', () => {
    expect(search(corpus, 'zzqxwv')).toEqual([]);
  });

  test('determinismo: o índice frio, o cacheado e um índice novo devolvem o mesmo resultado', () => {
    const index = createSearchIndex();
    const calls = [
      index.search(PROCESS, corpus, 'webhook retry', undefined),
      index.search(PROCESS, corpus, 'webhook retry', undefined),
      ...Array.from({ length: 3 }, () => search(corpus, 'webhook retry')),
    ];

    expect(calls[0]).not.toHaveLength(0);
    for (const call of calls) expect(call).toEqual(calls[0]);
  });
});
