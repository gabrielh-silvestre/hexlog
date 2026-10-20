import { describe, expect, jest, test } from '@jest/globals';
import { CHANGES_ITEMS_CAP, queryPage } from '../../src/mcp/tools/query.ts';
import {
  PAGE_CHARS_CAP,
  type QueryResult,
  type QueryService,
} from '../../src/queries/query-service.ts';

const idOf = (n: number) => `run-1:00000000-0000-7000-8000-${n.toString(16).padStart(12, '0')}`;

const emptyPage: QueryResult = { records: [], marker: {} };

function queryWith(page: QueryResult) {
  const queryRecords = jest.fn<QueryService['queryRecords']>(() => page);
  return { query: { queryRecords }, queryRecords };
}

describe('queryPage', () => {
  test('M4: passes PAGE_CHARS_CAP as maxChars and forwards the rest of the input', () => {
    const { query, queryRecords } = queryWith(emptyPage);

    queryPage(query, { project: 'p', process: 'run-1', limit: 10 });

    expect(queryRecords).toHaveBeenCalledWith({
      project: 'p',
      process: 'run-1',
      limit: 10,
      relations: 'counts',
      maxChars: PAGE_CHARS_CAP,
    });
  });

  test('forwards fields to the service together with maxChars', () => {
    const { query, queryRecords } = queryWith(emptyPage);

    queryPage(query, { project: 'p', fields: ['ref'] });

    expect(queryRecords).toHaveBeenCalledWith({
      project: 'p',
      fields: ['ref'],
      relations: 'counts',
      maxChars: PAGE_CHARS_CAP,
    });
  });

  test.each(['full', 'none'] as const)('keeps an explicit relations value %s', (relations) => {
    const { query, queryRecords } = queryWith(emptyPage);

    queryPage(query, { project: 'p', relations });

    expect(queryRecords).toHaveBeenCalledWith(expect.objectContaining({ relations }));
  });

  test('without changes, the page comes back as it came', () => {
    const { query } = queryWith(emptyPage);

    expect(queryPage(query, { project: 'p' })).toEqual(emptyPage);
  });

  test.each([
    ['entered above the cap', CHANGES_ITEMS_CAP + 7, 1, { entered: 7, left: 0 }],
    ['left above the cap', 1, CHANGES_ITEMS_CAP + 3, { entered: 0, left: 3 }],
    ['both above the cap', CHANGES_ITEMS_CAP + 2, CHANGES_ITEMS_CAP + 5, { entered: 2, left: 5 }],
    ['exactly at the cap', CHANGES_ITEMS_CAP, CHANGES_ITEMS_CAP, undefined],
  ])('M4: changes with %s', (_title, enteredCount, leftCount, omitted) => {
    const entered = Array.from({ length: enteredCount }, (_, i) => idOf(i));
    const left = Array.from({ length: leftCount }, (_, i) => ({
      id: idOf(1_000 + i),
      reason: 'superseded' as const,
    }));
    const { query } = queryWith({ ...emptyPage, changes: { entered, left, marker: {} } });

    const { changes } = queryPage(query, { project: 'p' });

    expect(changes?.entered).toEqual(entered.slice(0, CHANGES_ITEMS_CAP));
    expect(changes?.left).toEqual(left.slice(0, CHANGES_ITEMS_CAP));
    expect(changes?.omitted).toEqual(omitted);
  });
});
