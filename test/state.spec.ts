import { describe, test, expect } from '@jest/globals';
import { randomUUIDv7 } from 'node:crypto';
import { omit } from 'es-toolkit';
import type { EventLine } from '../src/events.ts';
import {
  effectiveNow,
  projectState,
  validateField,
  VocabularySchema,
  type Vocabulary,
} from '../src/state.ts';

// ---- fixtures locais (duplicadas em state.property.spec.ts: 2 arquivos só, sem 3º módulo) ----

const T = (n: number) => new Date(n * 60_000).toISOString();
const TARGET_1 = 'hex:target:u1';
const TARGET_2 = 'hex:target:u2';

const emptyVocabulary: Vocabulary = {
  core: { milestoneType: [], result: [], action: [] },
  byOwner: {},
};

let nextSeqValue = 0;

function line(args: {
  type: string;
  data: Record<string, unknown>;
  id?: string;
  timestamp?: string;
  seq?: number;
}): EventLine {
  const seqNumber = args.seq ?? nextSeqValue++;
  return {
    seq: seqNumber,
    id: args.id ?? `p:r:${args.type}:${randomUUIDv7()}`,
    type: args.type,
    timestamp: args.timestamp ?? T(seqNumber),
    agent: 'test',
    prevHash: '0'.repeat(64), // sintético: a projeção não verifica hash
    data: args.data,
  };
}

function milestone(
  data: {
    target: string;
    milestoneType?: string;
    dueAt?: string;
    decisions?: { item: string; action: string; text: string }[];
    predecessors?: string[];
  },
  options: { id?: string; timestamp?: string; seq?: number } = {},
): EventLine {
  const { milestoneType = 'test-event', ...rest } = data;
  return line({ type: 'milestone', data: { milestoneType, ...rest }, ...options });
}

function verdict(
  data: {
    target: string;
    claim: string;
    result?: string;
    supersedes?: string[];
    dependsOn?: string[];
  },
  options: { id?: string; timestamp?: string; seq?: number } = {},
): EventLine {
  const { result = 'confirmed', ...rest } = data;
  return line({
    type: 'verdict',
    data: { source: 'f', evidence: 'p', origin: 'o', trace: 'r', result, ...rest },
    ...options,
  });
}

function vote(
  data: { target: string; round: string; votersExpected: number; position?: string },
  options: { id?: string; timestamp?: string; seq?: number } = {},
): EventLine {
  const { position = 'approve', ...rest } = data;
  return line({ type: 'vote', data: { position, changed: false, ...rest }, ...options });
}

// ---- testes ----

describe('projectState › State bate com fixture (envelope novo, target hex:target:*)', () => {
  test('marco + veredito confirmando produzem o State esperado', () => {
    const m1 = milestone({ target: TARGET_1, milestoneType: 'open-skeleton' }, { timestamp: T(0) });
    const v1 = verdict(
      { target: TARGET_1, claim: 'dod-1', result: 'confirmed' },
      { timestamp: T(1) },
    );
    const lines = [m1, v1];
    const vocabulary: Vocabulary = {
      core: { milestoneType: ['open-skeleton'], result: ['confirmed'], action: [] },
      byOwner: {},
    };

    expect(projectState(lines, vocabulary, effectiveNow(T(1), lines))).toEqual({
      logThrough: { id: v1.id, seq: v1.seq, timestamp: v1.timestamp },
      active: [
        { target: TARGET_1, claim: 'dod-1', status: 'active', active: v1.id, result: 'confirmed' },
      ],
      conflicts: [],
      orphans: [],
      toReview: [],
      invalidReferences: [],
      warnings: [],
      forks: [],
      targets: [TARGET_1],
      blocked: [],
      released: [],
      phases: [{ target: TARGET_1, current: 'open-skeleton' }],
      voteRounds: [],
    });
  });
});

