import { afterEach, describe, expect, it, jest } from '@jest/globals';
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

// Texto indexável de um registro sem string em `data`: só type e target.
const BARE_CHARS = 'note\narea.topic'.length;

const textRecord = (text: string): HexRecord => makeRecord({ data: { text } });

const makeRecords = (count: number, text = 'webhook') =>
  Array.from({ length: count }, () => textRecord(text));

// Cada `addAll` do MiniSearch é uma montagem ou um acréscimo; os tamanhos dos lotes mostram qual.
const addAll = jest.spyOn(MiniSearch.prototype, 'addAll');
const indexedBatches = () => addAll.mock.calls.map(([documents]) => documents.length);

describe('createSearchIndex', () => {
  afterEach(() => {
    addAll.mockClear();
  });

  it('should reuse the index without rebuilding for the same set of records', () => {
    const index = createSearchIndex();
    const records = makeRecords(3);
    const first = index.search(PROC_A, records, 'webhook');

    const second = index.search(PROC_A, records, 'webhook');

    expect(second).toEqual(first);
    expect(indexedBatches()).toEqual([3]);
  });

  it('should give each process its own index even with the same records', () => {
    const index = createSearchIndex();
    const records = makeRecords(2);
    index.search(PROC_A, records, 'webhook');

    index.search(PROC_B, records, 'webhook');

    expect(indexedBatches()).toEqual([2, 2]);
  });

  it('should index only the new records when the log only grew', () => {
    const index = createSearchIndex();
    const records = makeRecords(3);
    index.search(PROC_A, records, 'webhook');
    const grown = [...records, ...makeRecords(2)];

    const ids = index.search(PROC_A, grown, 'webhook');

    expect(indexedBatches()).toEqual([3, 2]);
    expect(ids).toEqual(grown.map((record) => record.id));
  });

  it('should not serve the stale index when the last record has other content', () => {
    const index = createSearchIndex();
    const records = [...makeRecords(2, 'webhook'), textRecord('retry')];
    index.search(PROC_A, records, 'retry');
    const diverged = [...records.slice(0, 2), textRecord('timeout')];

    expect(index.search(PROC_A, diverged, 'retry')).toEqual([]);
  });

  it('should rebuild once and find the new content when the last record has other content', () => {
    const index = createSearchIndex();
    const records = [...makeRecords(2, 'webhook'), textRecord('retry')];
    index.search(PROC_A, records, 'retry');
    const diverged = [...records.slice(0, 2), textRecord('timeout')];
    index.search(PROC_A, diverged, 'retry');

    expect(index.search(PROC_A, diverged, 'timeout')).toEqual([diverged[2]!.id]);
    expect(indexedBatches()).toEqual([3, 3]);
  });

  it('should return the prefix records for a log shorter than the indexed one', () => {
    const index = createSearchIndex();
    const records = makeRecords(3);
    index.search(PROC_A, records, 'webhook');

    expect(index.search(PROC_A, records.slice(0, 2), 'webhook')).toEqual([
      records[0]!.id,
      records[1]!.id,
    ]);
  });

  it('should keep the warm index cached after answering a shorter log with an ephemeral engine', () => {
    const index = createSearchIndex();
    const records = makeRecords(3);
    index.search(PROC_A, records, 'webhook');
    index.search(PROC_A, records.slice(0, 2), 'webhook');

    expect(index.search(PROC_A, records, 'webhook')).toEqual(records.map((record) => record.id));

    expect(indexedBatches()).toEqual([3, 2]);
  });

  it('should return empty for a process without records', () => {
    const index = createSearchIndex();
    const records = makeRecords(3);
    index.search(PROC_A, records, 'webhook');
    addAll.mockClear();

    expect(index.search(PROC_A, [], 'webhook')).toEqual([]);
  });

  it('should index nothing and keep the warm index after a search over a process without records', () => {
    const index = createSearchIndex();
    const records = makeRecords(3);
    index.search(PROC_A, records, 'webhook');
    addAll.mockClear();
    index.search(PROC_A, [], 'webhook');

    index.search(PROC_A, records, 'webhook');

    expect(indexedBatches()).toEqual([]);
  });

  it('should keep the most recently used process when the budget is exceeded', () => {
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
  });

  it('should evict the least recently used process when the budget is exceeded', () => {
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

    index.search(PROC_B, b, 'webhook');

    expect(indexedBatches()).toEqual([2, 2]);
  });

  it('should keep evicting until it fits when the new process is large', () => {
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

  it('should return the records of a process above the budget alone', () => {
    const index = createSearchIndex(3 * RECORD_CHARS);
    const small = makeRecords(2);
    const huge = makeRecords(4);
    index.search(PROC_A, small, 'webhook');
    addAll.mockClear();

    expect(index.search(PROC_B, huge, 'webhook')).toEqual(huge.map((record) => record.id));
  });

  it('should not store a process above the budget alone and rebuild it on every search', () => {
    const index = createSearchIndex(3 * RECORD_CHARS);
    const small = makeRecords(2);
    const huge = makeRecords(4);
    index.search(PROC_A, small, 'webhook');
    addAll.mockClear();
    index.search(PROC_B, huge, 'webhook');

    index.search(PROC_B, huge, 'webhook');
    index.search(PROC_A, small, 'webhook');

    // Dois acréscimos completos do B, e o A segue em cache, sem despejo.
    expect(indexedBatches()).toEqual([4, 4]);
  });

  it('should count text in the budget: a process of few long records evicts the short ones', () => {
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

  it('should not store a process whose text alone is above the budget, even with few records', () => {
    const index = createSearchIndex(3 * RECORD_CHARS);
    const long = [textRecord('webhook '.repeat(30))];

    index.search(PROC_A, long, 'webhook');
    index.search(PROC_A, long, 'webhook');

    expect(indexedBatches()).toEqual([1, 1]);
  });

  it('should evict a process from the cache when it grows past the budget', () => {
    const index = createSearchIndex(3 * RECORD_CHARS);
    const records = makeRecords(3);
    index.search(PROC_A, records, 'webhook');
    const grown = [...records, textRecord('webhook')];

    index.search(PROC_A, grown, 'webhook');
    index.search(PROC_A, grown, 'webhook');

    expect(indexedBatches()).toEqual([3, 1, 4]);
  });

  it('should not store the project scope: two searches build twice', () => {
    const index = createSearchIndex(3 * RECORD_CHARS);
    const records = makeRecords(3);

    index.search(PROJECT, records, 'webhook');
    index.search(PROJECT, records, 'webhook');

    expect(indexedBatches()).toEqual([3, 3]);
  });

  it('should take a ref whose process is "*" as the project scope, never stored', () => {
    const index = createSearchIndex();
    const records = makeRecords(3);
    const project: ProcessRef = { project: 'proj', process: '*' };
    index.search(project, records, 'webhook');

    index.search(project, records, 'webhook');

    expect(indexedBatches()).toEqual([3, 3]);
  });

  it('should not count the project scope in the budget nor evict the warm processes', () => {
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

  it('should return the same result with the cache as the index without it, on hit, growth and rebuild', () => {
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

  it('should not count the non-string values of data in the budget', () => {
    const index = createSearchIndex(2 * BARE_CHARS);
    const records = Array.from({ length: 2 }, () =>
      makeRecord({ data: { count: 1, enabled: true, note: null } }),
    );
    index.search(PROC_A, records, 'note');

    index.search(PROC_A, records, 'note');

    expect(indexedBatches()).toEqual([2]);
  });

  it('should give the distinct terms of the text in lower case and without accent', () => {
    const index = createSearchIndex();

    expect(index.terms('Café WEBHOOK cafe webhook')).toEqual(['cafe', 'webhook']);
  });

  it('should give no term for a text of only combining marks', () => {
    const index = createSearchIndex();

    expect(index.terms('\u0301')).toEqual([]);
  });

  it('should match a record by the prefix of a term', () => {
    const index = createSearchIndex();
    const match = textRecord('webhook');
    const records = [match, textRecord('retry')];

    expect(index.search(PROC_A, records, 'webh')).toEqual([match.id]);
  });

  it('should tolerate one edit in a term of five characters', () => {
    const index = createSearchIndex();
    const match = textRecord('retry');
    const records = [match, textRecord('webhook')];

    expect(index.search(PROC_A, records, 'retri')).toEqual([match.id]);
  });

  it('should not fall back to any term when a record has all of them', () => {
    const index = createSearchIndex();
    const both = textRecord('webhook retry');
    const records = [both, textRecord('webhook only'), textRecord('retry only')];

    expect(index.search(PROC_A, records, 'webhook retry')).toEqual([both.id]);
  });

  it('should fall back to any term when no record has all of them', () => {
    const index = createSearchIndex();
    const match = textRecord('webhook');
    const records = [match, textRecord('retry')];

    expect(index.search(PROC_A, records, 'webhook kubernetes')).toEqual([match.id]);
  });

  it('should require half of the terms, rounded up, from a record in the fallback', () => {
    const index = createSearchIndex();
    const alphaBeta = textRecord('alpha beta');
    const alphaBetaGamma = textRecord('alpha beta gamma');
    const records = [textRecord('alpha'), alphaBeta, alphaBetaGamma];

    const ids = index.search(PROC_A, records, 'alpha beta zeta');

    expect(ids.toSorted()).toEqual([alphaBeta.id, alphaBetaGamma.id]);
  });

  it('should return only the allowed records', () => {
    const index = createSearchIndex();
    const records = makeRecords(3);
    const allowed = new Set([records[0]!.id, records[2]!.id]);

    expect(index.search(PROC_A, records, 'webhook', allowed)).toEqual([
      records[0]!.id,
      records[2]!.id,
    ]);
  });

  it('should fall back to any term over the allowed records when none of them has all the terms', () => {
    const index = createSearchIndex();
    const records = [textRecord('webhook retry'), textRecord('webhook only')];
    const allowed = new Set([records[1]!.id]);

    expect(index.search(PROC_A, records, 'webhook retry', allowed)).toEqual([records[1]!.id]);
  });

  it('should rank the more relevant record before an earlier one in the log', () => {
    const index = createSearchIndex();
    const diluted = textRecord(`webhook ${'filler '.repeat(8)}`);
    const focused = textRecord('webhook');

    expect(index.search(PROC_A, [diluted, focused], 'webhook')).toEqual([focused.id, diluted.id]);
  });

  it('should keep the log order between records of the same relevance', () => {
    const index = createSearchIndex();
    // O MiniSearch percorre o prefixo 'ab' por 'abc' antes de 'abz': a ordem nativa do empate inverte o log.
    const records = [textRecord('abz'), textRecord('abc')];

    expect(index.search(PROC_A, records, 'ab')).toEqual([records[0]!.id, records[1]!.id]);
  });
});
