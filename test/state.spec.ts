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

const vocabularioVazio: Vocabulary = {
  core: { milestoneType: [], result: [], action: [] },
  byOwner: {},
};

let proximoSeqValor = 0;

function line(args: {
  type: string;
  data: Record<string, unknown>;
  id?: string;
  timestamp?: string;
  seq?: number;
}): EventLine {
  const numeroSeq = args.seq ?? proximoSeqValor++;
  return {
    seq: numeroSeq,
    id: args.id ?? `p:r:${args.type}:${randomUUIDv7()}`,
    type: args.type,
    timestamp: args.timestamp ?? T(numeroSeq),
    agent: 'teste',
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
  },
  opcoes: { id?: string; timestamp?: string; seq?: number } = {},
): EventLine {
  const { milestoneType = 'evento-teste', ...resto } = data;
  return line({ type: 'milestone', data: { milestoneType, ...resto }, ...opcoes });
}

function verdict(
  data: { target: string; claim: string; result?: string; supersedes?: string[] },
  opcoes: { id?: string; timestamp?: string; seq?: number } = {},
): EventLine {
  const { result = 'confirmada', ...resto } = data;
  return line({
    type: 'verdict',
    data: { source: 'f', evidence: 'p', origin: 'o', trace: 'r', result, ...resto },
    ...opcoes,
  });
}

// ---- testes ----

describe('projetar › Estado bate com fixture (envelope novo, alvo hex:target:*)', () => {
  test('marco + veredito confirmando produzem o Estado esperado', () => {
    const m1 = milestone(
      { target: TARGET_1, milestoneType: 'esqueleto-aberto' },
      { timestamp: T(0) },
    );
    const v1 = verdict(
      { target: TARGET_1, claim: 'dod-1', result: 'confirmada' },
      { timestamp: T(1) },
    );
    const lines = [m1, v1];
    const vocabulary: Vocabulary = {
      core: { milestoneType: ['esqueleto-aberto'], result: ['confirmada'], action: [] },
      byOwner: {},
    };

    expect(projectState(lines, vocabulary, effectiveNow(T(1), lines))).toEqual({
      logThrough: { id: v1.id, seq: v1.seq, timestamp: v1.timestamp },
      active: [{ target: TARGET_1, claim: 'dod-1', status: 'active', active: v1.id }],
      conflicts: [],
      orphans: [],
      toReview: [],
      invalidReferences: [],
      warnings: [],
    });
  });
});

describe('projetar › pureza', () => {
  test('mesmos argumentos produzem o mesmo resultado', () => {
    const v1 = verdict({ target: TARGET_1, claim: 'a1' }, { timestamp: T(0) });
    const lines = [v1];
    expect(projectState(lines, vocabularioVazio, T(0))).toEqual(
      projectState(lines, vocabularioVazio, T(0)),
    );
  });

  test('rebuild completo repetido (replay incremental) bate com o rebuild direto', () => {
    const m1 = milestone({ target: TARGET_1, dueAt: T(10) }, { timestamp: T(0) });
    const v1 = verdict({ target: TARGET_1, claim: 'a1' }, { timestamp: T(1) });
    const v2 = verdict({ target: TARGET_1, claim: 'a2' }, { timestamp: T(2) });
    const lines = [m1, v1, v2];

    let ultimoReplay;
    for (let ate = 1; ate <= lines.length; ate++) {
      const parcial = lines.slice(0, ate);
      ultimoReplay = projectState(parcial, vocabularioVazio, effectiveNow(T(2), parcial));
    }

    expect(ultimoReplay).toEqual(projectState(lines, vocabularioVazio, effectiveNow(T(2), lines)));
  });
});

describe('projetar › dedupe por id', () => {
  test('evento duplicado por id não muda a Projeção', () => {
    const v1 = verdict({ target: TARGET_1, claim: 'a1' }, { timestamp: T(0) });
    const v2 = verdict({ target: TARGET_1, claim: 'a2' }, { timestamp: T(1) });
    const lines = [v1, v2];
    const comDuplicata = [v1, v1, v2];

    expect(projectState(comDuplicata, vocabularioVazio, T(1))).toEqual(
      projectState(lines, vocabularioVazio, T(1)),
    );
  });
});

