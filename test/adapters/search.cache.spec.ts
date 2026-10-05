import { afterEach, describe, expect, jest, test } from '@jest/globals';
import MiniSearch from 'minisearch';
import { createSearchIndex } from '../../src/adapters/search.ts';
import type { HexRecord } from '../../src/domain/record.ts';
import { PROJECT_INDEX, type ProcessRef } from '../../src/ports.ts';
import { makeRecord } from './search-helpers.ts';

const PROC_A: ProcessRef = { project: 'proj', process: 'alpha' };
const PROC_B: ProcessRef = { project: 'proj', process: 'beta' };
const PROC_C: ProcessRef = { project: 'proj', process: 'gamma' };
const PROJECT: ProcessRef = { project: 'proj', process: PROJECT_INDEX };

// Texto indexável de `textRecord('webhook')`: type, target e o texto, juntos por quebra de linha.
const RECORD_CHARS = 'note\narea.topic\nwebhook'.length;

const textRecord = (text: string): HexRecord => makeRecord({ data: { text } });

const makeRecords = (count: number, text = 'webhook') =>
  Array.from({ length: count }, () => textRecord(text));

// Cada `addAll` do MiniSearch é uma montagem ou um acréscimo; os tamanhos dos lotes mostram qual.
const addAll = jest.spyOn(MiniSearch.prototype, 'addAll');
const indexedBatches = () => addAll.mock.calls.map(([documents]) => documents.length);

afterEach(() => {
  addAll.mockClear();
});

