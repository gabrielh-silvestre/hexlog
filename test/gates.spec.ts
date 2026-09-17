import { describe, test, expect } from '@jest/globals';
import { GateMilestoneData } from '../src/events.ts';
import type { State } from '../src/state.ts';
import type { Chain, Break } from '../src/chain.ts';
import {
  BUILTIN_GATES,
  evaluateBuiltin,
  isBuiltinGate,
  listBuiltinGates,
  buildGateMilestoneData,
  normalizeCustomEvidence,
  type BuiltinGateName,
  type EvaluationResult,
} from '../src/gates.ts';
import { BUILTIN_GATE_NAMES } from '../src/definitions.ts';

// ---- fixtures locais ----

const T = (n: number) => new Date(n * 60_000).toISOString();
const TARGET = 'hex:target:u1';

function cleanChain(): Chain {
  return {
    ok: true,
    totalLines: 1,
    head: '0'.repeat(64),
    breaks: [],
    totalBreaks: 0,
    repairedLines: [],
  };
}

function cleanState(): State {
  return {
    logThrough: { id: `${TARGET}:0`, seq: 0, timestamp: T(0) },
    active: [],
    conflicts: [],
    orphans: [],
    toReview: [],
    invalidReferences: [],
    warnings: [],
    chain: cleanChain(),
  };
}

type OrphanItem = State['orphans'][number];
type ConflictItem = State['conflicts'][number];
type InvalidReferenceItem = State['invalidReferences'][number];

const orphanItem = (i: number): OrphanItem => ({
  milestone: `p:r:milestone:${i}`,
  target: TARGET,
  dueAt: T(-1),
});
const conflictItem = (i: number): ConflictItem => ({
  target: TARGET,
  claim: `a${i}`,
  candidates: ['id1', 'id2'],
});
const breakItem = (i: number): Break => ({ index: i, reason: 'hash-mismatch' });
const invalidReferenceItem = (i: number): InvalidReferenceItem => ({
  citedBy: `id${i}`,
  reference: `ref${i}`,
});

// Um cenário por gate embutido: como violar o estado e onde a violação aparece.
const SCENARIOS: { name: BuiltinGateName; overrides: (count: number) => Partial<State> }[] = [
  {
    name: 'no-orphans',
    overrides: (count) => ({ orphans: Array.from({ length: count }, (_, i) => orphanItem(i)) }),
  },
  {
    name: 'no-conflicts',
    overrides: (count) => ({
      conflicts: Array.from({ length: count }, (_, i) => conflictItem(i)),
    }),
  },
  {
    name: 'chain-intact',
    overrides: (count) => ({
      chain: {
        ...cleanChain(),
        ok: false,
        breaks: Array.from({ length: count }, (_, i) => breakItem(i)),
        totalBreaks: count,
      },
    }),
  },
  {
    name: 'no-invalid-references',
    overrides: (count) => ({
      invalidReferences: Array.from({ length: count }, (_, i) => invalidReferenceItem(i)),
    }),
  },
];

// ---- N5: gates embutidos ----

describe('N5 › gates embutidos', () => {
  test('BUILTIN_GATES tem exatamente os 4 nomes de BUILTIN_GATE_NAMES', () => {
    expect(Object.keys(BUILTIN_GATES).sort()).toEqual([...BUILTIN_GATE_NAMES].sort());
  });

  describe.each(SCENARIOS)('gate $name', ({ name, overrides }) => {
    test('estado violando reprova, com a prova completa e o total real', () => {
      const state: State = { ...cleanState(), ...overrides(3) };
      const result = evaluateBuiltin(name, state);

      expect(result.passed).toBe(false);
      expect(result.totalEvidenceItems).toBe(3);
      expect(result.evidence).toHaveLength(3);
    });

    test('60 itens: prova cortada em 50, totalEvidenceItems mantém o total real', () => {
      const state: State = { ...cleanState(), ...overrides(60) };
      const result = evaluateBuiltin(name, state);

      expect(result.evidence).toHaveLength(50);
      expect(result.totalEvidenceItems).toBe(60);
    });

    test('estado limpo passa com prova vazia e evaluatedThrough = último elo', () => {
      const state = cleanState();
      expect(evaluateBuiltin(name, state)).toEqual({
        passed: true,
        evidence: [],
        totalEvidenceItems: 0,
        evaluatedThrough: state.logThrough,
      });
    });
  });

  test('contrato: resultado nunca é boolean solto, sempre objeto com as 4 chaves', () => {
    const expectedKeys = ['evaluatedThrough', 'passed', 'evidence', 'totalEvidenceItems'].sort();
    const results: EvaluationResult[] = [
      evaluateBuiltin('no-orphans', cleanState()),
      evaluateBuiltin('no-orphans', { ...cleanState(), orphans: [orphanItem(0)] }),
    ];

    for (const result of results) {
      expect(typeof result).toBe('object');
      expect(Object.keys(result).sort()).toEqual(expectedKeys);
    }
  });

  test('isBuiltinGate reconhece só os 4 nomes embutidos', () => {
    expect(isBuiltinGate('chain-intact')).toBe(true);
    expect(isBuiltinGate('my-custom-gate')).toBe(false);
  });

  test('buildGateMilestoneData produz GateMilestoneData válido com origem embutido', () => {
    const state = cleanState();
    const result = evaluateBuiltin('chain-intact', state);
    const data = buildGateMilestoneData({
      name: 'chain-intact',
      origin: 'builtin',
      criteria: BUILTIN_GATES['chain-intact'].criteria,
      target: TARGET,
      result,
    });

    expect(() => GateMilestoneData.parse(data)).not.toThrow();
    expect(data.gate.origin).toBe('builtin');
  });

  test("normalizeCustomEvidence('x') vira ['x']", () => {
    expect(normalizeCustomEvidence('x')).toEqual(['x']);
  });

  test('normalizeCustomEvidence mantém o array quando já vem em lista', () => {
    expect(normalizeCustomEvidence(['a', 'b'])).toEqual(['a', 'b']);
  });

  test('listBuiltinGates() tem 4 itens, cada um com criterio não vazio', () => {
    const list = listBuiltinGates();
    expect(list).toHaveLength(4);
    for (const { criteria } of list) expect(criteria.length).toBeGreaterThan(0);
  });
});

// ---- N6 (nível de buildGateMilestoneData; a tool evaluate_gate fica pro passo 7b) ----

describe('N6 › gate custom em buildGateMilestoneData', () => {
  test('origem custom e criterio vindo de fora produzem GateMilestoneData válido', () => {
    const result: EvaluationResult = {
      passed: false,
      evidence: ['evidence'],
      totalEvidenceItems: 1,
      evaluatedThrough: null,
    };
    const data = buildGateMilestoneData({
      name: 'my-custom-gate',
      origin: 'custom',
      criteria: 'user-defined criteria',
      target: TARGET,
      result,
    });

    expect(() => GateMilestoneData.parse(data)).not.toThrow();
    expect(data.gate).toMatchObject({
      name: 'my-custom-gate',
      origin: 'custom',
      criteria: 'user-defined criteria',
      passed: false,
      evidence: ['evidence'],
      totalEvidenceItems: 1,
      evaluatedThrough: null,
    });
  });
});
