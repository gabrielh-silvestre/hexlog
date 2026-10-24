import { describe, expect, it } from '@jest/globals';
import { z } from 'zod';
import {
  RULE_MAX_CODE_POINTS,
  SECTION_MAX_CODE_POINTS,
  STATEMENT_MAX_CODE_POINTS,
  STRATEGY_DOC,
  planSync,
  validateExtracted,
  verifySync,
  type ExtractedRule,
  type LogRow,
  type SyncInput,
  type SyncPlan,
} from '../scripts/flow/sync.ts';
import { definitionOf } from './flow-data.ts';

const maxLengthOf = (type: string, field: string): number | undefined =>
  z
    .object({ properties: z.record(z.string(), z.object({ maxLength: z.number().optional() })) })
    .parse(definitionOf('types', type)).properties[field]?.maxLength;

const extractedRule = (overrides: Partial<ExtractedRule> = {}): ExtractedRule => ({
  slug: 'rule-a',
  rule: 'Some rule',
  section: 'Some section',
  ...overrides,
});

describe('validateExtracted', () => {
  it('should return nothing for rules within the ceilings', () => {
    const rules = [extractedRule(), extractedRule({ slug: 'rule-b', rule: 'x'.repeat(400) })];

    expect(validateExtracted('fronteiras', rules)).toEqual([]);
  });

  it('should keep the ceilings equal to the maxLength of the directive and premise types', () => {
    expect([RULE_MAX_CODE_POINTS, SECTION_MAX_CODE_POINTS, STATEMENT_MAX_CODE_POINTS]).toEqual([
      maxLengthOf('directive', 'rule'),
      maxLengthOf('directive', 'section'),
      maxLengthOf('premise', 'statement'),
    ]);
  });

  it.each([
    ['a rule above the ceiling', { rule: 'x'.repeat(401) }, 'rule', 401, 400],
    ['an empty rule', { rule: '' }, 'rule', 0, 400],
    ['a section above the ceiling', { section: 'x'.repeat(121) }, 'section', 121, 120],
    ['an empty section', { section: '' }, 'section', 0, 120],
    ['a slug outside the target format', { slug: 'Rule_A' }, 'slug', 6, 63],
    ['a slug above 63 characters', { slug: 'a'.repeat(64) }, 'slug', 64, 63],
  ] as const)('should report %s with the measured size', (_name, overrides, field, size, max) => {
    const rules = [extractedRule(overrides)];

    const excess = validateExtracted('fronteiras', rules);

    expect(excess).toEqual([{ slug: rules[0]?.slug, field, size, max }]);
  });

  it('should count code points instead of UTF-16 units', () => {
    const rules = [extractedRule({ rule: '😀'.repeat(400) })];

    expect(validateExtracted('fronteiras', rules)).toEqual([]);
  });

  it('should report a repeated slug once with how many times it appears', () => {
    const rules = [extractedRule(), extractedRule(), extractedRule()];

    expect(validateExtracted('fronteiras', rules)).toEqual([
      { slug: 'rule-a', field: 'duplicate-slug', size: 3, max: 1 },
    ]);
  });

  describe('with the estrategia document', () => {
    it('should measure the rule as a statement of up to 255 code points', () => {
      const rules = [extractedRule({ section: '', rule: 'x'.repeat(256) })];

      expect(validateExtracted(STRATEGY_DOC, rules)).toEqual([
        { slug: 'rule-a', field: 'statement', size: 256, max: 255 },
      ]);
    });

    it('should accept an empty section', () => {
      const rules = [extractedRule({ section: '', rule: 'x'.repeat(255) })];

      expect(validateExtracted(STRATEGY_DOC, rules)).toEqual([]);
    });
  });
});

