import { describe, test, expect, jest } from '@jest/globals';
import {
  evaluateGate,
  GateQuestion,
  matchesSelector,
  matchesTargetPrefix,
  Selector,
} from '../../src/domain/gate.ts';
import type { GateInput, GateScope } from '../../src/domain/gate.ts';
import { Gate, RecordType, RelationName } from '../../src/domain/definitions.ts';
import type { HexRecord, RelationKind } from '../../src/domain/record.ts';
import * as omc from '../fixtures/domains/omc.ts';
import * as rdsc from '../fixtures/domains/rdsc.ts';

const id = (process: string, n: number) => `${process}:${String(n).padStart(8, '0')}`;

type Extra = { target?: string; data?: HexRecord['data'] };

function rec(
  recordId: string,
  type: string,
  relations: [RelationKind, string][] = [],
  { target = 'feature', data = {} }: Extra = {},
): HexRecord {
  return {
    id: recordId,
    type,
    at: '2026-09-30T12:00:00.000Z',
    target,
    author: { agent: 'tester', client: 'jest' },
    data,
    relations: relations.map(([kind, to]) => ({ kind, to })),
  };
}

type SpiedInput = GateInput & { records: jest.Mock<GateInput['records']> };

/** Leitura em que os dois alcances devolvem os mesmos registros. */
const reading = (records: HexRecord[], target?: string): SpiedInput => ({
  target,
  records: jest.fn<GateInput['records']>(() => records),
});

const question = (raw: unknown) => GateQuestion.parse(raw);

const [p1, p2, p3, p4, p5] = [id('p', 1), id('p', 2), id('p', 3), id('p', 4), id('p', 5)];

describe('Selector e GateQuestion (schemas)', () => {
  test('where aceita só valor escalar', () => {
    expect(Selector.safeParse({ where: { a: 'x', b: 2, c: true } }).success).toBe(true);
    expect(Selector.safeParse({ where: { a: { gte: 2 } } }).success).toBe(false);
    expect(Selector.safeParse({ where: { a: null } }).success).toBe(false);
    expect(Selector.safeParse({ where: { a: [1] } }).success).toBe(false);
  });

  test('o seletor recusa chave desconhecida, nome inválido e prefixo inválido', () => {
    expect(Selector.safeParse({ kind: 'plan' }).success).toBe(false);
    expect(Selector.safeParse({ type: 'Plan' }).success).toBe(false);
    expect(Selector.safeParse({ targetPrefix: 'a.' }).success).toBe(false);
  });

  test('cada kind tem a sua forma, e o que não é do catálogo é recusado', () => {
    const valid = [
      { kind: 'approved', of: {}, by: { type: 'review' }, scope: 'project' },
      { kind: 'occurred', select: { type: 'review' }, min: 2 },
      { kind: 'no_pending', pending: {}, resolvedBy: { kind: 'answers', from: ['review'] } },
      { kind: 'no_open_contradiction' },
      { kind: 'no_open_contradiction', of: { type: 'plan' } },
    ];
    expect(valid.map((raw) => GateQuestion.safeParse(raw).success)).toEqual(valid.map(() => true));

    const invalid = [
      { kind: 'overdue', of: {} },
      { kind: 'approved' },
      { kind: 'occurred', select: {}, min: 0 },
      { kind: 'occurred', select: {}, dueAt: '2026-01-01T00:00:00Z' },
      { kind: 'no_pending', pending: {}, resolvedBy: { kind: 'unknown' } },
      { kind: 'no_pending', pending: {}, resolvedBy: { kind: 'answers', from: [] } },
      { kind: 'occurred', select: {}, scope: 'global' },
    ];
    expect(invalid.map((raw) => GateQuestion.safeParse(raw).success)).toEqual(
      invalid.map(() => false),
    );
  });
});