describe('projectState › pureza', () => {
  test('mesmos argumentos produzem o mesmo resultado', () => {
    const v1 = verdict({ target: TARGET_1, claim: 'a1' }, { timestamp: T(0) });
    const lines = [v1];
    expect(projectState(lines, emptyVocabulary, T(0))).toEqual(
      projectState(lines, emptyVocabulary, T(0)),
    );
  });

  test('rebuild completo repetido (replay incremental) bate com o rebuild direto', () => {
    const m1 = milestone({ target: TARGET_1, dueAt: T(10) }, { timestamp: T(0) });
    const v1 = verdict({ target: TARGET_1, claim: 'a1' }, { timestamp: T(1) });
    const v2 = verdict({ target: TARGET_1, claim: 'a2' }, { timestamp: T(2) });
    const lines = [m1, v1, v2];

    let lastReplay;
    for (let through = 1; through <= lines.length; through++) {
      const partial = lines.slice(0, through);
      lastReplay = projectState(partial, emptyVocabulary, effectiveNow(T(2), partial));
    }

    expect(lastReplay).toEqual(projectState(lines, emptyVocabulary, effectiveNow(T(2), lines)));
  });
});

describe('projectState › dedupe por id', () => {
  test('evento duplicado por id não muda a Projection', () => {
    const v1 = verdict({ target: TARGET_1, claim: 'a1' }, { timestamp: T(0) });
    const v2 = verdict({ target: TARGET_1, claim: 'a2' }, { timestamp: T(1) });
    const lines = [v1, v2];
    const withDuplicate = [v1, v1, v2];

    expect(projectState(withDuplicate, emptyVocabulary, T(1))).toEqual(
      projectState(lines, emptyVocabulary, T(1)),
    );
  });
});

describe('N3 › supersessão', () => {
  test('veredito único fica vigente', () => {
    const v1 = verdict({ target: TARGET_1, claim: 'a1' }, { timestamp: T(0) });
    const projection = projectState([v1], emptyVocabulary, T(0));
    expect(projection.active).toEqual([
      { target: TARGET_1, claim: 'a1', status: 'active', active: v1.id, result: 'confirmed' },
    ]);
    expect(projection.conflicts).toEqual([]);
  });

  test('dois vereditos concorrentes sem supera viram conflito', () => {
    const v1 = verdict({ target: TARGET_1, claim: 'a1' }, { timestamp: T(0) });
    const v2 = verdict({ target: TARGET_1, claim: 'a1' }, { timestamp: T(1) });
    const projection = projectState([v1, v2], emptyVocabulary, T(1));
    expect(projection.active).toEqual([
      {
        target: TARGET_1,
        claim: 'a1',
        status: 'conflict',
        candidates: [v1.id, v2.id],
        result: 'confirmed',
      },
    ]);
    expect(projection.conflicts).toEqual([
      { target: TARGET_1, claim: 'a1', candidates: [v1.id, v2.id] },
    ]);
  });

  test('cadeia A<-B<-C: só C fica vigente (supera em cadeia)', () => {
    const a = verdict({ target: TARGET_1, claim: 'x' }, { timestamp: T(0) });
    const b = verdict({ target: TARGET_1, claim: 'x', supersedes: [a.id] }, { timestamp: T(1) });
    const c = verdict({ target: TARGET_1, claim: 'x', supersedes: [b.id] }, { timestamp: T(2) });
    const projection = projectState([a, b, c], emptyVocabulary, T(2));
    expect(projection.active).toEqual([
      { target: TARGET_1, claim: 'x', status: 'active', active: c.id, result: 'confirmed' },
    ]);
  });

  test('supera cruzando target/claim diferente não funde grupos', () => {
    const y = verdict({ target: TARGET_2, claim: 'A2' }, { timestamp: T(0) });
    const x = verdict({ target: TARGET_1, claim: 'A1', supersedes: [y.id] }, { timestamp: T(1) });
    const projection = projectState([y, x], emptyVocabulary, T(1));
    expect(projection.active).toEqual([
      { target: TARGET_1, claim: 'A1', status: 'active', active: x.id, result: 'confirmed' },
    ]);
  });

  test('supera para id que não é Verdict do log vira invalidReferences', () => {
    const anyMilestone = milestone({ target: TARGET_1 }, { timestamp: T(0) });
    const v1 = verdict(
      { target: TARGET_1, claim: 'a1', supersedes: [anyMilestone.id] },
      { timestamp: T(1) },
    );
    const projection = projectState([anyMilestone, v1], emptyVocabulary, T(1));
    expect(projection.invalidReferences).toEqual([{ citedBy: v1.id, reference: anyMilestone.id }]);
    expect(projection.active).toEqual([
      { target: TARGET_1, claim: 'a1', status: 'active', active: v1.id, result: 'confirmed' },
    ]);
  });

  test('supera para id inexistente vira referenciasInvalidas', () => {
    const v1 = verdict(
      { target: TARGET_1, claim: 'a1', supersedes: ['p:r:verdict:phantom'] },
      { timestamp: T(0) },
    );
    const projection = projectState([v1], emptyVocabulary, T(0));
    expect(projection.invalidReferences).toEqual([
      { citedBy: v1.id, reference: 'p:r:verdict:phantom' },
    ]);
  });
});

