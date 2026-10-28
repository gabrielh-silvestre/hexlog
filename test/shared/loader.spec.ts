import { afterEach, describe, expect, it, jest } from '@jest/globals';
import { anchor, hashLink, sha256hex, type Expected, type Link } from '../../src/domain/chain.ts';
import { BATCH_MAX } from '../../src/domain/record.ts';
import { HexlogError } from '../../src/errors.ts';
import type { ProcessReader, ProcessRef, RawProcess } from '../../src/ports.ts';
import {
  checkExpectedHead,
  formatLine,
  isValidLine,
  loadVerified,
  MAX_BREAKS,
  parseLog,
  verifyProcess,
  type Break,
} from '../../src/shared/loader.ts';
import { chainOf as chainFrom, emptyManifest, idAt, linkAt } from '../fixtures/chain-line.ts';

const AT = '2026-09-30T12:00:00.000Z';

const manifest = emptyManifest({ project: 'demo', process: 'proc-1' }, AT);

const START: Expected = { seq: 0, prevHash: anchor(manifest) };

const chainOf = (count: number, batchOf?: (seq: number) => Link['batch']) =>
  chainFrom(manifest, count, batchOf);

const [A, B, C] = chainOf(3) as [Link, Link, Link];

const lineOf = (...links: Link[]) => formatLine(links);
/** O elo com o `prevHash` trocado: forma válida, mas não casa a posição. */
const forge = (link: Link): Link => ({ ...link, prevHash: sha256hex('forged') });
const forgedLine = (link: Link) => lineOf(forge(link));

/** JSON bem formado que não tem a forma de uma linha de log. */
const NOT_A_LINE = '{"foo":1}';

const rawOf = (text: string): RawProcess => ({
  manifest,
  text,
  endsWithNewline: text === '' || text.endsWith('\n'),
});

const TORN = '{"links":[{"seq":1,"id"';

describe('formatLine', () => {
  it('should frame { links } ended by \\n', () => {
    const text = formatLine([A, B]);

    expect(text.endsWith('\n')).toBe(true);
    expect(JSON.parse(text)).toEqual({ links: [A, B] });
  });
});

describe('isValidLine', () => {
  it('should accept back a line framed by formatLine', () => {
    const text = lineOf(A, B);

    expect(isValidLine(text.slice(0, -1), START)).toEqual({
      status: 'valid',
      links: [A, B],
      next: { seq: 2, prevHash: hashLink(B) },
    });
  });

  it.each([
    { name: 'a segment that does not parse as JSON', segment: TORN },
    { name: 'an empty segment', segment: '' },
  ])('should classify $name as torn', ({ segment }) => {
    expect(isValidLine(segment, START)).toEqual({ status: 'torn' });
  });

  it.each(['null', '42', NOT_A_LINE, '{"links":[]}', '{"links":[1]}'])(
    'should reject the JSON %s, which is not shaped like a line, as invalid-line without advancing',
    (segment) => {
      expect(isValidLine(segment, START)).toEqual({
        status: 'rejected',
        reasons: ['invalid-line'],
      });
    },
  );

  it('should reject a key besides links as invalid-line (the line is strict)', () => {
    expect(isValidLine(JSON.stringify({ links: [A], extra: 1 }), START)).toEqual({
      status: 'rejected',
      reasons: ['invalid-line'],
    });
  });

  it('should accept a line with BATCH_MAX links, the last that fits', () => {
    const full = chainOf(BATCH_MAX);

    expect(isValidLine(JSON.stringify({ links: full }), START)).toMatchObject({ status: 'valid' });
  });

  it('should reject a line with one link over BATCH_MAX as invalid-line', () => {
    const full = chainOf(BATCH_MAX);
    const [extra] = chainOf(BATCH_MAX + 1).slice(-1);

    expect(isValidLine(JSON.stringify({ links: [...full, extra] }), START)).toEqual({
      status: 'rejected',
      reasons: ['invalid-line'],
    });
  });

  it('should reject a link that does not take the position with the reasons, and continue the chain from it', () => {
    const forged = forge(B);

    expect(isValidLine(JSON.stringify({ links: [forged] }), START)).toEqual({
      status: 'rejected',
      reasons: ['diverging-seq', 'hash-mismatch'],
      next: { seq: 2, prevHash: hashLink(forged) },
    });
  });

  it('should require the second link to continue the hash and the seq of the first', () => {
    expect(isValidLine(JSON.stringify({ links: [A, C] }), START)).toEqual({
      status: 'rejected',
      reasons: ['diverging-seq', 'hash-mismatch'],
      next: { seq: 3, prevHash: hashLink(C) },
    });
  });

  it('should reject the whole line for an invalid-shaped link in the middle of it, without advancing', () => {
    expect(isValidLine(JSON.stringify({ links: [A, { seq: 1 }] }), START)).toEqual({
      status: 'rejected',
      reasons: ['invalid-line'],
    });
  });
});