describe('seleção de registros', () => {
  test('matchesTargetPrefix mantém a fronteira em ponto', () => {
    expect(matchesTargetPrefix('a.b', 'a.b')).toBe(true);
    expect(matchesTargetPrefix('a.b.c', 'a.b')).toBe(true);
    expect(matchesTargetPrefix('a.bc', 'a.b')).toBe(false);
    expect(matchesTargetPrefix('a', 'a.b')).toBe(false);
  });

  test('type, targetPrefix e where se combinam por igualdade', () => {
    const record = rec(p1, 'plan', [], { target: 'a.b', data: { isRevision: true, round: 2 } });
    expect(matchesSelector(record, {})).toBe(true);
    expect(matchesSelector(record, { type: 'plan', targetPrefix: 'a' })).toBe(true);
    expect(matchesSelector(record, { where: { isRevision: true, round: 2 } })).toBe(true);
    expect(matchesSelector(record, { type: 'review' })).toBe(false);
    expect(matchesSelector(record, { targetPrefix: 'a.c' })).toBe(false);
    expect(matchesSelector(record, { where: { isRevision: 'true' } })).toBe(false);
    expect(matchesSelector(record, { where: { missing: false } })).toBe(false);
  });

  test('targetPrefix omitido herda o target da avaliação, e o próprio prevalece', () => {
    const record = rec(p1, 'plan', [], { target: 'a.b' });
    expect(matchesSelector(record, {}, 'a.b')).toBe(true);
    expect(matchesSelector(record, {}, 'a.c')).toBe(false);
    expect(matchesSelector(record, { targetPrefix: 'a' }, 'a.c')).toBe(true);
  });
});

describe('occurred', () => {
  const q = (min?: number) => question({ kind: 'occurred', select: { type: 'review' }, min });

  test('passa com ao menos um registro vigente (min padrão 1) e devolve os ids', () => {
    const records = [rec(p1, 'review'), rec(p2, 'plan')];
    expect(evaluateGate([q()], reading(records)).questions[0]).toEqual({
      index: 0,
      kind: 'occurred',
      passed: true,
      evidence: { found: [p1] },
    });
    expect(evaluateGate([q()], reading([rec(p2, 'plan')])).passed).toBe(false);
  });

  test('min exige a quantidade, e registro substituído ou revogado não conta', () => {
    const records = [rec(p1, 'review'), rec(p2, 'review'), rec(p3, 'review', [['revokes', p2]])];
    expect(evaluateGate([q(2)], reading(records)).questions[0]?.evidence).toEqual({
      found: [p1, p3],
    });
    expect(evaluateGate([q(2)], reading(records)).passed).toBe(true);
    expect(evaluateGate([q(3)], reading(records)).passed).toBe(false);
  });

  test('where de igualdade filtra o campo de data, como no gate de revisão', () => {
    const records = [
      rec(p1, 'plan', [], { data: { isRevision: false } }),
      rec(p2, 'plan', [['supersedes', p1]], { data: { isRevision: true } }),
    ];
    const revised = question({ kind: 'occurred', select: { where: { isRevision: true } } });
    const original = question({ kind: 'occurred', select: { where: { isRevision: false } } });
    expect(evaluateGate([revised], reading(records)).passed).toBe(true);
    expect(evaluateGate([original], reading(records)).passed).toBe(false);
  });

  test('o target da avaliação restringe o que conta', () => {
    const records = [rec(p1, 'review', [], { target: 'a.b' })];
    expect(evaluateGate([q()], reading(records, 'a')).passed).toBe(true);
    expect(evaluateGate([q()], reading(records, 'c')).passed).toBe(false);
  });
});

