import { describe, expect, test } from '@jest/globals';
import { orderBy } from 'es-toolkit';
import {
  search,
  isCandidate,
  stripDiacritics,
  distinctTerms,
  indexableText,
  type Filters,
} from '../src/search.ts';
import type { ProcessManifest, Vocabulary } from '../src/definitions.ts';
import type { EventLine } from '../src/events.ts';
import { gerarCorpus } from './fixtures/corpus.ts';

const VOCABULARIO: Vocabulary = {
  core: {
    milestoneType: ['aprovado', 'rejeitado'],
    result: ['ok', 'falhou'],
    action: ['seguir', 'revisar'],
  },
  byOwner: {},
};

const MANIFESTO: ProcessManifest = {
  project: 'p1',
  process: 'proc1',
  createdAt: '2026-01-01T00:00:00.000Z',
  fixed: {
    types: {
      nota: { type: 'object', properties: { texto: { type: 'string' } }, required: ['texto'] },
    },
    vocabulary: VOCABULARIO,
    gates: {},
  },
  hashes: { schemas: '0'.repeat(64), vocabulario: '0'.repeat(64), gates: '0'.repeat(64) },
};

function linhaBase(overrides: Partial<EventLine>): EventLine {
  return {
    seq: 0,
    id: 'p1:proc1:milestone:00000000-0000-7000-8000-000000000001',
    type: 'milestone',
    timestamp: '2026-01-01T00:00:00.000Z',
    agent: 'agente-teste',
    prevHash: '0'.repeat(64),
    data: {},
    ...overrides,
  };
}

function linhaComTexto(frase: string): EventLine {
  return linhaBase({ type: 'nota', data: { texto: frase } });
}

function candidatosDe(linhas: EventLine[]): { index: number; line: EventLine }[] {
  return linhas.map((line, index) => ({ index, line }));
}

describe('textoIndexavel', () => {
  test('Marco: inclui marcoTipo, contagem.campo e decisoes[].item/acao/texto; exclui alvo e prazoExecucao', () => {
    const linha = linhaBase({
      data: {
        milestoneType: 'aprovado',
        target: 'hex:target:secreto',
        dueAt: '2026-02-01T00:00:00.000Z',
        count: { field: 'itens pendentes', value: 42 },
        decisions: [{ item: 'revisar contrato', action: 'seguir', text: 'aprovado apos analise' }],
      },
    });
    const texto = indexableText(linha);
    for (const parte of [
      'aprovado',
      'itens pendentes',
      'revisar contrato',
      'seguir',
      'aprovado apos analise',
    ]) {
      expect(texto).toContain(parte);
    }
    expect(texto).not.toContain('hex:target:secreto');
    expect(texto).not.toContain('2026-02-01');
    expect(texto).not.toContain('42');
  });

  test('Marco de gate: inclui gate.nome/criterio e itens string de gate.prova; exclui alvo e itens estruturados', () => {
    const linha = linhaBase({
      data: {
        milestoneType: 'gate',
        target: 'hex:target:secreto',
        gate: {
          name: 'gate-custom',
          origin: 'custom',
          criteria: 'critério textual do gate',
          passed: true,
          evidence: ['evidência em texto', { estruturado: true }],
          totalEvidenceItems: 2,
          evaluatedThrough: {
            id: 'p1:proc1:milestone:x',
            seq: 3,
            timestamp: '2026-01-01T00:00:00.000Z',
          },
        },
      },
    });
    const texto = indexableText(linha);
    expect(texto).toContain('gate-custom');
    expect(texto).toContain('critério textual do gate');
    expect(texto).toContain('evidência em texto');
    expect(texto).not.toContain('hex:target:secreto');
    expect(texto).not.toContain('estruturado');
  });

  test('Veredito: inclui afirmacao/fonte/resultado/prova/origem/rastro; exclui destino e supera', () => {
    const linha = linhaBase({
      type: 'verdict',
      data: {
        claim: 'afirmação textual',
        source: 'fonte textual',
        result: 'ok',
        evidence: ['prova um', 'prova dois'],
        target: 'hex:target:secreto',
        supersedes: ['p1:proc1:verdict:00000000-0000-7000-8000-000000000000'],
        origin: 'origem textual',
        trace: 'rastro textual',
      },
    });
    const texto = indexableText(linha);
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
    expect(texto).not.toContain('hex:target:secreto');
    expect(texto).not.toContain('00000000-0000-7000-8000-000000000000');
  });

  test('custom: inclui toda string em qualquer profundidade, exceto hex: e ids completos', () => {
    const linha = linhaBase({
      type: 'nota',
      data: {
        texto: 'nota em texto livre',
        numero: 42,
        ok: true,
        detalhe: { sub: 'valor aninhado' },
        lista: [
          'item um',
          'hex:target:secreto',
          'p1:proc1:milestone:00000000-0000-7000-8000-000000000000',
        ],
      },
    });
    const texto = indexableText(linha);
    expect(texto).toContain('nota em texto livre');
    expect(texto).toContain('valor aninhado');
    expect(texto).toContain('item um');
    expect(texto).not.toContain('hex:target:secreto');
    expect(texto).not.toContain('00000000-0000-7000-8000-000000000000');
    expect(texto).not.toContain('42');
  });

  test('envelope: id, prevHash, timestamp e agente nunca entram no índice', () => {
    const linha = linhaBase({
      type: 'verdict',
      data: {
        claim: 'x',
        source: 'y',
        result: 'ok',
        evidence: 'z',
        target: 'hex:target:a',
        origin: 'o',
        trace: 'r',
      },
    });
    const texto = indexableText(linha);
    expect(texto).not.toContain(linha.id);
    expect(texto).not.toContain(linha.prevHash);
    expect(texto).not.toContain(linha.timestamp);
    expect(texto).not.toContain(linha.agent);
  });
});