describe('P1 › forks', () => {
  test('2 sucessores vivos do mesmo superado → forks aponta os dois', () => {
    const a = verdict({ target: TARGET_1, claim: 'x' }, { timestamp: T(0) });
    const b = verdict({ target: TARGET_1, claim: 'y', supersedes: [a.id] }, { timestamp: T(1) });
    const c = verdict({ target: TARGET_1, claim: 'z', supersedes: [a.id] }, { timestamp: T(2) });
    const projection = projectState([a, b, c], emptyVocabulary, T(2));

    expect(projection.forks).toEqual([{ verdict: a.id, successors: [b.id, c.id] }]);
  });

  test('cadeias independentes, cada citado com só 1 sucessor vivo → forks vazio (fan-out legítimo, fora de escopo)', () => {
    const a1 = verdict({ target: TARGET_1, claim: 'x' }, { timestamp: T(0) });
    const b1 = verdict({ target: TARGET_1, claim: 'x', supersedes: [a1.id] }, { timestamp: T(1) });
    const a2 = verdict({ target: TARGET_2, claim: 'y' }, { timestamp: T(2) });
    const b2 = verdict({ target: TARGET_2, claim: 'y', supersedes: [a2.id] }, { timestamp: T(3) });
    const projection = projectState([a1, b1, a2, b2], emptyVocabulary, T(3));

    expect(projection.forks).toEqual([]);
  });

  test('recuperação: D supera os dois ramos (B e C) → forks vazio', () => {
    const a = verdict({ target: TARGET_1, claim: 'x' }, { timestamp: T(0) });
    const b = verdict({ target: TARGET_1, claim: 'y', supersedes: [a.id] }, { timestamp: T(1) });
    const c = verdict({ target: TARGET_1, claim: 'z', supersedes: [a.id] }, { timestamp: T(2) });
    const d = verdict(
      { target: TARGET_1, claim: 'w', supersedes: [b.id, c.id] },
      { timestamp: T(3) },
    );
    const projection = projectState([a, b, c, d], emptyVocabulary, T(3));

    expect(projection.forks).toEqual([]);
  });

  test('recuperação: D supera só um ramo (B) → resta 1 sucessor vivo (C) e forks fica vazio', () => {
    const a = verdict({ target: TARGET_1, claim: 'x' }, { timestamp: T(0) });
    const b = verdict({ target: TARGET_1, claim: 'y', supersedes: [a.id] }, { timestamp: T(1) });
    const c = verdict({ target: TARGET_1, claim: 'z', supersedes: [a.id] }, { timestamp: T(2) });
    const d = verdict({ target: TARGET_1, claim: 'y', supersedes: [b.id] }, { timestamp: T(3) });
    const projection = projectState([a, b, c, d], emptyVocabulary, T(3));

    expect(projection.forks).toEqual([]);
  });
});