describe('approved', () => {
  const q = question({ kind: 'approved', of: { type: 'plan' }, by: { type: 'review' } });

  test('passa quando todo vigente em of tem apoio vigente que casa by, sem contradição', () => {
    const records = [rec(p1, 'plan'), rec(p2, 'review', [['supports', p1]])];
    expect(evaluateGate([q], reading(records)).questions[0]).toEqual({
      index: 0,
      kind: 'approved',
      passed: true,
      evidence: { of: [p1], supports: [p2], contradictions: [], unsupported: [] },
    });
  });

  test('pendente: sem registro em of, ou com registro sem apoio', () => {
    expect(evaluateGate([q], reading([])).passed).toBe(false);
    const result = evaluateGate([q], reading([rec(p1, 'plan')])).questions[0];
    expect(result?.passed).toBe(false);
    expect(result?.evidence).toEqual({
      of: [p1],
      supports: [],
      contradictions: [],
      unsupported: [p1],
    });
  });

  test('todo vigente em of precisa de apoio, não basta um', () => {
    const records = [
      rec(p1, 'plan', [], { target: 'a' }),
      rec(p2, 'plan', [], { target: 'b' }),
      rec(p3, 'review', [['supports', p1]]),
    ];
    const result = evaluateGate([q], reading(records)).questions[0];
    expect(result?.passed).toBe(false);
    expect(result?.evidence).toMatchObject({ unsupported: [p2] });
  });

  test('apoio de tipo que não casa by não conta', () => {
    const records = [rec(p1, 'plan'), rec(p2, 'deviation', [['supports', p1]])];
    expect(evaluateGate([q], reading(records)).passed).toBe(false);
  });

  test('sem by, qualquer apoio vigente serve', () => {
    const open = question({ kind: 'approved', of: { type: 'plan' } });
    const records = [rec(p1, 'plan'), rec(p2, 'deviation', [['supports', p1]])];
    expect(evaluateGate([open], reading(records)).passed).toBe(true);
  });

  test('recusado: contradição vigente reprova e aparece na evidência', () => {
    const records = [
      rec(p1, 'plan'),
      rec(p2, 'review', [['supports', p1]]),
      rec(p3, 'review', [['contradicts', p1]]),
    ];
    const result = evaluateGate([q], reading(records)).questions[0];
    expect(result?.passed).toBe(false);
    expect(result?.evidence).toMatchObject({ supports: [p2], contradictions: [p3] });
  });

  test('contradição e apoio de registro que deixou de ser vigente não contam', () => {
    const records = [
      rec(p1, 'plan'),
      rec(p2, 'review', [['supports', p1]]),
      rec(p3, 'review', [['contradicts', p1]]),
      rec(p4, 'review', [['revokes', p3]]),
    ];
    expect(evaluateGate([q], reading(records)).passed).toBe(true);

    const withdrawn = [...records, rec(p5, 'review', [['revokes', p2]])];
    expect(evaluateGate([q], reading(withdrawn)).passed).toBe(false);
  });

  test('plano substituído sai de of: a revisão vigente precisa da própria aprovação', () => {
    const approvedOriginal = [rec(p1, 'plan'), rec(p2, 'review', [['supports', p1]])];
    const revised = [...approvedOriginal, rec(p3, 'plan', [['supersedes', p1]])];
    const result = evaluateGate([q], reading(revised)).questions[0];
    expect(result?.passed).toBe(false);
    expect(result?.evidence).toMatchObject({ of: [p3], unsupported: [p3] });

    const reapproved = [...revised, rec(p4, 'review', [['supports', p3]])];
    expect(evaluateGate([q], reading(reapproved)).passed).toBe(true);
  });
});

describe('no_pending', () => {
  const q = question({
    kind: 'no_pending',
    pending: { type: 'deviation' },
    resolvedBy: { kind: 'answers' },
  });

  test('vale por vacuidade quando não há pendente', () => {
    expect(evaluateGate([q], reading([rec(p1, 'plan')])).questions[0]).toEqual({
      index: 0,
      kind: 'no_pending',
      passed: true,
      evidence: { unresolved: [] },
    });
  });

  test('reprova e lista o pendente sem resolução', () => {
    const records = [
      rec(p1, 'deviation'),
      rec(p2, 'deviation'),
      rec(p3, 'plan', [['answers', p2]]),
    ];
    const result = evaluateGate([q], reading(records)).questions[0];
    expect(result?.passed).toBe(false);
    expect(result?.evidence).toEqual({ unresolved: [p1] });
  });

  test('resolução de outro kind não serve, e a de registro não vigente também', () => {
    const wrongKind = [rec(p1, 'deviation'), rec(p2, 'plan', [['supports', p1]])];
    expect(evaluateGate([q], reading(wrongKind)).passed).toBe(false);

    const revoked = [
      rec(p1, 'deviation'),
      rec(p2, 'plan', [['answers', p1]]),
      rec(p3, 'plan', [['revokes', p2]]),
    ];
    expect(evaluateGate([q], reading(revoked)).passed).toBe(false);
  });

  test('from restringe o tipo de quem resolve', () => {
    const fromReview = question({
      kind: 'no_pending',
      pending: { type: 'deviation' },
      resolvedBy: { kind: 'answers', from: ['review'] },
    });
    const byPlan = [rec(p1, 'deviation'), rec(p2, 'plan', [['answers', p1]])];
    const byReview = [rec(p1, 'deviation'), rec(p2, 'review', [['answers', p1]])];
    expect(evaluateGate([fromReview], reading(byPlan)).passed).toBe(false);
    expect(evaluateGate([fromReview], reading(byReview)).passed).toBe(true);
  });
});