describe('parseLog', () => {
  type Case = {
    name: string;
    text: string;
    seqs: number[];
    breaks: Break[];
    repaired: number[];
  };

  const cases: Case[] = [
    { name: 'an empty file', text: '', seqs: [], breaks: [], repaired: [] },
    { name: 'a valid line', text: lineOf(A), seqs: [0], breaks: [], repaired: [] },
    {
      name: 'a single torn remainder, repaired by the next line',
      text: `${lineOf(A)}${TORN}\n${lineOf(B)}`,
      seqs: [0, 1],
      breaks: [],
      repaired: [1],
    },
    {
      name: 'torn + torn',
      text: `${lineOf(A)}${TORN}\n${TORN}\n${lineOf(B)}`,
      seqs: [0, 1],
      breaks: [],
      repaired: [1, 2],
    },
    {
      name: 'torn + a lone \\n',
      text: `${lineOf(A)}${TORN}\n\n${lineOf(B)}`,
      seqs: [0, 1],
      breaks: [],
      repaired: [1, 2],
    },
    {
      name: 'torn + a short write',
      text: `${lineOf(A)}${TORN}\n{"links":\n${lineOf(B)}`,
      seqs: [0, 1],
      breaks: [],
      repaired: [1, 2],
    },
    {
      name: 'torn + a valid tail (no \\n)',
      text: `${lineOf(A)}${TORN}\n${lineOf(B).slice(0, -1)}`,
      seqs: [0, 1],
      breaks: [],
      repaired: [1],
    },
    {
      name: 'torn + a line that parses and does not match',
      text: `${lineOf(A)}${TORN}\n${forgedLine(B)}`,
      seqs: [0],
      breaks: [
        { index: 1, reason: 'invalid-line' },
        { index: 2, reason: 'hash-mismatch' },
      ],
      repaired: [],
    },
    {
      name: 'torn + an invalid-line without next: the pending one becomes a break and the position does not move',
      text: `${lineOf(A)}${TORN}\n${NOT_A_LINE}\n${lineOf(B)}`,
      seqs: [0, 1],
      breaks: [
        { index: 1, reason: 'invalid-line' },
        { index: 2, reason: 'invalid-line' },
      ],
      repaired: [],
    },
    {
      name: 'terminators \\r\\n: the \\r left in the segment is whitespace for JSON',
      text: `${lineOf(A).replace(/\n$/, '\r\n')}${lineOf(B).replace(/\n$/, '\r\n')}`,
      seqs: [0, 1],
      breaks: [],
      repaired: [],
    },
    {
      name: 'an invalid line that parses',
      text: `${lineOf(A)}${NOT_A_LINE}\n${lineOf(B)}`,
      seqs: [0, 1],
      breaks: [{ index: 1, reason: 'invalid-line' }],
      repaired: [],
    },
    {
      name: 'a valid tail',
      text: `${lineOf(A)}${lineOf(B).slice(0, -1)}`,
      seqs: [0, 1],
      breaks: [],
      repaired: [],
    },
    {
      name: 'a torn tail, ignored',
      text: `${lineOf(A)}${TORN}`,
      seqs: [0],
      breaks: [],
      repaired: [],
    },
    {
      name: 'a JSON tail that does not match',
      text: `${lineOf(A)}${forgedLine(B).slice(0, -1)}`,
      seqs: [0],
      breaks: [{ index: 1, reason: 'hash-mismatch' }],
      repaired: [],
    },
    {
      name: 'garbage inserted between valid lines, repaired',
      text: `${lineOf(A)}garbage\n${lineOf(B)}`,
      seqs: [0, 1],
      breaks: [],
      repaired: [1],
    },
    {
      name: 'a valid line replaced by garbage, breaking at the next valid line',
      text: `${lineOf(A)}garbage\n${lineOf(C)}`,
      seqs: [0],
      breaks: [
        { index: 1, reason: 'invalid-line' },
        { index: 2, reason: 'diverging-seq' },
        { index: 2, reason: 'hash-mismatch' },
      ],
      repaired: [],
    },
  ];

  it.each(cases)(
    'should give the seqs, breaks and repaired lines for $name',
    ({ text, seqs, breaks, repaired }) => {
      const parsed = parseLog(text, START.prevHash);

      expect(parsed.lines.flatMap((line) => line.links.map((link) => link.seq))).toEqual(seqs);
      expect(parsed.breaks).toEqual(breaks);
      expect(parsed.repairedLines).toEqual(repaired);
    },
  );

  /** A gravação seguinte do `process-store`: um elo em `end`, com o `\n` de prefixo se o log não termina nele. */
  const appendNext = (text: string, end: Expected): string => {
    const link = linkAt(end, {
      id: idAt(manifest.process, end.seq + 1),
      author: { agent: 'luffy', client: 'claude-code' },
    });
    return `${text}${text === '' || text.endsWith('\n') ? '' : '\n'}${lineOf(link)}`;
  };

  it.each(cases)('should append the next write after $name', ({ text }) => {
    const before = parseLog(text, START.prevHash);

    const after = parseLog(appendNext(text, before.end), START.prevHash);

    expect(after.breaks).toEqual(before.breaks);
    expect(after.lines.at(-1)?.links.map((link) => link.seq)).toEqual([before.end.seq]);
    expect(after.end.seq).toBe(before.end.seq + 1);
  });

  it('should neither consume a seq nor report a break or a repaired line for a torn remainder at the end of the file', () => {
    const parsed = parseLog(`${lineOf(A)}${TORN}\n\n`, START.prevHash);

    expect(parsed.end).toEqual({ seq: 1, prevHash: hashLink(A) });
    expect(parsed.breaks).toEqual([]);
    expect(parsed.repairedLines).toEqual([]);
  });

  it('should advance the chain over a rejected line so the following consistent lines do not break again', () => {
    const forged = forge(B);
    const next = { ...C, prevHash: hashLink(forged) };

    const parsed = parseLog(`${lineOf(A)}${lineOf(forged)}${lineOf(next)}`, START.prevHash);

    expect(parsed.breaks).toEqual([{ index: 1, reason: 'hash-mismatch' }]);
    expect(parsed.lines.map((line) => line.index)).toEqual([0, 2]);
  });
});