describe('N3 › supersessão', () => {
  test('veredito único fica vigente', () => {
    const v1 = verdict({ target: TARGET_1, claim: 'a1' }, { timestamp: T(0) });
    const projecao = projectState([v1], vocabularioVazio, T(0));
    expect(projecao.active).toEqual([
      { target: TARGET_1, claim: 'a1', status: 'active', active: v1.id },
    ]);
    expect(projecao.conflicts).toEqual([]);
  });

  test('dois vereditos concorrentes sem supera viram conflito', () => {
    const v1 = verdict({ target: TARGET_1, claim: 'a1' }, { timestamp: T(0) });
    const v2 = verdict({ target: TARGET_1, claim: 'a1' }, { timestamp: T(1) });
    const projecao = projectState([v1, v2], vocabularioVazio, T(1));
    expect(projecao.active).toEqual([
      { target: TARGET_1, claim: 'a1', status: 'conflict', candidates: [v1.id, v2.id] },
    ]);
    expect(projecao.conflicts).toEqual([
      { target: TARGET_1, claim: 'a1', candidates: [v1.id, v2.id] },
    ]);
  });

  test('cadeia A<-B<-C: só C fica vigente (supera em cadeia)', () => {
    const a = verdict({ target: TARGET_1, claim: 'x' }, { timestamp: T(0) });
    const b = verdict({ target: TARGET_1, claim: 'x', supersedes: [a.id] }, { timestamp: T(1) });
    const c = verdict({ target: TARGET_1, claim: 'x', supersedes: [b.id] }, { timestamp: T(2) });
    const projecao = projectState([a, b, c], vocabularioVazio, T(2));
    expect(projecao.active).toEqual([
      { target: TARGET_1, claim: 'x', status: 'active', active: c.id },
    ]);
  });

  test('supera cruzando destino/afirmação diferente não funde grupos', () => {
    const y = verdict({ target: TARGET_2, claim: 'A2' }, { timestamp: T(0) });
    const x = verdict({ target: TARGET_1, claim: 'A1', supersedes: [y.id] }, { timestamp: T(1) });
    const projecao = projectState([y, x], vocabularioVazio, T(1));
    expect(projecao.active).toEqual([
      { target: TARGET_1, claim: 'A1', status: 'active', active: x.id },
    ]);
  });

  test('supera para id que não é Veredito do log vira referenciasInvalidas', () => {
    const marcoQualquer = milestone({ target: TARGET_1 }, { timestamp: T(0) });
    const v1 = verdict(
      { target: TARGET_1, claim: 'a1', supersedes: [marcoQualquer.id] },
      { timestamp: T(1) },
    );
    const projecao = projectState([marcoQualquer, v1], vocabularioVazio, T(1));
    expect(projecao.invalidReferences).toEqual([{ citedBy: v1.id, reference: marcoQualquer.id }]);
    expect(projecao.active).toEqual([
      { target: TARGET_1, claim: 'a1', status: 'active', active: v1.id },
    ]);
  });

  test('supera para id inexistente vira referenciasInvalidas', () => {
    const v1 = verdict(
      { target: TARGET_1, claim: 'a1', supersedes: ['p:r:verdict:fantasma'] },
      { timestamp: T(0) },
    );
    const projecao = projectState([v1], vocabularioVazio, T(0));
    expect(projecao.invalidReferences).toEqual([
      { citedBy: v1.id, reference: 'p:r:verdict:fantasma' },
    ]);
  });
});

describe('N3 › órfãos (relógio injetado)', () => {
  test('vencido pelo relógio do próprio log', () => {
    const abertura = milestone({ target: TARGET_1, dueAt: T(1) }, { timestamp: T(0) });
    const outro = verdict({ target: TARGET_2, claim: 'a1' }, { timestamp: T(3) });
    const lines = [abertura, outro];

    expect(projectState(lines, vocabularioVazio, effectiveNow(T(0), lines)).orphans).toEqual([
      { milestone: abertura.id, target: TARGET_1, dueAt: T(1) },
    ]);
  });

  test('a tempo (agora ainda antes do prazo) não é órfão', () => {
    const abertura = milestone({ target: TARGET_1, dueAt: T(10) }, { timestamp: T(0) });
    expect(projectState([abertura], vocabularioVazio, T(1)).orphans).toEqual([]);
  });

  test('pela parede: relógio injetado ultrapassa o prazo mesmo sem evento novo no log', () => {
    const abertura = milestone({ target: TARGET_1, dueAt: T(1) }, { timestamp: T(0) });
    const agora = effectiveNow(T(5), [abertura]);

    expect(projectState([abertura], vocabularioVazio, agora).orphans).toEqual([
      { milestone: abertura.id, target: TARGET_1, dueAt: T(1) },
    ]);
  });
});

