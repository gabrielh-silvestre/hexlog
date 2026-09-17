import { describe, expect, test } from '@jest/globals';
import { orderBy } from 'es-toolkit';
import {
  buscar,
  ehCandidato,
  semAcento,
  termosDistintos,
  textoIndexavel,
  type Filtros,
} from '../src/busca.ts';
import type { Manifesto, Vocabulario } from '../src/definicoes.ts';
import type { Linha } from '../src/eventos.ts';
import { gerarCorpus } from './fixtures/corpus.ts';

const VOCABULARIO: Vocabulario = {
  nucleo: {
    marcoTipo: ['aprovado', 'rejeitado'],
    resultado: ['ok', 'falhou'],
    acao: ['seguir', 'revisar'],
  },
  porDono: {},
};

const MANIFESTO: Manifesto = {
  projeto: 'p1',
  processo: 'proc1',
  criadoEm: '2026-01-01T00:00:00.000Z',
  fixado: {
    tipos: {
      nota: { type: 'object', properties: { texto: { type: 'string' } }, required: ['texto'] },
    },
    vocabulario: VOCABULARIO,
    gates: {},
  },
  hashes: { schemas: '0'.repeat(64), vocabulario: '0'.repeat(64), gates: '0'.repeat(64) },
};

function linhaBase(overrides: Partial<Linha>): Linha {
  return {
    seq: 0,
    id: 'p1:proc1:marco:00000000-0000-7000-8000-000000000001',
    tipo: 'marco',
    timestamp: '2026-01-01T00:00:00.000Z',
    agente: 'agente-teste',
    prevHash: '0'.repeat(64),
    dados: {},
    ...overrides,
  };
}

function linhaComTexto(frase: string): Linha {
  return linhaBase({ tipo: 'nota', dados: { texto: frase } });
}

function candidatosDe(linhas: Linha[]): { indice: number; linha: Linha }[] {
  return linhas.map((linha, indice) => ({ indice, linha }));
}

