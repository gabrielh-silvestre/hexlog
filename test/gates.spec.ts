import { describe, test, expect } from '@jest/globals';
import { GateMilestoneData } from '../src/events.ts';
import type { State } from '../src/state.ts';
import type { Chain, Quebra } from '../src/chain.ts';
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
import { BUILTIN_GATE_NAMES } from '../src/storage.ts';

// ---- fixtures locais ----

const T = (n: number) => new Date(n * 60_000).toISOString();
const TARGET = 'hex:target:u1';

function cadeiaLimpa(): Chain {
  return {
    ok: true,
    totalLinhas: 1,
    cabeca: '0'.repeat(64),
    quebras: [],
    totalQuebras: 0,
    linhasReparadas: [],
  };
}

function estadoLimpo(): State {
  return {
    logThrough: { id: `${TARGET}:0`, seq: 0, timestamp: T(0) },
    active: [],
    conflicts: [],
    orphans: [],
    toReview: [],
    invalidReferences: [],
    warnings: [],
    chain: cadeiaLimpa(),
  };
}

type ItemOrfao = State['orphans'][number];
type ItemConflito = State['conflicts'][number];
type ItemReferenciaInvalida = State['invalidReferences'][number];

const itemOrfao = (i: number): ItemOrfao => ({
  milestone: `p:r:milestone:${i}`,
  target: TARGET,
  dueAt: T(-1),
});
const itemConflito = (i: number): ItemConflito => ({
  target: TARGET,
  claim: `a${i}`,
  candidates: ['id1', 'id2'],
});
const itemQuebra = (i: number): Quebra => ({ indice: i, motivo: 'hash-nao-bate' });
const itemReferenciaInvalida = (i: number): ItemReferenciaInvalida => ({
  citedBy: `id${i}`,
  reference: `ref${i}`,
});

// Um cenário por gate embutido: como violar o estado e onde a violação aparece.
const CENARIOS: { nome: BuiltinGateName; overrides: (qtd: number) => Partial<State> }[] = [
  {
    nome: 'no-orphans',
    overrides: (qtd) => ({ orphans: Array.from({ length: qtd }, (_, i) => itemOrfao(i)) }),
  },
  {
    nome: 'no-conflicts',
    overrides: (qtd) => ({ conflicts: Array.from({ length: qtd }, (_, i) => itemConflito(i)) }),
  },
  {
    nome: 'chain-intact',
    overrides: (qtd) => ({
      chain: {
        ...cadeiaLimpa(),
        ok: false,
        quebras: Array.from({ length: qtd }, (_, i) => itemQuebra(i)),
        totalQuebras: qtd,
      },
    }),
  },
  {
    nome: 'no-invalid-references',
    overrides: (qtd) => ({
      invalidReferences: Array.from({ length: qtd }, (_, i) => itemReferenciaInvalida(i)),
    }),
  },
];

// ---- N5: gates embutidos ----

describe('N5 › gates embutidos', () => {
  test('GATES_EMBUTIDOS tem exatamente os 4 nomes de GATES_EMBUTIDOS_NOMES', () => {
    expect(Object.keys(BUILTIN_GATES).sort()).toEqual([...BUILTIN_GATE_NAMES].sort());
  });

  describe.each(CENARIOS)('gate $nome', ({ nome, overrides }) => {
    test('estado violando reprova, com a prova completa e o total real', () => {
      const estado: State = { ...estadoLimpo(), ...overrides(3) };
      const resultado = evaluateBuiltin(nome, estado);

      expect(resultado.passed).toBe(false);
      expect(resultado.totalEvidenceItems).toBe(3);
      expect(resultado.evidence).toHaveLength(3);
    });

    test('60 itens: prova cortada em 50, totalItensProva mantém o total real', () => {
      const estado: State = { ...estadoLimpo(), ...overrides(60) };
      const resultado = evaluateBuiltin(nome, estado);

      expect(resultado.evidence).toHaveLength(50);
      expect(resultado.totalEvidenceItems).toBe(60);
    });

    test('estado limpo passa com prova vazia e avaliadoAte = último elo', () => {
      const estado = estadoLimpo();
      expect(evaluateBuiltin(nome, estado)).toEqual({
        passed: true,
        evidence: [],
        totalEvidenceItems: 0,
        evaluatedThrough: estado.logThrough,
      });
    });
  });

  test('contrato: resultado nunca é boolean solto, sempre objeto com as 4 chaves', () => {
    const chavesEsperadas = ['evaluatedThrough', 'passed', 'evidence', 'totalEvidenceItems'].sort();
    const resultados: EvaluationResult[] = [
      evaluateBuiltin('no-orphans', estadoLimpo()),
      evaluateBuiltin('no-orphans', { ...estadoLimpo(), orphans: [itemOrfao(0)] }),
    ];

    for (const resultado of resultados) {
      expect(typeof resultado).toBe('object');
      expect(Object.keys(resultado).sort()).toEqual(chavesEsperadas);
    }
  });

  test('ehGateEmbutido reconhece só os 4 nomes embutidos', () => {
    expect(isBuiltinGate('chain-intact')).toBe(true);
    expect(isBuiltinGate('meu-gate-custom')).toBe(false);
  });

  test('montarDadosMarcoGate produz DadosMarcoGate válido com origem embutido', () => {
    const estado = estadoLimpo();
    const resultado = evaluateBuiltin('chain-intact', estado);
    const data = buildGateMilestoneData({
      name: 'chain-intact',
      origin: 'builtin',
      criteria: BUILTIN_GATES['chain-intact'].criteria,
      target: TARGET,
      result: resultado,
    });

    expect(() => GateMilestoneData.parse(data)).not.toThrow();
    expect(data.gate.origin).toBe('builtin');
  });

  test("normalizarProvaCustom('x') vira ['x']", () => {
    expect(normalizeCustomEvidence('x')).toEqual(['x']);
  });

  test('normalizarProvaCustom mantém o array quando já vem em lista', () => {
    expect(normalizeCustomEvidence(['a', 'b'])).toEqual(['a', 'b']);
  });

  test('listarGatesEmbutidos() tem 4 itens, cada um com criterio não vazio', () => {
    const lista = listBuiltinGates();
    expect(lista).toHaveLength(4);
    for (const { criteria } of lista) expect(criteria.length).toBeGreaterThan(0);
  });
});

// ---- N6 (nível de montarDadosMarcoGate; a tool avaliar_gate fica pro passo 7b) ----

describe('N6 › gate custom em montarDadosMarcoGate', () => {
  test('origem custom e criterio vindo de fora produzem DadosMarcoGate válido', () => {
    const resultado: EvaluationResult = {
      passed: false,
      evidence: ['evidência'],
      totalEvidenceItems: 1,
      evaluatedThrough: null,
    };
    const data = buildGateMilestoneData({
      name: 'meu-gate-custom',
      origin: 'custom',
      criteria: 'critério definido pelo usuário',
      target: TARGET,
      result: resultado,
    });

    expect(() => GateMilestoneData.parse(data)).not.toThrow();
    expect(data.gate).toMatchObject({
      name: 'meu-gate-custom',
      origin: 'custom',
      criteria: 'critério definido pelo usuário',
      passed: false,
      evidence: ['evidência'],
      totalEvidenceItems: 1,
      evaluatedThrough: null,
    });
  });
});