describe('verifyProcess', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  /** Três elos em duas linhas; o 1º abre o lote `batch-a` (com `key`) e o 3º tem um lote sem `key`. */
  function verifiedThreeLinks() {
    const [first, second, third] = chainOf(3, (seq) =>
      seq === 0
        ? { fingerprint: sha256hex('batch-a'), key: 'batch-a' }
        : seq === 2
          ? { fingerprint: sha256hex('batch-b') }
          : undefined,
    ) as [Link, Link, Link];
    const verified = verifyProcess(rawOf(`${lineOf(first, second)}${lineOf(third)}`));
    return { first, second, third, verified };
  }

  it('should return the manifest of the process as read', () => {
    const { verified } = verifiedThreeLinks();

    expect(verified.manifest).toBe(manifest);
  });

  it('should return the records in log order', () => {
    const { first, second, third, verified } = verifiedThreeLinks();

    expect(verified.records).toEqual([first, second, third]);
  });

  it('should report the chain as ok, with the head at the last link', () => {
    const { third, verified } = verifiedThreeLinks();

    expect(verified.chain).toEqual({
      ok: true,
      totalRecords: 3,
      head: hashLink(third),
      breaks: [],
      totalBreaks: 0,
      repairedLines: [],
    });
  });

  it('should index only the batches that carry a key', () => {
    const { first, second, verified } = verifiedThreeLinks();

    expect(verified.batches).toEqual(
      new Map([['batch-a', { fingerprint: sha256hex('batch-a'), links: [first, second] }]]),
    );
  });

  it('should put the end position after the last link', () => {
    const { third, verified } = verifiedThreeLinks();

    expect(verified.end).toEqual({ seq: 3, prevHash: hashLink(third) });
  });

  it('should put the head and the end position of an empty process at its anchor', () => {
    const verified = verifyProcess(rawOf(''));

    expect(verified.chain).toEqual({
      ok: true,
      totalRecords: 0,
      head: START.prevHash,
      breaks: [],
      totalBreaks: 0,
      repairedLines: [],
    });
    expect(verified.end).toEqual(START);
  });

  it('should keep the first occurrence of a key', () => {
    const [first, second] = chainOf(2, (seq) => ({
      fingerprint: sha256hex(`print-${seq}`),
      key: 'same',
    })) as [Link, Link];

    const { batches } = verifyProcess(rawOf(`${lineOf(first)}${lineOf(second)}`));

    expect(batches).toEqual(
      new Map([['same', { fingerprint: sha256hex('print-0'), links: [first] }]]),
    );
  });

  it('should report a broken chain as ok false, with the breaks and the count', () => {
    const { chain } = verifyProcess(rawOf(`${lineOf(A)}${forgedLine(B)}`));

    expect(chain).toMatchObject({
      ok: false,
      totalRecords: 1,
      totalBreaks: 1,
      breaks: [{ index: 1, reason: 'hash-mismatch' }],
    });
  });

  it('should output only 100 breaks while the total count stays exact', () => {
    const garbage = `${NOT_A_LINE}\n`.repeat(150);

    const { chain } = verifyProcess(rawOf(`${lineOf(A)}${garbage}`));

    expect(chain.breaks).toHaveLength(100);
    expect(chain.totalBreaks).toBe(150);
  });

  it('should output only 100 repaired lines', () => {
    const [first, ...rest] = chainOf(151) as [Link, ...Link[]];
    const text = `${lineOf(first)}${rest.map((link) => `${TORN}\n${lineOf(link)}`).join('')}`;

    const { chain } = verifyProcess(rawOf(text));

    expect(chain.ok).toBe(true);
    expect(chain.repairedLines).toHaveLength(100);
  });

  it('should call JSON.parse once per segment of records.jsonl, in order', () => {
    const segments = [
      lineOf(A).slice(0, -1),
      TORN,
      lineOf(B).slice(0, -1),
      '',
      lineOf(C).slice(0, -1),
    ];
    const spy = jest.spyOn(JSON, 'parse');

    verifyProcess(rawOf(segments.join('\n')), C.id);

    expect(spy).toHaveBeenCalledTimes(segments.length);

    segments.forEach((segment, index) => {
      expect(spy).toHaveBeenNthCalledWith(index + 1, segment);
    });
  });

  describe('with a marker', () => {
    it('should read the process as empty for a null marker', () => {
      const verified = verifyProcess(rawOf(`${lineOf(A)}${lineOf(B)}`), null);

      expect(verified.records).toEqual([]);
      expect(verified.chain).toMatchObject({ ok: true, totalRecords: 0, head: START.prevHash });
      expect(verified.end).toEqual(START);
    });

    it('should cut after the marked record, the end position following the cut', () => {
      const verified = verifyProcess(rawOf(`${lineOf(A)}${lineOf(B)}${lineOf(C)}`), B.id);

      expect(verified.records).toEqual([A, B]);
      expect(verified.chain).toMatchObject({ totalRecords: 2, head: hashLink(B) });
      expect(verified.end).toEqual({ seq: 2, prevHash: hashLink(B) });
    });

    it('should cut a batch at a marker in the middle of it and drop it from the batches map', () => {
      const [first, second] = chainOf(2, (seq) =>
        seq === 0 ? { fingerprint: sha256hex('batch'), key: 'batch' } : undefined,
      ) as [Link, Link];

      const verified = verifyProcess(rawOf(lineOf(first, second)), first.id);

      expect(verified.records).toEqual([first]);
      expect(verified.batches.size).toBe(0);
      expect(verified.end).toEqual({ seq: 1, prevHash: hashLink(first) });
    });

    it('should not count a break after the marker', () => {
      const text = `${lineOf(A)}${NOT_A_LINE}\n${lineOf(B)}`;

      expect(verifyProcess(rawOf(text), A.id).chain.ok).toBe(true);
    });

    it('should count a break before the marker', () => {
      const text = `${lineOf(A)}${NOT_A_LINE}\n${lineOf(B)}`;

      expect(verifyProcess(rawOf(text), B.id).chain).toMatchObject({
        ok: false,
        breaks: [{ index: 1, reason: 'invalid-line' }],
      });
    });

    it('should throw MARKER_NOT_FOUND for a marker on a rejected line: only an accepted line can be marked', () => {
      expect(() => verifyProcess(rawOf(`${lineOf(A)}${forgedLine(B)}`), B.id)).toThrow(
        expect.objectContaining({ code: 'MARKER_NOT_FOUND' }),
      );
    });

    it('should throw MARKER_NOT_FOUND for a marker that is not in the log', () => {
      expect(() => verifyProcess(rawOf(lineOf(A)), B.id)).toThrow(
        expect.objectContaining({
          constructor: HexlogError,
          code: 'MARKER_NOT_FOUND',
          details: [expect.objectContaining({ path: '/marker', code: 'marker-not-found' })],
        }),
      );
    });
  });
});