describe('textoIndexavel', () => {
  test('Marco: inclui marcoTipo, contagem.campo e decisoes[].item/acao/texto; exclui alvo e prazoExecucao', () => {
    const linha = linhaBase({
      dados: {
        marcoTipo: 'aprovado',
        alvo: 'hex:alvo:secreto',
        prazoExecucao: '2026-02-01T00:00:00.000Z',
        contagem: { campo: 'itens pendentes', valor: 42 },
        decisoes: [{ item: 'revisar contrato', acao: 'seguir', texto: 'aprovado apos analise' }],
      },
    });
    const texto = textoIndexavel(linha);
    for (const parte of [
      'aprovado',
      'itens pendentes',
      'revisar contrato',
      'seguir',
      'aprovado apos analise',
    ]) {
      expect(texto).toContain(parte);
    }
    expect(texto).not.toContain('hex:alvo:secreto');
    expect(texto).not.toContain('2026-02-01');
    expect(texto).not.toContain('42');
  });

  test('Marco de gate: inclui gate.nome/criterio e itens string de gate.prova; exclui alvo e itens estruturados', () => {
    const linha = linhaBase({
      dados: {
        marcoTipo: 'gate',
        alvo: 'hex:alvo:secreto',
        gate: {
          nome: 'gate-custom',
          origem: 'custom',
          criterio: 'critério textual do gate',
          passou: true,
          prova: ['evidência em texto', { estruturado: true }],
          totalItensProva: 2,
          avaliadoAte: { id: 'p1:proc1:marco:x', seq: 3, timestamp: '2026-01-01T00:00:00.000Z' },
        },
      },
    });
    const texto = textoIndexavel(linha);
    expect(texto).toContain('gate-custom');
    expect(texto).toContain('critério textual do gate');
    expect(texto).toContain('evidência em texto');
    expect(texto).not.toContain('hex:alvo:secreto');
    expect(texto).not.toContain('estruturado');
  });

  test('Veredito: inclui afirmacao/fonte/resultado/prova/origem/rastro; exclui destino e supera', () => {
    const linha = linhaBase({
      tipo: 'veredito',
      dados: {
        afirmacao: 'afirmação textual',
        fonte: 'fonte textual',
        resultado: 'ok',
        prova: ['prova um', 'prova dois'],
        destino: 'hex:alvo:secreto',
        supera: ['p1:proc1:veredito:00000000-0000-7000-8000-000000000000'],
        origem: 'origem textual',
        rastro: 'rastro textual',
      },
    });
    const texto = textoIndexavel(linha);
    for (const parte of [
      'afirmação textual',
      'fonte textual',
      'ok',
      'prova um',
      'prova dois',
      'origem textual',
      'rastro textual',
    ]) {
      expect(texto).toContain(parte);
    }
    expect(texto).not.toContain('hex:alvo:secreto');
    expect(texto).not.toContain('00000000-0000-7000-8000-000000000000');
  });

  test('custom: inclui toda string em qualquer profundidade, exceto hex: e ids completos', () => {
    const linha = linhaBase({
      tipo: 'nota',
      dados: {
        texto: 'nota em texto livre',
        numero: 42,
        ok: true,
        detalhe: { sub: 'valor aninhado' },
        lista: [
          'item um',
          'hex:alvo:secreto',
          'p1:proc1:marco:00000000-0000-7000-8000-000000000000',
        ],
      },
    });
    const texto = textoIndexavel(linha);
    expect(texto).toContain('nota em texto livre');
    expect(texto).toContain('valor aninhado');
    expect(texto).toContain('item um');
    expect(texto).not.toContain('hex:alvo:secreto');
    expect(texto).not.toContain('00000000-0000-7000-8000-000000000000');
    expect(texto).not.toContain('42');
  });

  test('envelope: id, prevHash, timestamp e agente nunca entram no índice', () => {
    const linha = linhaBase({
      tipo: 'veredito',
      dados: {
        afirmacao: 'x',
        fonte: 'y',
        resultado: 'ok',
        prova: 'z',
        destino: 'hex:alvo:a',
        origem: 'o',
        rastro: 'r',
      },
    });
    const texto = textoIndexavel(linha);
    expect(texto).not.toContain(linha.id);
    expect(texto).not.toContain(linha.prevHash);
    expect(texto).not.toContain(linha.timestamp);
    expect(texto).not.toContain(linha.agente);
  });
});

describe('semAcento', () => {
  test('remove acentos e normaliza para minúsculas', () => {
    expect(semAcento('AUTENTICAÇÃO')).toBe('autenticacao');
    expect(semAcento('inválido')).toBe('invalido');
  });
});

describe('ehCandidato', () => {
  test('alvo: igualdade exata, "login" não casa "login-1"', () => {
    const login = linhaBase({ dados: { marcoTipo: 'aprovado', alvo: 'hex:alvo:login' } });
    const loginUm = linhaBase({ dados: { marcoTipo: 'aprovado', alvo: 'hex:alvo:login-1' } });
    expect(ehCandidato(login, { alvo: 'hex:alvo:login' })).toBe(true);
    expect(ehCandidato(loginUm, { alvo: 'hex:alvo:login' })).toBe(false);
  });

  test('alvo casa tanto dados.alvo (Marco) quanto dados.destino (Veredito)', () => {
    const veredito = linhaBase({
      tipo: 'veredito',
      dados: {
        afirmacao: 'a',
        fonte: 'f',
        resultado: 'ok',
        prova: 'p',
        destino: 'hex:alvo:x',
        origem: 'o',
        rastro: 'r',
      },
    });
    expect(ehCandidato(veredito, { alvo: 'hex:alvo:x' })).toBe(true);
  });

  test('resultado: igualdade exata sem validação de vocabulário, só em Veredito', () => {
    const veredito = linhaBase({
      tipo: 'veredito',
      dados: {
        afirmacao: 'a',
        fonte: 'f',
        resultado: 'fora-do-vocabulario',
        prova: 'p',
        destino: 'hex:alvo:x',
        origem: 'o',
        rastro: 'r',
      },
    });
    expect(ehCandidato(veredito, { resultado: 'fora-do-vocabulario' })).toBe(true);
    const marco = linhaBase({ dados: { marcoTipo: 'aprovado', alvo: 'hex:alvo:x' } });
    expect(ehCandidato(marco, { resultado: 'fora-do-vocabulario' })).toBe(false);
  });

  test('marcoTipo: só casa em Marco', () => {
    const marco = linhaBase({ dados: { marcoTipo: 'aprovado', alvo: 'hex:alvo:x' } });
    expect(ehCandidato(marco, { marcoTipo: 'aprovado' })).toBe(true);
    expect(ehCandidato(marco, { marcoTipo: 'rejeitado' })).toBe(false);
  });

  test('intervalo [apos, antes)', () => {
    const linha = linhaBase({
      timestamp: '2026-01-05T00:00:00.000Z',
      dados: { marcoTipo: 'aprovado', alvo: 'hex:alvo:x' },
    });
    expect(ehCandidato(linha, { apos: '2026-01-05T00:00:00.000Z' })).toBe(true);
    expect(ehCandidato(linha, { apos: '2026-01-05T00:00:00.001Z' })).toBe(false);
    expect(ehCandidato(linha, { antes: '2026-01-05T00:00:00.000Z' })).toBe(false);
    expect(ehCandidato(linha, { antes: '2026-01-05T00:00:00.001Z' })).toBe(true);
  });
});

