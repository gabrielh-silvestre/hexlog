import { describe, test, expect } from '@jest/globals';
import {
  buildVigency,
  checkRelation,
  hasCycle,
  lineages,
  needsReview,
  RelationKind,
} from '../../src/domain/relations.ts';
import type { Linked, NamedRelation, RuleContext } from '../../src/domain/relations.ts';
import { RelationKind as RecordRelationKind } from '../../src/domain/record.ts';
import type { RelationKind as Kind } from '../../src/domain/record.ts';

const id = (process: string, n: number) => `${process}:${String(n).padStart(8, '0')}`;

function rec(recordId: string, ...relations: [Kind, string][]): Linked {
  return { id: recordId, relations: relations.map(([kind, to]) => ({ kind, to })) };
}

const [e1, e2, v1, v2] = [id('p', 1), id('p', 2), id('p', 3), id('p', 4)];

describe('RelationKind', () => {
  test('é o mesmo de record.ts, reexportado sem duplicar', () => {
    expect(RelationKind).toBe(RecordRelationKind);
  });
});

describe('vigência e linhagem (D-08)', () => {
  test('registro sem relação de entrada é vigente, e id desconhecido também', () => {
    const vigency = buildVigency([rec(e1)]);
    expect(vigency.isCurrent(e1)).toBe(true);
    expect(vigency.isCurrent(id('p', 99))).toBe(true);
    expect(vigency.currentOf(e1)).toBe(e1);
  });

  test('supersedes tira a vigência do antigo e a versão atual é a última da linhagem', () => {
    const vigency = buildVigency([
      rec(e1),
      rec(e2, ['supersedes', e1]),
      rec(v1, ['supersedes', e2]),
    ]);
    expect([e1, e2, v1].map((x) => vigency.isCurrent(x))).toEqual([false, false, true]);
    expect(vigency.currentOf(e1)).toBe(v1);
    expect(vigency.currentOf(e2)).toBe(v1);
  });

  test('revokes tira a vigência, e revogar a versão atual encerra a linhagem sem vigente', () => {
    const vigency = buildVigency([rec(e1), rec(e2, ['supersedes', e1]), rec(v1, ['revokes', e2])]);
    expect(vigency.isCurrent(e2)).toBe(false);
    expect(vigency.currentOf(e1)).toBeNull();
    expect(vigency.currentOf(e2)).toBeNull();
    expect(vigency.isCurrent(v1)).toBe(true);
  });

  test('relação que não é supersedes nem revokes não altera a vigência', () => {
    const vigency = buildVigency([rec(e1), rec(v1, ['supports', e1], ['complements', e1])]);
    expect(vigency.isCurrent(e1)).toBe(true);
  });

  test('o resultado não depende da ordem de leitura', () => {
    const records = [rec(e1), rec(e2, ['supersedes', e1]), rec(v1, ['supersedes', e2])];
    const vigency = buildVigency([...records].reverse());
    expect(vigency.currentOf(e1)).toBe(v1);
  });

  test('lineages agrupa por supersedes, e revokes não junta linhagens', () => {
    const groups = lineages([
      rec(e1),
      rec(e2, ['supersedes', e1]),
      rec(v1),
      rec(v2, ['revokes', v1]),
    ]);
    expect(groups.map((group) => [...group].sort())).toEqual(
      expect.arrayContaining([[e1, e2], [v1], [v2]]),
    );
    expect(groups).toHaveLength(3);
  });
});

describe('ciclo', () => {
  test('aresta de volta montada à mão é ciclo, e autoaresta também', () => {
    expect(hasCycle([rec(e1, ['supersedes', e2]), rec(e2, ['supersedes', e1])])).toBe(true);
    expect(hasCycle([rec(e1, ['supersedes', e1])])).toBe(true);
  });

  test('cadeia de substituição e destino fora dos registros lidos não são ciclo', () => {
    expect(
      hasCycle([
        rec(e1),
        rec(e2, ['supersedes', e1]),
        rec(v1, ['supersedes', e2], ['supersedes', id('q', 1)]),
      ]),
    ).toBe(false);
  });

  test('apoio mútuo não é ciclo de substituição', () => {
    expect(hasCycle([rec(e1, ['supports', e2]), rec(e2, ['supports', e1])])).toBe(false);
  });
});