describe('checkExpectedHead', () => {
  const verifiedOf = (...links: Link[]) =>
    verifyProcess(rawOf(links.map((l) => lineOf(l)).join('')));

  it('should return the head of a verification with a break in the middle without head-not-found', () => {
    const verified = verifyProcess(rawOf(`${lineOf(A)}${forgedLine(B)}`));

    expect(verified.chain.breaks).not.toHaveLength(0);

    const chain = checkExpectedHead(verified, verified.chain.head);

    expect(chain).toBe(verified.chain);
  });

  it('should turn the hash of no link into head-not-found at totalRecords, count it in totalBreaks and zero ok', () => {
    const verified = verifiedOf(A, B);

    expect(checkExpectedHead(verified, hashLink(C))).toEqual({
      ...verified.chain,
      ok: false,
      breaks: [{ index: 2, reason: 'head-not-found' }],
      totalBreaks: 1,
    });
  });

  it('should put the break after the chain breaks and, with the list at the ceiling, only add it to the total', () => {
    const verified = verifyProcess(rawOf(`${lineOf(A)}${`${NOT_A_LINE}\n`.repeat(MAX_BREAKS)}`));

    const chain = checkExpectedHead(verified, hashLink(C));

    expect(chain.breaks).toHaveLength(MAX_BREAKS);
    expect(chain.breaks).toEqual(verified.chain.breaks);
    expect(chain.totalBreaks).toBe(MAX_BREAKS + 1);
  });
});

describe('loadVerified', () => {
  it('should read the raw process from the port once and verify what came back', () => {
    const ref: ProcessRef = { project: 'demo', process: 'proc-1' };
    const raw = rawOf(lineOf(A, B));
    const read = jest.fn<(ref: ProcessRef) => RawProcess>().mockReturnValue(raw);

    const verified = loadVerified({ read } as unknown as ProcessReader, ref, A.id);

    expect(read).toHaveBeenCalledTimes(1);
    expect(read).toHaveBeenCalledWith(ref);
    expect(verified).toEqual(verifyProcess(raw, A.id));
  });
});
