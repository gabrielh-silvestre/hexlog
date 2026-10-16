import { describe, test, expect, jest } from '@jest/globals';
import {
  evaluateGate,
  GateQuestion,
  matchesSelector,
  matchesTargetPrefix,
  Selector,
  summarizeQuestion,
} from '../../src/domain/gate.ts';
import type { GateInput, GateScope, QuestionResult } from '../../src/domain/gate.ts';
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

describe('Selector and GateQuestion (schemas)', () => {
  test('where accepts only a scalar value', () => {
    expect(Selector.safeParse({ where: { a: 'x', b: 2, c: true } }).success).toBe(true);
    expect(Selector.safeParse({ where: { a: { gte: 2 } } }).success).toBe(false);
    expect(Selector.safeParse({ where: { a: null } }).success).toBe(false);
    expect(Selector.safeParse({ where: { a: [1] } }).success).toBe(false);
  });

  test('the selector refuses an unknown key, an invalid name and an invalid prefix', () => {
    expect(Selector.safeParse({ kind: 'plan' }).success).toBe(false);
    expect(Selector.safeParse({ type: 'Plan' }).success).toBe(false);
    expect(Selector.safeParse({ targetPrefix: 'a.' }).success).toBe(false);
  });

  test('each kind has its own shape, and anything outside the catalog is refused', () => {
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
      { kind: 'no_pending', pending: {}, resolvedBy: { kind: 'answers', from: ['a', 'a'] } },
      { kind: 'occurred', select: {}, scope: 'global' },
    ];
    expect(invalid.map((raw) => GateQuestion.safeParse(raw).success)).toEqual(
      invalid.map(() => false),
    );
  });
});

describe('record selection', () => {
  test('matchesTargetPrefix keeps the boundary at the dot', () => {
    expect(matchesTargetPrefix('a.b', 'a.b')).toBe(true);
    expect(matchesTargetPrefix('a.b.c', 'a.b')).toBe(true);
    expect(matchesTargetPrefix('a.bc', 'a.b')).toBe(false);
    expect(matchesTargetPrefix('a', 'a.b')).toBe(false);
  });

  test('type, targetPrefix and where combine by equality', () => {
    const record = rec(p1, 'plan', [], { target: 'a.b', data: { isRevision: true, round: 2 } });
    expect(matchesSelector(record, {})).toBe(true);
    expect(matchesSelector(record, { type: 'plan', targetPrefix: 'a' })).toBe(true);
    expect(matchesSelector(record, { where: { isRevision: true, round: 2 } })).toBe(true);
    expect(matchesSelector(record, { type: 'review' })).toBe(false);
    expect(matchesSelector(record, { targetPrefix: 'a.c' })).toBe(false);
    expect(matchesSelector(record, { where: { isRevision: 'true' } })).toBe(false);
    expect(matchesSelector(record, { where: { missing: false } })).toBe(false);
  });

  // `where` compara por identidade: nenhuma coerção entre número, string e booleano.
  test.each([
    ['number against boolean', { n: 1 }, { n: true }],
    ['string against number', { n: '1' }, { n: 1 }],
    ['zero against false', { n: 0 }, { n: false }],
  ])('where does not coerce types: %s', (_label, data, where) => {
    expect(matchesSelector(rec(p1, 'plan', [], { data }), { where })).toBe(false);
  });

  test('an omitted targetPrefix inherits the evaluation target, and its own prevails', () => {
    const record = rec(p1, 'plan', [], { target: 'a.b' });
    expect(matchesSelector(record, {}, 'a.b')).toBe(true);
    expect(matchesSelector(record, {}, 'a.c')).toBe(false);
    expect(matchesSelector(record, { targetPrefix: 'a' }, 'a.c')).toBe(true);
  });
});

