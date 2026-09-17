import { describe, test, expect } from '@jest/globals';
import { DadosMarcoGate } from '../src/eventos.ts';
import type { Estado } from '../src/estado.ts';
import type { Cadeia, Quebra } from '../src/cadeia.ts';
import {
  GATES_EMBUTIDOS,
  avaliarEmbutido,
  ehGateEmbutido,
  listarGatesEmbutidos,
  montarDadosMarcoGate,
  normalizarProvaCustom,
  type NomeGateEmbutido,
  type ResultadoGate,
} from '../src/gates.ts';
import { GATES_EMBUTIDOS_NOMES } from '../src/dados.ts';

// ---- fixtures locais ----

const T = (n: number) => new Date(n * 60_000).toISOString();
const ALVO = 'hex:alvo:u1';

function cadeiaLimpa(): Cadeia {
  return {
    ok: true,
    totalLinhas: 1,
    cabeca: '0'.repeat(64),
    quebras: [],
    totalQuebras: 0,
    linhasReparadas: [],
  };
}

function estadoLimpo(): Estado {
  return {
    logAte: { id: `${ALVO}:0`, seq: 0, timestamp: T(0) },
    vigentes: [],
    conflitos: [],
    orfaos: [],
    aRevisar: [],
    referenciasInvalidas: [],
    avisos: [],
    cadeia: cadeiaLimpa(),
  };
}

type ItemOrfao = Estado['orfaos'][number];
type ItemConflito = Estado['conflitos'][number];
type ItemReferenciaInvalida = Estado['referenciasInvalidas'][number];

const itemOrfao = (i: number): ItemOrfao => ({
  marco: `p:r:marco:${i}`,
  alvo: ALVO,
  prazoExecucao: T(-1),
});
const itemConflito = (i: number): ItemConflito => ({
  destino: ALVO,
  afirmacao: `a${i}`,
  candidatos: ['id1', 'id2'],
});
const itemQuebra = (i: number): Quebra => ({ indice: i, motivo: 'hash-nao-bate' });
const itemReferenciaInvalida = (i: number): ItemReferenciaInvalida => ({
  citadaPor: `id${i}`,
  referencia: `ref${i}`,
});

// Um cenário por gate embutido: como violar o estado e onde a violação aparece.
const CENARIOS: { nome: NomeGateEmbutido; overrides: (qtd: number) => Partial<Estado> }[] = [
  {
    nome: 'sem-orfaos',
    overrides: (qtd) => ({ orfaos: Array.from({ length: qtd }, (_, i) => itemOrfao(i)) }),
  },
  {
    nome: 'sem-conflitos',
    overrides: (qtd) => ({ conflitos: Array.from({ length: qtd }, (_, i) => itemConflito(i)) }),
  },
  {
    nome: 'cadeia-integra',
    overrides: (qtd) => ({
      cadeia: {
        ...cadeiaLimpa(),
        ok: false,
        quebras: Array.from({ length: qtd }, (_, i) => itemQuebra(i)),
        totalQuebras: qtd,
      },
    }),
  },
  {
    nome: 'sem-referencias-invalidas',
    overrides: (qtd) => ({
      referenciasInvalidas: Array.from({ length: qtd }, (_, i) => itemReferenciaInvalida(i)),
    }),
  },
];

// ---- N5: gates embutidos ----