describe('buscar: ordenação, desempate e fallback OR', () => {
  test('relevância decrescente, empate por índice físico crescente', () => {
    const candidatos = [
      { indice: 5, linha: linhaComTexto('alfa') },
      { indice: 2, linha: linhaComTexto('alfa') },
      { indice: 9, linha: linhaComTexto('alfa beta') },
    ];
    const { resultados } = buscar(candidatos, 'alfa');
    expect(resultados).toEqual(orderBy(resultados, ['relevancia', 'indice'], ['desc', 'asc']));
    const indices = resultados.map((r) => r.indice);
    expect(indices.indexOf(2)).toBeLessThan(indices.indexOf(5));
  });

  test('AND vazio com 2+ termos distintos cai para OR', () => {
    const candidatos = [
      { indice: 0, linha: linhaComTexto('alfa') },
      { indice: 1, linha: linhaComTexto('beta') },
    ];
    const { resultados, combinacao } = buscar(candidatos, 'alfa gama');
    expect(combinacao).toBe('OR');
    expect(resultados.map((r) => r.indice)).toEqual([0]);
  });

  test('termo único sem resultado continua AND', () => {
    const candidatos = [{ indice: 0, linha: linhaComTexto('alfa') }];
    const { resultados, combinacao } = buscar(candidatos, 'zzz');
    expect(resultados).toEqual([]);
    expect(combinacao).toBe('AND');
  });

  test('termosDistintos conta termos únicos após processTerm (acento e maiúsculas)', () => {
    expect(termosDistintos('Café café CAFÉ')).toBe(1);
    expect(termosDistintos('cache invalidação')).toBe(2);
  });
});