describe('N3 › órfãos (relógio injetado)', () => {
  test('vencido pelo relógio do próprio log', () => {
    const opening = milestone({ target: TARGET_1, dueAt: T(1) }, { timestamp: T(0) });
    const other = verdict({ target: TARGET_2, claim: 'a1' }, { timestamp: T(3) });
    const lines = [opening, other];

    expect(projectState(lines, emptyVocabulary, effectiveNow(T(0), lines)).orphans).toEqual([
      { milestone: opening.id, target: TARGET_1, dueAt: T(1) },
    ]);
  });

  test('a tempo (agora ainda antes do prazo) não é órfão', () => {
    const opening = milestone({ target: TARGET_1, dueAt: T(10) }, { timestamp: T(0) });
    expect(projectState([opening], emptyVocabulary, T(1)).orphans).toEqual([]);
  });

  test('pela parede: relógio injetado ultrapassa o prazo mesmo sem evento novo no log', () => {
    const opening = milestone({ target: TARGET_1, dueAt: T(1) }, { timestamp: T(0) });
    const now = effectiveNow(T(5), [opening]);

    expect(projectState([opening], emptyVocabulary, now).orphans).toEqual([
      { milestone: opening.id, target: TARGET_1, dueAt: T(1) },
    ]);
  });
});

describe('N3 › aRevisar (com gate incluído)', () => {
  test('inclui eventos do mesmo target do verdict superado (milestone e gate), exclui targets não relacionados', () => {
    const v1 = verdict({ target: TARGET_1, claim: 'a1' }, { timestamp: T(0) });
    const m1 = milestone({ target: TARGET_1, milestoneType: 'comment' }, { timestamp: T(1) });
    const gate1 = milestone({ target: TARGET_1, milestoneType: 'gate' }, { timestamp: T(2) });
    const v2 = verdict({ target: TARGET_1, claim: 'a1', supersedes: [v1.id] }, { timestamp: T(3) });
    const otherTarget = milestone(
      { target: TARGET_2, milestoneType: 'comment' },
      { timestamp: T(4) },
    );

    const projection = projectState([v1, m1, gate1, v2, otherTarget], emptyVocabulary, T(4));

    expect(projection.toReview).toEqual(expect.arrayContaining([m1.id, gate1.id, v2.id]));
    expect(projection.toReview).not.toEqual(expect.arrayContaining([v1.id]));
    expect(projection.toReview).not.toEqual(expect.arrayContaining([otherTarget.id]));
  });
});

describe('Mudança 5 › dependsOn', () => {
  test('dependsOn para id inexistente vira invalidReferences', () => {
    const v1 = verdict(
      { target: TARGET_1, claim: 'a1', dependsOn: ['p:r:verdict:phantom'] },
      { timestamp: T(0) },
    );
    const projection = projectState([v1], emptyVocabulary, T(0));
    expect(projection.invalidReferences).toEqual([
      { citedBy: v1.id, reference: 'p:r:verdict:phantom' },
    ]);
  });

  test('supera premissa da qual outro verdict depende: dependente entra no mesmo toReview', () => {
    const premise = verdict({ target: TARGET_1, claim: 'p' }, { timestamp: T(0) });
    const dependent = verdict(
      { target: TARGET_2, claim: 'd', dependsOn: [premise.id] },
      { timestamp: T(1) },
    );
    const supersedingPremise = verdict(
      { target: TARGET_1, claim: 'p', supersedes: [premise.id] },
      { timestamp: T(2) },
    );
    const projection = projectState(
      [premise, dependent, supersedingPremise],
      emptyVocabulary,
      T(2),
    );

    expect(projection.toReview).toEqual(
      expect.arrayContaining([supersedingPremise.id, dependent.id]),
    );
  });

  test('dependência circular A↔B: termina sem travar e devolve os dois targets exatamente uma vez cada', () => {
    const idA = `p:r:verdict:${randomUUIDv7()}`;
    const idB = `p:r:verdict:${randomUUIDv7()}`;
    const a = verdict(
      { target: TARGET_1, claim: 'a', dependsOn: [idB] },
      { id: idA, timestamp: T(0) },
    );
    const b = verdict(
      { target: TARGET_2, claim: 'b', dependsOn: [idA] },
      { id: idB, timestamp: T(1) },
    );
    const supersedingA = verdict(
      { target: TARGET_1, claim: 'a', supersedes: [idA] },
      { timestamp: T(2) },
    );

    const projection = projectState([a, b, supersedingA], emptyVocabulary, T(2));

    expect(projection.toReview).toEqual(expect.arrayContaining([supersedingA.id, b.id]));
    expect(projection.toReview).toHaveLength(2);
  });
});

