import type { HexRecord } from '../../src/domain/record.ts';

let counter = 0;

/** Registro de teste com id sequencial; `overrides` troca qualquer campo (o `data` padrão é vazio). */
export function makeRecord(overrides: Partial<HexRecord> = {}): HexRecord {
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