describe('no_open_contradiction', () => {
  test('reprova quando um vigente tem contradição vigente, e lista os contradizidos', () => {
    const q = question({ kind: 'no_open_contradiction' });
    const records = [rec(p1, 'plan'), rec(p2, 'plan'), rec(p3, 'review', [['contradicts', p2]])];
    const result = evaluateGate([q], reading(records)).questions[0];
    expect(result?.passed).toBe(false);
    expect(result?.evidence).toEqual({ conflicting: [p2] });
  });

  test('passa quando a contradição foi revogada ou o contradito deixou de ser vigente', () => {
    const q = question({ kind: 'no_open_contradiction' });
    const revoked = [
      rec(p1, 'plan'),
      rec(p2, 'review', [['contradicts', p1]]),
      rec(p3, 'review', [['revokes', p2]]),
    ];
    const replaced = [
      rec(p1, 'plan'),
      rec(p2, 'review', [['contradicts', p1]]),
      rec(p3, 'plan', [['supersedes', p1]]),
    ];
    expect(evaluateGate([q], reading(revoked)).passed).toBe(true);
    expect(evaluateGate([q], reading(replaced)).passed).toBe(true);
  });

  test('of restringe o que é conferido', () => {
    const q = question({ kind: 'no_open_contradiction', of: { type: 'plan' } });
    const records = [rec(p1, 'review'), rec(p2, 'plan', [['contradicts', p1]])];
    expect(evaluateGate([q], reading(records)).passed).toBe(true);
  });
});

describe('alcance (D-24)', () => {
  const plan = rec(id('p', 1), 'plan');
  const foreignReview = rec(id('other', 1), 'review', [['supports', plan.id]]);
  const q = (scope: GateScope) =>
    question({ kind: 'approved', of: { type: 'plan' }, by: { type: 'review' }, scope });

  const scoped = (): SpiedInput => ({
    records: jest.fn<GateInput['records']>((scope) =>
      scope === 'project' ? [plan, foreignReview] : [plan],
    ),
  });

  test('alcance processo não enxerga apoio vindo de outro processo, e o projeto enxerga', () => {
    expect(evaluateGate([q('process')], scoped()).passed).toBe(false);
    expect(evaluateGate([q('project')], scoped()).passed).toBe(true);
  });

  test('sem scope vale process, e o alcance project só é lido se alguma pergunta o declara', () => {
    const input = scoped();
    evaluateGate([question({ kind: 'occurred', select: {} })], input);
    expect(input.records).toHaveBeenCalledTimes(1);
    expect(input.records).toHaveBeenCalledWith('process');

    const mixed = scoped();
    evaluateGate([q('process'), q('project'), q('project')], mixed);
    expect(mixed.records).toHaveBeenCalledTimes(2);
    expect(mixed.records).toHaveBeenCalledWith('project');
  });
});