describe('ciclo do Milestone', () => {
  test('abre e permanece aberto (sem órfão) antes do prazo', () => {
    const opening = milestone({ target: TARGET_1, dueAt: T(10) }, { timestamp: T(0) });
    expect(projectState([opening], emptyVocabulary, T(1)).orphans).toEqual([]);
  });

  test('fecha por Verdict no mesmo target', () => {
    const opening = milestone({ target: TARGET_1, dueAt: T(1) }, { timestamp: T(0) });
    const closing = verdict({ target: TARGET_1, claim: 'a1' }, { timestamp: T(2) });
    expect(projectState([opening, closing], emptyVocabulary, T(5)).orphans).toEqual([]);
  });

  test('fecha por Milestone sem dueAt', () => {
    const opening = milestone({ target: TARGET_1, dueAt: T(1) }, { timestamp: T(0) });
    const closing = milestone({ target: TARGET_1 }, { timestamp: T(2) });
    expect(projectState([opening, closing], emptyVocabulary, T(5)).orphans).toEqual([]);
  });

  test('nova abertura reinicia o ciclo, ignorando o anterior', () => {
    const opening1 = milestone({ target: TARGET_1, dueAt: T(1) }, { timestamp: T(0) });
    const closing = verdict({ target: TARGET_1, claim: 'a1' }, { timestamp: T(2) });
    const opening2 = milestone({ target: TARGET_1, dueAt: T(20) }, { timestamp: T(3) });
    const lines = [opening1, closing, opening2];

    expect(projectState(lines, emptyVocabulary, T(4)).orphans).toEqual([]);
    expect(projectState(lines, emptyVocabulary, T(25)).orphans).toEqual([
      { milestone: opening2.id, target: TARGET_1, dueAt: T(20) },
    ]);
  });
});

describe('N13 › R-3: Milestone de gate não abre nem fecha', () => {
  test('Milestone de gate sozinho não cria abertura', () => {
    const gate = milestone({ target: TARGET_1, milestoneType: 'gate' }, { timestamp: T(0) });
    expect(projectState([gate], emptyVocabulary, T(100)).orphans).toEqual([]);
  });

  test('órfão persiste depois de um Milestone de gate no mesmo target', () => {
    const opening = milestone({ target: TARGET_1, dueAt: T(1) }, { timestamp: T(0) });
    const gate = milestone({ target: TARGET_1, milestoneType: 'gate' }, { timestamp: T(2) });
    const lines = [opening, gate];

    expect(projectState(lines, emptyVocabulary, T(5)).orphans).toEqual([
      { milestone: opening.id, target: TARGET_1, dueAt: T(1) },
    ]);
  });
});