describe('semAcento', () => {
  test('remove acentos e normaliza para minúsculas', () => {
    expect(stripDiacritics('AUTENTICAÇÃO')).toBe('autenticacao');
    expect(stripDiacritics('inválido')).toBe('invalido');
  });
});

describe('ehCandidato', () => {
  test('alvo: igualdade exata, "login" não casa "login-1"', () => {
    const login = linhaBase({ data: { milestoneType: 'aprovado', target: 'hex:target:login' } });
    const loginUm = linhaBase({
      data: { milestoneType: 'aprovado', target: 'hex:target:login-1' },
    });
    expect(isCandidate(login, { target: 'hex:target:login' })).toBe(true);
    expect(isCandidate(loginUm, { target: 'hex:target:login' })).toBe(false);
  });

  test('alvo casa tanto data.target (Marco) quanto data.target (Veredito)', () => {
    const veredito = linhaBase({
      type: 'verdict',
      data: {
        claim: 'a',
        source: 'f',
        result: 'ok',
        evidence: 'p',
        target: 'hex:target:x',
        origin: 'o',
        trace: 'r',
      },
    });
    expect(isCandidate(veredito, { target: 'hex:target:x' })).toBe(true);
  });

  test('resultado: igualdade exata sem validação de vocabulário, só em Veredito', () => {
    const veredito = linhaBase({
      type: 'verdict',
      data: {
        claim: 'a',
        source: 'f',
        result: 'fora-do-vocabulario',
        evidence: 'p',
        target: 'hex:target:x',
        origin: 'o',
        trace: 'r',
      },
    });
    expect(isCandidate(veredito, { result: 'fora-do-vocabulario' })).toBe(true);
    const marco = linhaBase({ data: { milestoneType: 'aprovado', target: 'hex:target:x' } });
    expect(isCandidate(marco, { result: 'fora-do-vocabulario' })).toBe(false);
  });

  test('marcoTipo: só casa em Marco', () => {
    const marco = linhaBase({ data: { milestoneType: 'aprovado', target: 'hex:target:x' } });
    expect(isCandidate(marco, { milestoneType: 'aprovado' })).toBe(true);
    expect(isCandidate(marco, { milestoneType: 'rejeitado' })).toBe(false);
  });

  test('intervalo [apos, antes)', () => {
    const linha = linhaBase({
      timestamp: '2026-01-05T00:00:00.000Z',
      data: { milestoneType: 'aprovado', target: 'hex:target:x' },
    });
    expect(isCandidate(linha, { after: '2026-01-05T00:00:00.000Z' })).toBe(true);
    expect(isCandidate(linha, { after: '2026-01-05T00:00:00.001Z' })).toBe(false);
    expect(isCandidate(linha, { before: '2026-01-05T00:00:00.000Z' })).toBe(false);
    expect(isCandidate(linha, { before: '2026-01-05T00:00:00.001Z' })).toBe(true);
  });
});

describe('buscar: ordenação, desempate e fallback OR', () => {
  test('relevância decrescente, empate por índice físico crescente', () => {
    const candidatos = [
      { index: 5, line: linhaComTexto('alfa') },
      { index: 2, line: linhaComTexto('alfa') },
      { index: 9, line: linhaComTexto('alfa beta') },
    ];
    const { results } = search(candidatos, 'alfa');
    expect(results).toEqual(orderBy(results, ['relevance', 'index'], ['desc', 'asc']));
    const indices = results.map((r) => r.index);
    expect(indices.indexOf(2)).toBeLessThan(indices.indexOf(5));
  });

  test('AND vazio com 2+ termos distintos cai para OR', () => {
    const candidatos = [
      { index: 0, line: linhaComTexto('alfa') },
      { index: 1, line: linhaComTexto('beta') },
    ];
    const { results, combination } = search(candidatos, 'alfa gama');
    expect(combination).toBe('OR');
    expect(results.map((r) => r.index)).toEqual([0]);
  });

  test('termo único sem resultado continua AND', () => {
    const candidatos = [{ index: 0, line: linhaComTexto('alfa') }];
    const { results, combination } = search(candidatos, 'zzz');
    expect(results).toEqual([]);
    expect(combination).toBe('AND');
  });

  test('termosDistintos conta termos únicos após processTerm (acento e maiúsculas)', () => {
    expect(distinctTerms('Café café CAFÉ')).toBe(1);
    expect(distinctTerms('cache invalidação')).toBe(2);
  });
});

