import { describe, test, expect, jest } from '@jest/globals';
import {
  buildVigency,
  checkRelation,
  hasCycle,
  lineages,
  needsReview,
} from '../../src/domain/relations.ts';
import type { Linked, NamedRelation, RuleContext, Vigency } from '../../src/domain/relations.ts';
import type { RelationInput, RelationKind as Kind } from '../../src/domain/record.ts';
import * as rdsc from '../fixtures/domains/rdsc.ts';

const id = (process: string, n: number) => `${process}:${String(n).padStart(8, '0')}`;

function rec(recordId: string, ...relations: [Kind, string][]): Linked {
  return { id: recordId, relations: relations.map(([kind, to]) => ({ kind, to })) };
}

const [e1, e2, v1, v2] = [id('p', 1), id('p', 2), id('p', 3), id('p', 4)];

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

  test('lineages ignora supersedes para registro não lido e não funde linhagens por ele', () => {
    const [q1, q2] = [id('q', 1), id('q', 2)];
    const groups = lineages([rec(e1, ['supersedes', q1]), rec(e2, ['supersedes', q2]), rec(v1)]);
    expect(groups.map((group) => [...group].sort())).toEqual(
      expect.arrayContaining([[e1], [e2], [v1]]),
    );
    expect(groups).toHaveLength(3);
  });

  test('currentOf termina e devolve null num ciclo montado à mão', () => {
    const vigency = buildVigency([rec(e1, ['supersedes', e2]), rec(e2, ['supersedes', e1])]);
    expect([e1, e2].map((x) => vigency.isCurrent(x))).toEqual([false, false]);
    expect(vigency.currentOf(e1)).toBeNull();
    expect(vigency.currentOf(e2)).toBeNull();
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

  test('ciclo de três registros é ciclo, com ou sem cauda', () => {
    const ring = [
      rec(e1, ['supersedes', v1]),
      rec(e2, ['supersedes', e1]),
      rec(v1, ['supersedes', e2]),
    ];
    expect(hasCycle(ring)).toBe(true);
    expect(hasCycle([...ring, rec(v2, ['supersedes', v1])])).toBe(true);
  });

  test('cauda sem fechar o anel não é ciclo', () => {
    expect(
      hasCycle([rec(e1), rec(e2, ['supersedes', e1]), rec(v1, ['supersedes', e2]), rec(v2)]),
    ).toBe(false);
  });
});

