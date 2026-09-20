import { describe, test, expect } from '@jest/globals';
import { GateMilestoneData } from '../src/events.ts';
import type { State } from '../src/state.ts';
import type { Chain, Break } from '../src/chain.ts';
import {
  BUILTIN_GATES,
  evaluateBuiltin,
  evaluateRule,
  isBuiltinGate,
  listBuiltinGates,
  buildGateMilestoneData,
  normalizeCustomEvidence,
  type BuiltinGateName,
  type EvaluationResult,
  type RuleGateSpec,
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
    forks: [],
    targets: [],
    blocked: [],
    released: [],
    phases: [],
    voteRounds: [],
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

// ---- mudança 1 (D1): fixtures de StatusEntry para evaluateRule ----

type ActiveEntry = State['active'][number];

// `claim` fixo e alheio a `result`: os testes de `evaluateRule` casam contra `result` (B3), então
// o fixture não pode reusar o mesmo valor para os dois campos ou o bug do bypass passaria despercebido.
const activeEntry = (target: string, result: string): ActiveEntry => ({
  target,
  claim: 'claim-livre',
  status: 'active',
  active: `${target}:verdict:winner`,
  result,
});

const conflictEntry = (target: string, result: string | null): ActiveEntry => ({
  target,
  claim: 'claim-livre',
  status: 'conflict',
  candidates: ['id1', 'id2'],
  result,
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

  test('isBuiltinGate reconhece só os 5 nomes embutidos', () => {
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

  test('listBuiltinGates() tem 5 itens, cada um com criterio não vazio', () => {
    const list = listBuiltinGates();
    expect(list).toHaveLength(5);
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

// ---- Mudança 1 (leva 4) — gate de regra: evaluateRule ----

describe('Mudança 1 (leva 4) — evaluateRule', () => {
  const spec = (overrides: Partial<RuleGateSpec> = {}): RuleGateSpec => ({
    targetPattern: 'hex:target:review-',
    requireVigente: true,
    acceptedResults: ['approved'],
    minCount: 2,
    ...overrides,
  });

  test('piso batido: 2 targets vigentes com result aceito e minCount 2 → passa, prova com os 2 targets', () => {
    const state: State = {
      ...cleanState(),
      active: [
        activeEntry('hex:target:review-a', 'approved'),
        activeEntry('hex:target:review-b', 'approved'),
      ],
    };
    const result = evaluateRule(spec(), state);

    expect(result.passed).toBe(true);
    expect(result.evidence).toEqual(['hex:target:review-a', 'hex:target:review-b']);
    expect(result.totalEvidenceItems).toBe(2);
    expect(result.evaluatedThrough).toBe(state.logThrough);
  });

  test('piso não batido: só 1 target vigente bate, minCount 2 → reprova', () => {
    const state: State = {
      ...cleanState(),
      active: [activeEntry('hex:target:review-a', 'approved')],
    };
    expect(evaluateRule(spec(), state).passed).toBe(false);
  });

  test('requireVigente: true ignora status conflict (não conta como vigente)', () => {
    const state: State = {
      ...cleanState(),
      active: [
        activeEntry('hex:target:review-a', 'approved'),
        conflictEntry('hex:target:review-b', 'approved'),
      ],
    };
    expect(evaluateRule(spec({ requireVigente: true }), state).passed).toBe(false);
  });

  test('requireVigente: false conta status conflict junto de active', () => {
    const state: State = {
      ...cleanState(),
      active: [
        activeEntry('hex:target:review-a', 'approved'),
        conflictEntry('hex:target:review-b', 'approved'),
      ],
    };
    const result = evaluateRule(spec({ requireVigente: false }), state);
    expect(result.passed).toBe(true);
    expect(result.evidence).toEqual(['hex:target:review-a', 'hex:target:review-b']);
  });

  test('acceptedResults vazio: nenhum result bate, minCount 0 passa mesmo sem candidatos', () => {
    const state: State = {
      ...cleanState(),
      active: [activeEntry('hex:target:review-a', 'approved')],
    };
    const result = evaluateRule(spec({ acceptedResults: [], minCount: 0 }), state);
    expect(result.passed).toBe(true);
    expect(result.evidence).toEqual([]);
  });

  test('targetPattern sem match: 0 candidatos, piso 0 passa, piso > 0 reprova', () => {
    const state: State = {
      ...cleanState(),
      active: [activeEntry('hex:target:other-a', 'approved')],
    };
    expect(evaluateRule(spec({ minCount: 0 }), state).passed).toBe(true);
    expect(evaluateRule(spec({ minCount: 1 }), state).passed).toBe(false);
  });

  test('result fora de acceptedResults não conta, mesmo dentro do targetPattern', () => {
    const state: State = {
      ...cleanState(),
      active: [activeEntry('hex:target:review-a', 'rejected')],
    };
    expect(evaluateRule(spec({ minCount: 0 }), state).passed).toBe(true);
    expect(evaluateRule(spec({ minCount: 1 }), state).passed).toBe(false);
  });

  // B3: `claim` batendo `acceptedResults` não deve contar — só `result` conta. Este é o bypass
  // que o fix fecha (antes, `evaluateRule` filtrava `entry.claim` em vez de `entry.result`).
  test('claim dentro de acceptedResults com result fora não conta (bypass do gate de regra)', () => {
    const state: State = {
      ...cleanState(),
      active: [
        {
          target: 'hex:target:review-a',
          claim: 'approved',
          status: 'active',
          active: 'v1',
          result: 'rejected',
        },
      ],
    };
    expect(evaluateRule(spec({ minCount: 0 }), state).passed).toBe(true);
    expect(evaluateRule(spec({ minCount: 1 }), state).passed).toBe(false);
  });

  test('conflict com result divergente entre candidatos (result: null) não conta', () => {
    const state: State = {
      ...cleanState(),
      active: [conflictEntry('hex:target:review-a', null)],
    };
    expect(evaluateRule(spec({ requireVigente: false, minCount: 0 }), state).passed).toBe(true);
    expect(evaluateRule(spec({ requireVigente: false, minCount: 1 }), state).passed).toBe(false);
  });

  test('60 matches: prova cortada em 50, totalEvidenceItems mantém o total real', () => {
    const state: State = {
      ...cleanState(),
      active: Array.from({ length: 60 }, (_, i) =>
        activeEntry(`hex:target:review-${i}`, 'approved'),
      ),
    };
    const result = evaluateRule(spec({ minCount: 0 }), state);
    expect(result.evidence).toHaveLength(50);
    expect(result.totalEvidenceItems).toBe(60);
  });
});
