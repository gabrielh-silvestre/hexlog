import type { HexRecord } from '../../src/domain/record.ts';
import { idAt } from '../fixtures/chain-line.ts';

let counter = 0;

/** Registro de teste com id sequencial; `overrides` troca qualquer campo (o `data` padrão é vazio). */
export function makeRecord(overrides: Partial<HexRecord> = {}): HexRecord {
  counter += 1;
  return {
    id: idAt('proc', counter),
    type: 'note',
    at: '2026-01-01T00:00:00.000Z',
    target: 'area.topic',
    author: { agent: 'tester', client: 'test' },
    data: {},
    relations: [],
    ...overrides,
  };
}