describe('regras estruturais (D-10)', () => {
  const names = new Map<string, NamedRelation>([
    ...rdsc.relations.map((relation): [string, NamedRelation] => [relation.name, relation]),
    ['replaces-doc', { kind: 'supersedes', to: ['doc'] }],
  ]);

  /** Mesma vigência para qualquer tipo de relação. */
  const inForce = (vigency: Vigency) => ({ vigencyFor: () => vigency });

  function ctx(overrides: Partial<RuleContext> = {}): RuleContext {
    return {
      from: { id: id('p', 10), type: 'verdict' },
      to: { id: e1, type: 'evidence' },
      siblings: [],
      names,
      ...inForce(buildVigency([rec(e1)])),
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
    expect(violationOf(checkRelation({ kind: 'supports' }, ctx(inForce(replaced))))).toEqual({
      code: 'stale-destination',
      current: e2,
    });
    expect(violationOf(checkRelation({ kind: 'supports' }, ctx(inForce(revoked))))).toEqual({
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
      expect(checkRelation({ kind }, ctx(inForce(replaced)))).toEqual({ kind });
    }
  });

  test('not-current em supersedes e revokes sobre registro já substituído ou revogado', () => {
    const sameType = { from: { id: id('p', 10), type: 'evidence' } };
    const replaced = buildVigency([rec(e1), rec(e2, ['supersedes', e1])]);
    const revoked = buildVigency([rec(e1), rec(v1, ['revokes', e1])]);
    expect(
      violationOf(
        checkRelation({ kind: 'supersedes' }, ctx({ ...sameType, ...inForce(replaced) })),
      ),
    ).toEqual({
      code: 'not-current',
      current: e2,
    });
    expect(
      violationOf(checkRelation({ kind: 'revokes' }, ctx({ ...sameType, ...inForce(revoked) }))),
    ).toEqual({
      code: 'not-current',
      current: null,
    });
  });

  describe('vigência por tipo de relação (U1, D-10)', () => {
    const sameType = { from: { id: id('p', 10), type: 'evidence' } };
    const self = id('p', 10);

    /** Um lote de um item: `before` é o que vigora antes dele, `whole` inclui as relações dele. */
    function checkInBatch(relations: [Kind, string][], index: number) {
      const [kind, to] = relations[index]!;
      const before = buildVigency([rec(e1)]);
      const whole = buildVigency([rec(e1), rec(self, ...relations)]);
      const vigencyFor = jest.fn((relationKind: Kind) =>
        relationKind === 'supports' ? whole : before,
      );
      const siblings = relations
        .filter((_, i) => i !== index)
        .map(([k, t]) => ({ kind: k, to: t }));
      const result = checkRelation(
        { kind },
        ctx({ ...sameType, to: { id: to, type: 'evidence' }, siblings, vigencyFor }),
      );
      return { result, vigencyFor };
    }

    test.each([
      [
        'supersedes antes',
        [
          ['supersedes', e1],
          ['supports', e1],
        ],
      ],
      [
        'supports antes',
        [
          ['supports', e1],
          ['supersedes', e1],
        ],
      ],
    ] as [string, [Kind, string][]][])(
      'lote [supersedes → E, supports → E], %s: o supersedes passa e o supports é recusado',
      (_label, relations) => {
        const supersedesIndex = relations.findIndex(([kind]) => kind === 'supersedes');
        const supportsIndex = relations.findIndex(([kind]) => kind === 'supports');
        expect(checkInBatch(relations, supersedesIndex).result).toEqual({ kind: 'supersedes' });
        expect(violationOf(checkInBatch(relations, supportsIndex).result)).toEqual({
          code: 'stale-destination',
          current: self,
        });
      },
    );

    test('checkRelation pede a vigência do próprio tipo da relação', () => {
      const { vigencyFor: forSupports } = checkInBatch([['supports', e1]], 0);
      expect(forSupports).toHaveBeenCalledWith('supports');
      const { vigencyFor: forRevokes } = checkInBatch([['revokes', e1]], 0);
      expect(forRevokes).toHaveBeenCalledWith('revokes');
    });
  });

  test('supersedes-and-revokes nas duas direções, e só para o mesmo destino', () => {
    const sameType = { from: { id: id('p', 10), type: 'evidence' } };
    const revokes = [{ kind: 'revokes' as const, to: e1 }];
    const supersedes = [{ kind: 'supersedes' as const, to: e1 }];
    expect(
      violationOf(checkRelation({ kind: 'supersedes' }, ctx({ ...sameType, siblings: revokes }))),
    ).toEqual({ code: 'supersedes-and-revokes' });
    expect(
      violationOf(checkRelation({ kind: 'revokes' }, ctx({ ...sameType, siblings: supersedes }))),
    ).toEqual({ code: 'supersedes-and-revokes' });
    const elsewhere = [{ kind: 'revokes' as const, to: e2 }];
    expect(
      checkRelation({ kind: 'supersedes' }, ctx({ ...sameType, siblings: elsewhere })),
    ).toEqual({ kind: 'supersedes' });
  });

  describe('ordem fixa das regras (D-06, D-10)', () => {
    const sameType = { from: { id: id('p', 10), type: 'evidence' } };
    const otherProcess = { to: { id: id('q', 1), type: 'verdict' } };
    const replaced = buildVigency([rec(e1), rec(e2, ['supersedes', e1])]);

    // Cada caso viola duas regras vizinhas da ordem; vale a primeira.
    test.each([
      [
        'self-relation antes de unknown-relation-name',
        { as: 'nope' },
        { to: { id: id('p', 10), type: 'verdict' } },
        'self-relation',
      ],
      [
        'kind-mismatch antes de cross-process-currency',
        { as: 'replaces', kind: 'revokes' },
        otherProcess,
        'kind-mismatch',
      ],
      [
        'cross-process-currency antes de type-mismatch',
        { kind: 'supersedes' },
        otherProcess,
        'cross-process-currency',
      ],
      ['type-mismatch antes de endpoint-type', { as: 'replaces-doc' }, {}, 'type-mismatch'],
      [
        'endpoint-type antes de supports-and-contradicts',
        { as: 'based-on' },
        { ...sameType, siblings: [{ kind: 'contradicts', to: e1 }] },
        'endpoint-type',
      ],
      [
        'supports-and-contradicts antes de stale-destination',
        { kind: 'supports' },
        { siblings: [{ kind: 'contradicts', to: e1 }], ...inForce(replaced) },
        'supports-and-contradicts',
      ],
      [
        'supersedes-and-revokes antes de not-current',
        { kind: 'supersedes' },
        { ...sameType, siblings: [{ kind: 'revokes', to: e1 }], ...inForce(replaced) },
        'supersedes-and-revokes',
      ],
    ] as [string, Parameters<typeof checkRelation>[0], Partial<RuleContext>, string][])(
      '%s',
      (_label, input, overrides, code) => {
        expect(violationOf(checkRelation(input, ctx(overrides)))?.code).toBe(code);
      },
    );

    test('as vale como o kind do nome nas regras que leem o kind', () => {
      expect(violationOf(checkRelation({ as: 'replaces' }, ctx(otherProcess)))?.code).toBe(
        'cross-process-currency',
      );
      expect(
        violationOf(checkRelation({ as: 'replaces' }, ctx({ ...sameType, ...inForce(replaced) }))),
      ).toEqual({ code: 'not-current', current: e2 });
      expect(violationOf(checkRelation({ as: 'based-on' }, ctx(inForce(replaced))))).toEqual({
        code: 'stale-destination',
        current: e2,
      });
    });
  });

  test('kind ou as é obrigatório: o tipo recusa relação sem nenhum dos dois', () => {
    const parsed: RelationInput = { to: e1, kind: 'supports' };
    expect(checkRelation(parsed, ctx())).toEqual({ kind: 'supports' });
    expect(checkRelation({ kind: 'supports', as: 'based-on' }, ctx())).toEqual({
      kind: 'supports',
    });
    // @ts-expect-error nem kind nem as
    const withoutBoth = () => checkRelation({}, ctx());
    expect(withoutBoth).toBeInstanceOf(Function);
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

  test('staleIn também sai ordenada, qualquer que seja a ordem de leitura', () => {
    const [reviewA, reviewB] = [id('p', 12), id('p', 13)];
    const marks = needsReview([
      rec(plan),
      rec(reviewB, ['supports', plan]),
      rec(reviewA, ['supports', plan]),
      rec(id('p', 14), ['supersedes', reviewA]),
      rec(id('p', 15), ['supersedes', reviewB]),
    ]);
    expect(marks.get(plan)?.staleIn).toEqual([reviewA, reviewB]);
  });

  test('destino que não está em records não gera marca (D-24, D-09)', () => {
    const unread = id('q', 1);
    const marks = needsReview([
      rec(evidence, ['supports', unread]),
      rec(evidence2, ['supersedes', evidence]),
    ]);
    expect(marks.size).toBe(0);
  });

  test('controle: o mesmo apoio com o destino lido marca a origem vigente', () => {
    const marks = needsReview([
      rec(evidence),
      rec(evidence2, ['supersedes', evidence]),
      rec(verdict, ['supports', evidence]),
    ]);
    expect(marks.get(verdict)).toEqual({ staleIn: [], staleOut: [evidence] });
  });
});
