import { describe, expect, jest, test } from '@jest/globals';
import type { AttachmentStatus, Chain } from '../src/chain.ts';
import type { EventLine } from '../src/events.ts';
import { projectTimeline, type TimelineProcess, type UnloadableProcess } from '../src/timeline.ts';
import { at, captureError } from './helpers.ts';

const TARGET = 'hex:target:plano';
const HASH_A = 'a'.repeat(64);
const HASH_B = 'b'.repeat(64);

const okChain = (totalLines: number): Chain => ({
  ok: true,
  totalLines,
  head: '',
  breaks: [],
  totalBreaks: 0,
  repairedLines: [],
});

/** Elo sintético: a projeção não confere hash, só lê os campos. */
function link(
  processName: string,
  seq: number,
  type: string,
  timestamp: string,
  data: Record<string, unknown>,
): EventLine {
  return {
    seq,
    id: `p:${processName}:${type}:${seq}`,
    type,
    timestamp,
    agent: 'hexlog-flow',
    prevHash: '0'.repeat(64),
    data,
  };
}

function processOf(
  name: string,
  lines: EventLine[],
  extra: Partial<TimelineProcess> = {},
): TimelineProcess {
  return {
    name,
    lines,
    chain: okChain(lines.length),
    attachmentStatus: new Map<string, AttachmentStatus>(),
    ...extra,
  };
}

const T1 = '2026-01-01T00:00:01.000Z';
const T2 = '2026-01-01T00:00:02.000Z';
const T3 = '2026-01-01T00:00:03.000Z';

/** Código do erro que `projectTimeline` lança para `targets`. */
function errorCodeFor(targets: string[]): string {
  return captureError(() => projectTimeline([], targets)).code;
}

describe('S3: ordem e cruzamento de processos', () => {
  test('ordena por timestamp e desempata por processo e seq', () => {
    const first = processOf('zeta', [
      link('zeta', 0, 'report', T2, { note: 'z0', target: TARGET }),
      link('zeta', 1, 'report', T2, { note: 'z1', target: TARGET }),
    ]);
    const second = processOf('alfa', [
      link('alfa', 0, 'report', T2, { note: 'a0', target: TARGET }),
      link('alfa', 1, 'report', T1, { note: 'a1', target: TARGET }),
    ]);

    const { entries } = projectTimeline([first, second], [TARGET]);

    expect(entries.map((entry) => [entry.process, entry.seq])).toEqual([
      ['alfa', 1],
      ['alfa', 0],
      ['zeta', 0],
      ['zeta', 1],
    ]);
    expect(entries.map((entry) => entry.at)).toEqual([T1, T2, T2, T2]);
  });

  test('compara o instante, não o texto: sem milissegundos vem antes de .500', () => {
    const lines = [
      link('p', 0, 'report', '2026-01-01T00:00:01.500Z', { target: TARGET }),
      link('p', 1, 'report', '2026-01-01T00:00:01Z', { target: TARGET }),
    ];
    const { entries } = projectTimeline([processOf('p', lines)], [TARGET]);
    expect(entries.map((entry) => entry.seq)).toEqual([1, 0]);
  });

  test('subárvore de target: a.b inclui a.b.c e exclui a.bc; sem target não entra', () => {
    const lines = [
      link('p', 0, 'report', T1, { target: 'hex:target:a.b' }),
      link('p', 1, 'report', T1, { target: 'hex:target:a.b.c' }),
      link('p', 2, 'report', T1, { target: 'hex:target:a.bc' }),
      link('p', 3, 'report', T1, { note: 'sem target' }),
    ];
    const { entries, total } = projectTimeline([processOf('p', lines)], ['hex:target:a.b']);
    expect(entries.map((entry) => entry.target)).toEqual(['hex:target:a.b', 'hex:target:a.b.c']);
    expect(total).toBe(2);
  });

  test('vários targets somam as subárvores', () => {
    const lines = [
      link('p', 0, 'report', T1, { target: 'hex:target:x' }),
      link('p', 1, 'report', T2, { target: 'hex:target:y' }),
      link('p', 2, 'report', T3, { target: 'hex:target:z' }),
    ];
    const { entries } = projectTimeline([processOf('p', lines)], ['hex:target:x', 'hex:target:z']);
    expect(entries.map((entry) => entry.seq)).toEqual([0, 2]);
  });

  test('targets vazio, mais de 20 ou fora do formato → INVALID_INPUT', () => {
    const invalid = [
      [],
      Array.from({ length: 21 }, (_, index) => `hex:target:t${index}`),
      ['plano'],
      ['hex:target:a.'],
    ];
    expect(invalid.map(errorCodeFor)).toEqual(invalid.map(() => 'INVALID_INPUT'));
  });
});