describe('N5 › gates embutidos', () => {
  test('GATES_EMBUTIDOS tem exatamente os 4 nomes de GATES_EMBUTIDOS_NOMES', () => {
    expect(Object.keys(GATES_EMBUTIDOS).sort()).toEqual([...GATES_EMBUTIDOS_NOMES].sort());
  });

  describe.each(CENARIOS)('gate $nome', ({ nome, overrides }) => {
    test('estado violando reprova, com a prova completa e o total real', () => {
      const estado: Estado = { ...estadoLimpo(), ...overrides(3) };
      const resultado = avaliarEmbutido(nome, estado);

      expect(resultado.passou).toBe(false);
      expect(resultado.totalItensProva).toBe(3);
      expect(resultado.prova).toHaveLength(3);
    });

    test('60 itens: prova cortada em 50, totalItensProva mantém o total real', () => {
      const estado: Estado = { ...estadoLimpo(), ...overrides(60) };
      const resultado = avaliarEmbutido(nome, estado);

      expect(resultado.prova).toHaveLength(50);
      expect(resultado.totalItensProva).toBe(60);
    });

    test('estado limpo passa com prova vazia e avaliadoAte = último elo', () => {
      const estado = estadoLimpo();
      expect(avaliarEmbutido(nome, estado)).toEqual({
        passou: true,
        prova: [],
        totalItensProva: 0,
        avaliadoAte: estado.logAte,
      });
    });
  });

  test('contrato: resultado nunca é boolean solto, sempre objeto com as 4 chaves', () => {
    const chavesEsperadas = ['avaliadoAte', 'passou', 'prova', 'totalItensProva'].sort();
    const resultados: ResultadoGate[] = [
      avaliarEmbutido('sem-orfaos', estadoLimpo()),
      avaliarEmbutido('sem-orfaos', { ...estadoLimpo(), orfaos: [itemOrfao(0)] }),
    ];

    for (const resultado of resultados) {
      expect(typeof resultado).toBe('object');
      expect(Object.keys(resultado).sort()).toEqual(chavesEsperadas);
    }
  });

  test('ehGateEmbutido reconhece só os 4 nomes embutidos', () => {
    expect(ehGateEmbutido('cadeia-integra')).toBe(true);
    expect(ehGateEmbutido('meu-gate-custom')).toBe(false);
  });

  test('montarDadosMarcoGate produz DadosMarcoGate válido com origem embutido', () => {
    const estado = estadoLimpo();
    const resultado = avaliarEmbutido('cadeia-integra', estado);
    const dados = montarDadosMarcoGate({
      nome: 'cadeia-integra',
      origem: 'embutido',
      criterio: GATES_EMBUTIDOS['cadeia-integra'].criterio,
      alvo: ALVO,
      resultado,
    });

    expect(() => DadosMarcoGate.parse(dados)).not.toThrow();
    expect(dados.gate.origem).toBe('embutido');
  });

  test("normalizarProvaCustom('x') vira ['x']", () => {
    expect(normalizarProvaCustom('x')).toEqual(['x']);
  });

  test('normalizarProvaCustom mantém o array quando já vem em lista', () => {
    expect(normalizarProvaCustom(['a', 'b'])).toEqual(['a', 'b']);
  });

  test('listarGatesEmbutidos() tem 4 itens, cada um com criterio não vazio', () => {
    const lista = listarGatesEmbutidos();
    expect(lista).toHaveLength(4);
    for (const { criterio } of lista) expect(criterio.length).toBeGreaterThan(0);
  });
});

// ---- N6 (nível de montarDadosMarcoGate; a tool avaliar_gate fica pro passo 7b) ----

describe('N6 › gate custom em montarDadosMarcoGate', () => {
  test('origem custom e criterio vindo de fora produzem DadosMarcoGate válido', () => {
    const resultado: ResultadoGate = {
      passou: false,
      prova: ['evidência'],
      totalItensProva: 1,
      avaliadoAte: null,
    };
    const dados = montarDadosMarcoGate({
      nome: 'meu-gate-custom',
      origem: 'custom',
      criterio: 'critério definido pelo usuário',
      alvo: ALVO,
      resultado,
    });

    expect(() => DadosMarcoGate.parse(dados)).not.toThrow();
    expect(dados.gate).toMatchObject({
      nome: 'meu-gate-custom',
      origem: 'custom',
      criterio: 'critério definido pelo usuário',
      passou: false,
      prova: ['evidência'],
      totalItensProva: 1,
      avaliadoAte: null,
    });
  });
});