describe('regras estruturais (D-10)', () => {
  const names = new Map<string, NamedRelation>([
    ['replaces', { kind: 'supersedes' }],
    ['based-on', { kind: 'supports', from: ['verdict'], to: ['evidence'] }],
  ]);

  function ctx(overrides: Partial<RuleContext> = {}): RuleContext {
    return {
      from: { id: id('p', 10), type: 'verdict' },
      to: { id: e1, type: 'evidence' },
      siblings: [],
      names,
      vigency: buildVigency([rec(e1)]),
      ...overrides,
    };
  }

  const violationOf = (result: ReturnType<typeof checkRelation>) =>
    'violation' in result ? result.violation : undefined;

  test('relação válida devolve o kind', () => {
    expect(checkRelation({ kind: 'supports' }, ctx())).toEqual({ kind: 'supports' });
  });

  test('self-relation', () => {
    const result = checkRelation(
      { kind: 'supports' },
      ctx({ to: { id: id('p', 10), type: 'verdict' } }),
    );
    expect(violationOf(result)).toEqual({ code: 'self-relation' });
  });

  test('as preenche o kind; kind igual ao do nome passa', () => {
    expect(checkRelation({ as: 'based-on' }, ctx())).toEqual({ kind: 'supports' });
    expect(checkRelation({ as: 'based-on', kind: 'supports' }, ctx())).toEqual({
      kind: 'supports',
    });
  });

  test('unknown-relation-name e kind-mismatch', () => {
    expect(violationOf(checkRelation({ as: 'nope' }, ctx()))).toEqual({
      code: 'unknown-relation-name',
    });
    expect(violationOf(checkRelation({ as: 'based-on', kind: 'contradicts' }, ctx()))).toEqual({
      code: 'kind-mismatch',
    });
  });

  test('endpoint-type recusa origem ou destino fora das listas do nome', () => {
    const wrongFrom = ctx({ from: { id: id('p', 10), type: 'evidence' } });
    const wrongTo = ctx({ to: { id: e1, type: 'verdict' } });
    expect(violationOf(checkRelation({ as: 'based-on' }, wrongFrom))).toEqual({
      code: 'endpoint-type',
    });
    expect(violationOf(checkRelation({ as: 'based-on' }, wrongTo))).toEqual({
      code: 'endpoint-type',
    });
  });

  test('pontas sem lista declarada aceitam qualquer tipo', () => {
    const base = ctx({ from: { id: id('p', 10), type: 'evidence' } });
    expect(checkRelation({ as: 'replaces' }, base)).toEqual({ kind: 'supersedes' });
  });

  test('cross-process-currency em supersedes e em revokes entre processos', () => {
    const other = { to: { id: id('q', 1), type: 'verdict' } };
    expect(violationOf(checkRelation({ kind: 'supersedes' }, ctx(other)))).toEqual({
      code: 'cross-process-currency',
    });
    expect(violationOf(checkRelation({ kind: 'revokes' }, ctx(other)))).toEqual({
      code: 'cross-process-currency',
    });
  });

  test('type-mismatch só em supersedes: revokes aceita outro tipo', () => {
    expect(violationOf(checkRelation({ kind: 'supersedes' }, ctx()))).toEqual({
      code: 'type-mismatch',
    });
    expect(checkRelation({ kind: 'revokes' }, ctx())).toEqual({ kind: 'revokes' });
  });

  test('supports-and-contradicts nas duas direções', () => {
    const contradicts = [{ kind: 'contradicts' as const, to: e1 }];
    const supports = [{ kind: 'supports' as const, to: e1 }];
    expect(
      violationOf(checkRelation({ kind: 'supports' }, ctx({ siblings: contradicts }))),
    ).toEqual({
      code: 'supports-and-contradicts',
    });
    expect(
      violationOf(checkRelation({ kind: 'contradicts' }, ctx({ siblings: supports }))),
    ).toEqual({
      code: 'supports-and-contradicts',
    });
    expect(
      checkRelation({ kind: 'contradicts' }, ctx({ siblings: [{ kind: 'supports', to: e2 }] })),
    ).toEqual({
      kind: 'contradicts',
    });
  });

  test('stale-destination traz a versão atual da linhagem ou null', () => {
    const replaced = buildVigency([rec(e1), rec(e2, ['supersedes', e1])]);
    const revoked = buildVigency([rec(e1), rec(v1, ['revokes', e1])]);
    expect(violationOf(checkRelation({ kind: 'supports' }, ctx({ vigency: replaced })))).toEqual({
      code: 'stale-destination',
      current: e2,
    });
    expect(violationOf(checkRelation({ kind: 'supports' }, ctx({ vigency: revoked })))).toEqual({
      code: 'stale-destination',
      current: null,
    });
  });

  test('só supports confere a vigência do destino: contradicts, answers e derivesFrom passam', () => {
    const replaced = buildVigency([rec(e1), rec(e2, ['supersedes', e1])]);
    for (const kind of [
      'contradicts',
      'answers',
      'derivesFrom',
      'complements',
      'reopens',
    ] as const) {
      expect(checkRelation({ kind }, ctx({ vigency: replaced }))).toEqual({ kind });
    }
  });

  test('not-current em supersedes e revokes sobre registro já substituído ou revogado', () => {
    const sameType = { from: { id: id('p', 10), type: 'evidence' } };
    const replaced = buildVigency([rec(e1), rec(e2, ['supersedes', e1])]);
    const revoked = buildVigency([rec(e1), rec(v1, ['revokes', e1])]);
    expect(
      violationOf(checkRelation({ kind: 'supersedes' }, ctx({ ...sameType, vigency: replaced }))),
    ).toEqual({
      code: 'not-current',
      current: e2,
    });
    expect(
      violationOf(checkRelation({ kind: 'revokes' }, ctx({ ...sameType, vigency: revoked }))),
    ).toEqual({
      code: 'not-current',
      current: null,
    });
  });

  test('vigência depois do lote inteiro: supports e supersedes ao mesmo destino são recusados nas duas ordens', () => {
    const batchFirst = buildVigency([
      rec(e1),
      rec(id('p', 10), ['supports', e1], ['supersedes', e1]),
    ]);
    expect(
      violationOf(checkRelation({ kind: 'supports' }, ctx({ vigency: batchFirst }))),
    ).toMatchObject({
      code: 'stale-destination',
    });
    const batchSecond = buildVigency([
      rec(e1),
      rec(id('p', 10), ['supersedes', e1], ['supports', e1]),
    ]);
    expect(
      violationOf(checkRelation({ kind: 'supports' }, ctx({ vigency: batchSecond }))),
    ).toMatchObject({
      code: 'stale-destination',
    });
  });

  test('a primeira regra violada, na ordem fixa, é a devolvida', () => {
    const bad = ctx({
      to: { id: id('q', 1), type: 'verdict' },
      siblings: [{ kind: 'supports', to: id('q', 1) }],
    });
    expect(violationOf(checkRelation({ kind: 'supersedes' }, bad))).toEqual({
      code: 'cross-process-currency',
    });
  });
});