describe('createSearchIndex com cache', () => {
  test('o mesmo conjunto de registros reaproveita o índice sem remontar', () => {
    const index = createSearchIndex();
    const records = makeRecords(3);

    const first = index.search(PROC_A, records, 'webhook');
    const second = index.search(PROC_A, records, 'webhook');

    expect(second).toEqual(first);
    expect(indexedBatches()).toEqual([3]);
  });

  test('cada processo tem o próprio índice, mesmo com os mesmos registros', () => {
    const index = createSearchIndex();
    const records = makeRecords(2);

    index.search(PROC_A, records, 'webhook');
    index.search(PROC_B, records, 'webhook');

    expect(indexedBatches()).toEqual([2, 2]);
  });

  test('log que só cresceu indexa apenas os registros novos', () => {
    const index = createSearchIndex();
    const records = makeRecords(3);
    index.search(PROC_A, records, 'webhook');

    const grown = [...records, ...makeRecords(2)];
    const ids = index.search(PROC_A, grown, 'webhook');

    expect(indexedBatches()).toEqual([3, 2]);
    expect(ids).toEqual(grown.map((record) => record.id));
  });

  test('último registro com outro conteúdo descarta o índice e remonta', () => {
    const index = createSearchIndex();
    const records = [...makeRecords(2, 'webhook'), textRecord('retry')];
    index.search(PROC_A, records, 'retry');

    const diverged = [...records.slice(0, 2), textRecord('timeout')];

    expect(index.search(PROC_A, diverged, 'retry')).toEqual([]);
    expect(index.search(PROC_A, diverged, 'timeout')).toEqual([diverged[2]!.id]);
    expect(indexedBatches()).toEqual([3, 3]);
  });

  test('log menor que o indexado é um prefixo: monta um motor efêmero e o índice quente continua em cache', () => {
    const index = createSearchIndex();
    const records = makeRecords(3);
    index.search(PROC_A, records, 'webhook');

    expect(index.search(PROC_A, records.slice(0, 2), 'webhook')).toEqual([
      records[0]!.id,
      records[1]!.id,
    ]);
    expect(index.search(PROC_A, records, 'webhook')).toEqual(records.map((record) => record.id));

    expect(indexedBatches()).toEqual([3, 2]);
  });

  test('processo sem registros devolve vazio, não indexa nada e não apaga o índice quente', () => {
    const index = createSearchIndex();
    const records = makeRecords(3);
    index.search(PROC_A, records, 'webhook');
    addAll.mockClear();

    expect(index.search(PROC_A, [], 'webhook')).toEqual([]);
    index.search(PROC_A, records, 'webhook');

    expect(indexedBatches()).toEqual([]);
  });

  test('passou do orçamento, apaga o processo usado há mais tempo', () => {
    const index = createSearchIndex(5 * RECORD_CHARS);
    const a = makeRecords(3);
    const b = makeRecords(2);
    const c = makeRecords(2);
    index.search(PROC_A, a, 'webhook');
    index.search(PROC_B, b, 'webhook');
    // Usar o A de novo faz do B o menos usado.
    index.search(PROC_A, a, 'webhook');
    addAll.mockClear();

    index.search(PROC_C, c, 'webhook');
    index.search(PROC_A, a, 'webhook');
    expect(indexedBatches()).toEqual([2]);

    index.search(PROC_B, b, 'webhook');
    expect(indexedBatches()).toEqual([2, 2]);
  });

  test('o despejo continua até caber quando o processo novo é grande', () => {
    const index = createSearchIndex(5 * RECORD_CHARS);
    const smallA = makeRecords(2);
    const smallB = makeRecords(2);
    const big = makeRecords(5);
    index.search(PROC_A, smallA, 'webhook');
    index.search(PROC_B, smallB, 'webhook');

    index.search(PROC_C, big, 'webhook');
    addAll.mockClear();
    // O B primeiro: com um despejo só ele ainda estaria em cache, e remontar o A não o tira dali.
    index.search(PROC_B, smallB, 'webhook');
    index.search(PROC_A, smallA, 'webhook');

    expect(indexedBatches()).toEqual([2, 2]);
  });

  test('processo acima do orçamento sozinho não é guardado e remonta a cada busca', () => {
    const index = createSearchIndex(3 * RECORD_CHARS);
    const small = makeRecords(2);
    const huge = makeRecords(4);
    index.search(PROC_A, small, 'webhook');
    addAll.mockClear();

    expect(index.search(PROC_B, huge, 'webhook')).toEqual(huge.map((record) => record.id));
    index.search(PROC_B, huge, 'webhook');
    index.search(PROC_A, small, 'webhook');

    // Dois acréscimos completos do B, e o A segue em cache, sem despejo.
    expect(indexedBatches()).toEqual([4, 4]);
  });

  test('o orçamento conta texto: um processo de poucos registros longos despeja os curtos', () => {
    const index = createSearchIndex(6 * RECORD_CHARS);
    const shortA = makeRecords(2);
    const shortB = makeRecords(2);
    const long = [textRecord('webhook '.repeat(10))];
    index.search(PROC_A, shortA, 'webhook');
    index.search(PROC_B, shortB, 'webhook');

    // Um só registro, mas com texto de sobra para tirar os dois processos curtos do cache.
    index.search(PROC_C, long, 'webhook');
    addAll.mockClear();
    index.search(PROC_A, shortA, 'webhook');
    index.search(PROC_B, shortB, 'webhook');

    expect(indexedBatches()).toEqual([2, 2]);
  });

  test('processo cujo texto sozinho passa do orçamento não é guardado, mesmo com poucos registros', () => {
    const index = createSearchIndex(3 * RECORD_CHARS);
    const long = [textRecord('webhook '.repeat(30))];

    index.search(PROC_A, long, 'webhook');
    index.search(PROC_A, long, 'webhook');

    expect(indexedBatches()).toEqual([1, 1]);
  });

  test('processo que passa a exceder o orçamento sai do cache', () => {
    const index = createSearchIndex(3 * RECORD_CHARS);
    const records = makeRecords(3);
    index.search(PROC_A, records, 'webhook');

    const grown = [...records, textRecord('webhook')];
    index.search(PROC_A, grown, 'webhook');
    index.search(PROC_A, grown, 'webhook');

    expect(indexedBatches()).toEqual([3, 1, 4]);
  });

  test('o alcance projeto não é guardado: duas buscas montam duas vezes', () => {
    const index = createSearchIndex(3 * RECORD_CHARS);
    const records = makeRecords(3);

    index.search(PROJECT, records, 'webhook');
    index.search(PROJECT, records, 'webhook');

    expect(indexedBatches()).toEqual([3, 3]);
  });

  test('o alcance projeto não conta no orçamento nem despeja os processos quentes', () => {
    const index = createSearchIndex(4 * RECORD_CHARS);
    const a = makeRecords(2);
    const b = makeRecords(2);
    const project = [...a, ...b];
    index.search(PROC_A, a, 'webhook');
    index.search(PROC_B, b, 'webhook');
    addAll.mockClear();

    index.search(PROJECT, project, 'webhook');
    index.search(PROC_A, a, 'webhook');
    index.search(PROJECT, project, 'webhook');
    index.search(PROC_B, b, 'webhook');

    expect(indexedBatches()).toEqual([4, 4]);
  });

  test('o resultado com cache é idêntico ao do índice sem cache, em acerto, crescimento e remontagem', () => {
    const cached = createSearchIndex();
    const queries = ['webhook', 'webhook retry', 'Webhook webhook', 'authent', 'kubernetes'];
    const base = [
      textRecord('webhook retry with backoff'),
      textRecord('webhook'),
      textRecord('authentication webhook timeout'),
      textRecord('webhook'),
    ];
    const grown = [...base, textRecord('retry webhook'), textRecord('unrelated words')];
    const rewritten = [...base.slice(0, 3), textRecord('retry only')];

    for (const records of [base, base, grown, grown, rewritten]) {
      for (const query of queries) {
        expect(cached.search(PROC_A, records, query)).toEqual(
          createSearchIndex().search(PROC_A, records, query),
        );
      }
    }
  });
});