describe('avisos (N4): por dono e classes', () => {
  test('milestoneType do núcleo não gera aviso', () => {
    const vocabulary: Vocabulary = {
      core: { milestoneType: ['opening'], result: [], action: [] },
      byOwner: {},
    };
    const m1 = milestone({ target: TARGET_1, milestoneType: 'opening' }, { timestamp: T(0) });
    expect(projectState([m1], vocabulary, T(0)).warnings).toEqual([]);
  });

  test('milestoneType de extensão de um dono gera aviso com esse dono', () => {
    const vocabulary: Vocabulary = {
      core: { milestoneType: [], result: [], action: [] },
      byOwner: { 'owner-x': { milestoneType: ['card-reviewed'], result: [], action: [] } },
    };
    const m1 = milestone({ target: TARGET_1, milestoneType: 'card-reviewed' }, { timestamp: T(0) });
    expect(projectState([m1], vocabulary, T(0)).warnings).toEqual([
      {
        event: m1.id,
        field: 'milestoneType',
        value: 'card-reviewed',
        kind: 'extension',
        owner: 'owner-x',
      },
    ]);
  });

  test('milestoneType declarado por dois donos vira extensão ambígua (dono null)', () => {
    const vocabulary: Vocabulary = {
      core: { milestoneType: [], result: [], action: [] },
      byOwner: {
        'owner-a': { milestoneType: ['card-reviewed'], result: [], action: [] },
        'owner-b': { milestoneType: ['card-reviewed'], result: [], action: [] },
      },
    };
    const m1 = milestone({ target: TARGET_1, milestoneType: 'card-reviewed' }, { timestamp: T(0) });
    const [warning] = projectState([m1], vocabulary, T(0)).warnings;
    expect(warning).toEqual({
      event: m1.id,
      field: 'milestoneType',
      value: 'card-reviewed',
      kind: 'extension',
      owner: null,
    });
  });

  test('milestoneType e result desconhecidos (campos fechados) viram erro na leitura, sem lançar (log legado continua legível)', () => {
    const m1 = milestone({ target: TARGET_1, milestoneType: 'novel' }, { timestamp: T(0) });
    const v1 = verdict({ target: TARGET_1, claim: 'a1', result: 'novel' }, { timestamp: T(1) });
    expect(projectState([m1, v1], emptyVocabulary, T(1)).warnings).toEqual([
      { event: m1.id, field: 'milestoneType', value: 'novel', kind: 'error', owner: null },
      { event: v1.id, field: 'result', value: 'novel', kind: 'error', owner: null },
    ]);
  });

  test('decisoes[].acao é validado por decisão', () => {
    const vocabulary: Vocabulary = {
      core: { milestoneType: ['test-event'], result: [], action: ['approve'] },
      byOwner: {},
    };
    const m1 = milestone(
      {
        target: TARGET_1,
        decisions: [
          { item: 'x', action: 'approve', text: 't' },
          { item: 'y', action: 'reject', text: 't2' },
        ],
      },
      { timestamp: T(0) },
    );
    expect(projectState([m1], vocabulary, T(0)).warnings).toEqual([
      { event: m1.id, field: 'decisions.action', value: 'reject', kind: 'error', owner: null },
    ]);
  });

  test('Milestone de gate é ignorado nos avisos', () => {
    const m1 = milestone({ target: TARGET_1, milestoneType: 'gate' }, { timestamp: T(0) });
    expect(projectState([m1], emptyVocabulary, T(0)).warnings).toEqual([]);
  });
});

describe('validarCampo', () => {
  const vocabulary: Vocabulary = {
    core: { milestoneType: ['core-type'], result: [], action: [] },
    byOwner: { d1: { milestoneType: [], result: ['ext-result'], action: [] } },
  };

  test('valor do núcleo devolve null (sem aviso)', () => {
    expect(validateField(vocabulary, 'milestoneType', 'core-type')).toBeNull();
  });

  test('valor de extensão de um dono devolve classe extensao com esse dono', () => {
    expect(validateField(vocabulary, 'result', 'ext-result')).toEqual({
      kind: 'extension',
      owner: 'd1',
    });
  });

  test('resultado fora de tudo (campo fechado desde o gate de regra) devolve erro', () => {
    expect(validateField(vocabulary, 'result', 'never-seen')).toEqual({
      kind: 'error',
      owner: null,
    });
  });

  test('position fora de tudo (campo aberto — não fechou junto com result) devolve aviso-desconhecido', () => {
    expect(validateField(vocabulary, 'position', 'never-seen')).toEqual({
      kind: 'unknown-warning',
      owner: null,
    });
  });

  test('milestoneType fora de tudo (campo fechado) devolve erro', () => {
    expect(validateField(vocabulary, 'milestoneType', 'never-seen')).toEqual({
      kind: 'error',
      owner: null,
    });
  });
});

describe('agoraEfetivo (Q10)', () => {
  test('usa o relógio injetado quando é mais recente que o último elo', () => {
    const lines = [verdict({ target: TARGET_1, claim: 'a1' }, { timestamp: T(0) })];
    expect(effectiveNow(T(5), lines)).toBe(T(5));
  });

  test('usa o timestamp do último elo quando é mais recente que o relógio injetado', () => {
    const lines = [verdict({ target: TARGET_1, claim: 'a1' }, { timestamp: T(5) })];
    expect(effectiveNow(T(0), lines)).toBe(T(5));
  });

  test('sem elos, usa o relógio injetado', () => {
    expect(effectiveNow(T(3), [])).toBe(T(3));
  });
});