describe('S3: resumo por tipo', () => {
  test('milestone, gate, verdict e custom', () => {
    const lines = [
      link('p', 0, 'milestone', T1, {
        milestoneType: 'plan-drafted',
        target: TARGET,
        decisions: [{ item: 'i', action: 'follow', text: 't' }],
        trace: 'não entra',
      }),
      link('p', 1, 'milestone', T1, {
        milestoneType: 'gate',
        target: TARGET,
        gate: { name: 'no-conflicts', origin: 'builtin', passed: true, evidence: [] },
      }),
      link('p', 2, 'verdict', T2, {
        claim: 'plan-review',
        source: 'oh-my-claudecode:critic',
        result: 'approve',
        evidence: 'ok',
        target: TARGET,
        origin: 'o',
        trace: 't',
      }),
      link('p', 3, 'report', T3, {
        source: 'oh-my-claudecode:architect',
        target: TARGET,
        note: 'n',
        attachment: HASH_A,
      }),
    ];
    const { entries } = projectTimeline(
      [processOf('p', lines, { attachmentStatus: new Map([[HASH_A, 'ok']]) })],
      [TARGET],
    );

    expect(entries.map((entry) => entry.summary)).toEqual([
      {
        milestoneType: 'plan-drafted',
        decisions: [{ item: 'i', action: 'follow', text: 't' }],
      },
      { milestoneType: 'gate', gate: 'no-conflicts', passed: true },
      { claim: 'plan-review', result: 'approve', evidence: 'ok' },
      { note: 'n' },
    ]);
    expect(entries.map((entry) => [entry.source, entry.result])).toEqual([
      [undefined, undefined],
      [undefined, undefined],
      ['oh-my-claudecode:critic', 'approve'],
      ['oh-my-claudecode:architect', undefined],
    ]);
  });
});

describe('S3: superados', () => {
  test('supersedes de Verdict e de evento custom geram supersededBy; um custom nunca marca um Verdict', () => {
    const lines = [
      link('p', 0, 'verdict', T1, {
        claim: 'c',
        result: 'r',
        evidence: 'e',
        source: 's',
        target: TARGET,
      }),
      link('p', 1, 'verdict', T2, {
        claim: 'c',
        result: 'r',
        evidence: 'e',
        source: 's',
        target: TARGET,
        supersedes: ['p:p:verdict:0'],
      }),
      link('p', 2, 'report', T1, { target: TARGET }),
      link('p', 3, 'report', T2, { target: TARGET, supersedes: ['p:p:report:2'] }),
      // adulterado à mão: um custom citando um Verdict não o marca como superado
      link('p', 4, 'report', T3, { target: TARGET, supersedes: ['p:p:verdict:1'] }),
    ];
    const { entries } = projectTimeline([processOf('p', lines)], [TARGET]);

    const bySeq = Object.fromEntries(entries.map((entry) => [entry.seq, entry]));
    expect(at(entries, 0).supersededBy).toEqual(['p:p:verdict:1']);
    expect(bySeq[1]?.supersededBy).toBeUndefined();
    expect(bySeq[2]?.supersededBy).toEqual(['p:p:report:3']);
    expect(bySeq[3]?.supersedes).toEqual(['p:p:report:2']);
  });

  test('o superado aparece em outro processo do projeto', () => {
    const first = processOf('a', [link('a', 0, 'report', T1, { target: TARGET })]);
    const second = processOf('b', [
      link('b', 0, 'report', T2, { target: TARGET, supersedes: ['p:a:report:0'] }),
    ]);
    const { entries } = projectTimeline([first, second], [TARGET]);
    expect(at(entries, 0).supersededBy).toEqual(['p:b:report:0']);
  });

  test('supersedes para id ausente → SUPERSEDES_DANGLING', () => {
    const lines = [link('p', 0, 'report', T1, { target: TARGET, supersedes: ['p:p:report:99'] })];
    const { warnings } = projectTimeline([processOf('p', lines)], [TARGET]);
    expect(warnings).toEqual([
      expect.objectContaining({
        code: 'SUPERSEDES_DANGLING',
        details: { id: 'p:p:report:0', missing: ['p:p:report:99'] },
      }),
    ]);
  });
});

