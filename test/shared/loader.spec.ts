import { describe, test, expect, jest, afterEach } from '@jest/globals';
import { anchor, hashLink, sha256hex, type Expected, type Link } from '../../src/domain/chain.ts';
import type { RecordId } from '../../src/domain/ids.ts';
import { HexlogError } from '../../src/errors.ts';
import type { ProcessRef, RawProcess } from '../../src/ports.ts';
import {
  formatLine,
  isValidLine,
  loadVerified,
  parseLog,
  verifyProcess,
  type Break,
} from '../../src/shared/loader.ts';
import { emptyManifest, linkAt } from '../fixtures/chain-line.ts';

const AT = '2026-09-30T12:00:00.000Z';

const manifest = emptyManifest({ project: 'demo', process: 'proc-1' }, AT);

const START: Expected = { seq: 0, prevHash: anchor(manifest) };

const recordId = (n: number): RecordId =>
  `proc-1:0198f4a0-0000-7000-8000-${n.toString(16).padStart(12, '0')}`;

/** Elos encadeados a partir da âncora: o `seq` N tem `id` N+1 e `prevHash` do elo anterior. */
function chainOf(count: number, batchOf: (seq: number) => Link['batch'] = () => undefined): Link[] {
  const links: Link[] = [];
  let expected = START;
  for (let seq = 0; seq < count; seq++) {
    const batch = batchOf(seq);
    const link = linkAt(expected, {
      id: recordId(seq + 1),
      author: { agent: 'luffy', client: 'claude-code' },
      data: { text: `registro ${seq}` },
      ...(batch === undefined ? {} : { batch }),
    });
    links.push(link);
    expected = { seq: seq + 1, prevHash: hashLink(link) };
  }
  return links;
}

const [A, B, C] = chainOf(3) as [Link, Link, Link];

const lineOf = (...links: Link[]) => formatLine(links);
/** Linha de forma válida que não casa a posição: o `prevHash` não é o do elo anterior. */
const forgedLine = (link: Link) => lineOf({ ...link, prevHash: sha256hex('forjado') });

const rawOf = (text: string): RawProcess => ({
  manifest,
  text,
  endsWithNewline: text === '' || text.endsWith('\n'),
});

const TORN = '{"links":[{"seq":1,"id"';

describe('formatLine e isValidLine', () => {
  test('formatLine enquadra { links } terminado em \\n e isValidLine o aceita de volta', () => {
    const text = lineOf(A, B);
    expect(text.endsWith('\n')).toBe(true);
    expect(JSON.parse(text)).toEqual({ links: [A, B] });
    expect(isValidLine(text.slice(0, -1), START)).toEqual({
      status: 'valid',
      links: [A, B],
      next: { seq: 2, prevHash: hashLink(B) },
    });
  });

  test('segmento que não parseia como JSON (inclusive vazio) é rasgado', () => {
    expect(isValidLine(TORN, START)).toEqual({ status: 'torn' });
    expect(isValidLine('', START)).toEqual({ status: 'torn' });
  });

  test.each(['null', '42', '{"foo":1}', '{"links":[]}', '{"links":[1]}'])(
    'JSON %s que não tem a forma de uma linha é rejeitado como invalid-line, sem avançar',
    (segment) => {
      expect(isValidLine(segment, START)).toEqual({
        status: 'rejected',
        reasons: ['invalid-line'],
      });
    },
  );

  test('elo que não ocupa a posição é rejeitado com as razões, e a cadeia segue dele', () => {
    const forged = { ...B, prevHash: sha256hex('forjado') };
    expect(isValidLine(JSON.stringify({ links: [forged] }), START)).toEqual({
      status: 'rejected',
      reasons: ['diverging-seq', 'hash-mismatch'],
      next: { seq: 2, prevHash: hashLink(forged) },
    });
  });

  test('continuidade interna: o segundo elo precisa continuar o hash e o seq do primeiro', () => {
    expect(isValidLine(JSON.stringify({ links: [A, C] }), START)).toEqual({
      status: 'rejected',
      reasons: ['diverging-seq', 'hash-mismatch'],
      next: { seq: 3, prevHash: hashLink(C) },
    });
  });

  test('elo de forma inválida no meio da linha rejeita a linha inteira, sem avançar', () => {
    expect(isValidLine(JSON.stringify({ links: [A, { seq: 1 }] }), START)).toEqual({
      status: 'rejected',
      reasons: ['invalid-line'],
    });
  });
});