describe('VocabularioSchema', () => {
  test('aceita vocabulário válido', () => {
    const valid = {
      core: { milestoneType: ['a'], result: [], action: [] },
      byOwner: { 'owner-x': { milestoneType: [], result: ['b'], action: [] } },
    };
    expect(VocabularySchema.safeParse(valid).success).toBe(true);
  });

  test('rejeita chave extra (strictObject)', () => {
    const invalid = { core: { milestoneType: [], result: [], action: [] }, byOwner: {}, extra: 1 };
    expect(VocabularySchema.safeParse(invalid).success).toBe(false);
  });
});

describe('S3: eventos custom são inertes', () => {
  test('State com eventos custom intercalados é igual ao State sem eles (fora logThrough)', () => {
    const v1 = verdict({ target: TARGET_1, claim: 'a1' }, { timestamp: T(0) });
    const custom = line({ type: 'annotation', data: { text: 'free note' }, timestamp: T(1) });
    const v2 = verdict({ target: TARGET_1, claim: 'a2' }, { timestamp: T(2) });
    const now = T(2);

    const projectionWithoutCustom = omit(projectState([v1, v2], emptyVocabulary, now), [
      'logThrough',
    ]);
    const projectionWithCustom = omit(projectState([v1, custom, v2], emptyVocabulary, now), [
      'logThrough',
    ]);

    expect(projectionWithCustom).toEqual(projectionWithoutCustom);
  });
});

describe('Mudança 4 › bloqueado/liberado', () => {
  const PREDECESSOR = 'hex:target:predecessor';

  test('predecessor sem nenhum Verdict: bloqueado', () => {
    const m1 = milestone({ target: TARGET_1, predecessors: [PREDECESSOR] }, { timestamp: T(0) });
    const projection = projectState([m1], emptyVocabulary, T(0));
    expect(projection.blocked).toEqual([{ target: TARGET_1, blockedBy: [PREDECESSOR] }]);
    expect(projection.released).toEqual([]);
  });

  test('predecessor com Verdict ativo: liberado', () => {
    const predVerdict = verdict({ target: PREDECESSOR, claim: 'done' }, { timestamp: T(0) });
    const m1 = milestone({ target: TARGET_1, predecessors: [PREDECESSOR] }, { timestamp: T(1) });
    const projection = projectState([predVerdict, m1], emptyVocabulary, T(1));
    expect(projection.released).toEqual([TARGET_1]);
    expect(projection.blocked).toEqual([]);
  });

  test('predecessor com Verdict superado e não reativado: continua bloqueado', () => {
    const a = verdict({ target: PREDECESSOR, claim: 'x' }, { timestamp: T(0) });
    // supera cruzando para outro target/claim: o grupo (PREDECESSOR, 'x') some de `active`
    // (mesma mecânica do teste "supera cruzando target/claim diferente não funde grupos").
    const c = verdict({ target: TARGET_2, claim: 'y', supersedes: [a.id] }, { timestamp: T(1) });
    const m1 = milestone({ target: TARGET_1, predecessors: [PREDECESSOR] }, { timestamp: T(2) });
    const projection = projectState([a, c, m1], emptyVocabulary, T(2));
    expect(projection.blocked).toEqual([{ target: TARGET_1, blockedBy: [PREDECESSOR] }]);
  });

  test('target sem predecessors declarado não aparece em bloqueado nem liberado', () => {
    const m1 = milestone({ target: TARGET_1 }, { timestamp: T(0) });
    const projection = projectState([m1], emptyVocabulary, T(0));
    expect(projection.blocked).toEqual([]);
    expect(projection.released).toEqual([]);
  });

  test('última ocorrência que declara predecessors vence', () => {
    const predA = 'hex:target:pred-a';
    const predB = 'hex:target:pred-b';
    const verdictB = verdict({ target: predB, claim: 'done' }, { timestamp: T(0) });
    const m1 = milestone({ target: TARGET_1, predecessors: [predA] }, { timestamp: T(1) });
    const m2 = milestone({ target: TARGET_1, predecessors: [predB] }, { timestamp: T(2) });
    const projection = projectState([verdictB, m1, m2], emptyVocabulary, T(2));
    expect(projection.released).toEqual([TARGET_1]);
    expect(projection.blocked).toEqual([]);
  });
});

