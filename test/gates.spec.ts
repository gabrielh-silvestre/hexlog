import { describe, test, expect } from '@jest/globals';
import canonicalize from 'canonicalize';
import { BUILTIN_GATE_DATA_MAX_CHARS, GateMilestoneData } from '../src/events.ts';
import type { State } from '../src/state.ts';
import type { Chain, Break } from '../src/chain.ts';
import {
  BUILTIN_GATES,
  evaluateBuiltin,
  fitBuiltinGateResult,
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
const targetOfId = (id: string) => `hex:target:of-${id}`;

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
    forks: [],
    targets: [],
    chain: cleanChain(),
  };
}

type OrphanItem = State['orphans'][number];
type ConflictItem = State['conflicts'][number];
type InvalidReferenceItem = State['invalidReferences'][number];
type ForkItem = State['forks'][number];

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
const forkItem = (i: number): ForkItem => ({
  verdict: `superseded${i}`,
  successors: [`successor${i}a`, `successor${i}b`],
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
  {
    name: 'no-forks',
    overrides: (count) => ({ forks: Array.from({ length: count }, (_, i) => forkItem(i)) }),
  },
];

// ---- N5: gates embutidos ----

describe('N5 › gates embutidos', () => {
  test('BUILTIN_GATES tem exatamente os 5 nomes de BUILTIN_GATE_NAMES', () => {
    expect(Object.keys(BUILTIN_GATES).sort()).toEqual([...BUILTIN_GATE_NAMES].sort());
  });

  describe.each(SCENARIOS)('gate $name', ({ name, overrides }) => {
    test('estado violando reprova, com a prova completa e o total real', () => {
      const state: State = { ...cleanState(), ...overrides(3) };
      const result = evaluateBuiltin(name, state, targetOfId);

      expect(result.passed).toBe(false);
      expect(result.totalEvidenceItems).toBe(3);
      expect(result.evidence).toHaveLength(3);
    });

    test('60 itens: prova cortada em 50, totalEvidenceItems mantém o total real', () => {
      const state: State = { ...cleanState(), ...overrides(60) };
      const result = evaluateBuiltin(name, state, targetOfId);

      expect(result.evidence).toHaveLength(50);
      expect(result.totalEvidenceItems).toBe(60);
    });

    test('estado limpo passa com prova vazia e evaluatedThrough = último elo', () => {
      const state = cleanState();
      expect(evaluateBuiltin(name, state, targetOfId)).toEqual({
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
      evaluateBuiltin('no-orphans', cleanState(), targetOfId),
      evaluateBuiltin('no-orphans', { ...cleanState(), orphans: [orphanItem(0)] }, targetOfId),
    ];

    for (const result of results) {
      expect(typeof result).toBe('object');
      expect(Object.keys(result).sort()).toEqual(expectedKeys);
    }
  });

  test('isBuiltinGate reconhece só os 5 nomes embutidos', () => {
    expect(isBuiltinGate('chain-intact')).toBe(true);
    expect(isBuiltinGate('my-custom-gate')).toBe(false);
  });

  test('buildGateMilestoneData produz GateMilestoneData válido com origem embutido', () => {
    const state = cleanState();
    const result = evaluateBuiltin('chain-intact', state, targetOfId);
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

  test('listBuiltinGates() tem 5 itens, cada um com criterio não vazio', () => {
    const list = listBuiltinGates();
    expect(list).toHaveLength(5);
    for (const { criteria } of list) expect(criteria.length).toBeGreaterThan(0);
  });
  test.each([
    ['no-orphans', { milestone: 'p:r:milestone:0', target: TARGET }],
    ['no-conflicts', { target: TARGET, candidates: ['id1', 'id2'] }],
    ['chain-intact', { index: 0, reason: 'hash-mismatch' }],
    ['no-invalid-references', { citedBy: 'id0', reference: 'ref0', target: 'hex:target:of-id0' }],
    [
      'no-forks',
      {
        verdict: 'superseded0',
        successors: ['successor0a', 'successor0b'],
        target: 'hex:target:of-superseded0',
      },
    ],
  ] as const)(
    'gate %s: item de prova é referência por id e target, sem texto do Estado',
    (name, item) => {
      const scenario = SCENARIOS.find((candidate) => candidate.name === name);
      const state: State = { ...cleanState(), ...scenario?.overrides(1) };
      expect(evaluateBuiltin(name, state, targetOfId).evidence).toEqual([item]);
    },
  );

  test('no-conflicts e no-orphans não copiam claim nem dueAt', () => {
    const conflicts = evaluateBuiltin(
      'no-conflicts',
      { ...cleanState(), conflicts: [conflictItem(0)] },
      targetOfId,
    );
    const orphans = evaluateBuiltin(
      'no-orphans',
      { ...cleanState(), orphans: [orphanItem(0)] },
      targetOfId,
    );
    expect(conflicts.evidence[0]).not.toHaveProperty('claim');
    expect(orphans.evidence[0]).not.toHaveProperty('dueAt');
  });

  describe('fitBuiltinGateResult', () => {
    const fit = (state: State) =>
      fitBuiltinGateResult({
        name: 'no-conflicts',
        criteria: BUILTIN_GATES['no-conflicts'].criteria,
        target: TARGET,
        result: evaluateBuiltin('no-conflicts', state, targetOfId),
      });
    const bigConflict = (candidateChars: number, candidates: number): ConflictItem => ({
      target: TARGET,
      claim: 'a',
      candidates: Array.from({ length: candidates }, () => 'c'.repeat(candidateChars)),
    });

    test('prova que cabe no teto passa intacta', () => {
      const data = fit({ ...cleanState(), conflicts: [conflictItem(0)] });
      expect(data.gate.evidence).toHaveLength(1);
      expect(data.gate.totalEvidenceItems).toBe(1);
    });

    test('50 conflitos de 100 candidatos: corta pelo fim até caber, total real intacto', () => {
      const conflicts = Array.from({ length: 50 }, () => bigConflict(60, 100));
      const data = fit({ ...cleanState(), conflicts });

      expect(data.gate.evidence.length).toBeGreaterThan(0);
      expect(data.gate.evidence.length).toBeLessThan(50);
      expect(data.gate.totalEvidenceItems).toBe(50);
      expect(data.gate.passed).toBe(false);
      expect((canonicalize(data) ?? '').length).toBeLessThanOrEqual(BUILTIN_GATE_DATA_MAX_CHARS);
    });

    test('item único acima do teto: evidence vazia, totalEvidenceItems intacto e data cabe', () => {
      const data = fit({ ...cleanState(), conflicts: [bigConflict(228, 200)] });

      expect(data.gate.evidence).toEqual([]);
      expect(data.gate.totalEvidenceItems).toBe(1);
      expect((canonicalize(data) ?? '').length).toBeLessThanOrEqual(BUILTIN_GATE_DATA_MAX_CHARS);
    });
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