describe('parseLog: as regras (1)-(5) de D-05', () => {
  type Case = {
    name: string;
    text: string;
    seqs: number[];
    breaks: Break[];
    repaired: number[];
  };

  const cases: Case[] = [
    { name: 'arquivo vazio', text: '', seqs: [], breaks: [], repaired: [] },
    { name: 'linha válida', text: lineOf(A), seqs: [0], breaks: [], repaired: [] },
    {
      name: 'resto rasgado único, reparado pela linha seguinte',
      text: `${lineOf(A)}${TORN}\n${lineOf(B)}`,
      seqs: [0, 1],
      breaks: [],
      repaired: [1],
    },
    {
      name: 'rasgo + rasgo',
      text: `${lineOf(A)}${TORN}\n${TORN}\n${lineOf(B)}`,
      seqs: [0, 1],
      breaks: [],
      repaired: [1, 2],
    },
    {
      name: 'rasgo + só \\n',
      text: `${lineOf(A)}${TORN}\n\n${lineOf(B)}`,
      seqs: [0, 1],
      breaks: [],
      repaired: [1, 2],
    },
    {
      name: 'rasgo + escrita curta',
      text: `${lineOf(A)}${TORN}\n{"links":\n${lineOf(B)}`,
      seqs: [0, 1],
      breaks: [],
      repaired: [1, 2],
    },
    {
      name: 'rasgo + cauda válida (sem \\n)',
      text: `${lineOf(A)}${TORN}\n${lineOf(B).slice(0, -1)}`,
      seqs: [0, 1],
      breaks: [],
      repaired: [1],
    },
    {
      name: 'rasgo + linha que parseia e não casa',
      text: `${lineOf(A)}${TORN}\n${forgedLine(B)}`,
      seqs: [0],
      breaks: [
        { index: 1, reason: 'invalid-line' },
        { index: 2, reason: 'hash-mismatch' },
      ],
      repaired: [],
    },
    {
      name: 'linha inválida que parseia',
      text: `${lineOf(A)}{"foo":1}\n${lineOf(B)}`,
      seqs: [0, 1],
      breaks: [{ index: 1, reason: 'invalid-line' }],
      repaired: [],
    },
    {
      name: 'cauda válida',
      text: `${lineOf(A)}${lineOf(B).slice(0, -1)}`,
      seqs: [0, 1],
      breaks: [],
      repaired: [],
    },
    {
      name: 'cauda rasgada, ignorada',
      text: `${lineOf(A)}${TORN}`,
      seqs: [0],
      breaks: [],
      repaired: [],
    },
    {
      name: 'cauda JSON que não casa',
      text: `${lineOf(A)}${forgedLine(B).slice(0, -1)}`,
      seqs: [0],
      breaks: [{ index: 1, reason: 'hash-mismatch' }],
      repaired: [],
    },
    {
      name: 'lixo inserido entre linhas válidas, reparado',
      text: `${lineOf(A)}lixo\n${lineOf(B)}`,
      seqs: [0, 1],
      breaks: [],
      repaired: [1],
    },
    {
      name: 'linha válida trocada por lixo, quebra na linha válida seguinte',
      text: `${lineOf(A)}lixo\n${lineOf(C)}`,
      seqs: [0],
      breaks: [
        { index: 1, reason: 'invalid-line' },
        { index: 2, reason: 'diverging-seq' },
        { index: 2, reason: 'hash-mismatch' },
      ],
      repaired: [],
    },
  ];

  test.each(cases)('$name', ({ text, seqs, breaks, repaired }) => {
    const parsed = parseLog(text, START.prevHash);
    expect(parsed.lines.flatMap((line) => line.links.map((link) => link.seq))).toEqual(seqs);
    expect(parsed.breaks).toEqual(breaks);
    expect(parsed.repairedLines).toEqual(repaired);
  });

  test('rasgo no fim do arquivo não consome seq: a posição final é a do último elo válido', () => {
    const parsed = parseLog(`${lineOf(A)}${TORN}\n\n`, START.prevHash);
    expect(parsed.end).toEqual({ seq: 1, prevHash: hashLink(A) });
    expect(parsed.breaks).toEqual([]);
    expect(parsed.repairedLines).toEqual([]);
  });

  test('linha rejeitada avança a cadeia: as linhas seguintes consistentes não quebram de novo', () => {
    const forged = { ...B, prevHash: sha256hex('forjado') };
    const next = { ...C, prevHash: hashLink(forged) };
    const parsed = parseLog(`${lineOf(A)}${lineOf(forged)}${lineOf(next)}`, START.prevHash);
    expect(parsed.breaks).toEqual([{ index: 1, reason: 'hash-mismatch' }]);
    expect(parsed.lines.map((line) => line.index)).toEqual([0, 2]);
  });
});