describe('M11', () => {
  const corpus = gerarCorpus({ tamanho: 300, manifesto: MANIFESTO, vocabulario: VOCABULARIO });
  const candidatos = candidatosDe(corpus.linhas);

  test('a) acento: "autenticacao" e "autenticação" retornam o mesmo conjunto e a mesma ordem', () => {
    const semAc = search(candidatos, 'autenticacao');
    const comAc = search(candidatos, 'autenticação');
    expect(comAc).toEqual(semAc);
  });

  test('b) erro de digitação: recall 1,0 sobre o gabarito de "autenticação"', () => {
    const gabarito = corpus.gabarito('autenticação');
    const { results } = search(candidatos, 'atenticação');
    const encontrados = new Set(results.map((r) => r.index));
    for (const indice of gabarito) expect(encontrados.has(indice)).toBe(true);
  });

  test('c) AND: "cache invalidação" só retorna quem tem as duas palavras, precisão 1,0', () => {
    const gabaritoCache = new Set(corpus.gabarito('cache'));
    const gabaritoInvalidacao = new Set(corpus.gabarito('invalidação'));
    const esperado = [...gabaritoCache].filter((indice) => gabaritoInvalidacao.has(indice));
    const { results, combination } = search(candidatos, 'cache invalidação');
    expect(combination).toBe('AND');
    expect(new Set(results.map((r) => r.index))).toEqual(new Set(esperado));
  });

  test('d) inexistente: "zzqxwv" → vazio', () => {
    const { results, combination } = search(candidatos, 'zzqxwv');
    expect(results).toEqual([]);
    expect(combination).toBe('AND');
  });

  test('e) determinismo: 5 chamadas idênticas devolvem o mesmo resultado', () => {
    const chamadas = Array.from({ length: 5 }, () => search(candidatos, 'cache'));
    for (const chamada of chamadas) expect(chamada).toEqual(chamadas[0]);
  });

  test('f) relevância não crescente, empate por índice físico crescente', () => {
    const { results } = search(candidatos, 'webhook');
    expect(results.length).toBeGreaterThan(0);
    expect(results).toEqual(orderBy(results, ['relevance', 'index'], ['desc', 'asc']));
  });

  test('i) linguagem natural: "problema com o webhook" cai para OR e acha os eventos de webhook', () => {
    const gabaritoWebhook = corpus.gabarito('webhook');
    const { results, combination } = search(candidatos, 'problema com o webhook');
    expect(combination).toBe('OR');
    expect(results.length).toBeGreaterThan(0);
    const encontrados = new Set(results.map((r) => r.index));
    for (const indice of gabaritoWebhook) expect(encontrados.has(indice)).toBe(true);
  });
});

describe('M12', () => {
  test('a) alvo exato nunca casa "login-1..6", inclusive combinado com busca "login"', () => {
    const corpus = gerarCorpus({ tamanho: 300, manifesto: MANIFESTO, vocabulario: VOCABULARIO });
    const filtros: Filters = { target: 'hex:target:login' };
    const candidatosFiltrados = candidatosDe(corpus.linhas).filter(({ line }) =>
      isCandidate(line, filtros),
    );
    expect(
      candidatosFiltrados.every(({ line }) => {
        const data = line.data as { target?: string };
        return data.target === 'hex:target:login';
      }),
    ).toBe(true);

    const { results } = search(candidatosFiltrados, 'login');
    expect(results.length).toBeGreaterThan(0);
  });

  test('c) apos/antes: só timestamp em [apos, antes)', () => {
    const corpus = gerarCorpus({ tamanho: 50, manifesto: MANIFESTO, vocabulario: VOCABULARIO });
    const filtros: Filters = {
      after: corpus.linhas[10].timestamp,
      before: corpus.linhas[20].timestamp,
    };
    const indices = candidatosDe(corpus.linhas)
      .filter(({ line }) => isCandidate(line, filtros))
      .map(({ index }) => index)
      .sort((a, b) => a - b);
    expect(indices).toEqual(Array.from({ length: 10 }, (_, i) => 10 + i));
  });

  test('d) busca + alvo + tipo: interseção', () => {
    const corpus = gerarCorpus({ tamanho: 300, manifesto: MANIFESTO, vocabulario: VOCABULARIO });
    const filtros: Filters = { type: 'verdict', target: 'hex:target:login' };
    const candidatosFiltrados = candidatosDe(corpus.linhas).filter(({ line }) =>
      isCandidate(line, filtros),
    );
    const { results } = search(candidatosFiltrados, 'login');
    expect(results.length).toBeGreaterThan(0);
    for (const resultado of results) {
      const linha = corpus.linhas[resultado.index];
      expect(linha.type).toBe('verdict');
      expect((linha.data as { target: string }).target).toBe('hex:target:login');
    }
  });
});
