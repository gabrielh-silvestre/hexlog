import { describe, test, expect } from '@jest/globals';
import { randomUUIDv7 } from 'node:crypto';
import fc from 'fast-check';
import type { EventLine } from '../src/events.ts';
import {
  anchor,
  hashLine,
  expectedPrevHash,
  nextSeq,
  sha256hex,
  verifyChain,
} from '../src/chain.ts';

const MANIFEST = { project: 'p', process: 'proc', fixed: { version: 1 } };

function buildLine(index: number, lastLink: EventLine | null, milestoneType = 'step'): EventLine {
  return {
    seq: nextSeq(lastLink, 0),
    id: `p:proc:milestone:${randomUUIDv7()}`,
    type: 'milestone',
    timestamp: new Date(Date.UTC(2026, 0, 1 + index)).toISOString(),
    agent: 'test-agent',
    prevHash: expectedPrevHash(lastLink, MANIFEST),
    data: { milestoneType, target: 'hex:target:u1' },
  };
}

/** Log íntegro de `count` elos encadeados a partir do manifesto (linhas 0..count-1). */
function buildLog(count: number): EventLine[] {
  const lines: EventLine[] = [];
  let lastLink: EventLine | null = null;
  for (let index = 0; index < count; index++) {
    const link = buildLine(index, lastLink);
    lines.push(link);
    lastLink = link;
  }
  return lines;
}

function toText(lines: Array<EventLine | string>): string {
  return (
    lines.map((line) => (typeof line === 'string' ? line : JSON.stringify(line))).join('\n') + '\n'
  );
}

describe('hashLinha / ancora (N10, golden)', () => {
  const manifest = { project: 'p', process: 'x', fixed: { version: 1 } };
  const expectedAnchor = '5d7cfecff0d3ee796cf1a27487ab0368e45534abd4aebd933d81ed2390416e25';
  const line: EventLine = {
    seq: 0,
    id: 'p:x:milestone:018f5b3a-1a2b-7c3d-89ab-0123456789ab',
    type: 'milestone',
    timestamp: '2026-01-01T00:00:00.000Z',
    agent: 'test-agent',
    prevHash: expectedAnchor,
    data: { milestoneType: 'start', target: 'hex:target:u1' },
  };
  const expectedHash = '0958cea414455bf21ed86a631424723e34361d45b91f1956f67064cb5075b049';

  test('ancora do manifesto é o hex fixo', () => {
    expect(anchor(manifest)).toBe(expectedAnchor);
  });

  test('hashLinha do elo é o hex fixo', () => {
    expect(hashLine(line)).toBe(expectedHash);
  });

  test('reordenar as chaves da linha não muda o hash (JCS ordena)', () => {
    const reordered = {
      data: line.data,
      prevHash: line.prevHash,
      agent: line.agent,
      timestamp: line.timestamp,
      type: line.type,
      id: line.id,
      seq: line.seq,
    };
    expect(hashLine(reordered)).toBe(expectedHash);
  });

  test('property: ida e volta por JSON.parse(JSON.stringify(l)) preserva o hash', () => {
    fc.assert(
      fc.property(fc.integer({ min: 0, max: 1000 }), (seq) => {
        const l: EventLine = { ...line, seq };
        const cloned = JSON.parse(JSON.stringify(l)) as EventLine;
        expect(hashLine(cloned)).toBe(hashLine(l));
      }),
    );
  });
});

describe('proximoSeq / prevHashEsperado (relativo)', () => {
  test('proximoSeq sem último elo = número de pendentes', () => {
    expect(nextSeq(null, 3)).toBe(3);
  });

  test('proximoSeq com último elo = seq + 1 + pendentes', () => {
    const link = buildLine(0, null);
    const withSeq5 = { ...link, seq: 5 };
    expect(nextSeq(withSeq5, 2)).toBe(8);
  });

  test('prevHashEsperado sem último elo = âncora do manifesto', () => {
    expect(expectedPrevHash(null, MANIFEST)).toBe(anchor(MANIFEST));
  });

  test('prevHashEsperado com último elo = hashLinha desse elo', () => {
    const link = buildLine(0, null);
    expect(expectedPrevHash(link, MANIFEST)).toBe(hashLine(link));
  });
});

