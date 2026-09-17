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
import { generateCorpus } from './fixtures/corpus.ts';

const VOCABULARY: Vocabulary = {
  core: {
    milestoneType: ['approved', 'rejected'],
    result: ['ok', 'failed'],
    action: ['proceed', 'review'],
  },
  byOwner: {},
};

const MANIFEST: ProcessManifest = {
  project: 'p1',
  process: 'proc1',
  createdAt: '2026-01-01T00:00:00.000Z',
  fixed: {
    types: {
      note: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] },
    },
    vocabulary: VOCABULARY,
    gates: {},
  },
  hashes: { schemas: '0'.repeat(64), vocabulary: '0'.repeat(64), gates: '0'.repeat(64) },
};

function baseLine(overrides: Partial<EventLine>): EventLine {
  return {
    seq: 0,
    id: 'p1:proc1:milestone:00000000-0000-7000-8000-000000000001',
    type: 'milestone',
    timestamp: '2026-01-01T00:00:00.000Z',
    agent: 'test-agent',
    prevHash: '0'.repeat(64),
    data: {},
    ...overrides,
  };
}

function lineWithText(text: string): EventLine {
  return baseLine({ type: 'note', data: { text } });
}

function candidatesFrom(lines: EventLine[]): { index: number; line: EventLine }[] {
  return lines.map((line, index) => ({ index, line }));
}

