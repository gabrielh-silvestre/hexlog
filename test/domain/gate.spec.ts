import { describe, it, expect, jest } from '@jest/globals';
import {
  evaluateGate,
  GateQuestion,
  matchesSelector,
  matchesTargetPrefix,
  prepareGate,
  Selector,
  summarizeQuestion,
} from '../../src/domain/gate.ts';
import type { GateInput, GateScope, QuestionResult } from '../../src/domain/gate.ts';
import { Gate } from '../../src/domain/definitions.ts';
import type { HexRecord, RelationKind } from '../../src/domain/record.ts';
import * as omc from '../fixtures/domains/omc.ts';
import * as rdsc from '../fixtures/domains/rdsc.ts';
import { at, recordId } from '../helpers.ts';

type Extra = { target?: string; data?: HexRecord['data'] };

function rec(
  id: string,
  type: string,
  relations: [RelationKind, string][] = [],
  { target = 'feature', data = {} }: Extra = {},
): HexRecord {
  return {
    id,
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

/** Resultado da pergunta `q` sobre `records`; `build` troca a leitura (por padrão `reading`). */
const resultOf = (
  q: ReturnType<typeof question>,
  records: HexRecord[],
  build: (records: HexRecord[]) => GateInput = reading,
) => evaluateGate([q], build(records)).questions[0];

const [p1, p2, p3, p4, p5] = [
  recordId('p', 1),
  recordId('p', 2),
  recordId('p', 3),
  recordId('p', 4),
  recordId('p', 5),
];

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

describe('Selector', () => {
  it('should accept a scalar value in where', () => {
    expect(Selector.safeParse({ where: { a: 'x', b: 2, c: true } }).success).toBe(true);
  });

  it.each([
    ['an operator object', { gte: 2 }],
    ['null', null],
    ['an array', [1]],
  ])('should refuse %s in where', (_label, value) => {
    expect(Selector.safeParse({ where: { a: value } }).success).toBe(false);
  });

  it.each([
    ['an unknown key', { kind: 'plan' }],
    ['an invalid name', { type: 'Plan' }],
    ['an invalid prefix', { targetPrefix: 'a.' }],
  ])('should refuse %s', (_label, raw) => {
    expect(Selector.safeParse(raw).success).toBe(false);
  });
});

describe('GateQuestion', () => {
  it.each([
    ['approved', { kind: 'approved', of: {}, by: { type: 'review' }, scope: 'project' }],
    ['occurred', { kind: 'occurred', select: { type: 'review' }, min: 2 }],
    [
      'no_pending',
      { kind: 'no_pending', pending: {}, resolvedBy: { kind: 'answers', from: ['review'] } },
    ],
    ['no_open_contradiction', { kind: 'no_open_contradiction' }],
    ['no_open_contradiction with of', { kind: 'no_open_contradiction', of: { type: 'plan' } }],
  ])('should accept the shape of %s', (_label, raw) => {
    expect(GateQuestion.safeParse(raw).success).toBe(true);
  });

  it.each([
    ['an unknown kind', { kind: 'overdue', of: {} }],
    ['approved without of', { kind: 'approved' }],
    ['occurred with min 0', { kind: 'occurred', select: {}, min: 0 }],
    ['occurred with dueAt', { kind: 'occurred', select: {}, dueAt: '2026-01-01T00:00:00Z' }],
    [
      'no_pending with an unknown resolvedBy',
      { kind: 'no_pending', pending: {}, resolvedBy: { kind: 'unknown' } },
    ],
    [
      'no_pending with an empty from',
      { kind: 'no_pending', pending: {}, resolvedBy: { kind: 'answers', from: [] } },
    ],
    [
      'no_pending with a repeated from',
      { kind: 'no_pending', pending: {}, resolvedBy: { kind: 'answers', from: ['a', 'a'] } },
    ],
    ['occurred with an unknown scope', { kind: 'occurred', select: {}, scope: 'global' }],
    ['approved with inherit false', { kind: 'approved', of: {}, inherit: false }],
    ['occurred with inherit', { kind: 'occurred', select: {}, inherit: true }],
    ['no_open_contradiction with inherit', { kind: 'no_open_contradiction', inherit: true }],
  ])('should refuse %s', (_label, raw) => {
    expect(GateQuestion.safeParse(raw).success).toBe(false);
  });

  it.each([
    ['approved', approvedInherit],
    ['no_pending', pendingInherit],
  ])('should accept inherit true on %s', (_label, raw) => {
    expect(GateQuestion.safeParse(raw).success).toBe(true);
  });
});

describe('matchesTargetPrefix', () => {
  it('should keep the boundary at the dot', () => {
    expect(matchesTargetPrefix('a.b', 'a.b')).toBe(true);
    expect(matchesTargetPrefix('a.b.c', 'a.b')).toBe(true);
    expect(matchesTargetPrefix('a.bc', 'a.b')).toBe(false);
    expect(matchesTargetPrefix('a', 'a.b')).toBe(false);
  });
});

describe('matchesSelector', () => {
  const revisedPlan = rec(p1, 'plan', [], { target: 'a.b', data: { isRevision: true, round: 2 } });

  it.each<{ label: string; selector: Parameters<typeof matchesSelector>[1]; matches: boolean }>([
    { label: 'an empty selector', selector: {}, matches: true },
    {
      label: 'type and targetPrefix',
      selector: { type: 'plan', targetPrefix: 'a' },
      matches: true,
    },
    {
      label: 'where equal to the data',
      selector: { where: { isRevision: true, round: 2 } },
      matches: true,
    },
    { label: 'another type', selector: { type: 'review' }, matches: false },
    { label: 'another targetPrefix', selector: { targetPrefix: 'a.c' }, matches: false },
    { label: 'where of another type', selector: { where: { isRevision: 'true' } }, matches: false },
    { label: 'where on a missing field', selector: { where: { missing: false } }, matches: false },
  ])('should return $matches for $label', ({ selector, matches }) => {
    expect(matchesSelector(revisedPlan, selector)).toBe(matches);
  });

  // `where` compara por identidade: nenhuma coerção entre número, string e booleano.
  it.each([
    ['number against boolean', { n: 1 }, { n: true }],
    ['string against number', { n: '1' }, { n: 1 }],
    ['zero against false', { n: 0 }, { n: false }],
  ])('should not coerce types in where: %s', (_label, data, where) => {
    expect(matchesSelector(rec(p1, 'plan', [], { data }), { where })).toBe(false);
  });

  it('should inherit the evaluation target for an omitted targetPrefix', () => {
    const record = rec(p1, 'plan', [], { target: 'a.b' });

    expect(matchesSelector(record, {}, 'a.b')).toBe(true);
    expect(matchesSelector(record, {}, 'a.c')).toBe(false);
  });

  it('should let its own targetPrefix prevail over the evaluation target', () => {
    const record = rec(p1, 'plan', [], { target: 'a.b' });

    expect(matchesSelector(record, { targetPrefix: 'a' }, 'a.c')).toBe(true);
  });
});

describe('evaluateGate', () => {
  describe('with an occurred question', () => {
    const q = (min?: number) => question({ kind: 'occurred', select: { type: 'review' }, min });

    it('should pass with at least one current record (default min 1) and return the ids', () => {
      const records = [rec(p1, 'review'), rec(p2, 'plan')];

      expect(resultOf(q(), records)).toEqual({
        index: 0,
        kind: 'occurred',
        passed: true,
        evidence: { found: [p1] },
      });
      expect(evaluateGate([q()], reading([rec(p2, 'plan')])).passed).toBe(false);
    });

    it('should require the min count', () => {
      const records = [rec(p1, 'review'), rec(p2, 'review'), rec(p3, 'review', [['revokes', p2]])];

      expect(evaluateGate([q(2)], reading(records)).passed).toBe(true);
      expect(evaluateGate([q(3)], reading(records)).passed).toBe(false);
    });

    it('should not count a superseded or revoked record', () => {
      const records = [
        rec(p1, 'review'),
        rec(p2, 'review'),
        rec(p3, 'review', [['revokes', p2]]),
        rec(p4, 'review', [['supersedes', p1]]),
      ];

      expect(resultOf(q(2), records)?.evidence).toEqual({ found: [p3, p4] });
    });

    it('should filter the data field by an equality where, as in the revision gate', () => {
      const records = [
        rec(p1, 'plan', [], { data: { isRevision: false } }),
        rec(p2, 'plan', [['supersedes', p1]], { data: { isRevision: true } }),
      ];
      const revised = question({ kind: 'occurred', select: { where: { isRevision: true } } });
      const original = question({ kind: 'occurred', select: { where: { isRevision: false } } });

      expect(evaluateGate([revised], reading(records)).passed).toBe(true);
      expect(evaluateGate([original], reading(records)).passed).toBe(false);
    });

    it('should restrict what counts to the evaluation target', () => {
      const records = [rec(p1, 'review', [], { target: 'a.b' })];

      expect(evaluateGate([q()], reading(records, 'a')).passed).toBe(true);
      expect(evaluateGate([q()], reading(records, 'c')).passed).toBe(false);
    });
  });

  describe('with an approved question', () => {
    const q = question({ kind: 'approved', of: { type: 'plan' }, by: { type: 'review' } });

    it('should pass when every current record in of has a current support matching by, with no contradiction', () => {
      const records = [rec(p1, 'plan'), rec(p2, 'review', [['supports', p1]])];

      expect(resultOf(q, records)).toEqual({
        index: 0,
        kind: 'approved',
        passed: true,
        evidence: { of: [p1], supports: [p2], contradictions: [], unsupported: [] },
      });
    });

    it('should stay pending with no record in of', () => {
      expect(evaluateGate([q], reading([])).passed).toBe(false);
    });

    it('should stay pending and list a record without support as unsupported', () => {
      expect(resultOf(q, [rec(p1, 'plan')])).toEqual({
        index: 0,
        kind: 'approved',
        passed: false,
        evidence: { of: [p1], supports: [], contradictions: [], unsupported: [p1] },
      });
    });

    it('should require support for every current record in of, since one is not enough', () => {
      const records = [
        rec(p1, 'plan', [], { target: 'a' }),
        rec(p2, 'plan', [], { target: 'b' }),
        rec(p3, 'review', [['supports', p1]]),
      ];

      expect(resultOf(q, records)).toMatchObject({
        passed: false,
        evidence: { unsupported: [p2] },
      });
    });

    it('should restrict a by without targetPrefix to the evaluation target', () => {
      const plan = rec(p1, 'plan', [], { target: 'a.b' });
      const outside = [plan, rec(p2, 'review', [['supports', p1]], { target: 'c' })];
      const inside = [plan, rec(p2, 'review', [['supports', p1]], { target: 'a.c' })];

      expect(evaluateGate([q], reading(outside, 'a')).passed).toBe(false);
      expect(evaluateGate([q], reading(inside, 'a')).passed).toBe(true);
    });

    it('should not count a support of a type that does not match by', () => {
      const records = [rec(p1, 'plan'), rec(p2, 'deviation', [['supports', p1]])];

      expect(evaluateGate([q], reading(records)).passed).toBe(false);
    });

    it('should accept any current support without by', () => {
      const open = question({ kind: 'approved', of: { type: 'plan' } });
      const records = [rec(p1, 'plan'), rec(p2, 'deviation', [['supports', p1]])];

      expect(evaluateGate([open], reading(records)).passed).toBe(true);
    });

    it('should fail on a current contradiction and show it in the evidence', () => {
      const records = [
        rec(p1, 'plan'),
        rec(p2, 'review', [['supports', p1]]),
        rec(p3, 'review', [['contradicts', p1]]),
      ];

      expect(resultOf(q, records)).toMatchObject({
        passed: false,
        evidence: { supports: [p2], contradictions: [p3] },
      });
    });

    it('should not count a contradiction or support from a record that stopped being current', () => {
      const records = [
        rec(p1, 'plan'),
        rec(p2, 'review', [['supports', p1]]),
        rec(p3, 'review', [['contradicts', p1]]),
        rec(p4, 'review', [['revokes', p3]]),
      ];
      const withdrawn = [...records, rec(p5, 'review', [['revokes', p2]])];

      expect(evaluateGate([q], reading(records)).passed).toBe(true);
      expect(evaluateGate([q], reading(withdrawn)).passed).toBe(false);
    });
  });

  describe('with a no_pending question', () => {
    const q = question({
      kind: 'no_pending',
      pending: { type: 'deviation' },
      resolvedBy: { kind: 'answers' },
    });

    it('should pass vacuously when nothing is pending', () => {
      expect(resultOf(q, [rec(p1, 'plan')])).toEqual({
        index: 0,
        kind: 'no_pending',
        passed: true,
        evidence: { unresolved: [] },
      });
    });

    it('should fail and list the pending record without resolution', () => {
      const records = [
        rec(p1, 'deviation'),
        rec(p2, 'deviation'),
        rec(p3, 'plan', [['answers', p2]]),
      ];

      expect(resultOf(q, records)).toEqual({
        index: 0,
        kind: 'no_pending',
        passed: false,
        evidence: { unresolved: [p1] },
      });
    });

    it.each([
      ['of another kind', [rec(p1, 'deviation'), rec(p2, 'plan', [['supports', p1]])]],
      [
        'from a non-current record',
        [
          rec(p1, 'deviation'),
          rec(p2, 'plan', [['answers', p1]]),
          rec(p3, 'plan', [['revokes', p2]]),
        ],
      ],
    ])('should not accept a resolution %s', (_label, records) => {
      expect(evaluateGate([q], reading(records)).passed).toBe(false);
    });

    it('should restrict the type of the resolver by from', () => {
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

  describe('with a no_open_contradiction question', () => {
    const openQ = question({ kind: 'no_open_contradiction' });

    it('should fail when a current record has a current contradiction, and list the contradicted ones', () => {
      const records = [rec(p1, 'plan'), rec(p2, 'plan'), rec(p3, 'review', [['contradicts', p2]])];

      expect(resultOf(openQ, records)).toEqual({
        index: 0,
        kind: 'no_open_contradiction',
        passed: false,
        evidence: { conflicting: [p2] },
      });
    });

    it.each([
      [
        'the contradiction was revoked',
        [
          rec(p1, 'plan'),
          rec(p2, 'review', [['contradicts', p1]]),
          rec(p3, 'review', [['revokes', p2]]),
        ],
      ],
      [
        'the contradicted record stopped being current',
        [
          rec(p1, 'plan'),
          rec(p2, 'review', [['contradicts', p1]]),
          rec(p3, 'plan', [['supersedes', p1]]),
        ],
      ],
    ])('should pass when %s', (_label, records) => {
      expect(evaluateGate([openQ], reading(records)).passed).toBe(true);
    });

    it('should restrict what is checked by of', () => {
      const q = question({ kind: 'no_open_contradiction', of: { type: 'plan' } });
      const records = [rec(p1, 'review'), rec(p2, 'plan', [['contradicts', p1]])];

      expect(evaluateGate([q], reading(records)).passed).toBe(true);
    });
  });

  describe('with a question scope', () => {
    const plan = rec(p1, 'plan');
    const foreignReview = rec(recordId('other', 1), 'review', [['supports', plan.id]]);
    const q = (scope: GateScope) =>
      question({ kind: 'approved', of: { type: 'plan' }, by: { type: 'review' }, scope });

    const scoped = (): SpiedInput => ({
      records: jest.fn<GateInput['records']>((scope) =>
        scope === 'project' ? [plan, foreignReview] : [plan],
      ),
    });

    it('should see support from another process only at project scope', () => {
      expect(evaluateGate([q('process')], scoped()).passed).toBe(false);
      expect(evaluateGate([q('project')], scoped()).passed).toBe(true);
    });

    it('should default to process scope', () => {
      const input = scoped();

      evaluateGate([question({ kind: 'occurred', select: {} })], input);

      expect(input.records).toHaveBeenCalledTimes(1);
      expect(input.records).toHaveBeenCalledWith('process');
    });

    it('should read project scope only if some question declares it', () => {
      const mixed = scoped();

      evaluateGate([q('process'), q('project'), q('project')], mixed);

      expect(mixed.records).toHaveBeenCalledTimes(2);
      expect(mixed.records).toHaveBeenCalledWith('project');
    });
  });

  it('should pass only if every question passes', () => {
    const questions = [
      question({ kind: 'occurred', select: { type: 'plan' } }),
      question({ kind: 'occurred', select: { type: 'review' } }),
    ];

    const result = evaluateGate(questions, reading([rec(p1, 'plan')]));

    expect(result.passed).toBe(false);
  });

  it('should give each result the index and the kind', () => {
    const questions = [
      question({ kind: 'occurred', select: { type: 'plan' } }),
      question({ kind: 'occurred', select: { type: 'review' } }),
    ];

    const result = evaluateGate(questions, reading([rec(p1, 'plan')]));

    expect(result.questions.map(({ index, kind }) => ({ index, kind }))).toEqual([
      { index: 0, kind: 'occurred' },
      { index: 1, kind: 'occurred' },
    ]);
  });

  // A definição recusa gate vazio (Gate.questions `.min(1)`); a avaliação segue vazio-verdadeira.
  it('should pass a gate without questions', () => {
    expect(evaluateGate([], reading([]))).toEqual({ passed: true, questions: [] });
  });

  it('should read no record for a gate without questions', () => {
    const input = reading([]);

    evaluateGate([], input);

    expect(input.records).not.toHaveBeenCalled();
  });

  describe('with the plan-ready gate of the omc fixture', () => {
    const questions = Gate.parse(omc.gates[0]).questions;
    const plan = (id: string, relations: [RelationKind, string][] = [], isRevision = false) =>
      rec(id, 'plan', relations, { data: { isRevision, diff: 'd' } });
    const review = (id: string, kind: RelationKind, to: string) => rec(id, 'review', [[kind, to]]);
    const deviation = (id: string) => rec(id, 'deviation', [], { data: { description: 'x' } });

    it('should pass with a current approval and no open deviation', () => {
      const records = [plan(p1), review(p2, 'supports', p1)];

      expect(evaluateGate(questions, reading(records)).passed).toBe(true);
    });

    it('should fail on a deviation without outcome', () => {
      const records = [plan(p1), review(p2, 'supports', p1), deviation(p3)];

      const open = evaluateGate(questions, reading(records));

      expect(open.passed).toBe(false);
      expect(open.questions.map(({ passed }) => passed)).toEqual([true, false]);
    });

    it('should pass once answers closes the deviation', () => {
      const records = [plan(p1), review(p2, 'supports', p1), deviation(p3)];
      const settled = [...records, rec(p4, 'review', [['answers', p3]])];

      expect(evaluateGate(questions, reading(settled)).passed).toBe(true);
    });

    it('should require the current revision to have its own approval, not counting the approval of the superseded version', () => {
      const original = [plan(p1), review(p2, 'supports', p1)];
      const revised = [...original, plan(p3, [['supersedes', p1]], true)];
      const reapproved = [...revised, review(p4, 'supports', p3)];

      expect(evaluateGate(questions, reading(revised)).passed).toBe(false);
      expect(evaluateGate(questions, reading(reapproved)).passed).toBe(true);
    });

    it('should fail again when an approved revision is superseded by an unapproved one', () => {
      const records = [
        plan(p1),
        review(p2, 'supports', p1),
        plan(p3, [['supersedes', p1]], true),
        review(p4, 'supports', p3),
        plan(p5, [['supersedes', p3]], true),
      ];

      expect(resultOf(at(questions, 0), records)).toMatchObject({
        passed: false,
        evidence: { of: [p5], unsupported: [p5] },
      });
    });
  });

  describe('with the rdsc gate', () => {
    const questions = Gate.parse(rdsc.gates[0]).questions;

    it('should evaluate the gate over verdict and evidence', () => {
      const records = [rec(p1, 'evidence'), rec(p2, 'verdict', [['supports', p1]])];

      expect(evaluateGate(questions, reading(records)).passed).toBe(true);
      expect(evaluateGate(questions, reading([rec(p1, 'evidence')])).passed).toBe(false);
    });

    it('should fail with a current contradiction over the verdict', () => {
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

  describe('with the inherit option', () => {
    it('should fail approved without inherit while the support is stuck on the superseded version', () => {
      expect(resultOf(approvedQ, supersededPlan, active)).toEqual({
        index: 0,
        kind: 'approved',
        passed: false,
        evidence: { of: [p3], supports: [], contradictions: [], unsupported: [p3] },
      });
    });

    it('should pass approved with inherit and list the supporter that counts only by inheritance', () => {
      expect(resultOf(approvedInherit, supersededPlan, active)).toEqual({
        index: 0,
        kind: 'approved',
        passed: true,
        evidence: {
          of: [p3],
          supports: [p2],
          contradictions: [],
          unsupported: [],
          inherited: [p2],
        },
      });
    });

    it('should not list a direct supporter as inherited', () => {
      const records = [...supersededPlan, rec(p4, 'review', [['supports', p3]])];

      expect(resultOf(approvedInherit, records, active)).toMatchObject({
        passed: true,
        evidence: { supports: [p4, p2], inherited: [p2] },
      });
    });

    it('should keep by filtering the inherited supporter', () => {
      const records = [
        rec(p1, 'plan'),
        rec(p2, 'deviation', [['supports', p1]]),
        rec(p3, 'plan', [['supersedes', p1]]),
      ];

      expect(resultOf(approvedInherit, records, active)).toMatchObject({
        passed: false,
        evidence: { unsupported: [p3], inherited: [] },
      });
    });

    it('should still fail on a current contradiction, because contradicts never inherits', () => {
      const records = [...supersededPlan, rec(p4, 'review', [['contradicts', p3]])];

      expect(resultOf(approvedInherit, records, active)).toMatchObject({
        passed: false,
        evidence: { contradictions: [p4] },
      });
    });

    it('should fail no_pending without inherit', () => {
      expect(resultOf(pendingQ, supersededResolver, active)).toMatchObject({
        passed: false,
        evidence: { unresolved: [p1] },
      });
    });

    it('should count the resolution of the superseded origin with inherit', () => {
      expect(resultOf(pendingInherit, supersededResolver, active)).toEqual({
        index: 0,
        kind: 'no_pending',
        passed: true,
        evidence: { unresolved: [], inherited: [p3] },
      });
    });

    it('should keep resolvedBy.from filtering the inherited resolver', () => {
      const fromReview = question({
        kind: 'no_pending',
        pending: { type: 'deviation' },
        resolvedBy: { kind: 'answers', from: ['review'] },
        inherit: true,
      });

      expect(resultOf(fromReview, supersededResolver, active)?.passed).toBe(false);
    });

    it('should ignore the option in a process without active inheritance', () => {
      const inactive = (records: HexRecord[]) => ({
        ...reading(records),
        isInheritanceActive: () => false,
      });

      expect(resultOf(approvedInherit, supersededPlan, inactive)).toMatchObject({
        passed: false,
        evidence: { unsupported: [p3], inherited: [] },
      });
    });

    it('should ignore the option when the input has no isInheritanceActive', () => {
      expect(resultOf(approvedInherit, supersededPlan)?.passed).toBe(false);
    });

    it('should keep the evidence shape of today without the option, even when inheritance is active', () => {
      const records = [rec(p1, 'plan'), rec(p2, 'review', [['supports', p1]])];

      const result = evaluateGate([approvedQ, pendingQ], active(records));

      expect(result.questions.map(({ evidence }) => Object.keys(evidence).sort())).toEqual([
        ['contradictions', 'of', 'supports', 'unsupported'],
        ['unresolved'],
      ]);
    });

    it('should not count an inherited supporter for a question without the option in a shared scope', () => {
      const results = evaluateGate([approvedQ, approvedInherit], active(supersededPlan));

      expect(results.questions.map(({ passed }) => passed)).toEqual([false, true]);
    });

    it('should consult the inheritance of a scope only when a question of that scope asks for it', () => {
      const projectPlan = [
        rec(recordId('q', 1), 'plan'),
        rec(recordId('q', 2), 'review', [['supports', recordId('q', 1)]]),
        rec(recordId('q', 3), 'plan', [['supersedes', recordId('q', 1)]]),
      ];
      const isInheritanceActive = jest.fn<(process: string) => boolean>(() => true);
      const input: GateInput = {
        records: (scope) => (scope === 'project' ? projectPlan : supersededPlan),
        isInheritanceActive,
      };
      const projectInherit = question({ ...approvedInherit, scope: 'project' });

      evaluateGate([approvedQ, projectInherit], input);

      expect(isInheritanceActive).toHaveBeenCalledWith('q');
      expect(isInheritanceActive).not.toHaveBeenCalledWith('p');
    });
  });
});

describe('QuestionResult', () => {
  // O `@ts-expect-error` é a prova, conferida pelo `npm run typecheck`; o `expect` só atende o
  // `jest/expect-expect`.
  it('should reject at compile time evidence that does not match the kind', () => {
    const mismatched: QuestionResult = {
      index: 0,
      passed: true,
      kind: 'approved',
      // @ts-expect-error `approved` não carrega `found`
      evidence: { found: [] },
    };

    expect(mismatched.kind).toBe('approved');
  });
});

describe('prepareGate', () => {
  const records = [
    rec(p1, 'review', [], { target: 'a.b' }),
    rec(p2, 'review', [], { target: 'c' }),
    rec(p3, 'plan', [], { target: 'a.b' }),
  ];
  const q = question({ kind: 'occurred', select: { type: 'review' } });

  it('should answer each target as evaluateGate does', () => {
    const run = prepareGate([q], reading(records));

    for (const target of ['a', 'c', 'd', undefined]) {
      expect(run(target)).toEqual(evaluateGate([q], reading(records, target)));
    }
  });

  it('should read the records once for the batch', () => {
    const input = reading(records);
    const run = prepareGate([q], input);

    for (const target of ['a', 'c', 'd', undefined]) {
      run(target);
    }

    expect(input.records).toHaveBeenCalledTimes(1);
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

  it('should return the result untouched in full mode', () => {
    expect(summarizeQuestion(approvedFailing, 'full')).toBe(approvedFailing);
  });

  it('should report the size of every list and no ids in counts mode', () => {
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

  it('should keep ids only for the diagnostic lists of a failed question in failing mode', () => {
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

  it('should drop the empty diagnostic lists in failing mode', () => {
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

  it('should omit evidence for a passed question in failing mode', () => {
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

  it('should omit evidence when an approved question fails with nothing to approve in failing mode', () => {
    const nothingToApprove: QuestionResult = {
      index: 0,
      kind: 'approved',
      passed: false,
      evidence: { of: [], supports: [], contradictions: [], unsupported: [] },
    };

    expect(summarizeQuestion(nothingToApprove, 'failing')).not.toHaveProperty('evidence');
  });

  it('should not mutate the result', () => {
    const before = structuredClone(approvedFailing);

    summarizeQuestion(approvedFailing, 'failing');

    expect(approvedFailing).toEqual(before);
  });

  it('should carry the size of the inherited list in counts mode', () => {
    const result = resultOf(approvedInherit, supersededPlan, active);

    expect(result && summarizeQuestion(result, 'counts')).toMatchObject({
      counts: { inherited: 1 },
    });
  });
});