describe('verifyChain (N1: log de 5 elos, corrupções pontuais)', () => {
  test('log íntegro de 5 elos verifica ok', () => {
    const log = buildLog(5);
    const result = verifyChain(toText(log), MANIFEST);
    expect(result).toEqual({
      ok: true,
      totalLines: 5,
      head: hashLine(log[4]),
      breaks: [],
      totalBreaks: 0,
      repairedLines: [],
    });
  });

  test('(a) JSON inválido na linha 1 → {1,invalid-line},{2,hash-mismatch}', () => {
    const log: Array<EventLine | string> = [...buildLog(5)];
    log[1] = '{ this is not valid json';
    const result = verifyChain(toText(log), MANIFEST);
    expect(result.breaks).toEqual([
      { index: 1, reason: 'invalid-line' },
      { index: 2, reason: 'hash-mismatch' },
    ]);
    expect(result.totalBreaks).toBe(2);
    expect(result.repairedLines).toEqual([]);
    expect(result.ok).toBe(false);
  });

  test('(b) dados alterado na linha 1 → {2,hash-mismatch}', () => {
    const log = buildLog(5);
    const changed: Array<EventLine | string> = [...log];
    changed[1] = { ...log[1], data: { ...log[1].data, milestoneType: 'changed' } };
    const result = verifyChain(toText(changed), MANIFEST);
    expect(result.breaks).toEqual([{ index: 2, reason: 'hash-mismatch' }]);
    expect(result.totalBreaks).toBe(1);
  });

  test('(c) linha 1 removida → {1,diverging-seq},{1,hash-mismatch}, sem cascata', () => {
    const log = buildLog(5);
    const withoutLine1 = log.filter((_, index) => index !== 1);
    const result = verifyChain(toText(withoutLine1), MANIFEST);
    expect(result.breaks).toEqual([
      { index: 1, reason: 'diverging-seq' },
      { index: 1, reason: 'hash-mismatch' },
    ]);
    expect(result.totalBreaks).toBe(2);
  });

  test('(d) cauda parcial sem \\n no fim + novo elo legítimo → repara e continua a cadeia', () => {
    const log = buildLog(5);
    const intactText = toText(log);
    // simula: o escritor completa a cauda torta com '\n' antes de anexar o novo elo (§4.7).
    const completedTail = `${intactText}{"seq":5,"tail":"partial bytes without closure"}\n`;
    const lastLink = log[4];
    const newLink = buildLine(5, lastLink);
    newLink.seq = nextSeq(lastLink, 1);
    newLink.prevHash = expectedPrevHash(lastLink, MANIFEST);
    const finalText = completedTail + JSON.stringify(newLink) + '\n';

    const result = verifyChain(finalText, MANIFEST);
    expect(result.ok).toBe(true);
    expect(result.breaks).toEqual([]);
    expect(result.repairedLines).toEqual([5]);
    expect(newLink.seq).toBe(6);
    expect(result.head).toBe(hashLine(newLink));
  });

  test('(e) (a) + prevHash alterado na linha 4 → {1,invalid-line},{2,hash-mismatch},{4,hash-mismatch}', () => {
    const log = buildLog(5);
    const changed: Array<EventLine | string> = [...log];
    changed[1] = '{ this is not valid json';
    changed[4] = { ...log[4], prevHash: sha256hex('random-junk') };
    const result = verifyChain(toText(changed), MANIFEST);
    expect(result.breaks).toEqual([
      { index: 1, reason: 'invalid-line' },
      { index: 2, reason: 'hash-mismatch' },
      { index: 4, reason: 'hash-mismatch' },
    ]);
    expect(result.totalBreaks).toBe(3);
  });

  test('(f) limite conhecido: lixo terminado em \\n + registrar legítimo → ok, reparado (indistinguível)', () => {
    const log = buildLog(5);
    const withGarbage = `${toText(log)}this is pure garbage, not json\n`;
    const lastLink = log[4];
    const newLink = buildLine(5, lastLink);
    newLink.seq = nextSeq(lastLink, 1);
    newLink.prevHash = expectedPrevHash(lastLink, MANIFEST);
    const finalText = withGarbage + JSON.stringify(newLink) + '\n';

    const result = verifyChain(finalText, MANIFEST);
    expect(result.ok).toBe(true);
    expect(result.repairedLines).toEqual([5]);
  });

  test('(g) (c) + registrar legítimo → só as 2 quebras de (c), sem quebras novas', () => {
    const log = buildLog(5);
    const withoutLine1 = log.filter((_, index) => index !== 1);
    const lastLink = withoutLine1[withoutLine1.length - 1];
    const newLink = buildLine(9, lastLink);
    newLink.seq = nextSeq(lastLink, 0);
    newLink.prevHash = expectedPrevHash(lastLink, MANIFEST);
    const finalText = toText([...withoutLine1, newLink]);

    const result = verifyChain(finalText, MANIFEST);
    expect(result.breaks).toEqual([
      { index: 1, reason: 'diverging-seq' },
      { index: 1, reason: 'hash-mismatch' },
    ]);
    expect(result.totalBreaks).toBe(2);
  });
});