describe('verifyProcess', () => {
  test('devolve registros, cadeia, manifesto, lotes por key e a posição final', () => {
    const [first, second, third] = chainOf(3, (seq) =>
      seq === 0
        ? { fingerprint: sha256hex('lote-a'), key: 'lote-a' }
        : seq === 2
          ? { fingerprint: sha256hex('lote-b') }
          : undefined,
    ) as [Link, Link, Link];
    const verified = verifyProcess(rawOf(`${lineOf(first, second)}${lineOf(third)}`));

    expect(verified.manifest).toBe(manifest);
    expect(verified.records).toEqual([first, second, third]);
    expect(verified.chain).toEqual({
      ok: true,
      totalRecords: 3,
      head: hashLink(third),
      breaks: [],
      totalBreaks: 0,
      repairedLines: [],
    });
    expect(verified.batches).toEqual(
      new Map([['lote-a', { fingerprint: sha256hex('lote-a'), links: [first, second] }]]),
    );
    expect(verified.end).toEqual({ seq: 3, prevHash: hashLink(third) });
  });

  test('processo vazio: head vazio e posição final na âncora', () => {
    const verified = verifyProcess(rawOf(''));
    expect(verified.chain).toEqual({
      ok: true,
      totalRecords: 0,
      head: '',
      breaks: [],
      totalBreaks: 0,
      repairedLines: [],
    });
    expect(verified.end).toEqual(START);
  });

  test('a primeira ocorrência de uma key vale', () => {
    const [first, second] = chainOf(2, (seq) => ({
      fingerprint: sha256hex(`impressao-${seq}`),
      key: 'mesma',
    })) as [Link, Link];
    const { batches } = verifyProcess(rawOf(`${lineOf(first)}${lineOf(second)}`));
    expect(batches).toEqual(
      new Map([['mesma', { fingerprint: sha256hex('impressao-0'), links: [first] }]]),
    );
  });

  test('cadeia quebrada: ok falso, com as quebras e a contagem', () => {
    const { chain } = verifyProcess(rawOf(`${lineOf(A)}${forgedLine(B)}`));
    expect(chain).toMatchObject({
      ok: false,
      totalRecords: 1,
      totalBreaks: 1,
      breaks: [{ index: 1, reason: 'hash-mismatch' }],
    });
  });

  test('tetos: só 100 quebras saem, e a contagem total é exata', () => {
    const garbage = '{"foo":1}\n'.repeat(150);
    const { chain } = verifyProcess(rawOf(`${lineOf(A)}${garbage}`));
    expect(chain.breaks).toHaveLength(100);
    expect(chain.totalBreaks).toBe(150);
  });

  test('tetos: só 100 linhas reparadas saem', () => {
    const [first, ...rest] = chainOf(151) as [Link, ...Link[]];
    const text = `${lineOf(first)}${rest.map((link) => `${TORN}\n${lineOf(link)}`).join('')}`;
    const { chain } = verifyProcess(rawOf(text));
    expect(chain.ok).toBe(true);
    expect(chain.repairedLines).toHaveLength(100);
  });

  describe('corte no marcador', () => {
    test('marcador nulo lê o processo como vazio', () => {
      const verified = verifyProcess(rawOf(`${lineOf(A)}${lineOf(B)}`), null);
      expect(verified.records).toEqual([]);
      expect(verified.chain).toMatchObject({ ok: true, totalRecords: 0, head: '' });
      expect(verified.end).toEqual(START);
    });

    test('corta depois do registro marcado e a posição final acompanha o corte', () => {
      const verified = verifyProcess(rawOf(`${lineOf(A)}${lineOf(B)}${lineOf(C)}`), B.id);
      expect(verified.records).toEqual([A, B]);
      expect(verified.chain).toMatchObject({ totalRecords: 2, head: hashLink(B) });
      expect(verified.end).toEqual({ seq: 2, prevHash: hashLink(B) });
    });

    test('marcador no meio de um lote corta o lote e o tira do mapa de lotes', () => {
      const [first, second] = chainOf(2, (seq) =>
        seq === 0 ? { fingerprint: sha256hex('lote'), key: 'lote' } : undefined,
      ) as [Link, Link];
      const verified = verifyProcess(rawOf(lineOf(first, second)), first.id);
      expect(verified.records).toEqual([first]);
      expect(verified.batches.size).toBe(0);
      expect(verified.end).toEqual({ seq: 1, prevHash: hashLink(first) });
    });

    test('quebra depois do marcador não conta; antes do marcador, conta', () => {
      const text = `${lineOf(A)}{"foo":1}\n${lineOf(B)}`;
      expect(verifyProcess(rawOf(text), A.id).chain.ok).toBe(true);
      expect(verifyProcess(rawOf(text), B.id).chain).toMatchObject({
        ok: false,
        breaks: [{ index: 1, reason: 'invalid-line' }],
      });
    });

    test('marcador que não está no log dá MARKER_NOT_FOUND', () => {
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

describe('SL2: cada linha é parseada uma vez por chamada', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  test('verifyProcess chama JSON.parse uma vez por segmento do records.jsonl, na ordem', () => {
    const segments = [
      lineOf(A).slice(0, -1),
      TORN,
      lineOf(B).slice(0, -1),
      '',
      lineOf(C).slice(0, -1),
    ];
    const spy = jest.spyOn(JSON, 'parse');

    verifyProcess(rawOf(segments.join('\n')), C.id);

    const parsedSegments = spy.mock.calls
      .map(([text]) => text)
      .filter((text) => segments.includes(text));
    expect(parsedSegments).toEqual(segments);
  });
});

describe('loadVerified', () => {
  test('lê o processo cru da porta uma vez e verifica o que veio', () => {
    const ref: ProcessRef = { project: 'demo', process: 'proc-1' };
    const raw = rawOf(lineOf(A, B));
    const store = { read: jest.fn<(ref: ProcessRef) => RawProcess>().mockReturnValue(raw) };

    const verified = loadVerified(store, ref, A.id);

    expect(store.read).toHaveBeenCalledTimes(1);
    expect(store.read).toHaveBeenCalledWith(ref);
    expect(verified).toEqual(verifyProcess(raw, A.id));
  });
});