describe('N3 › aRevisar (com gate incluído)', () => {
  test('inclui eventos do mesmo alvo do veredito superado (marco e gate), exclui alvos não relacionados', () => {
    const v1 = verdict({ target: TARGET_1, claim: 'a1' }, { timestamp: T(0) });
    const m1 = milestone({ target: TARGET_1, milestoneType: 'comentario' }, { timestamp: T(1) });
    const gate1 = milestone({ target: TARGET_1, milestoneType: 'gate' }, { timestamp: T(2) });
    const v2 = verdict({ target: TARGET_1, claim: 'a1', supersedes: [v1.id] }, { timestamp: T(3) });
    const outraUnidade = milestone(
      { target: TARGET_2, milestoneType: 'comentario' },
      { timestamp: T(4) },
    );

    const projecao = projectState([v1, m1, gate1, v2, outraUnidade], vocabularioVazio, T(4));

    expect(projecao.toReview).toEqual(expect.arrayContaining([m1.id, gate1.id, v2.id]));
    expect(projecao.toReview).not.toEqual(expect.arrayContaining([v1.id]));
    expect(projecao.toReview).not.toEqual(expect.arrayContaining([outraUnidade.id]));
  });
});

describe('ciclo do Marco', () => {
  test('abre e permanece aberto (sem órfão) antes do prazo', () => {
    const abertura = milestone({ target: TARGET_1, dueAt: T(10) }, { timestamp: T(0) });
    expect(projectState([abertura], vocabularioVazio, T(1)).orphans).toEqual([]);
  });

  test('fecha por Veredito no mesmo alvo', () => {
    const abertura = milestone({ target: TARGET_1, dueAt: T(1) }, { timestamp: T(0) });
    const fechamento = verdict({ target: TARGET_1, claim: 'a1' }, { timestamp: T(2) });
    expect(projectState([abertura, fechamento], vocabularioVazio, T(5)).orphans).toEqual([]);
  });

  test('fecha por Marco sem prazoExecucao', () => {
    const abertura = milestone({ target: TARGET_1, dueAt: T(1) }, { timestamp: T(0) });
    const fechamento = milestone({ target: TARGET_1 }, { timestamp: T(2) });
    expect(projectState([abertura, fechamento], vocabularioVazio, T(5)).orphans).toEqual([]);
  });

  test('nova abertura reinicia o ciclo, ignorando o anterior', () => {
    const abertura1 = milestone({ target: TARGET_1, dueAt: T(1) }, { timestamp: T(0) });
    const fechamento = verdict({ target: TARGET_1, claim: 'a1' }, { timestamp: T(2) });
    const abertura2 = milestone({ target: TARGET_1, dueAt: T(20) }, { timestamp: T(3) });
    const lines = [abertura1, fechamento, abertura2];

    expect(projectState(lines, vocabularioVazio, T(4)).orphans).toEqual([]);
    expect(projectState(lines, vocabularioVazio, T(25)).orphans).toEqual([
      { milestone: abertura2.id, target: TARGET_1, dueAt: T(20) },
    ]);
  });
});

describe('N13 › R-3: Marco de gate não abre nem fecha', () => {
  test('Marco de gate sozinho não cria abertura', () => {
    const gate = milestone({ target: TARGET_1, milestoneType: 'gate' }, { timestamp: T(0) });
    expect(projectState([gate], vocabularioVazio, T(100)).orphans).toEqual([]);
  });

  test('órfão persiste depois de um Marco de gate no mesmo alvo', () => {
    const abertura = milestone({ target: TARGET_1, dueAt: T(1) }, { timestamp: T(0) });
    const gate = milestone({ target: TARGET_1, milestoneType: 'gate' }, { timestamp: T(2) });
    const lines = [abertura, gate];

    expect(projectState(lines, vocabularioVazio, T(5)).orphans).toEqual([
      { milestone: abertura.id, target: TARGET_1, dueAt: T(1) },
    ]);
  });
});