describe('prova vencida pela linhagem (D-09)', () => {
  // Caso rdsc: veredito (verdict) apoiado por evidência (evidence) via based-on = supports.
  const evidence = id('p', 1);
  const evidence2 = id('p', 2);
  const verdict = id('p', 3);
  const verdict2 = id('p', 4);

  test('veredito vigente que cita evidência depois substituída recebe staleOut', () => {
    const marks = needsReview([
      rec(evidence),
      rec(verdict, ['supports', evidence]),
      rec(evidence2, ['supersedes', evidence]),
    ]);
    expect(marks.get(verdict)).toEqual({ staleIn: [], staleOut: [evidence] });
    expect(marks.has(evidence2)).toBe(false);
  });

  test('a marca sai quando o veredito V’ substitui V citando a evidência nova', () => {
    const marks = needsReview([
      rec(evidence),
      rec(verdict, ['supports', evidence]),
      rec(evidence2, ['supersedes', evidence]),
      rec(verdict2, ['supersedes', verdict], ['supports', evidence2]),
    ]);
    expect(marks.size).toBe(0);
  });

  test('V’ que substitui V sem citar a evidência nova não tem marca, pois não apoia mais nada', () => {
    const marks = needsReview([
      rec(evidence),
      rec(verdict, ['supports', evidence]),
      rec(evidence2, ['supersedes', evidence]),
      rec(verdict2, ['supersedes', verdict]),
    ]);
    expect(marks.size).toBe(0);
  });

  test('evidência revogada marca o veredito vigente', () => {
    const marks = needsReview([
      rec(evidence),
      rec(verdict, ['supports', evidence]),
      rec(id('p', 5), ['revokes', evidence]),
    ]);
    expect(marks.get(verdict)).toEqual({ staleIn: [], staleOut: [evidence] });
  });

  test('veredito vigente que cita evidência vigente não recebe marca', () => {
    expect(needsReview([rec(evidence), rec(verdict, ['supports', evidence])]).size).toBe(0);
  });

  // Plano aprovado por revisão: a revisão (review) apoia o plano (plan).
  const plan = id('p', 11);
  const review = id('p', 12);
  const review2 = id('p', 13);

  test('plano aprovado por revisão depois substituída recebe staleIn se a atual não apoia mais', () => {
    const marks = needsReview([
      rec(plan),
      rec(review, ['supports', plan]),
      rec(review2, ['supersedes', review]),
    ]);
    expect(marks.get(plan)).toEqual({ staleIn: [review], staleOut: [] });
  });

  test('R’ que repete supports para o plano mantém o apoio vivo e o plano sem marca', () => {
    const marks = needsReview([
      rec(plan),
      rec(review, ['supports', plan]),
      rec(review2, ['supersedes', review], ['supports', plan]),
    ]);
    expect(marks.size).toBe(0);
  });

  test('revisão revogada (linhagem de apoio revogada) marca o plano', () => {
    const marks = needsReview([
      rec(plan),
      rec(review, ['supports', plan]),
      rec(id('p', 14), ['revokes', review]),
    ]);
    expect(marks.get(plan)).toEqual({ staleIn: [review], staleOut: [] });
  });

  test('as listas saem ordenadas', () => {
    const marks = needsReview([
      rec(evidence),
      rec(evidence2),
      rec(verdict, ['supports', evidence2], ['supports', evidence]),
      rec(id('p', 6), ['supersedes', evidence]),
      rec(id('p', 7), ['supersedes', evidence2]),
    ]);
    expect(marks.get(verdict)?.staleOut).toEqual([evidence, evidence2]);
  });
});