describe('indexableText', () => {
  test('Milestone: inclui milestoneType, count.field e decisions[].item/action/text; exclui target e dueAt', () => {
    const line = baseLine({
      data: {
        milestoneType: 'approved',
        target: 'hex:target:secret',
        dueAt: '2026-02-01T00:00:00.000Z',
        count: { field: 'pending items', value: 42 },
        decisions: [{ item: 'review contract', action: 'proceed', text: 'approved after review' }],
      },
    });
    const text = indexableText(line);
    for (const part of [
      'approved',
      'pending items',
      'review contract',
      'proceed',
      'approved after review',
    ]) {
      expect(text).toContain(part);
    }
    expect(text).not.toContain('hex:target:secret');
    expect(text).not.toContain('2026-02-01');
    expect(text).not.toContain('42');
  });

  test('Milestone de gate: inclui gate.name/criteria e itens string de gate.evidence; exclui target e itens estruturados', () => {
    const line = baseLine({
      data: {
        milestoneType: 'gate',
        target: 'hex:target:secret',
        gate: {
          name: 'gate-custom',
          origin: 'custom',
          criteria: 'gate criteria text',
          passed: true,
          evidence: ['evidence in text', { structured: true }],
          totalEvidenceItems: 2,
          evaluatedThrough: {
            id: 'p1:proc1:milestone:x',
            seq: 3,
            timestamp: '2026-01-01T00:00:00.000Z',
          },
        },
      },
    });
    const text = indexableText(line);
    expect(text).toContain('gate-custom');
    expect(text).toContain('gate criteria text');
    expect(text).toContain('evidence in text');
    expect(text).not.toContain('hex:target:secret');
    expect(text).not.toContain('structured');
  });

  test('Verdict: inclui claim/source/result/evidence/origin/trace; exclui target e supersedes', () => {
    const line = baseLine({
      type: 'verdict',
      data: {
        claim: 'claim text',
        source: 'source text',
        result: 'ok',
        evidence: ['evidence one', 'evidence two'],
        target: 'hex:target:secret',
        supersedes: ['p1:proc1:verdict:00000000-0000-7000-8000-000000000000'],
        origin: 'origin text',
        trace: 'trace text',
      },
    });
    const text = indexableText(line);
    for (const part of [
      'claim text',
      'source text',
      'ok',
      'evidence one',
      'evidence two',
      'origin text',
      'trace text',
    ]) {
      expect(text).toContain(part);
    }
    expect(text).not.toContain('hex:target:secret');
    expect(text).not.toContain('00000000-0000-7000-8000-000000000000');
  });

  test('custom: inclui toda string em qualquer profundidade, exceto hex: e ids completos', () => {
    const line = baseLine({
      type: 'note',
      data: {
        text: 'free text note',
        number: 42,
        ok: true,
        detail: { sub: 'nested value' },
        list: [
          'item one',
          'hex:target:secret',
          'p1:proc1:milestone:00000000-0000-7000-8000-000000000000',
        ],
      },
    });
    const text = indexableText(line);
    expect(text).toContain('free text note');
    expect(text).toContain('nested value');
    expect(text).toContain('item one');
    expect(text).not.toContain('hex:target:secret');
    expect(text).not.toContain('00000000-0000-7000-8000-000000000000');
    expect(text).not.toContain('42');
  });

  test('envelope: id, prevHash, timestamp e agente nunca entram no índice', () => {
    const line = baseLine({
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
    const text = indexableText(line);
    expect(text).not.toContain(line.id);
    expect(text).not.toContain(line.prevHash);
    expect(text).not.toContain(line.timestamp);
    expect(text).not.toContain(line.agent);
  });
});

describe('stripDiacritics', () => {
  test('remove acentos e normaliza para minúsculas', () => {
    expect(stripDiacritics('CAFÉ')).toBe('cafe');
    expect(stripDiacritics('naïve')).toBe('naive');
  });
});

describe('isCandidate', () => {
  test('target: igualdade exata, "login" não casa "login-1"', () => {
    const login = baseLine({ data: { milestoneType: 'approved', target: 'hex:target:login' } });
    const loginOne = baseLine({
      data: { milestoneType: 'approved', target: 'hex:target:login-1' },
    });
    expect(isCandidate(login, { target: 'hex:target:login' })).toBe(true);
    expect(isCandidate(loginOne, { target: 'hex:target:login' })).toBe(false);
  });

  test('target casa tanto data.target (Milestone) quanto data.target (Verdict)', () => {
    const verdict = baseLine({
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
    expect(isCandidate(verdict, { target: 'hex:target:x' })).toBe(true);
  });

  test('result: igualdade exata sem validação de vocabulário, só em Verdict', () => {
    const verdict = baseLine({
      type: 'verdict',
      data: {
        claim: 'a',
        source: 'f',
        result: 'out-of-vocabulary',
        evidence: 'p',
        target: 'hex:target:x',
        origin: 'o',
        trace: 'r',
      },
    });
    expect(isCandidate(verdict, { result: 'out-of-vocabulary' })).toBe(true);
    const milestone = baseLine({ data: { milestoneType: 'approved', target: 'hex:target:x' } });
    expect(isCandidate(milestone, { result: 'out-of-vocabulary' })).toBe(false);
  });

  test('milestoneType: só casa em Milestone', () => {
    const milestone = baseLine({ data: { milestoneType: 'approved', target: 'hex:target:x' } });
    expect(isCandidate(milestone, { milestoneType: 'approved' })).toBe(true);
    expect(isCandidate(milestone, { milestoneType: 'rejected' })).toBe(false);
  });

  test('intervalo [after, before)', () => {
    const line = baseLine({
      timestamp: '2026-01-05T00:00:00.000Z',
      data: { milestoneType: 'approved', target: 'hex:target:x' },
    });
    expect(isCandidate(line, { after: '2026-01-05T00:00:00.000Z' })).toBe(true);
    expect(isCandidate(line, { after: '2026-01-05T00:00:00.001Z' })).toBe(false);
    expect(isCandidate(line, { before: '2026-01-05T00:00:00.000Z' })).toBe(false);
    expect(isCandidate(line, { before: '2026-01-05T00:00:00.001Z' })).toBe(true);
  });
});

describe('search: ordenação, desempate e fallback OR', () => {
  test('relevância decrescente, empate por índice físico crescente', () => {
    const candidates = [
      { index: 5, line: lineWithText('alpha') },
      { index: 2, line: lineWithText('alpha') },
      { index: 9, line: lineWithText('alpha beta') },
    ];
    const { results } = search(candidates, 'alpha');
    expect(results).toEqual(orderBy(results, ['relevance', 'index'], ['desc', 'asc']));
    const indices = results.map((r) => r.index);
    expect(indices.indexOf(2)).toBeLessThan(indices.indexOf(5));
  });

  test('AND vazio com 2+ termos distintos cai para OR', () => {
    const candidates = [
      { index: 0, line: lineWithText('alpha') },
      { index: 1, line: lineWithText('beta') },
    ];
    const { results, combination } = search(candidates, 'alpha gamma');
    expect(combination).toBe('OR');
    expect(results.map((r) => r.index)).toEqual([0]);
  });

  test('termo único sem resultado continua AND', () => {
    const candidates = [{ index: 0, line: lineWithText('alpha') }];
    const { results, combination } = search(candidates, 'zzz');
    expect(results).toEqual([]);
    expect(combination).toBe('AND');
  });

  test('distinctTerms conta termos únicos após processTerm (acento e maiúsculas)', () => {
    expect(distinctTerms('Café café CAFÉ')).toBe(1);
    expect(distinctTerms('cache invalidation')).toBe(2);
  });
});

describe('M11', () => {
  const corpus = generateCorpus({ size: 300, manifest: MANIFEST, vocabulary: VOCABULARY });
  const candidates = candidatesFrom(corpus.lines);

  test('a) acento: "cafe" e "café" retornam o mesmo conjunto e a mesma ordem', () => {
    const withoutAccent = search(candidates, 'cafe');
    const withAccent = search(candidates, 'café');
    expect(withAccent).toEqual(withoutAccent);
  });

  test('b) erro de digitação: recall 1,0 sobre o gabarito de "authentication"', () => {
    const expectedIndices = corpus.expected('authentication');
    const { results } = search(candidates, 'authentcation');
    const found = new Set(results.map((r) => r.index));
    for (const index of expectedIndices) expect(found.has(index)).toBe(true);
  });

  test('c) AND: "cache invalidation" só retorna quem tem as duas palavras, precisão 1,0', () => {
    const expectedCache = new Set(corpus.expected('cache'));
    const expectedInvalidation = new Set(corpus.expected('invalidation'));
    const expected = [...expectedCache].filter((index) => expectedInvalidation.has(index));
    const { results, combination } = search(candidates, 'cache invalidation');
    expect(combination).toBe('AND');
    expect(new Set(results.map((r) => r.index))).toEqual(new Set(expected));
  });

  test('d) inexistente: "zzqxwv" → vazio', () => {
    const { results, combination } = search(candidates, 'zzqxwv');
    expect(results).toEqual([]);
    expect(combination).toBe('AND');
  });

  test('e) determinismo: 5 chamadas idênticas devolvem o mesmo resultado', () => {
    const calls = Array.from({ length: 5 }, () => search(candidates, 'cache'));
    for (const call of calls) expect(call).toEqual(calls[0]);
  });

  test('f) relevância não crescente, empate por índice físico crescente', () => {
    const { results } = search(candidates, 'webhook');
    expect(results.length).toBeGreaterThan(0);
    expect(results).toEqual(orderBy(results, ['relevance', 'index'], ['desc', 'asc']));
  });

  test('i) linguagem natural: "problem with the webhook" cai para OR e acha os eventos de webhook', () => {
    const expectedWebhook = corpus.expected('webhook');
    const { results, combination } = search(candidates, 'problem with the webhook');
    expect(combination).toBe('OR');
    expect(results.length).toBeGreaterThan(0);
    const found = new Set(results.map((r) => r.index));
    for (const index of expectedWebhook) expect(found.has(index)).toBe(true);
  });
});

describe('M12', () => {
  test('a) target exato nunca casa "login-1..6", inclusive combinado com busca "login"', () => {
    const corpus = generateCorpus({ size: 300, manifest: MANIFEST, vocabulary: VOCABULARY });
    const filters: Filters = { target: 'hex:target:login' };
    const filteredCandidates = candidatesFrom(corpus.lines).filter(({ line }) =>
      isCandidate(line, filters),
    );
    expect(
      filteredCandidates.every(({ line }) => {
        const data = line.data as { target?: string };
        return data.target === 'hex:target:login';
      }),
    ).toBe(true);

    const { results } = search(filteredCandidates, 'login');
    expect(results.length).toBeGreaterThan(0);
  });

  test('c) after/before: só timestamp em [after, before)', () => {
    const corpus = generateCorpus({ size: 50, manifest: MANIFEST, vocabulary: VOCABULARY });
    const filters: Filters = {
      after: corpus.lines[10].timestamp,
      before: corpus.lines[20].timestamp,
    };
    const indices = candidatesFrom(corpus.lines)
      .filter(({ line }) => isCandidate(line, filters))
      .map(({ index }) => index)
      .sort((a, b) => a - b);
    expect(indices).toEqual(Array.from({ length: 10 }, (_, i) => 10 + i));
  });

  test('d) busca + target + tipo: interseção', () => {
    const corpus = generateCorpus({ size: 300, manifest: MANIFEST, vocabulary: VOCABULARY });
    const filters: Filters = { type: 'verdict', target: 'hex:target:login' };
    const filteredCandidates = candidatesFrom(corpus.lines).filter(({ line }) =>
      isCandidate(line, filters),
    );
    const { results } = search(filteredCandidates, 'login');
    expect(results.length).toBeGreaterThan(0);
    for (const result of results) {
      const line = corpus.lines[result.index];
      expect(line.type).toBe('verdict');
      expect((line.data as { target: string }).target).toBe('hex:target:login');
    }
  });
});