describe('M11', () => {
  const corpus = gerarCorpus({ tamanho: 300, manifesto: MANIFESTO, vocabulario: VOCABULARIO });
  const candidatos = candidatosDe(corpus.linhas);

  test('a) acento: "autenticacao" e "autenticação" retornam o mesmo conjunto e a mesma ordem', () => {
    const semAc = buscar(candidatos, 'autenticacao');
    const comAc = buscar(candidatos, 'autenticação');
    expect(comAc).toEqual(semAc);
  });

  test('b) erro de digitação: recall 1,0 sobre o gabarito de "autenticação"', () => {
    const gabarito = corpus.gabarito('autenticação');
    const { resultados } = buscar(candidatos, 'atenticação');
    const encontrados = new Set(resultados.map((r) => r.indice));
    for (const indice of gabarito) expect(encontrados.has(indice)).toBe(true);
  });

  test('c) AND: "cache invalidação" só retorna quem tem as duas palavras, precisão 1,0', () => {
    const gabaritoCache = new Set(corpus.gabarito('cache'));
    const gabaritoInvalidacao = new Set(corpus.gabarito('invalidação'));
    const esperado = [...gabaritoCache].filter((indice) => gabaritoInvalidacao.has(indice));
    const { resultados, combinacao } = buscar(candidatos, 'cache invalidação');
    expect(combinacao).toBe('AND');
    expect(new Set(resultados.map((r) => r.indice))).toEqual(new Set(esperado));
  });

  test('d) inexistente: "zzqxwv" → vazio', () => {
    const { resultados, combinacao } = buscar(candidatos, 'zzqxwv');
    expect(resultados).toEqual([]);
    expect(combinacao).toBe('AND');
  });

  test('e) determinismo: 5 chamadas idênticas devolvem o mesmo resultado', () => {
    const chamadas = Array.from({ length: 5 }, () => buscar(candidatos, 'cache'));
    for (const chamada of chamadas) expect(chamada).toEqual(chamadas[0]);
  });

  test('f) relevância não crescente, empate por índice físico crescente', () => {
    const { resultados } = buscar(candidatos, 'webhook');
    expect(resultados.length).toBeGreaterThan(0);
    expect(resultados).toEqual(orderBy(resultados, ['relevancia', 'indice'], ['desc', 'asc']));
  });

  test('i) linguagem natural: "problema com o webhook" cai para OR e acha os eventos de webhook', () => {
    const gabaritoWebhook = corpus.gabarito('webhook');
    const { resultados, combinacao } = buscar(candidatos, 'problema com o webhook');
    expect(combinacao).toBe('OR');
    expect(resultados.length).toBeGreaterThan(0);
    const encontrados = new Set(resultados.map((r) => r.indice));
    for (const indice of gabaritoWebhook) expect(encontrados.has(indice)).toBe(true);
  });
});

describe('M12', () => {
  test('a) alvo exato nunca casa "login-1..6", inclusive combinado com busca "login"', () => {
    const corpus = gerarCorpus({ tamanho: 300, manifesto: MANIFESTO, vocabulario: VOCABULARIO });
    const filtros: Filtros = { alvo: 'hex:alvo:login' };
    const candidatosFiltrados = candidatosDe(corpus.linhas).filter(({ linha }) =>
      ehCandidato(linha, filtros),
    );
    expect(
      candidatosFiltrados.every(({ linha }) => {
        const dados = linha.dados as { alvo?: string; destino?: string };
        return dados.alvo === 'hex:alvo:login' || dados.destino === 'hex:alvo:login';
      }),
    ).toBe(true);

    const { resultados } = buscar(candidatosFiltrados, 'login');
    expect(resultados.length).toBeGreaterThan(0);
  });

  test('c) apos/antes: só timestamp em [apos, antes)', () => {
    const corpus = gerarCorpus({ tamanho: 50, manifesto: MANIFESTO, vocabulario: VOCABULARIO });
    const filtros: Filtros = {
      apos: corpus.linhas[10].timestamp,
      antes: corpus.linhas[20].timestamp,
    };
    const indices = candidatosDe(corpus.linhas)
      .filter(({ linha }) => ehCandidato(linha, filtros))
      .map(({ indice }) => indice)
      .sort((a, b) => a - b);
    expect(indices).toEqual(Array.from({ length: 10 }, (_, i) => 10 + i));
  });

  test('d) busca + alvo + tipo: interseção', () => {
    const corpus = gerarCorpus({ tamanho: 300, manifesto: MANIFESTO, vocabulario: VOCABULARIO });
    const filtros: Filtros = { tipo: 'veredito', alvo: 'hex:alvo:login' };
    const candidatosFiltrados = candidatosDe(corpus.linhas).filter(({ linha }) =>
      ehCandidato(linha, filtros),
    );
    const { resultados } = buscar(candidatosFiltrados, 'login');
    expect(resultados.length).toBeGreaterThan(0);
    for (const resultado of resultados) {
      const linha = corpus.linhas[resultado.indice];
      expect(linha.tipo).toBe('veredito');
      expect((linha.dados as { destino: string }).destino).toBe('hex:alvo:login');
    }
  });
});