describe('resultado', () => {
  test('passa só se toda pergunta passa, e cada resultado leva o índice e o kind', () => {
    const questions = [
      question({ kind: 'occurred', select: { type: 'plan' } }),
      question({ kind: 'occurred', select: { type: 'review' } }),
    ];
    const result = evaluateGate(questions, reading([rec(p1, 'plan')]));
    expect(result.passed).toBe(false);
    expect(result.questions.map(({ index, kind, passed }) => ({ index, kind, passed }))).toEqual([
      { index: 0, kind: 'occurred', passed: true },
      { index: 1, kind: 'occurred', passed: false },
    ]);
  });

  test('gate sem perguntas passa e não lê registro', () => {
    const input = reading([]);
    expect(evaluateGate([], input)).toEqual({ passed: true, questions: [] });
    expect(input.records).not.toHaveBeenCalled();
  });
});

describe('gate plano-pronto (fixture omc)', () => {
  const questions = Gate.parse(omc.gates[0]).questions;
  const plan = (n: number, relations: [RelationKind, string][] = [], isRevision = false) =>
    rec(id('p', n), 'plan', relations, { data: { isRevision, diff: 'd' } });
  const review = (n: number, kind: RelationKind, to: string) =>
    rec(id('p', n), 'review', [[kind, to]]);
  const deviation = (n: number) => rec(id('p', n), 'deviation', [], { data: { description: 'x' } });

  test('aprovação vigente sem desvio aberto passa', () => {
    const records = [plan(1), review(2, 'supports', p1)];
    expect(evaluateGate(questions, reading(records)).passed).toBe(true);
  });

  test('desvio sem desfecho reprova, e answers fecha', () => {
    const records = [plan(1), review(2, 'supports', p1), deviation(3)];
    const open = evaluateGate(questions, reading(records));
    expect(open.passed).toBe(false);
    expect(open.questions.map(({ passed }) => passed)).toEqual([true, false]);

    const settled = [...records, rec(p4, 'review', [['answers', p3]])];
    expect(evaluateGate(questions, reading(settled)).passed).toBe(true);
  });

  test('a revisão vigente precisa da própria aprovação; a da versão substituída não vale', () => {
    const original = [plan(1), review(2, 'supports', p1)];
    const revised = [...original, plan(3, [['supersedes', p1]], true)];
    expect(evaluateGate(questions, reading(revised)).passed).toBe(false);

    const reapproved = [...revised, review(4, 'supports', p3)];
    expect(evaluateGate(questions, reading(reapproved)).passed).toBe(true);
  });

  test('revisão aprovada e depois substituída por outra sem aprovação volta a reprovar', () => {
    const records = [
      plan(1),
      review(2, 'supports', p1),
      plan(3, [['supersedes', p1]], true),
      review(4, 'supports', p3),
      plan(5, [['supersedes', p3]], true),
    ];
    const result = evaluateGate(questions, reading(records)).questions[0];
    expect(result?.passed).toBe(false);
    expect(result?.evidence).toMatchObject({ of: [p5], unsupported: [p5] });
  });
});

describe('fixtures de domínio', () => {
  test.each([
    ['omc', omc],
    ['rdsc', rdsc],
  ])('%s é validável pelos schemas de definitions.ts', (_name, domain) => {
    for (const schema of Object.values(domain.types)) {
      expect(RecordType.safeParse(schema).success).toBe(true);
    }
    for (const relation of domain.relations) {
      expect(RelationName.safeParse(relation).success).toBe(true);
    }
    for (const gate of domain.gates) {
      expect(Gate.safeParse(gate).success).toBe(true);
    }
  });

  test('omc declara approves/settles e rdsc declara based-on/replaces', () => {
    expect(omc.relations.map(({ name, kind }) => [name, kind])).toEqual([
      ['approves', 'supports'],
      ['settles', 'answers'],
    ]);
    expect(rdsc.relations.map(({ name, kind }) => [name, kind])).toEqual([
      ['based-on', 'supports'],
      ['replaces', 'supersedes'],
    ]);
  });

  test('o gate do rdsc avalia sobre veredito e evidência', () => {
    const questions = Gate.parse(rdsc.gates[0]).questions;
    const records = [rec(p1, 'evidence'), rec(p2, 'verdict', [['supports', p1]])];
    expect(evaluateGate(questions, reading(records)).passed).toBe(true);
    expect(evaluateGate(questions, reading([rec(p1, 'evidence')])).passed).toBe(false);
  });
});