describe('verifySync', () => {
  const DOC = 'docs/directives/fronteiras.md';
  const target = (slug: string): string => `directives.fronteiras.${slug}`;
  const oldRow = (id: string, slug: string, replacedBy: 'supersedes' | 'revokes'): LogRow => ({
    id,
    target: slug === 'doc' ? 'directives.fronteiras' : target(slug),
    data: {},
    out: [],
    in: [{ kind: replacedBy }],
  });
  const vigent = (id: string, slug: string, rule: string) => ({
    id,
    target: target(slug),
    rule,
    section: 'S',
    out: [],
  });

  function planWith(extracted: ExtractedRule[]): SyncPlan {
    const input: SyncInput = {
      docSlug: 'fronteiras',
      path: DOC,
      hash: 'hash-new',
      current: { id: 'old-doc', source: 'hash-old' },
      vigent: [vigent('old-a', 'rule-a', 'Old rule'), vigent('old-c', 'rule-c', 'Gone rule')],
      extracted,
    };
    return planSync(input);
  }

  const CHANGED = extractedRule({ slug: 'rule-a', rule: 'New rule', section: 'S' });
  const ADDED = extractedRule({ slug: 'rule-b', rule: 'Added rule', section: 'S' });

  /** O log depois de gravar o plano: um registro vigente por planejado e os antigos já substituídos. */
  function logAfter(plan: SyncPlan): LogRow[] {
    const written = plan.batches
      .flatMap(({ records }) => records)
      .map(({ target: recordTarget, data, relations }, index): LogRow => ({
        id: `new-${index}`,
        target: recordTarget,
        data,
        out: relations.map(({ kind, as, to }) => ({
          kind: kind ?? 'complements',
          ...(as !== undefined && { as }),
          to,
        })),
        in: [],
      }));
    return [
      ...written,
      oldRow('old-a', 'rule-a', 'supersedes'),
      oldRow('old-c', 'rule-c', 'revokes'),
      oldRow('old-doc', 'doc', 'supersedes'),
    ];
  }

  it('should report nothing when the log matches the plan', () => {
    const plan = planWith([CHANGED, ADDED]);

    expect(verifySync(plan, logAfter(plan))).toEqual([]);
  });

  it('should accept a named relation whose kind the pinned name defines', () => {
    const plan = planWith([CHANGED, { ...ADDED, closes: ['gap-1'] }]);

    expect(verifySync(plan, logAfter(plan))).toEqual([]);
  });

  it.each([
    [
      'a planned record that is missing',
      (rows: LogRow[]) => rows.filter(({ target: rowTarget }) => rowTarget !== target('rule-b')),
      { target: target('rule-b'), problem: 'missing' },
    ],
    [
      'a record whose data differs',
      (rows: LogRow[]) =>
        rows.map((row) =>
          row.target === target('rule-b') ? { ...row, data: { ...row.data, rule: 'Other' } } : row,
        ),
      { target: target('rule-b'), problem: 'data-differs' },
    ],
    [
      'a doc whose source differs from the hash',
      (rows: LogRow[]) =>
        rows.map((row) =>
          row.target === 'directives.fronteiras' && row.id.startsWith('new-')
            ? { ...row, data: { ...row.data, source: 'forged' } }
            : row,
        ),
      { target: 'directives.fronteiras', problem: 'source-differs' },
    ],
    [
      'a record whose outgoing relations differ',
      (rows: LogRow[]) =>
        rows.map((row) =>
          row.target === target('rule-a') && row.id.startsWith('new-') ? { ...row, out: [] } : row,
        ),
      { target: target('rule-a'), problem: 'relations-differ' },
    ],
    [
      'a superseded rule that is still current',
      (rows: LogRow[]) => rows.map((row) => (row.id === 'old-a' ? { ...row, in: [] } : row)),
      { target: target('rule-a'), problem: 'old-still-current' },
    ],
    [
      'a revoked rule that is still current',
      (rows: LogRow[]) => rows.map((row) => (row.id === 'old-c' ? { ...row, in: [] } : row)),
      { target: target('rule-c'), problem: 'old-still-current' },
    ],
  ])('should report %s', (_name, tamper, expected) => {
    const plan = planWith([CHANGED, ADDED]);
    const rows = tamper(logAfter(plan));

    expect(verifySync(plan, rows)).toEqual([expected]);
  });

  it('should report a removed doc whose log record lacks the removed flag', () => {
    const plan = planSync({
      docSlug: 'fronteiras',
      path: DOC,
      hash: 'hash-new',
      current: { id: 'old-doc', source: 'hash-old' },
      vigent: [],
      extracted: null,
    });
    const rows = logAfter(plan).map((row) =>
      row.id.startsWith('new-') ? { ...row, data: { path: DOC, source: 'hash-old' } } : row,
    );

    expect(verifySync(plan, rows)).toEqual([
      { target: 'directives.fronteiras', problem: 'data-differs' },
    ]);
  });
});