describe('avisos (N4): por dono e classes', () => {
  test('marcoTipo do núcleo não gera aviso', () => {
    const vocabulary: Vocabulary = {
      core: { milestoneType: ['abertura'], result: [], action: [] },
      byOwner: {},
    };
    const m1 = milestone({ target: TARGET_1, milestoneType: 'abertura' }, { timestamp: T(0) });
    expect(projectState([m1], vocabulary, T(0)).warnings).toEqual([]);
  });

  test('marcoTipo de extensão de um dono gera aviso com esse dono', () => {
    const vocabulary: Vocabulary = {
      core: { milestoneType: [], result: [], action: [] },
      byOwner: { 'dono-x': { milestoneType: ['card-revisado'], result: [], action: [] } },
    };
    const m1 = milestone({ target: TARGET_1, milestoneType: 'card-revisado' }, { timestamp: T(0) });
    expect(projectState([m1], vocabulary, T(0)).warnings).toEqual([
      {
        event: m1.id,
        field: 'milestoneType',
        value: 'card-revisado',
        kind: 'extension',
        owner: 'dono-x',
      },
    ]);
  });

  test('marcoTipo declarado por dois donos vira extensão ambígua (dono null)', () => {
    const vocabulary: Vocabulary = {
      core: { milestoneType: [], result: [], action: [] },
      byOwner: {
        'dono-a': { milestoneType: ['card-revisado'], result: [], action: [] },
        'dono-b': { milestoneType: ['card-revisado'], result: [], action: [] },
      },
    };
    const m1 = milestone({ target: TARGET_1, milestoneType: 'card-revisado' }, { timestamp: T(0) });
    const [aviso] = projectState([m1], vocabulary, T(0)).warnings;
    expect(aviso).toEqual({
      event: m1.id,
      field: 'milestoneType',
      value: 'card-revisado',
      kind: 'extension',
      owner: null,
    });
  });

  test('marcoTipo desconhecido (campo fechado) vira erro; resultado desconhecido (campo aberto) vira aviso-desconhecido', () => {
    const m1 = milestone({ target: TARGET_1, milestoneType: 'inedito' }, { timestamp: T(0) });
    const v1 = verdict({ target: TARGET_1, claim: 'a1', result: 'inedito' }, { timestamp: T(1) });
    expect(projectState([m1, v1], vocabularioVazio, T(1)).warnings).toEqual([
      { event: m1.id, field: 'milestoneType', value: 'inedito', kind: 'error', owner: null },
      {
        event: v1.id,
        field: 'result',
        value: 'inedito',
        kind: 'unknown-warning',
        owner: null,
      },
    ]);
  });

  test('decisoes[].acao é validado por decisão', () => {
    const vocabulary: Vocabulary = {
      core: { milestoneType: ['evento-teste'], result: [], action: ['aprovar'] },
      byOwner: {},
    };
    const m1 = milestone(
      {
        target: TARGET_1,
        decisions: [
          { item: 'x', action: 'aprovar', text: 't' },
          { item: 'y', action: 'rejeitar', text: 't2' },
        ],
      },
      { timestamp: T(0) },
    );
    expect(projectState([m1], vocabulary, T(0)).warnings).toEqual([
      { event: m1.id, field: 'decisions.action', value: 'rejeitar', kind: 'error', owner: null },
    ]);
  });

  test('Marco de gate é ignorado nos avisos', () => {
    const m1 = milestone({ target: TARGET_1, milestoneType: 'gate' }, { timestamp: T(0) });
    expect(projectState([m1], vocabularioVazio, T(0)).warnings).toEqual([]);
  });
});

describe('validarCampo', () => {
  const vocabulary: Vocabulary = {
    core: { milestoneType: ['nucleo-tipo'], result: [], action: [] },
    byOwner: { d1: { milestoneType: [], result: ['ext-resultado'], action: [] } },
  };

  test('valor do núcleo devolve null (sem aviso)', () => {
    expect(validateField(vocabulary, 'milestoneType', 'nucleo-tipo')).toBeNull();
  });

  test('valor de extensão de um dono devolve classe extensao com esse dono', () => {
    expect(validateField(vocabulary, 'result', 'ext-resultado')).toEqual({
      kind: 'extension',
      owner: 'd1',
    });
  });

  test('resultado fora de tudo (campo aberto) devolve aviso-desconhecido', () => {
    expect(validateField(vocabulary, 'result', 'nunca-visto')).toEqual({
      kind: 'unknown-warning',
      owner: null,
    });
  });

  test('marcoTipo fora de tudo (campo fechado) devolve erro', () => {
    expect(validateField(vocabulary, 'milestoneType', 'nunca-visto')).toEqual({
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
    const valido = {
      core: { milestoneType: ['a'], result: [], action: [] },
      byOwner: { 'dono-x': { milestoneType: [], result: ['b'], action: [] } },
    };
    expect(VocabularySchema.safeParse(valido).success).toBe(true);
  });

  test('rejeita chave extra (strictObject)', () => {
    const invalido = { core: { milestoneType: [], result: [], action: [] }, byOwner: {}, extra: 1 };
    expect(VocabularySchema.safeParse(invalido).success).toBe(false);
  });
});

describe('S3: eventos custom são inertes', () => {
  test('Estado com eventos custom intercalados é igual ao Estado sem eles (fora logAte)', () => {
    const v1 = verdict({ target: TARGET_1, claim: 'a1' }, { timestamp: T(0) });
    const custom = line({ type: 'anotacao', data: { texto: 'nota livre' }, timestamp: T(1) });
    const v2 = verdict({ target: TARGET_1, claim: 'a2' }, { timestamp: T(2) });
    const agora = T(2);

    const projecaoSemCustom = omit(projectState([v1, v2], vocabularioVazio, agora), ['logThrough']);
    const projecaoComCustom = omit(projectState([v1, custom, v2], vocabularioVazio, agora), [
      'logThrough',
    ]);

    expect(projecaoComCustom).toEqual(projecaoSemCustom);
  });
});