describe('occurred', () => {
  const q = (min?: number) => question({ kind: 'occurred', select: { type: 'review' }, min });

  test('passes with at least one current record (default min 1) and returns the ids', () => {
    const records = [rec(p1, 'review'), rec(p2, 'plan')];
    expect(evaluateGate([q()], reading(records)).questions[0]).toEqual({
      index: 0,
      kind: 'occurred',
      passed: true,
      evidence: { found: [p1] },
    });
    expect(evaluateGate([q()], reading([rec(p2, 'plan')])).passed).toBe(false);
  });

  test('min requires the count, and a superseded or revoked record does not count', () => {
    const records = [rec(p1, 'review'), rec(p2, 'review'), rec(p3, 'review', [['revokes', p2]])];
    expect(evaluateGate([q(2)], reading(records)).questions[0]?.evidence).toEqual({
      found: [p1, p3],
    });
    expect(evaluateGate([q(2)], reading(records)).passed).toBe(true);
    expect(evaluateGate([q(3)], reading(records)).passed).toBe(false);
  });

  test('an equality where filters the data field, as in the revision gate', () => {
    const records = [
      rec(p1, 'plan', [], { data: { isRevision: false } }),
      rec(p2, 'plan', [['supersedes', p1]], { data: { isRevision: true } }),
    ];
    const revised = question({ kind: 'occurred', select: { where: { isRevision: true } } });
    const original = question({ kind: 'occurred', select: { where: { isRevision: false } } });
    expect(evaluateGate([revised], reading(records)).passed).toBe(true);
    expect(evaluateGate([original], reading(records)).passed).toBe(false);
  });

  test('the evaluation target restricts what counts', () => {
    const records = [rec(p1, 'review', [], { target: 'a.b' })];
    expect(evaluateGate([q()], reading(records, 'a')).passed).toBe(true);
    expect(evaluateGate([q()], reading(records, 'c')).passed).toBe(false);
  });
});