describe('verifyChain: outros casos', () => {
  test('invalid-data: validateData reprovando um elo gera a quebra', () => {
    const e0 = buildLine(0, null);
    const e1 = buildLine(1, e0, 'bad');
    const validateData = (_type: string, data: Record<string, unknown>) =>
      data.milestoneType === 'bad'
        ? [{ path: '/data/milestoneType', code: 'bad', message: 'x' }]
        : null;

    const result = verifyChain(toText([e0, e1]), MANIFEST, validateData);
    expect(result.breaks).toEqual([{ index: 1, reason: 'invalid-data' }]);
    expect(result.ok).toBe(false);
  });

  test('transposição adjacente: quebras localizadas na janela afetada, recupera depois', () => {
    const log = buildLog(5);
    const transposed = [...log];
    [transposed[1], transposed[2]] = [transposed[2], transposed[1]];

    const result = verifyChain(toText(transposed), MANIFEST);
    expect(result.breaks).toEqual([
      { index: 1, reason: 'diverging-seq' },
      { index: 1, reason: 'hash-mismatch' },
      { index: 2, reason: 'diverging-seq' },
      { index: 2, reason: 'hash-mismatch' },
      { index: 3, reason: 'diverging-seq' },
      { index: 3, reason: 'hash-mismatch' },
    ]);
    // o elo original (não tocado) volta a verificar: a quebra não cascateia até o fim.
    expect(result.breaks.some((breakItem) => breakItem.index === 4)).toBe(false);
  });

  test('duplicata de elo: só a cópia anexada quebra, localizada no seu próprio índice', () => {
    const log = buildLog(5);
    const withDuplicate = [...log, log[2]];

    const result = verifyChain(toText(withDuplicate), MANIFEST);
    expect(result.breaks).toEqual([
      { index: 5, reason: 'diverging-seq' },
      { index: 5, reason: 'hash-mismatch' },
    ]);
  });

  test('cauda sem \\n é ignorada: nem conta em totalLines nem quebra a cadeia', () => {
    const log = buildLog(2);
    const text = `${toText(log)}{"seq":2,"tail":"no newline at the end"`;

    const result = verifyChain(text, MANIFEST);
    expect(result.totalLines).toBe(2);
    expect(result.ok).toBe(true);
    expect(result.head).toBe(hashLine(log[1]));
  });

  test('head é "" quando não há nenhum elo válido', () => {
    const result = verifyChain('garbage without json\nmore garbage\n', MANIFEST);
    expect(result.head).toBe('');
    expect(result.breaks).toEqual([
      { index: 0, reason: 'invalid-line' },
      { index: 1, reason: 'invalid-line' },
    ]);
  });
});