describe('Mudança 3 › fases', () => {
  test('fase atual é a milestoneType do Milestone não-gate mais recente do target', () => {
    const m1 = milestone({ target: TARGET_1, milestoneType: 'draft' }, { timestamp: T(0) });
    const m2 = milestone({ target: TARGET_1, milestoneType: 'review' }, { timestamp: T(1) });
    const projection = projectState([m1, m2], emptyVocabulary, T(1));
    expect(projection.phases).toEqual([{ target: TARGET_1, current: 'review' }]);
  });

  test('milestoneType "gate" nunca vira fase: fase permanece a do último Milestone não-gate', () => {
    const m1 = milestone({ target: TARGET_1, milestoneType: 'draft' }, { timestamp: T(0) });
    const gate = milestone({ target: TARGET_1, milestoneType: 'gate' }, { timestamp: T(1) });
    const projection = projectState([m1, gate], emptyVocabulary, T(1));
    expect(projection.phases).toEqual([{ target: TARGET_1, current: 'draft' }]);
  });

  test('target só com Milestone de gate não aparece em phases', () => {
    const gate = milestone({ target: TARGET_1, milestoneType: 'gate' }, { timestamp: T(0) });
    const projection = projectState([gate], emptyVocabulary, T(0));
    expect(projection.phases).toEqual([]);
  });

  test('cada target tem sua própria fase, independente dos demais', () => {
    const m1 = milestone({ target: TARGET_1, milestoneType: 'draft' }, { timestamp: T(0) });
    const m2 = milestone({ target: TARGET_2, milestoneType: 'review' }, { timestamp: T(1) });
    const projection = projectState([m1, m2], emptyVocabulary, T(1));
    expect(projection.phases).toEqual(
      expect.arrayContaining([
        { target: TARGET_1, current: 'draft' },
        { target: TARGET_2, current: 'review' },
      ]),
    );
  });
});

describe('Mudança 2 › voteRounds (contagem sem expor conteúdo)', () => {
  test('rodada aberta: votesReceived < votersExpected, revealed: false, sem position/data no resultado', () => {
    const v1 = vote({ target: TARGET_1, round: 'r1', votersExpected: 3 }, { timestamp: T(0) });
    const v2 = vote({ target: TARGET_1, round: 'r1', votersExpected: 3 }, { timestamp: T(1) });
    const projection = projectState([v1, v2], emptyVocabulary, T(1));
    expect(projection.voteRounds).toEqual([
      { target: TARGET_1, round: 'r1', votersExpected: 3, votesReceived: 2, revealed: false },
    ]);
  });

  test('rodada fechada: votesReceived === votersExpected, revealed: true', () => {
    const v1 = vote({ target: TARGET_1, round: 'r1', votersExpected: 2 }, { timestamp: T(0) });
    const v2 = vote({ target: TARGET_1, round: 'r1', votersExpected: 2 }, { timestamp: T(1) });
    const projection = projectState([v1, v2], emptyVocabulary, T(1));
    expect(projection.voteRounds).toEqual([
      { target: TARGET_1, round: 'r1', votersExpected: 2, votesReceived: 2, revealed: true },
    ]);
  });

  test('rodadas de targets/rounds diferentes não se misturam', () => {
    const v1 = vote({ target: TARGET_1, round: 'r1', votersExpected: 1 }, { timestamp: T(0) });
    const v2 = vote({ target: TARGET_2, round: 'r1', votersExpected: 5 }, { timestamp: T(1) });
    const projection = projectState([v1, v2], emptyVocabulary, T(1));
    expect(projection.voteRounds).toEqual(
      expect.arrayContaining([
        { target: TARGET_1, round: 'r1', votersExpected: 1, votesReceived: 1, revealed: true },
        { target: TARGET_2, round: 'r1', votersExpected: 5, votesReceived: 1, revealed: false },
      ]),
    );
  });
});