describe('approved', () => {
  const q = question({ kind: 'approved', of: { type: 'plan' }, by: { type: 'review' } });

  test('passes when every current record in of has a current support matching by, with no contradiction', () => {
    const records = [rec(p1, 'plan'), rec(p2, 'review', [['supports', p1]])];
    expect(evaluateGate([q], reading(records)).questions[0]).toEqual({
      index: 0,
      kind: 'approved',
      passed: true,
      evidence: { of: [p1], supports: [p2], contradictions: [], unsupported: [] },
    });
  });

  test('pending: no record in of, or a record without support', () => {
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

  test('every current record in of needs support, one is not enough', () => {
    const records = [
      rec(p1, 'plan', [], { target: 'a' }),
      rec(p2, 'plan', [], { target: 'b' }),
      rec(p3, 'review', [['supports', p1]]),
    ];
    const result = evaluateGate([q], reading(records)).questions[0];
    expect(result?.passed).toBe(false);
    expect(result?.evidence).toMatchObject({ unsupported: [p2] });
  });

  test('by without targetPrefix inherits the evaluation target, and support outside it does not count', () => {
    const plan = rec(p1, 'plan', [], { target: 'a.b' });
    const outside = [plan, rec(p2, 'review', [['supports', p1]], { target: 'c' })];
    const inside = [plan, rec(p2, 'review', [['supports', p1]], { target: 'a.c' })];
    expect(evaluateGate([q], reading(outside, 'a')).passed).toBe(false);
    expect(evaluateGate([q], reading(inside, 'a')).passed).toBe(true);
  });

  test('support of a type that does not match by does not count', () => {
    const records = [rec(p1, 'plan'), rec(p2, 'deviation', [['supports', p1]])];
    expect(evaluateGate([q], reading(records)).passed).toBe(false);
  });

  test('without by, any current support will do', () => {
    const open = question({ kind: 'approved', of: { type: 'plan' } });
    const records = [rec(p1, 'plan'), rec(p2, 'deviation', [['supports', p1]])];
    expect(evaluateGate([open], reading(records)).passed).toBe(true);
  });

  test('refused: a current contradiction fails and shows in the evidence', () => {
    const records = [
      rec(p1, 'plan'),
      rec(p2, 'review', [['supports', p1]]),
      rec(p3, 'review', [['contradicts', p1]]),
    ];
    const result = evaluateGate([q], reading(records)).questions[0];
    expect(result?.passed).toBe(false);
    expect(result?.evidence).toMatchObject({ supports: [p2], contradictions: [p3] });
  });

  test('contradiction and support from a record that stopped being current do not count', () => {
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
});

describe('no_pending', () => {
  const q = question({
    kind: 'no_pending',
    pending: { type: 'deviation' },
    resolvedBy: { kind: 'answers' },
  });

  test('passes vacuously when nothing is pending', () => {
    expect(evaluateGate([q], reading([rec(p1, 'plan')])).questions[0]).toEqual({
      index: 0,
      kind: 'no_pending',
      passed: true,
      evidence: { unresolved: [] },
    });
  });

  test('fails and lists the pending record without resolution', () => {
    const records = [
      rec(p1, 'deviation'),
      rec(p2, 'deviation'),
      rec(p3, 'plan', [['answers', p2]]),
    ];
    const result = evaluateGate([q], reading(records)).questions[0];
    expect(result?.passed).toBe(false);
    expect(result?.evidence).toEqual({ unresolved: [p1] });
  });

  test('a resolution of another kind does not serve, nor does one from a non-current record', () => {
    const wrongKind = [rec(p1, 'deviation'), rec(p2, 'plan', [['supports', p1]])];
    expect(evaluateGate([q], reading(wrongKind)).passed).toBe(false);

    const revoked = [
      rec(p1, 'deviation'),
      rec(p2, 'plan', [['answers', p1]]),
      rec(p3, 'plan', [['revokes', p2]]),
    ];
    expect(evaluateGate([q], reading(revoked)).passed).toBe(false);
  });

  test('from restricts the type of the resolver', () => {
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
  test('fails when a current record has a current contradiction, and lists the contradicted ones', () => {
    const q = question({ kind: 'no_open_contradiction' });
    const records = [rec(p1, 'plan'), rec(p2, 'plan'), rec(p3, 'review', [['contradicts', p2]])];
    const result = evaluateGate([q], reading(records)).questions[0];
    expect(result?.passed).toBe(false);
    expect(result?.evidence).toEqual({ conflicting: [p2] });
  });

  test('passes when the contradiction was revoked or the contradicted record stopped being current', () => {
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

  test('of restricts what is checked', () => {
    const q = question({ kind: 'no_open_contradiction', of: { type: 'plan' } });
    const records = [rec(p1, 'review'), rec(p2, 'plan', [['contradicts', p1]])];
    expect(evaluateGate([q], reading(records)).passed).toBe(true);
  });
});

describe('scope (D-24)', () => {
  const plan = rec(id('p', 1), 'plan');
  const foreignReview = rec(id('other', 1), 'review', [['supports', plan.id]]);
  const q = (scope: GateScope) =>
    question({ kind: 'approved', of: { type: 'plan' }, by: { type: 'review' }, scope });

  const scoped = (): SpiedInput => ({
    records: jest.fn<GateInput['records']>((scope) =>
      scope === 'project' ? [plan, foreignReview] : [plan],
    ),
  });

  test('process scope does not see support from another process, and project scope does', () => {
    expect(evaluateGate([q('process')], scoped()).passed).toBe(false);
    expect(evaluateGate([q('project')], scoped()).passed).toBe(true);
  });

  test('without scope it defaults to process, and project scope is read only if some question declares it', () => {
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

describe('result', () => {
  test('passes only if every question passes, and each result carries the index and the kind', () => {
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

  test('the type ties kind to the shape of the evidence', () => {
    const mismatched: QuestionResult = {
      index: 0,
      passed: true,
      kind: 'approved',
      // @ts-expect-error `approved` não carrega `found`
      evidence: { found: [] },
    };
    expect(mismatched.kind).toBe('approved');
  });

  // A definição recusa gate vazio (Gate.questions `.min(1)`); a avaliação segue vazio-verdadeira.
  test('a gate without questions passes and reads no record', () => {
    const input = reading([]);
    expect(evaluateGate([], input)).toEqual({ passed: true, questions: [] });
    expect(input.records).not.toHaveBeenCalled();
  });
});

describe('plan-ready gate (omc fixture)', () => {
  const questions = Gate.parse(omc.gates[0]).questions;
  const plan = (n: number, relations: [RelationKind, string][] = [], isRevision = false) =>
    rec(id('p', n), 'plan', relations, { data: { isRevision, diff: 'd' } });
  const review = (n: number, kind: RelationKind, to: string) =>
    rec(id('p', n), 'review', [[kind, to]]);
  const deviation = (n: number) => rec(id('p', n), 'deviation', [], { data: { description: 'x' } });

  test('a current approval with no open deviation passes', () => {
    const records = [plan(1), review(2, 'supports', p1)];
    expect(evaluateGate(questions, reading(records)).passed).toBe(true);
  });

  test('a deviation without outcome fails, and answers closes it', () => {
    const records = [plan(1), review(2, 'supports', p1), deviation(3)];
    const open = evaluateGate(questions, reading(records));
    expect(open.passed).toBe(false);
    expect(open.questions.map(({ passed }) => passed)).toEqual([true, false]);

    const settled = [...records, rec(p4, 'review', [['answers', p3]])];
    expect(evaluateGate(questions, reading(settled)).passed).toBe(true);
  });

  test('the current revision needs its own approval; the superseded version approval does not count', () => {
    const original = [plan(1), review(2, 'supports', p1)];
    const revised = [...original, plan(3, [['supersedes', p1]], true)];
    expect(evaluateGate(questions, reading(revised)).passed).toBe(false);

    const reapproved = [...revised, review(4, 'supports', p3)];
    expect(evaluateGate(questions, reading(reapproved)).passed).toBe(true);
  });

  test('a revision approved and then superseded by an unapproved one fails again', () => {
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

describe('domain fixtures', () => {
  test.each([
    ['omc', omc],
    ['rdsc', rdsc],
  ])('%s is valid against the definitions.ts schemas', (_name, domain) => {
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

  test('the rdsc gate evaluates over verdict and evidence', () => {
    const questions = Gate.parse(rdsc.gates[0]).questions;
    const records = [rec(p1, 'evidence'), rec(p2, 'verdict', [['supports', p1]])];
    expect(evaluateGate(questions, reading(records)).passed).toBe(true);
    expect(evaluateGate(questions, reading([rec(p1, 'evidence')])).passed).toBe(false);
  });

  test('the rdsc gate fails with a current contradiction over the verdict', () => {
    const questions = Gate.parse(rdsc.gates[0]).questions;
    const records = [
      rec(p1, 'evidence'),
      rec(p2, 'verdict', [['supports', p1]]),
      rec(p3, 'evidence', [['contradicts', p2]]),
    ];
    const result = evaluateGate(questions, reading(records));
    expect(result.passed).toBe(false);
    expect(result.questions.map(({ passed }) => passed)).toEqual([true, false]);
    expect(result.questions[1]?.evidence).toEqual({ conflicting: [p2] });
  });
});

describe('inherit option', () => {
  const approvedQ = question({ kind: 'approved', of: { type: 'plan' }, by: { type: 'review' } });
  const approvedInherit = question({ ...approvedQ, inherit: true });
  const pendingQ = question({
    kind: 'no_pending',
    pending: { type: 'deviation' },
    resolvedBy: { kind: 'answers', from: ['plan'] },
  });
  const pendingInherit = question({ ...pendingQ, inherit: true });

  /** Leitura com a herança ligada em todos os processos. */
  const active = (records: HexRecord[], target?: string): SpiedInput => ({
    ...reading(records, target),
    isInheritanceActive: () => true,
  });

  // p2 apoia a versão 1 do plano; p3 a supera sem relações.
  const supersededPlan = [
    rec(p1, 'plan'),
    rec(p2, 'review', [['supports', p1]]),
    rec(p3, 'plan', [['supersedes', p1]]),
  ];
  // p2 resolve o desvio p1, mas foi superado por p3 (a resolução subiu para p3).
  const supersededResolver = [
    rec(p1, 'deviation'),
    rec(p2, 'plan', [['answers', p1]]),
    rec(p3, 'plan', [['supersedes', p2]]),
  ];

  test('the schema accepts inherit true on approved and no_pending only', () => {
    expect(GateQuestion.safeParse(approvedInherit).success).toBe(true);
    expect(GateQuestion.safeParse(pendingInherit).success).toBe(true);
    const invalid = [
      { kind: 'approved', of: {}, inherit: false },
      { kind: 'occurred', select: {}, inherit: true },
      { kind: 'no_open_contradiction', inherit: true },
    ];
    expect(invalid.map((raw) => GateQuestion.safeParse(raw).success)).toEqual([
      false,
      false,
      false,
    ]);
  });

  test('approved without inherit fails while the support is stuck on the superseded version', () => {
    const result = evaluateGate([approvedQ], active(supersededPlan)).questions[0];
    expect(result?.passed).toBe(false);
    expect(result?.evidence).toEqual({
      of: [p3],
      supports: [],
      contradictions: [],
      unsupported: [p3],
    });
  });

  test('approved with inherit passes and lists the supporter that counts only by inheritance', () => {
    expect(evaluateGate([approvedInherit], active(supersededPlan)).questions[0]).toEqual({
      index: 0,
      kind: 'approved',
      passed: true,
      evidence: { of: [p3], supports: [p2], contradictions: [], unsupported: [], inherited: [p2] },
    });
  });

  test('a direct supporter is not listed as inherited', () => {
    const records = [...supersededPlan, rec(p4, 'review', [['supports', p3]])];
    const result = evaluateGate([approvedInherit], active(records)).questions[0];
    expect(result?.passed).toBe(true);
    expect(result?.evidence).toMatchObject({ supports: [p4, p2], inherited: [p2] });
  });

  test('by still filters the inherited supporter', () => {
    const records = [
      rec(p1, 'plan'),
      rec(p2, 'deviation', [['supports', p1]]),
      rec(p3, 'plan', [['supersedes', p1]]),
    ];
    const result = evaluateGate([approvedInherit], active(records)).questions[0];
    expect(result?.passed).toBe(false);
    expect(result?.evidence).toMatchObject({ unsupported: [p3], inherited: [] });
  });

  test('a current contradiction still fails, because contradicts never inherits', () => {
    const records = [...supersededPlan, rec(p4, 'review', [['contradicts', p3]])];
    const result = evaluateGate([approvedInherit], active(records)).questions[0];
    expect(result?.passed).toBe(false);
    expect(result?.evidence).toMatchObject({ contradictions: [p4] });
  });

  test('no_pending without inherit fails, with inherit the resolution of the superseded origin counts', () => {
    expect(evaluateGate([pendingQ], active(supersededResolver)).questions[0]).toMatchObject({
      passed: false,
      evidence: { unresolved: [p1] },
    });
    expect(evaluateGate([pendingInherit], active(supersededResolver)).questions[0]).toEqual({
      index: 0,
      kind: 'no_pending',
      passed: true,
      evidence: { unresolved: [], inherited: [p3] },
    });
  });

  test('resolvedBy.from still filters the inherited resolver', () => {
    const fromReview = question({
      kind: 'no_pending',
      pending: { type: 'deviation' },
      resolvedBy: { kind: 'answers', from: ['review'] },
      inherit: true,
    });
    expect(evaluateGate([fromReview], active(supersededResolver)).passed).toBe(false);
  });

  test('a process without active inheritance ignores the option', () => {
    const inactive = { ...reading(supersededPlan), isInheritanceActive: () => false };
    const result = evaluateGate([approvedInherit], inactive).questions[0];
    expect(result?.passed).toBe(false);
    expect(result?.evidence).toMatchObject({ unsupported: [p3], inherited: [] });
    expect(evaluateGate([approvedInherit], reading(supersededPlan)).passed).toBe(false);
  });

  test('without the option the evidence keeps today shape even when inheritance is active', () => {
    const records = [rec(p1, 'plan'), rec(p2, 'review', [['supports', p1]])];
    const result = evaluateGate([approvedQ, pendingQ], active(records));
    expect(result.questions.map(({ evidence }) => Object.keys(evidence))).toEqual([
      ['of', 'supports', 'contradictions', 'unsupported'],
      ['unresolved'],
    ]);
  });

  test('counts carries the size of the inherited list', () => {
    const [result] = evaluateGate([approvedInherit], active(supersededPlan)).questions;
    expect(result && summarizeQuestion(result, 'counts')).toMatchObject({
      counts: { inherited: 1 },
    });
  });

  test('inheritance is built only for a scope that asks for it', () => {
    const projectInherit = question({ ...approvedInherit, scope: 'project' });
    const input = active(supersededPlan);
    const results = evaluateGate([approvedQ, projectInherit], input);
    expect(results.questions.map(({ passed }) => passed)).toEqual([false, true]);
  });
});

describe('summarizeQuestion', () => {
  const approvedFailing: QuestionResult = {
    index: 0,
    kind: 'approved',
    passed: false,
    evidence: { of: [p1, p2], supports: [p3], contradictions: [p4], unsupported: [p2] },
  };
  const occurredFailing: QuestionResult = {
    index: 1,
    kind: 'occurred',
    passed: false,
    evidence: { found: [p1] },
  };
  const noPendingFailing: QuestionResult = {
    index: 2,
    kind: 'no_pending',
    passed: false,
    evidence: { unresolved: [p1, p2] },
  };
  const noContradictionFailing: QuestionResult = {
    index: 3,
    kind: 'no_open_contradiction',
    passed: false,
    evidence: { conflicting: [p5] },
  };

  test('summarizeQuestion full returns the result untouched', () => {
    expect(summarizeQuestion(approvedFailing, 'full')).toBe(approvedFailing);
  });

  test('summarizeQuestion counts reports the size of every list and no ids', () => {
    expect(summarizeQuestion(approvedFailing, 'counts')).toEqual({
      index: 0,
      kind: 'approved',
      passed: false,
      counts: { of: 2, supports: 1, contradictions: 1, unsupported: 1 },
    });
    expect(summarizeQuestion(occurredFailing, 'counts')).toEqual({
      index: 1,
      kind: 'occurred',
      passed: false,
      counts: { found: 1 },
    });
  });

  test('summarizeQuestion failing keeps ids only for the diagnostic lists of a failed question', () => {
    expect(summarizeQuestion(approvedFailing, 'failing')).toEqual({
      index: 0,
      kind: 'approved',
      passed: false,
      counts: { of: 2, supports: 1, contradictions: 1, unsupported: 1 },
      evidence: { unsupported: [p2], contradictions: [p4] },
    });
    expect(summarizeQuestion(occurredFailing, 'failing')).toMatchObject({
      evidence: { found: [p1] },
    });
    expect(summarizeQuestion(noPendingFailing, 'failing')).toMatchObject({
      evidence: { unresolved: [p1, p2] },
    });
    expect(summarizeQuestion(noContradictionFailing, 'failing')).toMatchObject({
      evidence: { conflicting: [p5] },
    });
  });

  test('summarizeQuestion failing drops the empty diagnostic lists', () => {
    const onlyContradicted: QuestionResult = {
      index: 0,
      kind: 'approved',
      passed: false,
      evidence: { of: [p1], supports: [p3], contradictions: [p4], unsupported: [] },
    };
    expect(summarizeQuestion(onlyContradicted, 'failing')).toMatchObject({
      evidence: { contradictions: [p4] },
    });
  });

  test('summarizeQuestion failing omits evidence for a passed question', () => {
    const passed: QuestionResult = {
      index: 0,
      kind: 'approved',
      passed: true,
      evidence: { of: [p1], supports: [p3], contradictions: [], unsupported: [] },
    };
    expect(summarizeQuestion(passed, 'failing')).toEqual({
      index: 0,
      kind: 'approved',
      passed: true,
      counts: { of: 1, supports: 1, contradictions: 0, unsupported: 0 },
    });
  });

  test('summarizeQuestion failing omits evidence when an approved question fails with nothing to approve', () => {
    const nothingToApprove: QuestionResult = {
      index: 0,
      kind: 'approved',
      passed: false,
      evidence: { of: [], supports: [], contradictions: [], unsupported: [] },
    };
    expect(summarizeQuestion(nothingToApprove, 'failing')).not.toHaveProperty('evidence');
  });

  test('summarizeQuestion does not mutate the result', () => {
    const before = structuredClone(approvedFailing);
    summarizeQuestion(approvedFailing, 'failing');
    expect(approvedFailing).toEqual(before);
  });
});