describe('S3/Q2: anexos e cadeia sem full', () => {
  const lines = [link('p', 0, 'report', T1, { target: TARGET, attachment: HASH_A })];

  test.each<[AttachmentStatus, string | undefined]>([
    ['ok', undefined],
    ['missing', 'ATTACHMENT_MISSING'],
    ['corrupted', 'ATTACHMENT_CORRUPTED'],
  ])('status %s aparece em attachment.status e vira aviso %s, sem full', (status, code) => {
    const input = processOf('p', lines, { attachmentStatus: new Map([[HASH_A, status]]) });
    const { entries, warnings } = projectTimeline([input], [TARGET]);

    expect(at(entries, 0).attachment).toEqual({ hash: HASH_A, status });
    expect(warnings.map((warning) => warning.code)).toEqual(code === undefined ? [] : [code]);
  });

  test('hash fora do mapa de status não é tratado como anexo', () => {
    const { entries } = projectTimeline([processOf('p', lines)], [TARGET]);
    expect(at(entries, 0).attachment).toBeUndefined();
  });

  test('cadeia quebrada aparece em processes[] e como CHAIN_BROKEN, com no máximo 20 quebras', () => {
    const breaks = Array.from({ length: 30 }, (_, index) => ({
      index,
      reason: 'hash-mismatch' as const,
    }));
    const broken: TimelineProcess = {
      ...processOf('p', lines),
      chain: { ...okChain(1), ok: false, breaks, totalBreaks: 30 },
    };
    const { processes, warnings } = projectTimeline([broken, processOf('q', [])], [TARGET]);

    expect(processes.map((entry) => [entry.process, entry.chain.ok])).toEqual([
      ['p', false],
      ['q', true],
    ]);
    expect(at(processes, 0).chain.breaks).toHaveLength(20);
    expect(at(processes, 0).chain.totalBreaks).toBe(30);
    expect(warnings.map((warning) => warning.code)).toEqual(['CHAIN_BROKEN']);
  });

  test('processo que não carregou vira PROCESS_CORRUPTED e não entra em processes[]', () => {
    const unloadable: UnloadableProcess = { name: 'x', error: 'schemas hash does not match' };
    const { processes, warnings } = projectTimeline([unloadable, processOf('p', lines)], [TARGET]);

    expect(processes.map((entry) => entry.process)).toEqual(['p']);
    expect(warnings).toEqual([
      { code: 'PROCESS_CORRUPTED', message: "process 'x': schemas hash does not match" },
    ]);
  });

  test('150 avisos → 100 no array e warningsTotal 150', () => {
    const many = Array.from({ length: 150 }, (_, seq) =>
      link('p', seq, 'report', T1, { target: TARGET, attachment: HASH_B }),
    );
    const input = processOf('p', many, { attachmentStatus: new Map([[HASH_B, 'missing']]) });
    const { warnings, warningsTotal } = projectTimeline([input], [TARGET]);

    expect(warnings).toHaveLength(100);
    expect(warningsTotal).toBe(150);
  });
});

describe('S3: full e tetos', () => {
  const text = 'x'.repeat(100);
  const lines = [link('p', 0, 'report', T1, { target: TARGET, attachment: HASH_A })];
  const input = processOf('p', lines, {
    attachmentStatus: new Map([[HASH_A, 'ok']]),
    readAttachmentText: (hash) => (hash === HASH_A ? text : undefined),
  });

  test('sem full não expõe texto, mesmo com o texto carregado', () => {
    const { entries } = projectTimeline([input], [TARGET]);
    expect(at(entries, 0).attachment).toEqual({ hash: HASH_A, status: 'ok' });
  });

  test('com full traz o texto inteiro e os bytes', () => {
    const { entries } = projectTimeline([input], [TARGET], { full: true });
    expect(at(entries, 0).attachment).toEqual({ hash: HASH_A, status: 'ok', bytes: 100, text });
  });

  test('teto por entrada: corta, marca truncated e aponta nextOffset', () => {
    const { entries } = projectTimeline([input], [TARGET], { full: true, entryTextCap: 30 });
    expect(at(entries, 0).attachment).toEqual({
      hash: HASH_A,
      status: 'ok',
      bytes: 100,
      text: 'x'.repeat(30),
      truncated: true,
      nextOffset: 30,
    });
  });

  test('full não traz texto de anexo ausente ou adulterado', () => {
    const broken = processOf('p', lines, { attachmentStatus: new Map([[HASH_A, 'corrupted']]) });
    const { entries } = projectTimeline([broken], [TARGET], { full: true });
    expect(at(entries, 0).attachment).toEqual({ hash: HASH_A, status: 'corrupted' });
  });
});

