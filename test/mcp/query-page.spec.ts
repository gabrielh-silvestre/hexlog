import { describe, expect, jest, test } from '@jest/globals';
import { PAGE_CHARS_CAP } from '../../src/mcp/kernel.ts';
import { CHANGES_ITEMS_CAP, queryPage } from '../../src/mcp/tools/query.ts';
import type { QueryResult, QueryService } from '../../src/queries/query-service.ts';

const idOf = (n: number) => `run-1:00000000-0000-7000-8000-${n.toString(16).padStart(12, '0')}`;

const emptyPage: QueryResult = { records: [], marker: {} };

function queryWith(page: QueryResult) {
  const queryRecords = jest.fn<QueryService['queryRecords']>(() => page);
  return { query: { queryRecords }, queryRecords };
}

describe('queryPage', () => {
  test('M4: passa PAGE_CHARS_CAP em maxChars e repassa o resto da entrada', () => {
    const { query, queryRecords } = queryWith(emptyPage);

    queryPage(query, { project: 'p', process: 'run-1', limit: 10 });

    expect(queryRecords).toHaveBeenCalledWith({
      project: 'p',
      process: 'run-1',
      limit: 10,
      maxChars: PAGE_CHARS_CAP,
    });
  });

  test('sem changes, a página volta como veio', () => {
    const { query } = queryWith(emptyPage);

    expect(queryPage(query, { project: 'p' })).toEqual(emptyPage);
  });

  test.each([
    ['entered acima do teto', CHANGES_ITEMS_CAP + 7, 1, { entered: 7, left: 0 }],
    ['left acima do teto', 1, CHANGES_ITEMS_CAP + 3, { entered: 0, left: 3 }],
    [
      'os dois acima do teto',
      CHANGES_ITEMS_CAP + 2,
      CHANGES_ITEMS_CAP + 5,
      { entered: 2, left: 5 },
    ],
    ['exatamente no teto', CHANGES_ITEMS_CAP, CHANGES_ITEMS_CAP, undefined],
  ])('M4: changes com %s', (_title, enteredCount, leftCount, omitted) => {
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