describe('S3: leitura preguiçosa do texto dos anexos', () => {
  const hashOf = (seq: number) => String(seq).repeat(64);
  const lines = Array.from({ length: 6 }, (_, seq) =>
    link('p', seq, 'report', `2026-01-01T00:00:0${seq}.000Z`, {
      target: TARGET,
      attachment: hashOf(seq),
    }),
  );
  const statuses = new Map<string, AttachmentStatus>(lines.map((_, seq) => [hashOf(seq), 'ok']));

  function inputWith(reader: (hash: string) => string | undefined): TimelineProcess {
    return processOf('p', lines, { attachmentStatus: statuses, readAttachmentText: reader });
  }

  test('com full lê só as entradas da página (since e limit), na ordem', () => {
    const reader = jest.fn((hash: string) => `texto ${hash.slice(0, 1)}`);

    const { entries } = projectTimeline([inputWith(reader)], [TARGET], {
      full: true,
      since: 1,
      limit: 2,
    });

    expect(reader.mock.calls.map(([hash]) => hash)).toEqual([hashOf(1), hashOf(2)]);
    expect(entries.map((entry) => entry.attachment?.text)).toEqual(['texto 1', 'texto 2']);
  });

  test('sem full o leitor nunca é chamado', () => {
    const reader = jest.fn(() => 'texto');

    projectTimeline([inputWith(reader)], [TARGET]);

    expect(reader).not.toHaveBeenCalled();
  });

  test('só lê blob de anexo íntegro', () => {
    const reader = jest.fn(() => 'texto');
    const broken = new Map(statuses).set(hashOf(0), 'corrupted').set(hashOf(1), 'missing');

    projectTimeline(
      [processOf('p', lines, { attachmentStatus: broken, readAttachmentText: reader })],
      [TARGET],
      {
        full: true,
        limit: 2,
      },
    );

    expect(reader).not.toHaveBeenCalled();
  });

  test('com o teto de caracteres da página lê no máximo um blob a mais que o devolvido', () => {
    const reader = jest.fn(() => 'y'.repeat(500));

    const { entries } = projectTimeline([inputWith(reader)], [TARGET], {
      full: true,
      pageCharsCap: 1_500,
    });

    expect(entries.length).toBeLessThan(6);
    expect(reader).toHaveBeenCalledTimes(entries.length + 1);
  });
});

describe('S3: paginação', () => {
  const lines = Array.from({ length: 5 }, (_, seq) =>
    link('p', seq, 'report', `2026-01-01T00:00:0${seq}.000Z`, {
      target: TARGET,
      note: 'n'.repeat(50),
    }),
  );
  const input = processOf('p', lines);

  test('limit e since caminham com nextCursor até null', () => {
    const page1 = projectTimeline([input], [TARGET], { limit: 2 });
    expect(page1.entries.map((entry) => entry.seq)).toEqual([0, 1]);
    expect(page1.nextCursor).toBe(2);
    expect(page1.total).toBe(5);

    const page3 = projectTimeline([input], [TARGET], { limit: 2, since: 4 });
    expect(page3.entries.map((entry) => entry.seq)).toEqual([4]);
    expect(page3.nextCursor).toBeNull();
  });

  test('teto de caracteres da página corta e marca truncatedByCharCap', () => {
    const size = JSON.stringify(at(projectTimeline([input], [TARGET]).entries, 0)).length;
    const page = projectTimeline([input], [TARGET], { pageCharsCap: size * 2 + 10 });

    expect(page.entries).toHaveLength(2);
    expect(page.truncatedByCharCap).toBe(true);
    expect(page.nextCursor).toBe(2);
  });

  test('a primeira entrada entra mesmo acima do teto', () => {
    const page = projectTimeline([input], [TARGET], { pageCharsCap: 10 });
    expect(page.entries).toHaveLength(1);
    expect(page.truncatedByCharCap).toBe(true);
    expect(page.nextCursor).toBe(1);
  });

  test('sem teto e sem limit devolve tudo, sem truncatedByCharCap', () => {
    const page = projectTimeline([input], [TARGET]);
    expect(page.entries).toHaveLength(5);
    expect(page.truncatedByCharCap).toBeUndefined();
    expect(page.nextCursor).toBeNull();
  });
});

describe('S3: pureza', () => {
  test('não muda a entrada', () => {
    const lines = [
      link('p', 0, 'report', T1, { target: TARGET, attachment: HASH_A }),
      link('p', 1, 'report', T2, { target: TARGET, supersedes: ['p:p:report:0'] }),
    ];
    const input = processOf('p', lines, {
      attachmentStatus: new Map([[HASH_A, 'ok']]),
      readAttachmentText: () => 'texto',
    });
    const { lines: linesBefore, chain, attachmentStatus } = input;
    const before = structuredClone({ lines: linesBefore, chain, attachmentStatus });

    projectTimeline([input], [TARGET], { full: true });

    expect({
      lines: input.lines,
      chain: input.chain,
      attachmentStatus: input.attachmentStatus,
    }).toEqual(before);
  });
});
